import { query_contract } from "@live-connector/lom-schema"
import { describe, expect, it, vi } from "vitest"
import type { ServerDeps } from "../deps"
import { FakeMcpServer } from "../test-support/fake-server"

vi.mock("@ableton-extensions/sdk", () => import("../test-support/fake-sdk"))

describe("query_contract.write", () => {
    it("declares do as the read and write tool", async () => {
        vi.stubGlobal("__LIVE_CONNECTOR_VERSION__", "9.9.9-test")
        const { registerAllTools } = await import("./mcp")
        const server = new FakeMcpServer()
        registerAllTools(server.asMcpServer(), {} as unknown as ServerDeps)
        expect([...server.tools.keys()].sort()).toEqual(["do", "meta", "render", "undo"])
        expect(query_contract.read.tool).toBe("do")
        expect(query_contract.write.tool).toBe("do")
        expect(query_contract.start_labels).toContain("WriteEvent")
        expect(query_contract.start_labels).toContain("RenderJob")
    })
})
