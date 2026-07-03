import { Clip, MidiClip, Simpler, Track } from "@ableton-extensions/sdk"
import {
    resolveWriteTargets,
    type ScalarValue,
    type SetAssignment,
    type SetStatement,
    type WriteValue,
} from "@live-connector/cypher"
import { BadRequestError } from "@live-connector/error"
import type { ServerDeps } from "../../deps"
import type { LomNode } from "../../lom/adapter"
import { createAdapterFromDeps, isVirtualLabel } from "../../lom/create-adapter"
import { objectIdentity } from "../../undo/identity"
import { buildSetInverse, captureClipNotes, captureNodeScalars } from "../../undo/restore"
import type { InverseOperation } from "../../undo/types"
import type { UndoableLevel } from "../common"
import {
    applyArrangementPropertySet,
    assessArrangementUndoable,
    captureArrangementClipBlueprint,
} from "./arrangement-edit"
import { type NoteInput, noteSchema, planNoteWrite } from "./notes"
import { assertSampleFile } from "./samples"
import { WRITABLE_BY_LABEL, writablePropertiesHint } from "./schemas"
import { beginWrite, checkConfirm, finalizeWrite, noMatchResponse } from "./write-support"

const ARRANGEMENT_PROPERTIES = new Set(["startTime", "duration", "startMarker", "endMarker"])

type ChangedEntry = {
    label: string
    target: { name?: string; index?: number | null }
    before: Record<string, ScalarValue | ScalarValue[] | Record<string, ScalarValue>[]>
    after: Record<string, ScalarValue | ScalarValue[] | Record<string, ScalarValue>[]>
}

function scalarWriteValue(value: WriteValue): ScalarValue | null {
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
    ) {
        return value
    }
    return null
}

function isNotesArray(value: WriteValue): value is Record<string, ScalarValue>[] {
    return Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null)
}

function labelWritableProperties(label: string): string[] {
    for (const [key, props] of Object.entries(WRITABLE_BY_LABEL)) {
        if (label === key) {
            return props
        }
    }
    return WRITABLE_BY_LABEL[label] ?? []
}

function resolveNodeLabel(
    node: LomNode,
    adapter: ReturnType<typeof createAdapterFromDeps>,
): string {
    return adapter.labelOf(node)
}

function assertNotVirtual(label: string): void {
    if (isVirtualLabel(label)) {
        throw new BadRequestError(`Cannot write to virtual label ${label}`, {
            hint: "WriteEvent and RenderJob are read-only.",
        })
    }
}

function isArrangementPlacementSet(node: LomNode, properties: string[]): boolean {
    return (
        properties.some((property) => ARRANGEMENT_PROPERTIES.has(property)) &&
        node.type === "object" &&
        node.value instanceof Clip
    )
}

async function applyScalarSet(
    deps: ServerDeps,
    node: LomNode,
    property: string,
    value: ScalarValue,
    adapter: ReturnType<typeof createAdapterFromDeps>,
): Promise<LomNode> {
    const label = resolveNodeLabel(node, adapter)
    if (property === "sampleFile" && label === "Simpler" && node.type === "object") {
        if (!(node.value instanceof Simpler)) {
            throw new BadRequestError("sampleFile can only be set on Simpler")
        }
        const simpler = node.value
        if (typeof value !== "string") {
            throw new BadRequestError("sampleFile expects a string path")
        }
        await assertSampleFile(value)
        const imported = await deps.context.resources.importIntoProject(value)
        await deps.context.withinTransaction(() => simpler.replaceSample(imported))
        return node
    }
    if (
        ARRANGEMENT_PROPERTIES.has(property) &&
        node.type === "object" &&
        node.value instanceof Clip
    ) {
        if (typeof value !== "number") {
            throw new BadRequestError(`${property} expects a number`)
        }
        const created = await applyArrangementPropertySet(deps, node, property, value)
        return {
            type: "object",
            label: created instanceof MidiClip ? "MidiClip" : adapter.labelOf(node),
            value: created,
            index: node.index,
        }
    }
    await deps.context.withinTransaction(() => adapter.setProperty(node, property, value))
    return node
}

async function applyNotesReplace(
    deps: ServerDeps,
    clip_node: LomNode,
    notes_value: Record<string, ScalarValue>[],
): Promise<void> {
    if (clip_node.type !== "object" || !(clip_node.value instanceof MidiClip)) {
        throw new BadRequestError("notes can only be set on MidiClip")
    }
    const clip = clip_node.value
    const parsed_notes: NoteInput[] = notes_value.map((raw) => noteSchema.parse(raw))
    const plan = planNoteWrite(clip, {
        tool_name: "do",
        notes: parsed_notes,
        mode: "replace",
        range: undefined,
        allowOutOfRange: false,
    })
    await deps.context.withinTransaction(() => {
        clip.notes = plan.computeNextNotes()
    })
}

async function applyNoteNodeSet(
    deps: ServerDeps,
    note_node: LomNode,
    assignments: { property: string; value: ScalarValue }[],
): Promise<void> {
    if (note_node.type !== "note") {
        throw new BadRequestError("Note property writes require a Note node in MATCH")
    }
    const parent_clip = await findParentMidiClip(deps, note_node)
    if (
        parent_clip === null ||
        parent_clip.type !== "object" ||
        !(parent_clip.value instanceof MidiClip)
    ) {
        throw new BadRequestError("could not resolve parent MidiClip for Note")
    }
    const clip = parent_clip.value
    const note_index = note_node.index
    const notes = [...clip.notes]
    const current = notes[note_index]
    if (current === undefined) {
        throw new BadRequestError(`Note index ${note_index} is out of range`)
    }
    const updated = { ...current }
    for (const { property, value } of assignments) {
        if (property === "pitch" && typeof value === "number") {
            updated.pitch = value
        } else if (property === "startTime" && typeof value === "number") {
            updated.startTime = value
        } else if (property === "duration" && typeof value === "number") {
            updated.duration = value
        } else if (property === "velocity" && typeof value === "number") {
            updated.velocity = value
        } else if (property === "muted" && typeof value === "boolean") {
            updated.muted = value
        }
    }
    notes[note_index] = updated
    await deps.context.withinTransaction(() => {
        clip.notes = notes
    })
}

async function findParentMidiClip(deps: ServerDeps, note_node: LomNode): Promise<LomNode | null> {
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

function groupAssignmentsByVariable(
    assignments: SetAssignment[],
): Map<string, { property: string; value: WriteValue }[]> {
    const grouped = new Map<string, { property: string; value: WriteValue }[]>()
    for (const assignment of assignments) {
        const list = grouped.get(assignment.variable) ?? []
        list.push({ property: assignment.property, value: assignment.value })
        grouped.set(assignment.variable, list)
    }
    return grouped
}

function assessSetUndoable(
    nodes: LomNode[],
    properties: string[],
    _adapter: ReturnType<typeof createAdapterFromDeps>,
): { undoable: UndoableLevel; reason?: string } {
    for (const node of nodes) {
        if (properties.includes("sampleFile")) {
            return {
                undoable: "partial",
                reason: "Previous sample path may not be restorable if the file was removed.",
            }
        }
        if (isArrangementPlacementSet(node, properties)) {
            return assessArrangementUndoable(node)
        }
    }
    return { undoable: "full" }
}

export async function executeSet(
    deps: ServerDeps,
    statement: string,
    ast: SetStatement,
    preview: boolean | undefined,
    confirm: boolean | undefined,
): Promise<Record<string, unknown>> {
    const adapter = createAdapterFromDeps(deps)
    const grouped = groupAssignmentsByVariable(ast.assignments)
    const nodes_by_variable = new Map<string, LomNode[]>()

    for (const [variable, assignments] of grouped) {
        const nodes = await resolveWriteTargets(ast.match, variable, adapter)
        if (nodes.length === 0) {
            return noMatchResponse(
                "No nodes matched the MATCH pattern. Adjust the pattern or use do read to inspect the Set.",
            )
        }
        for (const node of nodes) {
            const label = resolveNodeLabel(node, adapter)
            assertNotVirtual(label)
            const allowed = labelWritableProperties(label)
            if (allowed.length === 0) {
                throw new BadRequestError(`Label ${label} does not support SET`, {
                    hint: writablePropertiesHint(),
                })
            }
            for (const { property } of assignments) {
                if (!allowed.includes(property)) {
                    throw new BadRequestError(
                        `Property "${property}" is not writable on ${label}`,
                        { hint: `Writable on ${label}: ${allowed.join(", ")}` },
                    )
                }
            }
        }
        nodes_by_variable.set(variable, nodes)
    }

    const all_nodes = [...nodes_by_variable.values()].flat()
    const all_properties = ast.assignments.map((assignment) => assignment.property)

    if (preview === true) {
        const first_entry = grouped.entries().next().value
        if (first_entry !== undefined) {
            const [variable, assignments] = first_entry
            const nodes = nodes_by_variable.get(variable) ?? []
            const targets = await Promise.all(nodes.map((node) => adapter.serialize(node)))
            return {
                status: "preview",
                matched: all_nodes.length,
                assignments: Object.fromEntries(assignments.map((a) => [a.property, a.value])),
                targets,
            }
        }
    }

    const all_before: Record<string, ScalarValue>[] = []
    for (const [variable, assignments] of grouped) {
        const nodes = nodes_by_variable.get(variable) ?? []
        const scalar_capture_properties = assignments
            .map((assignment) => assignment.property)
            .filter((property) => property !== "notes")
        for (const node of nodes) {
            const before =
                scalar_capture_properties.length > 0
                    ? await captureNodeScalars(adapter, node, scalar_capture_properties)
                    : {}
            all_before.push(before)
        }
    }

    const undo_assessment = assessSetUndoable(all_nodes, all_properties, adapter)
    const confirm_blocked = checkConfirm(
        undo_assessment.undoable,
        undo_assessment.reason,
        confirm,
        { matched: all_nodes.length, properties: all_properties },
    )
    if (confirm_blocked !== null) {
        return confirm_blocked
    }

    const write_context = beginWrite(
        statement,
        "set",
        `set ${all_properties.join(",")} on ${all_nodes.length} node(s)`,
        undo_assessment.undoable,
        undo_assessment.reason,
    )

    const inverse_operations: InverseOperation[] = []
    const all_changed: ChangedEntry[] = []

    for (const [variable, assignments] of grouped) {
        const nodes = nodes_by_variable.get(variable) ?? []
        for (const node of nodes) {
            const label = resolveNodeLabel(node, adapter)
            const before: Record<
                string,
                ScalarValue | ScalarValue[] | Record<string, ScalarValue>[]
            > = {}
            const after: Record<
                string,
                ScalarValue | ScalarValue[] | Record<string, ScalarValue>[]
            > = {}
            let current_node = node

            const arrangement_properties = assignments
                .map((assignment) => assignment.property)
                .filter((property) => ARRANGEMENT_PROPERTIES.has(property))
            const arrangement_before =
                node.type === "object" &&
                node.value instanceof Clip &&
                arrangement_properties.length > 0 &&
                node.value.parent instanceof Track &&
                node.value.parent.arrangementClips.some(
                    (candidate) => candidate.handle === node.value.handle,
                )
                    ? captureArrangementClipBlueprint(node.value, node.value.parent)
                    : null

            for (const { property, value } of assignments) {
                if (property === "notes" && isNotesArray(value)) {
                    const old_notes = captureClipNotes(node)
                    const clip_identity = objectIdentity(node.type === "object" ? node.value : null)
                    before.notes = old_notes as unknown as Record<string, ScalarValue>[]
                    await applyNotesReplace(deps, node, value)
                    after.notes = value
                    if (clip_identity !== null) {
                        inverse_operations.push({
                            kind: "notes_replace",
                            clipIdentity: clip_identity,
                            oldNotes: old_notes,
                        })
                    }
                    continue
                }
                if (node.type === "note") {
                    const scalar = scalarWriteValue(value)
                    if (scalar === null) {
                        throw new BadRequestError(`Note property ${property} expects a scalar`)
                    }
                    before[property] = await adapter.getProperty(node, property)
                    await applyNoteNodeSet(deps, node, [{ property, value: scalar }])
                    after[property] = scalar
                    continue
                }
                const scalar = scalarWriteValue(value)
                if (scalar === null) {
                    throw new BadRequestError(`Property ${property} expects a scalar value`)
                }
                before[property] = await adapter.getProperty(current_node, property)

                if (ARRANGEMENT_PROPERTIES.has(property) && arrangement_before !== null) {
                    current_node = await applyScalarSet(
                        deps,
                        current_node,
                        property,
                        scalar,
                        adapter,
                    )
                } else {
                    await applyScalarSet(deps, current_node, property, scalar, adapter)
                }
                after[property] = scalar
            }

            if (arrangement_before !== null) {
                const new_identity = objectIdentity(
                    current_node.type === "object" ? current_node.value : null,
                )
                // undo 適用は inverse の並び順で行うため、新クリップの削除 → 旧状態の再作成の順に積む
                // （逆順だと移動幅が小さい場合に旧位置の再作成が新クリップと重なる）。
                if (new_identity !== null) {
                    inverse_operations.push({
                        kind: "delete_created",
                        items: [{ identity: new_identity, label }],
                    })
                }
                inverse_operations.push({
                    kind: "recreate",
                    blueprints: [arrangement_before],
                })
            }

            const serialized = await adapter.serialize(current_node)
            const target_ref: { name?: string; index?: number | null } = {}
            if (typeof serialized.name === "string") {
                target_ref.name = serialized.name
            }
            if (current_node.type === "object" || current_node.type === "note") {
                target_ref.index = current_node.index
            }
            all_changed.push({
                label,
                target: target_ref,
                before,
                after,
            })
        }
    }

    const scalar_properties = [...new Set(all_properties)].filter(
        (property) => property !== "notes" && !ARRANGEMENT_PROPERTIES.has(property),
    )
    if (scalar_properties.length > 0) {
        inverse_operations.unshift(
            buildSetInverse(all_nodes, adapter, scalar_properties, all_before),
        )
    }

    write_context.inverse.push(...inverse_operations)

    const meta = await finalizeWrite(deps, write_context)
    return {
        status: "ok",
        matched: all_nodes.length,
        changed: all_changed,
        ...meta,
    }
}
