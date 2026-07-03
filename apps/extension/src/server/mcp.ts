import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ServerDeps } from "../deps"
import { registerDoTool } from "../tools/do"
import { registerMetaTool } from "../tools/meta"
import { registerRenderTool } from "../tools/render"
import { registerUndoTool } from "../tools/undo"
import { SERVICE_VERSION } from "../version"
import { withToolAnnotations } from "./annotations"

/** initialize 応答でクライアントへ配布する運用規約の要約。 */
const SERVER_INSTRUCTIONS = `live-connector controls an Ableton Live Set as a property graph over the Live Object Model (LOM).

Recommended flow: (1) meta — schema, grammar contract, examples, overview; (2) do read — MATCH ... RETURN; (3) do write — MATCH ... SET / CREATE / DELETE / COPY (preview:true first); (4) render — bounce audio; (5) undo — revert writes.

Four verbs: meta (entry), do (read/write), render (listen), undo (revert).

Time coordinates (two systems, do not mix): note startTime and clip markers are CLIP-RELATIVE beats in [0, clipLength). Clip.startTime/endTime, CuePoint.time and arrangement placement use ARRANGEMENT-ABSOLUTE beats.

Guardrails: writes return diffs only; zero matches return {status:"no_match"} (not an error). undoable partial/none writes need confirm:true. do read without LIMIT truncates at 500 rows. undo applies to do writes only (not undo itself). Virtual labels WriteEvent and RenderJob are query-only.`

/** 登録ツール構成のサマリ。/health で稼働ホストのツール構成を外形確認するために使う。 */
export type RegisteredToolsSummary = {
    count: number
    digest: string
    names: string[]
}

export function registerAllTools(server: McpServer, deps: ServerDeps): void {
    registerMetaTool(server, deps)
    registerDoTool(server, deps)
    registerUndoTool(server, deps)
    registerRenderTool(server, deps)
}

function toolsDigest(names: string[]): string {
    const joined = names.join(",")
    let hash = 5381
    for (let index = 0; index < joined.length; index++) {
        hash = ((hash << 5) + hash + joined.charCodeAt(index)) >>> 0
    }
    return hash.toString(16).padStart(8, "0")
}

export function createMcpServer(deps: ServerDeps): McpServer {
    const server = new McpServer(
        { name: "live-connector", version: SERVICE_VERSION },
        { instructions: SERVER_INSTRUCTIONS },
    )
    registerAllTools(withToolAnnotations(server), deps)
    return server
}

export function describeRegisteredTools(deps: ServerDeps): RegisteredToolsSummary {
    const names: string[] = []
    const collector = {
        registerTool(name: string) {
            names.push(name)
        },
    } as unknown as McpServer
    registerAllTools(collector, deps)
    names.sort((left, right) => left.localeCompare(right))
    return { count: names.length, digest: toolsDigest(names), names }
}
