import { afterEach, describe, expect, it } from "vitest"
import {
    artifactUrl,
    clearArtifactsForTest,
    configureArtifactDelivery,
    matchArtifactPath,
    publishArtifact,
    resolveArtifact,
} from "./artifact-registry"

afterEach(() => {
    clearArtifactsForTest()
    configureArtifactDelivery({ enabled: false, ttlMs: 1000, host: "127.0.0.1", port: 7799 })
})

describe("artifact registry", () => {
    it("publishes a token and resolves the artifact", () => {
        configureArtifactDelivery({ enabled: true, ttlMs: 1000, host: "127.0.0.1", port: 7799 })
        const token = publishArtifact("render-1", "/tmp/audio.wav")
        expect(token).not.toBeNull()
        const resolution = resolveArtifact("render-1", token ?? "")
        expect(resolution).toEqual({
            kind: "ok",
            filePath: "/tmp/audio.wav",
            contentType: "audio/wav",
        })
    })

    it("returns null token when delivery is disabled", () => {
        configureArtifactDelivery({ enabled: false, ttlMs: 1000, host: "127.0.0.1", port: 7799 })
        expect(publishArtifact("render-1", "/tmp/audio.wav")).toBeNull()
        expect(artifactUrl("render-1", "x")).toBeNull()
    })

    it("rejects a wrong token", () => {
        configureArtifactDelivery({ enabled: true, ttlMs: 1000, host: "127.0.0.1", port: 7799 })
        publishArtifact("render-1", "/tmp/audio.wav")
        expect(resolveArtifact("render-1", "deadbeef")).toEqual({ kind: "forbidden" })
    })

    it("expires artifacts after the TTL", () => {
        configureArtifactDelivery({ enabled: true, ttlMs: 1, host: "127.0.0.1", port: 7799 })
        const token = publishArtifact("render-1", "/tmp/audio.wav") ?? ""
        const deadline = Date.now() + 5
        while (Date.now() < deadline) {
            // busy wait for TTL expiry
        }
        expect(resolveArtifact("render-1", token)).toEqual({ kind: "not_found" })
    })

    it("builds the loopback URL and matches the path", () => {
        configureArtifactDelivery({ enabled: true, ttlMs: 1000, host: "127.0.0.1", port: 7800 })
        expect(artifactUrl("render-1", "tok")).toBe(
            "http://127.0.0.1:7800/api/v1/artifacts/render-1/tok",
        )
        expect(matchArtifactPath("/api/v1/artifacts/render-1/tok")).toEqual({
            jobId: "render-1",
            token: "tok",
        })
        expect(matchArtifactPath("/api/v1/mcp")).toBeNull()
        expect(matchArtifactPath("/api/v1/artifacts/onlyjob")).toBeNull()
    })

    it("maps extensions to content types", () => {
        configureArtifactDelivery({ enabled: true, ttlMs: 1000, host: "127.0.0.1", port: 7799 })
        const token = publishArtifact("render-aiff", "/tmp/audio.aiff") ?? ""
        const resolution = resolveArtifact("render-aiff", token)
        expect(resolution.kind).toBe("ok")
        if (resolution.kind === "ok") {
            expect(resolution.contentType).toBe("audio/aiff")
        }
    })
})
