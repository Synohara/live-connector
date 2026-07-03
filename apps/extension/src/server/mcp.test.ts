import { describe, expect, it, vi } from "vitest"
import type { ServerDeps } from "../deps"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

async function loadDescribe() {
    vi.stubGlobal("__LIVE_CONNECTOR_VERSION__", "9.9.9-test")
    const module = await import("./mcp")
    return module.describeRegisteredTools
}

describe("describeRegisteredTools", () => {
    it("collects the four registered tools via the shared registration path", async () => {
        const describeRegisteredTools = await loadDescribe()
        const summary = describeRegisteredTools({} as unknown as ServerDeps)

        expect(summary.names).toEqual(["do", "meta", "render", "undo"])
        expect(summary.count).toBe(4)
        expect(new Set(summary.names).size).toBe(summary.names.length)
    })

    it("returns names sorted for a stable digest", async () => {
        const describeRegisteredTools = await loadDescribe()
        const summary = describeRegisteredTools({} as unknown as ServerDeps)
        const sorted = [...summary.names].sort((left, right) => left.localeCompare(right))
        expect(summary.names).toEqual(sorted)
        expect(summary.digest).toMatch(/^[0-9a-f]{8}$/)
    })

    it("produces a digest that changes when the tool set changes", async () => {
        const describeRegisteredTools = await loadDescribe()
        const summary = describeRegisteredTools({} as unknown as ServerDeps)
        const otherDigest = digestOf([...summary.names, "extra_tool"])
        expect(otherDigest).not.toBe(summary.digest)
    })
})

function digestOf(names: string[]): string {
    const joined = [...names].sort((left, right) => left.localeCompare(right)).join(",")
    let hash = 5381
    for (let index = 0; index < joined.length; index++) {
        hash = ((hash << 5) + hash + joined.charCodeAt(index)) >>> 0
    }
    return hash.toString(16).padStart(8, "0")
}
