import type { NoteDescription } from "@ableton-extensions/sdk"
import { MidiClip } from "@ableton-extensions/sdk"
import type { ScalarValue } from "@live-connector/cypher"
import { NotFoundError } from "@live-connector/error"
import type { ServerDeps, TargetApiVersion } from "../deps"
import { LomGraphAdapter, type LomNode } from "../lom/adapter"
import { objectIdentity } from "./identity"
import { findNodeByIdentity } from "./locate"
import type { InverseNotesReplace, InverseOperation, InverseSetProperties } from "./types"

type V = TargetApiVersion

function isScalar(value: unknown): value is ScalarValue {
    return (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
    )
}

/** identity 照合で旧プロパティを書き戻す。 */
export async function applySetPropertiesInverse(
    deps: ServerDeps,
    adapter: LomGraphAdapter,
    inverse: InverseSetProperties,
): Promise<{
    reverted: {
        label: string
        target: { name?: string; index?: number | null }
        properties: string[]
    }[]
    missingFromSet: number
    unmatchedNow: number
}> {
    const reverted: {
        label: string
        target: { name?: string; index?: number | null }
        properties: string[]
    }[] = []
    let missing_from_set = 0

    for (const target of inverse.targets) {
        const identity = target.identity
        if (identity === null) {
            missing_from_set++
            continue
        }
        const node = await findNodeByIdentity(deps, identity, target.label, adapter)
        if (node === null) {
            missing_from_set++
            continue
        }

        const props_applied: string[] = []
        for (const [property, value] of Object.entries(target.properties)) {
            if (!isScalar(value)) {
                continue
            }
            if (node.type === "object" && node.value instanceof MidiClip && property === "notes") {
                continue
            }
            await deps.context.withinTransaction(() => adapter.setProperty(node, property, value))
            props_applied.push(property)
        }

        if (props_applied.length > 0) {
            const serialized = await adapter.serialize(node)
            const target_ref: { name?: string; index?: number | null } = {}
            if (typeof serialized.name === "string") {
                target_ref.name = serialized.name
            }
            if (node.type === "object" || node.type === "note") {
                target_ref.index = node.index
            }
            reverted.push({
                label: target.label,
                target: target_ref,
                properties: props_applied,
            })
        }
    }

    return { reverted, missingFromSet: missing_from_set, unmatchedNow: 0 }
}

export async function applyNotesInverse(
    deps: ServerDeps,
    inverse: InverseNotesReplace,
): Promise<boolean> {
    const adapter = new LomGraphAdapter(deps.context)
    const node = await findNodeByIdentity(deps, inverse.clipIdentity, "MidiClip", adapter)
    if (node === null || node.type !== "object" || !(node.value instanceof MidiClip)) {
        return false
    }
    await deps.context.withinTransaction(() => {
        const clip = node.value as MidiClip<V>
        clip.notes = inverse.oldNotes as MidiClip<V>["notes"]
    })
    return true
}

export async function applyInverseOperations(
    deps: ServerDeps,
    inverse: InverseOperation[],
): Promise<Record<string, unknown>[]> {
    const adapter = new LomGraphAdapter(deps.context)
    const results: Record<string, unknown>[] = []
    for (const operation of inverse) {
        if (operation.kind === "set_properties") {
            const result = await applySetPropertiesInverse(deps, adapter, operation)
            results.push({ kind: "set_properties", ...result })
        } else if (operation.kind === "notes_replace") {
            const restored = await applyNotesInverse(deps, operation)
            results.push({ kind: "notes_replace", restored })
        }
    }
    return results
}

export function buildSetInverse(
    nodes: LomNode[],
    adapter: LomGraphAdapter,
    properties: string[],
    old_values: Record<string, ScalarValue>[],
): InverseSetProperties {
    return {
        kind: "set_properties",
        targets: nodes.map((node, index) => ({
            identity: objectIdentity(
                node.type === "object" ? node.value : node.type === "note" ? node.value : null,
            ),
            label: adapter.labelOf(node),
            properties: Object.fromEntries(
                properties
                    .map((property) => {
                        const value = old_values[index]?.[property]
                        return value !== undefined && isScalar(value) ? [property, value] : null
                    })
                    .filter((entry): entry is [string, ScalarValue] => entry !== null),
            ),
        })),
    }
}

export async function captureNodeScalars(
    adapter: LomGraphAdapter,
    node: LomNode,
    properties: string[],
): Promise<Record<string, ScalarValue>> {
    const out: Record<string, ScalarValue> = {}
    for (const property of properties) {
        out[property] = await adapter.getProperty(node, property)
    }
    return out
}

export function captureClipNotes(node: LomNode): NoteDescription[] {
    if (node.type !== "object" || !(node.value instanceof MidiClip)) {
        return []
    }
    return node.value.notes.map((note) => ({ ...note }))
}

export function assertUndoTargetFound(found: boolean, write_id: string): void {
    if (!found) {
        throw new NotFoundError(
            `undo target writeId "${write_id}" was not found or already undone`,
            {
                hint: "Use do read MATCH (e:WriteEvent) RETURN e to list undo log entries.",
            },
        )
    }
}
