import { Clip, ClipSlot, CuePoint, Device, MidiClip, Scene, Track } from "@ableton-extensions/sdk"
import type { DeleteStatement } from "@live-connector/cypher"
import { resolveWriteTargets } from "@live-connector/cypher"
import { BadRequestError } from "@live-connector/error"
import type { ServerDeps, TargetApiVersion } from "../../deps"
import type { LomNode } from "../../lom/adapter"
import { createAdapterFromDeps, isVirtualLabel } from "../../lom/create-adapter"
import { buildClipRecreateBlueprint } from "../../undo/blueprint"
import { objectIdentity } from "../../undo/identity"
import type { RecreateBlueprint } from "../../undo/types"
import type { UndoableLevel } from "../common"
import { CATALOG_DEVICE_NAMES } from "./devices"
import { deviceParent, requireRegularTrack } from "./structure"
import { beginWrite, checkConfirm, finalizeWrite, noMatchResponse } from "./write-support"

type V = TargetApiVersion

function sceneHasClips(deps: ServerDeps, scene_index: number | null): boolean {
    if (scene_index === null) {
        return false
    }
    for (const track of deps.context.application.song.tracks) {
        const slot = track.clipSlots[scene_index]
        if (slot !== undefined && slot.clip !== null) {
            return true
        }
    }
    return false
}

function assessDeleteUndoable(
    deps: ServerDeps,
    node: LomNode,
    adapter: ReturnType<typeof createAdapterFromDeps>,
): {
    undoable: UndoableLevel
    reason?: string
} {
    if (node.type === "object" && node.value instanceof Track) {
        return { undoable: "none", reason: "Track deletion cannot be recreated from MCP." }
    }
    if (node.type === "object" && node.value instanceof Device) {
        const name = node.value.name
        if (!CATALOG_DEVICE_NAMES.includes(name)) {
            return { undoable: "none", reason: `Unknown device "${name}" cannot be re-inserted.` }
        }
        return {
            undoable: "partial",
            reason: "Device will be re-inserted with default parameters; custom parameter values may be lost.",
        }
    }
    if (node.type === "object" && node.value instanceof Scene) {
        // シーン内クリップの再作成は未対応のため、クリップを持つシーンは partial として申告する。
        if (sceneHasClips(deps, node.index)) {
            return {
                undoable: "partial",
                reason: "Scene will be recreated empty; clips in the scene cannot be restored.",
            }
        }
        return { undoable: "full" }
    }
    if (node.type === "object" && node.value instanceof CuePoint) {
        return { undoable: "full" }
    }
    if (node.type === "object" && node.value instanceof Clip) {
        const parent = node.value.parent
        if (parent instanceof Track) {
            const blueprint = buildClipRecreateBlueprint(node)
            if (
                blueprint !== null &&
                blueprint.kind === "arrangement_audio_clip" &&
                blueprint.warping &&
                blueprint.warpMarkerCount > 2
            ) {
                return { undoable: "partial", reason: "Custom warp grid cannot be fully restored." }
            }
        }
        return { undoable: "full" }
    }
    if (node.type === "note") {
        return { undoable: "full" }
    }
    const label = adapter.labelOf(node)
    if (isVirtualLabel(label)) {
        throw new BadRequestError(`Cannot DELETE virtual label ${label}`)
    }
    return { undoable: "full" }
}

function buildRecreateBlueprint(
    node: LomNode,
    _adapter: ReturnType<typeof createAdapterFromDeps>,
): RecreateBlueprint | null {
    if (node.type === "object" && node.value instanceof CuePoint) {
        const cue = node.value
        return { kind: "cue_point", time: cue.time, name: cue.name }
    }
    if (node.type === "object" && node.value instanceof Scene) {
        return { kind: "scene", index: node.index ?? 0, name: node.value.name }
    }
    if (node.type === "object" && node.value instanceof Clip) {
        return buildClipRecreateBlueprint(node)
    }
    if (node.type === "object" && node.value instanceof Device) {
        const parent_identity = objectIdentity(deviceParent(node.value))
        if (parent_identity === null) {
            return null
        }
        return {
            kind: "device",
            name: node.value.name,
            index: node.index ?? 0,
            parentIdentity: parent_identity,
        }
    }
    return null
}

function buildNoteBlueprint(
    parent_clip: LomNode | null,
    note_node: LomNode,
    _adapter: ReturnType<typeof createAdapterFromDeps>,
): RecreateBlueprint | null {
    if (
        parent_clip === null ||
        parent_clip.type !== "object" ||
        !(parent_clip.value instanceof MidiClip) ||
        note_node.type !== "note"
    ) {
        return null
    }
    const clip_identity = objectIdentity(parent_clip.value)
    if (clip_identity === null) {
        return null
    }
    return {
        kind: "note",
        clipIdentity: clip_identity,
        noteIndex: note_node.index,
        note: { ...note_node.value },
    }
}

export async function executeDelete(
    deps: ServerDeps,
    statement: string,
    ast: DeleteStatement,
    preview: boolean | undefined,
    confirm: boolean | undefined,
): Promise<Record<string, unknown>> {
    const adapter = createAdapterFromDeps(deps)
    const nodes = await resolveWriteTargets(ast.match, ast.variable, adapter)
    if (nodes.length === 0) {
        return noMatchResponse("No nodes matched DELETE. Use do read to inspect targets.")
    }

    for (const node of nodes) {
        const label = adapter.labelOf(node)
        if (label === "ClipSlot") {
            throw new BadRequestError("DELETE ClipSlot is not supported; DELETE the Clip instead", {
                hint: "MATCH ...-[:HAS_CLIP]->(c:Clip) DELETE c",
            })
        }
    }

    let worst_undoable: UndoableLevel = "full"
    let undo_reason: string | undefined

    for (const node of nodes) {
        const assessment = assessDeleteUndoable(deps, node, adapter)
        if (assessment.undoable === "none") {
            worst_undoable = "none"
            undo_reason = assessment.reason
        } else if (assessment.undoable === "partial" && worst_undoable === "full") {
            worst_undoable = "partial"
            undo_reason = assessment.reason
        }
    }

    if (preview === true) {
        const targets = await Promise.all(nodes.map((node) => adapter.serialize(node)))
        return { status: "preview", matched: nodes.length, targets, undoable: worst_undoable }
    }

    const confirm_blocked = checkConfirm(worst_undoable, undo_reason, confirm, {
        matched: nodes.length,
        undoable: worst_undoable,
    })
    if (confirm_blocked !== null) {
        return confirm_blocked
    }

    const write_context = beginWrite(
        statement,
        "delete",
        `delete ${nodes.length} node(s)`,
        worst_undoable,
        undo_reason,
    )
    const blueprints: RecreateBlueprint[] = []
    const deleted: { label: string; summary: Record<string, unknown> }[] = []

    const note_nodes = nodes.filter((node) => node.type === "note")
    const non_note_nodes = nodes.filter((node) => node.type !== "note")

    for (const node of non_note_nodes) {
        const label = adapter.labelOf(node)
        const blueprint = buildRecreateBlueprint(node, adapter)
        if (blueprint !== null) {
            blueprints.push(blueprint)
        }

        if (node.type === "object" && node.value instanceof Scene) {
            const scene = node.value
            deleted.push({ label, summary: { index: node.index, name: scene.name } })
            await deps.context.withinTransaction(() =>
                deps.context.application.song.deleteScene(scene),
            )
            continue
        }
        if (node.type === "object" && node.value instanceof Track) {
            const song = deps.context.application.song
            const track = requireRegularTrack(node, song)
            deleted.push({ label, summary: { name: track.name, index: node.index } })
            await deps.context.withinTransaction(() => song.deleteTrack(track))
            continue
        }
        if (node.type === "object" && node.value instanceof Device) {
            const device = node.value
            const parent = deviceParent(device)
            deleted.push({ label, summary: { name: device.name, index: node.index } })
            await deps.context.withinTransaction(() => parent.deleteDevice(device))
            continue
        }
        if (node.type === "object" && node.value instanceof CuePoint) {
            const cue = node.value
            deleted.push({ label, summary: { name: cue.name, time: cue.time } })
            await deps.context.withinTransaction(() =>
                deps.context.application.song.deleteCuePoint(cue),
            )
            continue
        }
        if (node.type === "object" && node.value instanceof Clip) {
            const clip = node.value
            const parent = clip.parent
            if (parent instanceof ClipSlot) {
                deleted.push({ label, summary: { name: clip.name } })
                await deps.context.withinTransaction(() => parent.deleteClip())
                continue
            }
            if (parent instanceof Track) {
                deleted.push({ label, summary: { name: clip.name, startTime: clip.startTime } })
                await deps.context.withinTransaction(() => parent.deleteClip(clip))
                continue
            }
        }
        throw new BadRequestError(`DELETE not supported for label ${label}`)
    }

    if (note_nodes.length > 0) {
        await deleteNotesGrouped(deps, note_nodes, adapter, blueprints, deleted)
    }

    if (blueprints.length > 0) {
        write_context.inverse.push({ kind: "recreate", blueprints })
    }
    const meta = await finalizeWrite(deps, write_context)
    return { status: "ok", deleted, ...meta }
}

async function deleteNotesGrouped(
    deps: ServerDeps,
    note_nodes: LomNode[],
    adapter: ReturnType<typeof createAdapterFromDeps>,
    blueprints: RecreateBlueprint[],
    deleted: { label: string; summary: Record<string, unknown> }[],
): Promise<void> {
    const grouped = new Map<
        MidiClip<V>,
        {
            clip: MidiClip<V>
            indices: number[]
            notes: Extract<LomNode, { type: "note" }>[]
            clip_node: LomNode
        }
    >()

    for (const note_node of note_nodes) {
        if (note_node.type !== "note") {
            continue
        }
        const parent_clip = await findParentClipForNote(deps, note_node)
        if (
            parent_clip === null ||
            parent_clip.type !== "object" ||
            !(parent_clip.value instanceof MidiClip)
        ) {
            throw new BadRequestError("could not resolve parent MidiClip for Note DELETE")
        }
        const clip = parent_clip.value
        let group = grouped.get(clip)
        if (group === undefined) {
            group = {
                clip,
                clip_node: parent_clip,
                indices: [],
                notes: [],
            }
            grouped.set(clip, group)
        }
        group.indices.push(note_node.index)
        group.notes.push(note_node as Extract<LomNode, { type: "note" }>)
    }

    for (const group of grouped.values()) {
        for (const note_node of group.notes) {
            const blueprint = buildNoteBlueprint(group.clip_node, note_node, adapter)
            if (blueprint !== null) {
                blueprints.push(blueprint)
            }
        }
        const sorted_indices = [...group.indices].sort((left, right) => right - left)
        const notes = [...group.clip.notes]
        for (const index of sorted_indices) {
            const note_node = group.notes.find((candidate) => candidate.index === index)
            if (note_node !== undefined) {
                deleted.push({ label: "Note", summary: { pitch: note_node.value.pitch } })
            }
            notes.splice(index, 1)
        }
        await deps.context.withinTransaction(() => {
            group.clip.notes = notes
        })
    }
}

async function findParentClipForNote(
    deps: ServerDeps,
    note_node: LomNode,
): Promise<LomNode | null> {
    if (note_node.type !== "note") {
        return null
    }
    const adapter = createAdapterFromDeps(deps)
    const clips = await adapter.seeds("MidiClip")
    for (const clip_node of clips) {
        const notes = await adapter.expand(clip_node, ["HAS_NOTE"])
        for (const note of notes) {
            if (
                note.type === "note" &&
                note.index === note_node.index &&
                note.value === note_node.value
            ) {
                return clip_node
            }
        }
    }
    return null
}
