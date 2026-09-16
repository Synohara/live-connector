/**
 * companion Remote Script との TCP + JSON 行プロトコル。
 * 1 行 1 メッセージ（末尾 `\n`）。requestId で応答を相関する。
 * OSC と違い、requestId・ACK・タイムアウトを自前で持つ。
 */

export type CompanionRequest = {
    id: string
    command: string
    params: Record<string, unknown>
}

export type CompanionResponse = {
    id: string
    ok: boolean
    result?: Record<string, unknown>
    error?: string
}

export type CompanionStatus = {
    version: string
    /** Live Set の epoch（song handle 相当）。同じ Set かの照合に使う。 */
    setEpoch: string
    transport: {
        isPlaying: boolean
        currentSongTime: number
        recordMode: boolean
    }
    heartbeat: {
        watched: boolean
        deadlineMs: number
        lastSeenAgoMs: number | null
    }
}

export type VerifyTrackResult = {
    matched: boolean
    index: number | null
    setEpoch: string
}

export function encodeRequest(request: CompanionRequest): string {
    return `${JSON.stringify(request)}\n`
}

export function parseResponse(line: string): CompanionResponse {
    const parsed = JSON.parse(line) as Partial<CompanionResponse>
    if (typeof parsed.id !== "string" || typeof parsed.ok !== "boolean") {
        throw new Error("companion response is missing id/ok")
    }
    return {
        id: parsed.id,
        ok: parsed.ok,
        ...(parsed.result !== undefined ? { result: parsed.result } : {}),
        ...(parsed.error !== undefined ? { error: parsed.error } : {}),
    }
}

/** companion のコマンド名。 */
export const COMPANION_COMMANDS = {
    status: "status",
    heartbeat: "heartbeat",
    verifyTrack: "verify_track",
    watch: "watch",
    enforceStop: "enforce_stop",
    events: "events",
} as const

export type CompanionWatchParams = {
    enabled: boolean
    deadlineMs: number
    captureTrackName: string
    maxCaptureBeats: number
    startBeat: number
    endBeat: number
}
