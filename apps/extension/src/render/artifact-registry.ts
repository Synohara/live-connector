/**
 * job 単位の artifact 提供レジストリ。
 * 確定したファイルだけを、推測困難なトークン付きで loopback HTTP から配信する。
 * 任意パスを読み出す API にはしない（パスはレジストリ由来のみ）。
 */

import { randomBytes } from "node:crypto"

export type ArtifactDeliveryConfig = {
    enabled: boolean
    ttlMs: number
    host: string
    port: number
}

type ArtifactEntry = {
    filePath: string
    token: string
    contentType: string
    expiresAt: number
}

const ARTIFACT_PATH_PREFIX = "/api/v1/artifacts"

const entries = new Map<string, ArtifactEntry>()
let config: ArtifactDeliveryConfig = {
    enabled: false,
    ttlMs: 3_600_000,
    host: "127.0.0.1",
    port: 7799,
}

/** HTTP サーバー起動時に配信設定を注入する。 */
export function configureArtifactDelivery(next: ArtifactDeliveryConfig): void {
    config = next
}

export function artifactDeliveryEnabled(): boolean {
    return config.enabled
}

function contentTypeFor(file_path: string): string {
    const lower = file_path.toLowerCase()
    if (lower.endsWith(".aiff") || lower.endsWith(".aif") || lower.endsWith(".aifc")) {
        return "audio/aiff"
    }
    if (lower.endsWith(".wav")) {
        return "audio/wav"
    }
    return "application/octet-stream"
}

/** ファイルを公開し、トークンを返す。無効時は null。 */
export function publishArtifact(job_id: string, file_path: string): string | null {
    if (!config.enabled) {
        return null
    }
    const token = randomBytes(24).toString("hex")
    entries.set(job_id, {
        filePath: file_path,
        token,
        contentType: contentTypeFor(file_path),
        expiresAt: Date.now() + config.ttlMs,
    })
    return token
}

export type ArtifactResolution =
    | { kind: "ok"; filePath: string; contentType: string }
    | { kind: "not_found" }
    | { kind: "forbidden" }

/** トークンを照合して artifact を解決する。期限切れは not_found。 */
export function resolveArtifact(job_id: string, token: string): ArtifactResolution {
    const entry = entries.get(job_id)
    if (entry === undefined || entry.expiresAt <= Date.now()) {
        if (entry !== undefined) {
            entries.delete(job_id)
        }
        return { kind: "not_found" }
    }
    if (!timingSafeEqual(entry.token, token)) {
        return { kind: "forbidden" }
    }
    return { kind: "ok", filePath: entry.filePath, contentType: entry.contentType }
}

/** job の配信 URL。無効時は null。 */
export function artifactUrl(job_id: string, token: string): string | null {
    if (!config.enabled) {
        return null
    }
    return `http://${config.host}:${config.port}${ARTIFACT_PATH_PREFIX}/${job_id}/${token}`
}

/** pathname を artifact 配信ルートに分解する。 */
export function matchArtifactPath(pathname: string): { jobId: string; token: string } | null {
    if (!pathname.startsWith(`${ARTIFACT_PATH_PREFIX}/`)) {
        return null
    }
    const rest = pathname.slice(ARTIFACT_PATH_PREFIX.length + 1)
    const slash = rest.indexOf("/")
    if (slash <= 0 || slash === rest.length - 1) {
        return null
    }
    return { jobId: rest.slice(0, slash), token: rest.slice(slash + 1) }
}

export function clearArtifactsForTest(): void {
    entries.clear()
}

function timingSafeEqual(left: string, right: string): boolean {
    if (left.length !== right.length) {
        return false
    }
    let diff = 0
    for (let index = 0; index < left.length; index++) {
        diff |= left.charCodeAt(index) ^ right.charCodeAt(index)
    }
    return diff === 0
}
