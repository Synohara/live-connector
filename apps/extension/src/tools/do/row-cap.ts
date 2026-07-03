import type { Row } from "@live-connector/cypher"

/** LIMIT 省略時にサーバー側で適用する既定の行数上限。 */
export const DEFAULT_ROW_LIMIT = 500

/**
 * 明示 LIMIT にも適用する絶対上限。
 */
export const MAX_ROW_LIMIT = 2000

export type QueryResult = {
    count: number
    rows: Row[]
    truncated: boolean
    hint?: string
}

export function applyRowCap(
    rows: Row[],
    has_explicit_limit: boolean,
    cap: number,
    absolute_cap: number = MAX_ROW_LIMIT,
): QueryResult {
    const effective_cap = has_explicit_limit ? absolute_cap : cap
    if (rows.length <= effective_cap) {
        return { count: rows.length, rows, truncated: false }
    }
    const hint = has_explicit_limit
        ? `Result was clamped to the absolute cap of ${absolute_cap} rows even though LIMIT was explicit (the cap protects the MCP client context). Use SKIP for paging, narrow the pattern/WHERE, or summarize with aggregates (count/min/max/avg/sum).`
        : `Result was truncated to the default cap of ${cap} rows. Add LIMIT/SKIP for paging, or narrow the pattern/WHERE. Aggregates (count/min/max/avg/sum) summarize large sets in one row.`
    return {
        count: effective_cap,
        rows: rows.slice(0, effective_cap),
        truncated: true,
        hint,
    }
}
