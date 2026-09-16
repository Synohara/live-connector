import { describe, expect, it } from "vitest"
import { CompanionClient, type CompanionTransport } from "./client"
import { parseResponse } from "./protocol"

type Handler = (request: {
    id: string
    command: string
    params: Record<string, unknown>
}) => { ok: true; result: Record<string, unknown> } | { ok: false; error: string } | null

function makeTransport(handler: Handler, connectFails = false): CompanionTransport {
    let line_listener: ((line: string) => void) | null = null
    let close_listener: (() => void) | null = null
    return {
        connect() {
            return connectFails
                ? Promise.reject(new Error("connection refused"))
                : Promise.resolve()
        },
        send(line) {
            const request = JSON.parse(line) as {
                id: string
                command: string
                params: Record<string, unknown>
            }
            const reply = handler(request)
            if (reply === null) {
                return
            }
            queueMicrotask(() => {
                line_listener?.(
                    JSON.stringify({
                        id: request.id,
                        ok: reply.ok,
                        ...(reply.ok ? { result: reply.result } : { error: reply.error }),
                    }),
                )
            })
        },
        onLine(listener) {
            line_listener = listener
        },
        onClose(listener) {
            close_listener = listener
        },
        close() {
            close_listener?.()
            return Promise.resolve()
        },
    }
}

describe("CompanionClient", () => {
    it("correlates responses by requestId", async () => {
        const client = new CompanionClient(
            makeTransport(() => ({ ok: true, result: { version: "1.0.0", setEpoch: "abc" } })),
            { timeoutMs: 100 },
        )
        await client.start()
        const status = await client.status()
        expect(status.setEpoch).toBe("abc")
    })

    it("rejects with COMPANION_UNAVAILABLE on command error", async () => {
        const client = new CompanionClient(
            makeTransport(() => ({ ok: false, error: "boom" })),
            { timeoutMs: 100 },
        )
        await client.start()
        await expect(client.status()).rejects.toMatchObject({ code: "COMPANION_UNAVAILABLE" })
    })

    it("times out when no response arrives", async () => {
        const client = new CompanionClient(
            makeTransport(() => null),
            { timeoutMs: 20 },
        )
        await client.start()
        await expect(client.heartbeat()).rejects.toMatchObject({ code: "COMPANION_UNAVAILABLE" })
    })

    it("reports COMPANION_UNAVAILABLE when connect fails", async () => {
        const client = new CompanionClient(
            makeTransport(() => null, true),
            { timeoutMs: 100 },
        )
        await expect(client.start()).rejects.toMatchObject({ code: "COMPANION_UNAVAILABLE" })
    })

    it("rejects pending requests and marks disconnected on close", async () => {
        const client = new CompanionClient(
            makeTransport(() => null),
            { timeoutMs: 5_000 },
        )
        await client.start()
        const pending = client.heartbeat()
        await client.close()
        await expect(pending).rejects.toMatchObject({ code: "COMPANION_UNAVAILABLE" })
        expect(client.isConnected()).toBe(false)
    })

    it("parses only well-formed responses", () => {
        expect(() => parseResponse("not json")).toThrow()
        expect(() => parseResponse('{"id":"1"}')).toThrow()
        expect(parseResponse('{"id":"1","ok":true,"result":{}}')).toEqual({
            id: "1",
            ok: true,
            result: {},
        })
    })
})
