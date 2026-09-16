/**
 * companion Remote Script の TCP クライアント。
 * activation 単位の singleton として Runtime が保持する。
 * requestId 相関・タイムアウト・切断時の失敗処理を持つ。
 */

import net from "node:net"
import { HybridError } from "@live-connector/error"
import type { Logger } from "@live-connector/log"
import {
    COMPANION_COMMANDS,
    type CompanionStatus,
    type CompanionWatchParams,
    encodeRequest,
    parseResponse,
    type VerifyTrackResult,
} from "./protocol"

export type CompanionTransport = {
    connect(): Promise<void>
    send(line: string): void
    onLine(listener: (line: string) => void): void
    onClose(listener: () => void): void
    close(): Promise<void>
}

/** node:net による実トランスポート。 */
export function createTcpCompanionTransport(
    host: string,
    port: number,
    log: Logger,
): CompanionTransport {
    const socket = new net.Socket()
    let line_listener: ((line: string) => void) | null = null
    let close_listener: (() => void) | null = null
    let buffer = ""

    socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8")
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            if (line.trim().length > 0) {
                line_listener?.(line)
            }
            newline = buffer.indexOf("\n")
        }
    })
    socket.on("error", (error) => {
        log.warn("companion socket error", { error: String(error) })
    })
    socket.on("close", () => {
        close_listener?.()
    })

    return {
        connect() {
            return new Promise<void>((resolve, reject) => {
                const on_error = (error: Error) => {
                    socket.off("connect", on_connect)
                    reject(error)
                }
                const on_connect = () => {
                    socket.off("error", on_error)
                    resolve()
                }
                socket.once("error", on_error)
                socket.once("connect", on_connect)
                socket.connect(port, host)
            })
        },
        send(line) {
            socket.write(line)
        },
        onLine(listener) {
            line_listener = listener
        },
        onClose(listener) {
            close_listener = listener
        },
        close() {
            return new Promise<void>((resolve) => {
                socket.end(() => {
                    socket.destroy()
                    resolve()
                })
                setTimeout(resolve, 500)
            })
        },
    }
}

type Pending = {
    resolve: (result: Record<string, unknown>) => void
    reject: (error: unknown) => void
    timer: NodeJS.Timeout
}

export type CompanionClientOptions = {
    timeoutMs: number
}

export class CompanionClient {
    private readonly transport: CompanionTransport
    private readonly options: CompanionClientOptions
    private pending = new Map<string, Pending>()
    private counter = 0
    private connected = false

    constructor(transport: CompanionTransport, options: CompanionClientOptions) {
        this.transport = transport
        this.options = options
        this.transport.onLine((line) => this.handleLine(line))
        this.transport.onClose(() => this.handleClose())
    }

    async start(): Promise<void> {
        try {
            await this.transport.connect()
            this.connected = true
        } catch (error) {
            this.connected = false
            throw new HybridError(
                "COMPANION_UNAVAILABLE",
                `Failed to connect to companion: ${String(error)}`,
            )
        }
    }

    isConnected(): boolean {
        return this.connected
    }

    async close(): Promise<void> {
        await this.transport.close()
        this.connected = false
    }

    private handleClose(): void {
        this.connected = false
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer)
            pending.reject(new HybridError("COMPANION_UNAVAILABLE", "Companion connection closed"))
        }
        this.pending.clear()
    }

    private handleLine(line: string): void {
        let response: ReturnType<typeof parseResponse>
        try {
            response = parseResponse(line)
        } catch {
            return
        }
        const pending = this.pending.get(response.id)
        if (pending === undefined) {
            return
        }
        clearTimeout(pending.timer)
        this.pending.delete(response.id)
        if (response.ok) {
            pending.resolve(response.result ?? {})
        } else {
            pending.reject(
                new HybridError(
                    "COMPANION_UNAVAILABLE",
                    response.error ?? "Companion command failed",
                ),
            )
        }
    }

    request(
        command: string,
        params: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> {
        if (!this.connected) {
            return Promise.reject(
                new HybridError("COMPANION_UNAVAILABLE", "Companion is not connected"),
            )
        }
        this.counter = (this.counter + 1) % 1_000_000
        const id = `c${Date.now().toString(36)}-${this.counter.toString(36)}`
        return new Promise<Record<string, unknown>>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                reject(
                    new HybridError(
                        "COMPANION_UNAVAILABLE",
                        `Companion command "${command}" timed out`,
                    ),
                )
            }, this.options.timeoutMs)
            this.pending.set(id, { resolve, reject, timer })
            this.transport.send(encodeRequest({ id, command, params }))
        })
    }

    async status(): Promise<CompanionStatus> {
        const result = await this.request(COMPANION_COMMANDS.status)
        return result as unknown as CompanionStatus
    }

    async heartbeat(): Promise<void> {
        await this.request(COMPANION_COMMANDS.heartbeat)
    }

    async verifyTrack(name: string, index: number): Promise<VerifyTrackResult> {
        const result = await this.request(COMPANION_COMMANDS.verifyTrack, { name, index })
        return result as unknown as VerifyTrackResult
    }

    async watch(params: CompanionWatchParams): Promise<Record<string, unknown>> {
        return this.request(COMPANION_COMMANDS.watch, params as unknown as Record<string, unknown>)
    }

    async enforceStop(): Promise<Record<string, unknown>> {
        return this.request(COMPANION_COMMANDS.enforceStop)
    }

    async events(): Promise<Record<string, unknown>> {
        return this.request(COMPANION_COMMANDS.events)
    }
}
