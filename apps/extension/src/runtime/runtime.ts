/**
 * Shared Hybrid Runtime。activation 単位の singleton として生成し、
 * OSC 接続・Transport / routing adapter・lock・resolver を保持する。
 * HTTP リクエスト単位や MCP セッション単位で socket を bind しない。
 */

import type { Env } from "@live-connector/env"
import { HybridError } from "@live-connector/error"
import type { Logger } from "@live-connector/log"
import { createDgramTransport, OscClient, type OscDatagramTransport } from "../osc/client"
import { OscRoutingAdapter } from "../osc/routing"
import { OscTransportAdapter } from "../osc/transport"
import type { CaptureValidationLevel, OscSettings } from "../types/hybrid"
import {
    buildRenderCapabilities,
    buildRuntimeCapabilities,
    type RenderCapabilities,
    type RuntimeCapabilities,
} from "./capabilities"
import { RuntimeLocks } from "./locks"
import { CaptureResolver } from "./resolver"

/** OSC トランスポートの生成を差し替えるためのフック（テスト用）。 */
export type RuntimeOptions = {
    transportFactory?: (settings: OscSettings, log: Logger) => OscDatagramTransport
}

/** activation 単位で共有する Hybrid Runtime。 */
export class HybridRuntime {
    readonly settings: OscSettings
    readonly locks: RuntimeLocks

    private readonly log: Logger
    private readonly env: Env
    private readonly options: RuntimeOptions
    private client: OscClient | null = null
    private transport_adapter: OscTransportAdapter | null = null
    private routing_adapter: OscRoutingAdapter | null = null
    private capture_resolver: CaptureResolver | null = null
    private osc_error: string | undefined
    private started = false

    constructor(env: Env, log: Logger, options: RuntimeOptions = {}) {
        this.env = env
        this.log = log
        this.options = options
        this.locks = new RuntimeLocks()
        this.settings = {
            enabled: env.LIVE_CONNECTOR_OSC_ENABLED,
            host: env.LIVE_CONNECTOR_OSC_HOST,
            sendPort: env.LIVE_CONNECTOR_OSC_SEND_PORT,
            replyPort: env.LIVE_CONNECTOR_OSC_REPLY_PORT,
            timeoutMs: env.LIVE_CONNECTOR_OSC_TIMEOUT_MS,
        }
    }

    /**
     * OSC を起動する。OSC 無効・接続失敗でも例外を投げず、capabilities へ理由を残す。
     * 従来の SDK 機能は OSC 未接続でも動作する。
     */
    async start(): Promise<void> {
        if (this.started) {
            return
        }
        this.started = true
        if (!this.settings.enabled) {
            this.osc_error = "AbletonOSC integration is disabled by configuration"
            return
        }
        try {
            const transport = this.createTransport()
            const client = new OscClient(transport, this.settings, this.log)
            await client.start()
            this.client = client
            this.transport_adapter = new OscTransportAdapter(client)
            this.routing_adapter = new OscRoutingAdapter(client)
            this.capture_resolver = new CaptureResolver(this.routing_adapter)
            this.osc_error = undefined
            this.log.info("OSC client connected", {
                host: this.settings.host,
                sendPort: this.settings.sendPort,
                replyPort: this.settings.replyPort,
            })
        } catch (error) {
            this.osc_error = error instanceof Error ? error.message : String(error)
            this.log.warn("OSC client unavailable; only SDK features are active", {
                error: this.osc_error,
            })
            this.client = null
            this.transport_adapter = null
            this.routing_adapter = null
            this.capture_resolver = null
        }
    }

    /** listener と socket を解放する。 */
    async dispose(): Promise<void> {
        if (this.client !== null) {
            await this.client.stop()
        }
        this.client = null
        this.transport_adapter = null
        this.routing_adapter = null
        this.capture_resolver = null
        this.started = false
    }

    oscEnabled(): boolean {
        return this.settings.enabled
    }

    oscConnected(): boolean {
        return this.client?.isStarted() ?? false
    }

    oscReason(): string | undefined {
        return this.osc_error
    }

    validationLevel(): CaptureValidationLevel {
        return this.env.LIVE_CONNECTOR_CAPTURE_VALIDATION_LEVEL
    }

    maxCaptureBeats(): number {
        return this.env.LIVE_CONNECTOR_MAX_CAPTURE_BEATS
    }

    maxArtifactBytes(): number {
        return this.env.LIVE_CONNECTOR_MAX_ARTIFACT_BYTES
    }

    planTtlMs(): number {
        return this.env.LIVE_CONNECTOR_PLAN_TTL_MS
    }

    /** Transport adapter を返す。未接続なら OSC_UNAVAILABLE。 */
    requireTransport(): OscTransportAdapter {
        if (this.transport_adapter === null) {
            throw new HybridError(
                "OSC_UNAVAILABLE",
                this.osc_error ?? "AbletonOSC is not connected",
            )
        }
        return this.transport_adapter
    }

    /** Routing adapter を返す。未接続なら OSC_UNAVAILABLE。 */
    requireRouting(): OscRoutingAdapter {
        if (this.routing_adapter === null) {
            throw new HybridError(
                "OSC_UNAVAILABLE",
                this.osc_error ?? "AbletonOSC is not connected",
            )
        }
        return this.routing_adapter
    }

    /** Capture resolver を返す。未接続なら OSC_UNAVAILABLE。 */
    requireResolver(): CaptureResolver {
        if (this.capture_resolver === null) {
            throw new HybridError(
                "OSC_UNAVAILABLE",
                this.osc_error ?? "AbletonOSC is not connected",
            )
        }
        return this.capture_resolver
    }

    capabilities(): { render: RenderCapabilities; runtime: RuntimeCapabilities } {
        const input = {
            oscEnabled: this.settings.enabled,
            oscConnected: this.oscConnected(),
            oscReason: this.osc_error,
            maxCaptureBeats: this.maxCaptureBeats(),
            maxArtifactBytes: this.maxArtifactBytes(),
            validationLevel: this.validationLevel(),
            validationId: this.env.LIVE_CONNECTOR_CAPTURE_VALIDATION_ID,
        }
        return {
            render: buildRenderCapabilities(input),
            runtime: buildRuntimeCapabilities(input),
        }
    }

    private createTransport(): OscDatagramTransport {
        if (this.options.transportFactory !== undefined) {
            return this.options.transportFactory(this.settings, this.log)
        }
        return createDgramTransport(this.settings, this.log)
    }
}
