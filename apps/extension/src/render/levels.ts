/**
 * レベル解析（外部依存なし）。
 * - RMS dBFS: VU 相当の平均レベル。
 * - sample peak dBFS: サンプルピーク。true peak（オーバーサンプリング）は対象外。
 * チャンネルごとの Float32 サンプルから算出する。
 */

export type AudioLevels = {
    rmsDbfs: number | null
    peakDbfs: number | null
}

function dbfsFromAmplitude(amplitude: number): number | null {
    if (amplitude <= 0) {
        return null
    }
    return 20 * Math.log10(amplitude)
}

/** チャンネルごとの Float32 サンプルから RMS / sample peak を算出する。 */
export function computeLevels(channels: Float32Array[], sampleRate: number): AudioLevels {
    if (channels.length === 0 || sampleRate <= 0) {
        return { rmsDbfs: null, peakDbfs: null }
    }
    const frames = channels[0]?.length ?? 0
    if (frames === 0) {
        return { rmsDbfs: null, peakDbfs: null }
    }

    let sum_squares = 0
    let peak = 0
    for (const channel of channels) {
        for (let i = 0; i < channel.length; i++) {
            const value = channel[i] ?? 0
            sum_squares += value * value
            const magnitude = Math.abs(value)
            if (magnitude > peak) {
                peak = magnitude
            }
        }
    }
    const rms = Math.sqrt(sum_squares / (frames * channels.length))
    return {
        rmsDbfs: dbfsFromAmplitude(rms),
        peakDbfs: dbfsFromAmplitude(peak),
    }
}

/** サンプル配列のレベルを dBFS 文字列付きで要約する（ログ・応答用）。 */
export function summarizeLevels(levels: AudioLevels): string {
    const rms = levels.rmsDbfs === null ? "-inf" : levels.rmsDbfs.toFixed(2)
    const peak = levels.peakDbfs === null ? "-inf" : levels.peakDbfs.toFixed(2)
    return `rms=${rms} dBFS, peak=${peak} dBFS`
}
