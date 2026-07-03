/**
 * LOM オブジェクトの直列化可能な識別子（Handle.id の文字列）を返す。
 * フェイクや handle 未公開のオブジェクトは null。
 */
export function objectIdentity(value: unknown): string | null {
    if (typeof value !== "object" || value === null) {
        return null
    }
    const handle = (value as { handle?: unknown }).handle
    if (typeof handle !== "object" || handle === null || !("id" in handle)) {
        return null
    }
    const id = (handle as { id: unknown }).id
    if (typeof id === "bigint" || typeof id === "number" || typeof id === "string") {
        return String(id)
    }
    return null
}
