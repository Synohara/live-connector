import {
    AudioClip,
    AudioTrack,
    Clip,
    ClipSlot,
    MidiClip,
    MidiTrack,
    type NoteDescription,
    Track,
    type WarpMode,
} from "@ableton-extensions/sdk"
import { BadRequestError } from "@live-connector/error"
import type { TargetApiVersion } from "../deps"
import type { LomNode } from "../lom/adapter"
import { objectIdentity } from "./identity"
import type {
    ArrangementAudioClipBlueprint,
    ArrangementMidiClipBlueprint,
    RecreateBlueprint,
    SerializableClipBase,
    SessionAudioClipBlueprint,
    SessionMidiClipBlueprint,
} from "./types"

type V = TargetApiVersion

function captureClipBase(clip: Clip<V>): SerializableClipBase {
    return {
        name: clip.name,
        color: clip.color,
        muted: clip.muted,
        looping: clip.looping,
        startTime: clip.startTime,
        duration: clip.duration,
        startMarker: clip.startMarker,
        endMarker: clip.endMarker,
        loopStart: clip.loopStart,
        loopEnd: clip.loopEnd,
    }
}

function serializeNotes(notes: readonly NoteDescription[]): NoteDescription[] {
    return notes.map((note) => ({ ...note }))
}

export function buildArrangementMidiClipBlueprint(
    clip: MidiClip<V>,
    track: MidiTrack<V>,
): ArrangementMidiClipBlueprint {
    const track_identity = objectIdentity(track)
    if (track_identity === null) {
        throw new BadRequestError("arrangement MidiClip track has no identity")
    }
    return {
        kind: "arrangement_midi_clip",
        trackIdentity: track_identity,
        ...captureClipBase(clip),
        notes: serializeNotes(clip.notes),
    }
}

export function buildArrangementAudioClipBlueprint(
    clip: AudioClip<V>,
    track: AudioTrack<V>,
): ArrangementAudioClipBlueprint {
    const track_identity = objectIdentity(track)
    if (track_identity === null) {
        throw new BadRequestError("arrangement AudioClip track has no identity")
    }
    return {
        kind: "arrangement_audio_clip",
        trackIdentity: track_identity,
        ...captureClipBase(clip),
        filePath: clip.filePath,
        warping: clip.warping,
        warpMode: clip.warpMode as number,
        warpMarkerCount: clip.warpMarkers.length,
    }
}

export function buildArrangementClipBlueprint(
    clip: Clip<V>,
    track: Track<V>,
): ArrangementMidiClipBlueprint | ArrangementAudioClipBlueprint {
    if (clip instanceof MidiClip && track instanceof MidiTrack) {
        return buildArrangementMidiClipBlueprint(clip, track)
    }
    if (clip instanceof AudioClip && track instanceof AudioTrack) {
        return buildArrangementAudioClipBlueprint(clip, track)
    }
    throw new BadRequestError(
        "arrangement clip blueprint requires MidiClip on MidiTrack or AudioClip on AudioTrack",
    )
}

export function buildSessionMidiClipBlueprint(
    clip: MidiClip<V>,
    slot: ClipSlot<V>,
): SessionMidiClipBlueprint {
    const parent = slot.parent
    if (!(parent instanceof MidiTrack)) {
        throw new BadRequestError("session MidiClip requires MidiTrack parent")
    }
    const track_identity = objectIdentity(parent)
    if (track_identity === null) {
        throw new BadRequestError("session MidiClip track has no identity")
    }
    const slot_index = parent.clipSlots.indexOf(slot)
    if (slot_index < 0) {
        throw new BadRequestError("could not resolve ClipSlot index for session MidiClip")
    }
    return {
        kind: "session_midi_clip",
        trackIdentity: track_identity,
        slotIndex: slot_index,
        length: clip.duration,
        ...captureClipBase(clip),
        notes: serializeNotes(clip.notes),
    }
}

export function buildSessionAudioClipBlueprint(
    clip: AudioClip<V>,
    slot: ClipSlot<V>,
): SessionAudioClipBlueprint {
    const parent = slot.parent
    if (!(parent instanceof AudioTrack)) {
        throw new BadRequestError("session AudioClip requires AudioTrack parent")
    }
    const track_identity = objectIdentity(parent)
    if (track_identity === null) {
        throw new BadRequestError("session AudioClip track has no identity")
    }
    const slot_index = parent.clipSlots.indexOf(slot)
    if (slot_index < 0) {
        throw new BadRequestError("could not resolve ClipSlot index for session AudioClip")
    }
    return {
        kind: "session_audio_clip",
        trackIdentity: track_identity,
        slotIndex: slot_index,
        ...captureClipBase(clip),
        filePath: clip.filePath,
        warping: clip.warping,
        warpMode: clip.warpMode as number,
    }
}

export function buildSessionClipBlueprint(
    clip: Clip<V>,
    slot: ClipSlot<V>,
): SessionMidiClipBlueprint | SessionAudioClipBlueprint {
    if (clip instanceof MidiClip) {
        return buildSessionMidiClipBlueprint(clip, slot)
    }
    if (clip instanceof AudioClip) {
        return buildSessionAudioClipBlueprint(clip, slot)
    }
    throw new BadRequestError("session clip blueprint requires MidiClip or AudioClip")
}

export function buildClipRecreateBlueprint(node: LomNode): RecreateBlueprint | null {
    if (node.type !== "object" || !(node.value instanceof Clip)) {
        return null
    }
    const clip = node.value
    const parent = clip.parent
    if (parent instanceof Track) {
        return buildArrangementClipBlueprint(clip, parent)
    }
    if (parent instanceof ClipSlot) {
        return buildSessionClipBlueprint(clip, parent)
    }
    return null
}

export function warpModeFromBlueprint(warp_mode: number): WarpMode {
    return warp_mode as WarpMode
}
