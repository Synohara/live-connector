import type { ExtensionContext } from "@ableton-extensions/sdk"
import type { ScalarValue } from "@live-connector/cypher"
import type { ServerDeps, TargetApiVersion } from "../deps"
import { listRenderJobs } from "../render/jobs"
import { listWriteEventsForQuery } from "../undo/log"
import { LomGraphAdapter } from "./adapter"

export type VirtualLabelSources = {
    listWriteEvents: () => Promise<
        {
            id: string
            time: string
            kind: string
            statement: string
            undoable: string
            status: string
        }[]
    >
    listRenderJobs: () => Promise<
        {
            id: string
            status: string
            filePath?: string
            error?: string
        }[]
    >
}

export function defaultVirtualLabelSources(deps: ServerDeps): VirtualLabelSources {
    return {
        async listWriteEvents() {
            const entries = await listWriteEventsForQuery(deps)
            return entries.map((entry) => ({
                id: entry.writeId,
                time: entry.time,
                kind: entry.kind,
                statement: entry.statement,
                undoable: entry.undoable,
                status: entry.status,
            }))
        },
        listRenderJobs() {
            return Promise.resolve(
                listRenderJobs().map((job) => ({
                    id: job.id,
                    status: job.status,
                    ...(job.filePath !== undefined ? { filePath: job.filePath } : {}),
                    ...(job.error !== undefined ? { error: job.error } : {}),
                })),
            )
        },
    }
}

export function createLomGraphAdapter(
    context: ExtensionContext<TargetApiVersion>,
    sources: VirtualLabelSources = {
        listWriteEvents: async () => [],
        listRenderJobs: async () => [],
    },
): LomGraphAdapter {
    return new LomGraphAdapter(context, sources)
}

export function createAdapterFromDeps(deps: ServerDeps): LomGraphAdapter {
    return createLomGraphAdapter(deps.context, defaultVirtualLabelSources(deps))
}

export type VirtualNode = {
    type: "virtual"
    label: "WriteEvent" | "RenderJob"
    id: string
    properties: Record<string, ScalarValue>
}

export function isVirtualLabel(label: string): boolean {
    return label === "WriteEvent" || label === "RenderJob"
}
