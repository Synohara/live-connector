import { Device, Scene, Track } from "@ableton-extensions/sdk"
import type { CopyStatement } from "@live-connector/cypher"
import { resolveWriteTargets } from "@live-connector/cypher"
import { BadRequestError } from "@live-connector/error"
import type { ServerDeps } from "../../deps"
import { createAdapterFromDeps } from "../../lom/create-adapter"
import { objectIdentity } from "../../undo/identity"
import type { InverseDeleteCreated } from "../../undo/types"
import { deviceParent, requireRegularTrack } from "./structure"
import { beginWrite, finalizeWrite, noMatchResponse } from "./write-support"

const COPY_LABELS = new Set(["Track", "Scene", "Device", "MidiTrack", "AudioTrack"])

export async function executeCopy(
    deps: ServerDeps,
    statement: string,
    ast: CopyStatement,
    preview: boolean | undefined,
    _confirm: boolean | undefined,
): Promise<Record<string, unknown>> {
    const adapter = createAdapterFromDeps(deps)
    const nodes = await resolveWriteTargets(ast.match, ast.variable, adapter)
    if (nodes.length === 0) {
        return noMatchResponse("No nodes matched COPY.")
    }

    for (const node of nodes) {
        const label = adapter.labelOf(node)
        if (!COPY_LABELS.has(label)) {
            throw new BadRequestError(`COPY is not supported for label ${label}`, {
                hint: "COPY supports Track, Scene, and Device.",
            })
        }
    }

    if (preview === true) {
        const targets = await Promise.all(nodes.map((n) => adapter.serialize(n)))
        return { status: "preview", matched: nodes.length, targets }
    }

    const write_context = beginWrite(statement, "copy", `copy ${nodes.length} node(s)`, "full")
    const copied: {
        source: Record<string, unknown>
        created: { index: number | null; name: string }
    }[] = []
    const inverse_items: InverseDeleteCreated["items"] = []

    const song = deps.context.application.song

    for (const node of nodes) {
        if (node.type !== "object") {
            continue
        }
        if (node.value instanceof Scene) {
            const scene = node.value
            const created = await deps.context.withinTransaction(() => song.duplicateScene(scene))
            const index = song.scenes.findIndex((c) => c.handle === created.handle)
            copied.push({
                source: { label: "Scene", name: scene.name, index: node.index },
                created: { index: index < 0 ? null : index, name: created.name },
            })
            const identity = objectIdentity(created)
            if (identity !== null) {
                inverse_items.push({ identity, label: "Scene" })
            }
            continue
        }
        if (node.value instanceof Track) {
            const track = requireRegularTrack(node, song)
            const created = await deps.context.withinTransaction(() => song.duplicateTrack(track))
            const index = song.tracks.findIndex((c) => c.handle === created.handle)
            copied.push({
                source: { label: adapter.labelOf(node), name: track.name, index: node.index },
                created: { index: index < 0 ? null : index, name: created.name },
            })
            const identity = objectIdentity(created)
            if (identity !== null) {
                inverse_items.push({ identity, label: adapter.labelOf(node) })
            }
            continue
        }
        if (node.value instanceof Device) {
            const device = node.value
            const parent = deviceParent(device)
            const created = await deps.context.withinTransaction(() =>
                parent.duplicateDevice(device),
            )
            const index = parent.devices.findIndex((c) => c.handle === created.handle)
            copied.push({
                source: { label: "Device", name: device.name, index: node.index },
                created: { index: index < 0 ? null : index, name: created.name },
            })
            const identity = objectIdentity(created)
            if (identity !== null) {
                inverse_items.push({ identity, label: "Device" })
            }
        }
    }

    write_context.inverse.push({ kind: "delete_created", items: inverse_items })
    const meta = await finalizeWrite(deps, write_context)
    return { status: "ok", copied, ...meta }
}
