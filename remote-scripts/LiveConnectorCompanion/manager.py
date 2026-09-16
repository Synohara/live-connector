"""live-connector companion Remote Script.

loopback TCP + JSON 行プロトコルで拡張からのコマンドを受け、Live 正常稼働中の
安全保護（heartbeat 期限、録音範囲上限、対象トラック検証、停止後の安全化）を担う。
Live crash の救済は対象外。
"""

import json
import socket
import threading
import time

from _Framework.ControlSurface import ControlSurface

VERSION = "1.0.0"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 11002
TICK_DELAY = 1  # schedule_message の単位は 1/10 秒
MAX_EVENTS = 50


def djb2_epoch(names):
    """拡張側（TypeScript）と同じ djb2。トラック名の並びから Set epoch を作る。"""
    joined = "|".join(names)
    value = 5381
    for character in joined:
        value = ((value << 5) + value + ord(character)) & 0xFFFFFFFF
    return format(value, "x").rjust(8, "0")


class Manager(ControlSurface):
    def __init__(self, c_instance):
        ControlSurface.__init__(self, c_instance)
        self._requests = []
        self._connections = {}
        self._lock = threading.Lock()
        self._next_conn = 1
        self._events = []
        self._watch = None
        self._last_heartbeat = None
        self._server = None
        try:
            self._start_server()
            self.show_message(
                "live-connector companion listening on %s:%d" % (DEFAULT_HOST, DEFAULT_PORT)
            )
        except OSError as error:
            self.show_message(
                "live-connector companion could not bind %d (%s)" % (DEFAULT_PORT, error)
            )
        self.schedule_message(TICK_DELAY, self._tick)

    # -- server -------------------------------------------------------------

    def _start_server(self):
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind((DEFAULT_HOST, DEFAULT_PORT))
        server.listen(4)
        self._server = server
        thread = threading.Thread(target=self._accept_loop)
        thread.daemon = True
        thread.start()

    def _accept_loop(self):
        while True:
            try:
                connection, _ = self._server.accept()
            except Exception:
                return
            with self._lock:
                connection_id = self._next_conn
                self._next_conn += 1
                self._connections[connection_id] = connection
            thread = threading.Thread(
                target=self._connection_loop, args=(connection_id, connection)
            )
            thread.daemon = True
            thread.start()

    def _connection_loop(self, connection_id, connection):
        buffer = b""
        try:
            while True:
                data = connection.recv(4096)
                if not data:
                    break
                buffer += data
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    text = line.decode("utf-8", "replace").strip()
                    if not text:
                        continue
                    try:
                        request = json.loads(text)
                    except ValueError:
                        continue
                    with self._lock:
                        self._requests.append((connection_id, request))
        except Exception:
            pass
        finally:
            with self._lock:
                self._connections.pop(connection_id, None)
            try:
                connection.close()
            except Exception:
                pass

    def _send(self, connection_id, response):
        with self._lock:
            connection = self._connections.get(connection_id)
        if connection is None:
            return
        try:
            connection.sendall((json.dumps(response) + "\n").encode("utf-8"))
        except Exception:
            pass

    # -- main-thread loop ---------------------------------------------------

    def _tick(self):
        try:
            self._drain_requests()
            self._check_safety()
        except Exception as error:
            self.log_message("companion tick error: %s" % str(error))
        self.schedule_message(TICK_DELAY, self._tick)

    def _drain_requests(self):
        with self._lock:
            pending = self._requests
            self._requests = []
        for connection_id, request in pending:
            response = self._handle(connection_id, request)
            self._send(connection_id, response)

    def _handle(self, connection_id, request):
        request_id = request.get("id")
        command = request.get("command")
        params = request.get("params") or {}
        try:
            result = self._dispatch(command, params)
            return {"id": request_id, "ok": True, "result": result}
        except Exception as error:
            return {"id": request_id, "ok": False, "error": str(error)}

    def _dispatch(self, command, params):
        if command == "status":
            return self._status()
        if command == "heartbeat":
            self._last_heartbeat = time.time()
            return {"ack": True}
        if command == "verify_track":
            return self._verify_track(str(params.get("name")), int(params.get("index")))
        if command == "watch":
            return self._watch_command(params)
        if command == "enforce_stop":
            return self._safety_stop("manual")
        if command == "events":
            return {"events": self._events[-MAX_EVENTS:]}
        raise ValueError("unknown command: %s" % command)

    def _epoch(self):
        return djb2_epoch([track.name for track in self.song().tracks])

    def _status(self):
        song = self.song()
        watch = self._watch
        return {
            "version": VERSION,
            "setEpoch": self._epoch(),
            "transport": {
                "isPlaying": bool(song.is_playing),
                "currentSongTime": float(song.current_song_time),
                "recordMode": bool(song.record_mode),
            },
            "heartbeat": {
                "watched": watch is not None,
                "deadlineMs": int(watch["deadline_ms"]) if watch else 0,
                "lastSeenAgoMs": None
                if self._last_heartbeat is None
                else int((time.time() - self._last_heartbeat) * 1000),
            },
        }

    def _verify_track(self, name, index):
        names = [track.name for track in self.song().tracks]
        matches = [i for i, candidate in enumerate(names) if candidate == name]
        matched = len(matches) == 1 and matches[0] == index
        return {
            "matched": matched,
            "index": matches[0] if len(matches) == 1 else None,
            "setEpoch": self._epoch(),
        }

    def _watch_command(self, params):
        if not bool(params.get("enabled")):
            self._watch = None
            return {"watched": False}
        song = self.song()
        self._watch = {
            "deadline_ms": int(params.get("deadlineMs") or 10000),
            "capture_track_name": str(params.get("captureTrackName") or ""),
            "max_capture_beats": float(params.get("maxCaptureBeats") or 0),
            "start_beat": float(params.get("startBeat") or 0),
            "end_beat": float(params.get("endBeat") or 0),
            "before": {
                "loop": bool(song.loop),
                "loop_start": float(song.loop_start),
                "loop_length": float(song.loop_length),
                "punch_in": bool(song.punch_in),
                "punch_out": bool(song.punch_out),
                "current_song_time": float(song.current_song_time),
                "record_mode": bool(song.record_mode),
            },
        }
        self._last_heartbeat = time.time()
        return {"watched": True}

    def _check_safety(self):
        watch = self._watch
        if watch is None:
            return
        song = self.song()
        now = time.time()
        overdue = (
            self._last_heartbeat is not None
            and (now - self._last_heartbeat) * 1000 > watch["deadline_ms"]
        )
        position = float(song.current_song_time)
        over_range = position > watch["end_beat"] + 0.5 or (
            watch["max_capture_beats"] > 0
            and position > watch["start_beat"] + watch["max_capture_beats"] + 0.5
        )
        if overdue or over_range:
            self._safety_stop("heartbeat" if overdue else "range")

    def _safety_stop(self, reason):
        watch = self._watch
        song = self.song()
        try:
            song.stop_playing()
        except Exception:
            pass
        try:
            song.record_mode = False
        except Exception:
            pass
        if watch is not None:
            for track in song.tracks:
                if track.name == watch["capture_track_name"]:
                    try:
                        track.arm = False
                    except Exception:
                        pass
            before = watch["before"]
            try:
                song.loop = before["loop"]
                song.loop_start = before["loop_start"]
                song.loop_length = before["loop_length"]
                song.punch_in = before["punch_in"]
                song.punch_out = before["punch_out"]
                song.current_song_time = before["current_song_time"]
                song.record_mode = before["record_mode"]
            except Exception:
                pass
            self._watch = None
        event = {"at": time.time(), "reason": reason}
        self._events.append(event)
        self.log_message("companion safety stop: %s" % reason)
        return {"stopped": True, "reason": reason}
