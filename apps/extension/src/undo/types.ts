import type { NoteDescription } from "@ableton-extensions/sdk"
import type { ScalarValue } from "@live-connector/cypher"
import type { UndoableLevel } from "../tools/common"

export type InverseSetTarget = {
    identity: string | null
    label: string
    properties: Record<string, ScalarValue>
}

export type InverseSetProperties = {
    kind: "set_properties"
    targets: InverseSetTarget[]
}

export type InverseDeleteCreatedItem = {
    identity: string
    label: string
}

export type InverseDeleteCreated = {
    kind: "delete_created"
    items: InverseDeleteCreatedItem[]
}

export type SerializableClipBase = {
    name: string
    color: number
    muted: boolean
    looping: boolean
    startTime: number
    duration: number
    startMarker: number
    endMarker: number
    loopStart: number
    loopEnd: number
}

export type ArrangementMidiClipBlueprint = SerializableClipBase & {
    kind: "arrangement_midi_clip"
    trackIdentity: string
    notes: NoteDescription[]
}

export type ArrangementAudioClipBlueprint = SerializableClipBase & {
    kind: "arrangement_audio_clip"
    trackIdentity: string
    filePath: string
    warping: boolean
    warpMode: number
    warpMarkerCount: number
}

export type SessionMidiClipBlueprint = SerializableClipBase & {
    kind: "session_midi_clip"
    trackIdentity: string
    slotIndex: number
    length: number
    notes: NoteDescription[]
}

export type SessionAudioClipBlueprint = SerializableClipBase & {
    kind: "session_audio_clip"
    trackIdentity: string
    slotIndex: number
    filePath: string
    warping: boolean
    warpMode: number
}

export type DeviceBlueprint = {
    kind: "device"
    name: string
    index: number
    parentIdentity: string
}

export type NoteBlueprint = {
    kind: "note"
    clipIdentity: string
    noteIndex: number
    note: NoteDescription
}

export type CuePointBlueprint = {
    kind: "cue_point"
    time: number
    name: string
}

export type SceneBlueprint = {
    kind: "scene"
    index: number
    name: string
}

export type RecreateBlueprint =
    | ArrangementMidiClipBlueprint
    | ArrangementAudioClipBlueprint
    | SessionMidiClipBlueprint
    | SessionAudioClipBlueprint
    | DeviceBlueprint
    | NoteBlueprint
    | CuePointBlueprint
    | SceneBlueprint

export type InverseRecreate = {
    kind: "recreate"
    blueprints: RecreateBlueprint[]
}

export type InverseNotesReplace = {
    kind: "notes_replace"
    clipIdentity: string
    oldNotes: NoteDescription[]
}

export type InverseOperation =
    | InverseSetProperties
    | InverseDeleteCreated
    | InverseRecreate
    | InverseNotesReplace

export type UndoLogEntry = {
    writeId: string
    time: string
    statement: string
    kind: "set" | "create" | "delete" | "copy"
    summary: string
    undoable: UndoableLevel
    undoableReason?: string
    status: "applied" | "undone"
    inverse: InverseOperation[]
}
