import {
    AudioTrack,
    type Clip,
    type MidiClip,
    MidiTrack,
    type NoteDescription,
} from "@ableton-extensions/sdk"
import { NotFoundError } from "@live-connector/error"
import type { ServerDeps, TargetApiVersion } from "../deps"
import { warpModeFromBlueprint } from "./blueprint"
import {
    findClipSlotByTrackAndIndex,
    findDeviceParentByIdentity,
    findMidiClipByIdentity,
    findTrackByIdentity,
} from "./locate"
import type { InverseRecreate, RecreateBlueprint } from "./types"

type V = TargetApiVersion

async function recreateArrangementMidiClip(
    deps: ServerDeps,
    blueprint: Extract<RecreateBlueprint, { kind: "arrangement_midi_clip" }>,
): Promise<Clip<V>> {
    const track = await findTrackByIdentity(deps, blueprint.trackIdentity)
    if (!(track instanceof MidiTrack)) {
        throw new NotFoundError(
            `track ${blueprint.trackIdentity} not found for arrangement MidiClip recreate`,
        )
    }
    return deps.context.withinTransaction(async () => {
        const created = await track.createMidiClip(blueprint.startTime, blueprint.duration)
        created.notes = blueprint.notes as MidiClip<V>["notes"]
        created.name = blueprint.name
        created.color = blueprint.color
        created.muted = blueprint.muted
        created.looping = blueprint.looping
        return created
    })
}

async function recreateArrangementAudioClip(
    deps: ServerDeps,
    blueprint: Extract<RecreateBlueprint, { kind: "arrangement_audio_clip" }>,
): Promise<Clip<V>> {
    const track = await findTrackByIdentity(deps, blueprint.trackIdentity)
    if (!(track instanceof AudioTrack)) {
        throw new NotFoundError(
            `track ${blueprint.trackIdentity} not found for arrangement AudioClip recreate`,
        )
    }
    return deps.context.withinTransaction(async () => {
        const created = await track.createAudioClip({
            filePath: blueprint.filePath,
            startTime: blueprint.startTime,
            duration: blueprint.duration,
            isWarped: blueprint.warping,
            loopSettings: {
                looping: blueprint.looping,
                startMarker: blueprint.startMarker,
                endMarker: blueprint.endMarker,
                loopStart: blueprint.loopStart,
                loopEnd: blueprint.loopEnd,
            },
        })
        created.warpMode = warpModeFromBlueprint(blueprint.warpMode)
        created.name = blueprint.name
        created.color = blueprint.color
        created.muted = blueprint.muted
        return created
    })
}

async function recreateSessionMidiClip(
    deps: ServerDeps,
    blueprint: Extract<RecreateBlueprint, { kind: "session_midi_clip" }>,
): Promise<Clip<V>> {
    const slot = await findClipSlotByTrackAndIndex(
        deps,
        blueprint.trackIdentity,
        blueprint.slotIndex,
    )
    if (slot === null) {
        throw new NotFoundError(
            `ClipSlot ${blueprint.trackIdentity}:${blueprint.slotIndex} not found`,
        )
    }
    return deps.context.withinTransaction(async () => {
        const created = await slot.createMidiClip(blueprint.length)
        created.notes = blueprint.notes as MidiClip<V>["notes"]
        created.name = blueprint.name
        created.color = blueprint.color
        created.muted = blueprint.muted
        created.looping = blueprint.looping
        return created
    })
}

async function recreateSessionAudioClip(
    deps: ServerDeps,
    blueprint: Extract<RecreateBlueprint, { kind: "session_audio_clip" }>,
): Promise<Clip<V>> {
    const slot = await findClipSlotByTrackAndIndex(
        deps,
        blueprint.trackIdentity,
        blueprint.slotIndex,
    )
    if (slot === null) {
        throw new NotFoundError(
            `ClipSlot ${blueprint.trackIdentity}:${blueprint.slotIndex} not found`,
        )
    }
    return deps.context.withinTransaction(async () => {
        const created = await slot.createAudioClip({ filePath: blueprint.filePath })
        created.name = blueprint.name
        created.color = blueprint.color
        created.muted = blueprint.muted
        created.looping = blueprint.looping
        created.warping = blueprint.warping
        created.warpMode = warpModeFromBlueprint(blueprint.warpMode)
        return created
    })
}

async function recreateDevice(
    deps: ServerDeps,
    blueprint: Extract<RecreateBlueprint, { kind: "device" }>,
): Promise<{ name: string; index: number }> {
    const parent = await findDeviceParentByIdentity(deps, blueprint.parentIdentity)
    if (parent === null) {
        throw new NotFoundError(`device parent ${blueprint.parentIdentity} not found`)
    }
    const device = await deps.context.withinTransaction(() =>
        parent.insertDevice(blueprint.name, blueprint.index),
    )
    return { name: device.name, index: blueprint.index }
}

async function recreateNote(
    deps: ServerDeps,
    blueprint: Extract<RecreateBlueprint, { kind: "note" }>,
): Promise<{ clipIdentity: string; noteIndex: number }> {
    const clip = await findMidiClipByIdentity(deps, blueprint.clipIdentity)
    if (clip === null) {
        throw new NotFoundError(`MidiClip ${blueprint.clipIdentity} not found for note recreate`)
    }
    await deps.context.withinTransaction(() => {
        const notes = [...clip.notes] as NoteDescription[]
        const insert_index = Math.min(blueprint.noteIndex, notes.length)
        notes.splice(insert_index, 0, blueprint.note)
        clip.notes = notes as MidiClip<V>["notes"]
    })
    return { clipIdentity: blueprint.clipIdentity, noteIndex: blueprint.noteIndex }
}

export async function applyRecreate(
    deps: ServerDeps,
    inverse: InverseRecreate,
): Promise<{ recreated: Record<string, unknown>[] }> {
    const recreated: Record<string, unknown>[] = []
    const song = deps.context.application.song

    for (const blueprint of inverse.blueprints) {
        if (blueprint.kind === "cue_point") {
            const cue = await deps.context.withinTransaction(async () => {
                const created = await song.createCuePoint(blueprint.time)
                created.name = blueprint.name
                return created
            })
            recreated.push({ label: "CuePoint", time: cue.time, name: cue.name })
            continue
        }
        if (blueprint.kind === "scene") {
            const scene = await deps.context.withinTransaction(async () => {
                const insert_index = Math.min(blueprint.index, song.scenes.length)
                const created = await song.createScene(insert_index)
                created.name = blueprint.name
                return created
            })
            recreated.push({ label: "Scene", index: blueprint.index, name: scene.name })
            continue
        }
        if (blueprint.kind === "arrangement_midi_clip") {
            const created = await recreateArrangementMidiClip(deps, blueprint)
            recreated.push({
                label: "MidiClip",
                name: created.name,
                startTime: created.startTime,
            })
            continue
        }
        if (blueprint.kind === "arrangement_audio_clip") {
            const created = await recreateArrangementAudioClip(deps, blueprint)
            recreated.push({
                label: "AudioClip",
                name: created.name,
                startTime: created.startTime,
            })
            continue
        }
        if (blueprint.kind === "session_midi_clip") {
            const created = await recreateSessionMidiClip(deps, blueprint)
            recreated.push({
                label: "MidiClip",
                name: created.name,
                slotIndex: blueprint.slotIndex,
            })
            continue
        }
        if (blueprint.kind === "session_audio_clip") {
            const created = await recreateSessionAudioClip(deps, blueprint)
            recreated.push({
                label: "AudioClip",
                name: created.name,
                slotIndex: blueprint.slotIndex,
            })
            continue
        }
        if (blueprint.kind === "device") {
            const inserted = await recreateDevice(deps, blueprint)
            recreated.push({ label: "Device", ...inserted })
            continue
        }
        if (blueprint.kind === "note") {
            const restored = await recreateNote(deps, blueprint)
            recreated.push({ label: "Note", ...restored })
        }
    }

    return { recreated }
}
