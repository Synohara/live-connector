/**
 * `meta` が返す capabilities / runtime の構築。
 * 未接続・未検証・ポート競合では available:false と理由を返す。
 */

import type { CaptureValidationLevel } from "../types/hybrid"

/** capabilities 構築の入力。 */
export type CapabilitiesInput = {
    oscEnabled: boolean
    oscConnected: boolean
    oscReason: string | undefined
    maxCaptureBeats: number
    maxArtifactBytes: number
    validationLevel: CaptureValidationLevel
    validationId: string | undefined
    gainstageMeasureBeats: number
    gainstageMaxIterations: number
    gainstageToleranceDb: number
}

/** `render.mainOutput` の能力記述。 */
export type MainOutputCapability = {
    available: boolean
    method: "realtime-resampling"
    reason?: string
    requiresConfirmation: true
    requiresStoppedTransport: true
    timeUnit: "quarter-note-beats"
    supportsIsolatedTail: false
    supportsOffline: false
}

/** `render` の能力記述。 */
export type RenderCapabilities = {
    audioTrackPreFx: { available: true; method: "sdk-pre-fx" }
    mainOutput: MainOutputCapability
}

/** `runtime` の記述。 */
export type RuntimeCapabilities = {
    osc: { connected: boolean; reason?: string }
    capturePairing: "verified-on-job-start"
    realtimeRenderLimit: 1
    maxCaptureBeats: number
    maxArtifactBytes: number
    validationLevel: CaptureValidationLevel
    validationId?: string
    meter: { available: boolean; method: "abletonosc-output-meter"; reason?: string }
    gainstage: {
        available: boolean
        metrics: ["vu", "peak"]
        targets: ["track-volume", "device-output", "main"]
        measureBeats: number
        maxIterations: number
        toleranceDb: number
    }
}

export function buildRenderCapabilities(input: CapabilitiesInput): RenderCapabilities {
    const available = input.oscEnabled && input.oscConnected
    const main_output: MainOutputCapability = {
        available,
        method: "realtime-resampling",
        requiresConfirmation: true,
        requiresStoppedTransport: true,
        timeUnit: "quarter-note-beats",
        supportsIsolatedTail: false,
        supportsOffline: false,
    }
    if (!available) {
        main_output.reason = input.oscReason ?? "AbletonOSC is not connected"
    }
    return {
        audioTrackPreFx: { available: true, method: "sdk-pre-fx" },
        mainOutput: main_output,
    }
}

export function buildRuntimeCapabilities(input: CapabilitiesInput): RuntimeCapabilities {
    const osc: { connected: boolean; reason?: string } = { connected: input.oscConnected }
    if (!input.oscConnected) {
        osc.reason = input.oscReason ?? "AbletonOSC is not connected"
    }
    const meter: RuntimeCapabilities["meter"] = {
        available: input.oscConnected,
        method: "abletonosc-output-meter",
    }
    if (!input.oscConnected) {
        meter.reason = input.oscReason ?? "AbletonOSC is not connected"
    }
    return {
        osc,
        capturePairing: "verified-on-job-start",
        realtimeRenderLimit: 1,
        maxCaptureBeats: input.maxCaptureBeats,
        maxArtifactBytes: input.maxArtifactBytes,
        validationLevel: input.validationLevel,
        ...(input.validationId !== undefined ? { validationId: input.validationId } : {}),
        meter,
        gainstage: {
            available: input.oscConnected,
            metrics: ["vu", "peak"],
            targets: ["track-volume", "device-output", "main"],
            measureBeats: input.gainstageMeasureBeats,
            maxIterations: input.gainstageMaxIterations,
            toleranceDb: input.gainstageToleranceDb,
        },
    }
}
