import { evaluate, parseQuery } from "@live-connector/cypher"
import type { ServerDeps } from "../../deps"
import { createAdapterFromDeps } from "../../lom/create-adapter"
import { applyRowCap, DEFAULT_ROW_LIMIT } from "./row-cap"

export async function executeRead(
    deps: ServerDeps,
    statement: string,
): Promise<Record<string, unknown>> {
    const ast = parseQuery(statement)
    const adapter = createAdapterFromDeps(deps)
    const rows = await evaluate(ast, adapter)
    const result = applyRowCap(rows, ast.limit !== null, DEFAULT_ROW_LIMIT)
    return { status: "ok", ...result }
}
