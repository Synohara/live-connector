import { describe, expect, it } from "vitest"
import { computeLevels } from "./levels"

function sine(
    frequency: number,
    amplitude: number,
    sample_rate: number,
    seconds: number,
): Float32Array {
    const frames = Math.round(sample_rate * seconds)
    const out = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
        out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sample_rate)
    }
    return out
}

describe("computeLevels", () => {
    it("reports RMS (VU) and sample peak for a 1 kHz sine", () => {
        const levels = computeLevels([sine(1000, 0.5, 48000, 1)], 48000)
        expect(levels.peakDbfs).toBeCloseTo(-6.02, 1)
        expect(levels.rmsDbfs).toBeCloseTo(-9.03, 1)
    })

    it("tracks a 6 dB level change", () => {
        const loud = computeLevels([sine(1000, 0.5, 48000, 1)], 48000)
        const quiet = computeLevels([sine(1000, 0.25, 48000, 1)], 48000)
        expect((loud.rmsDbfs ?? 0) - (quiet.rmsDbfs ?? 0)).toBeCloseTo(6.02, 1)
        expect((loud.peakDbfs ?? 0) - (quiet.peakDbfs ?? 0)).toBeCloseTo(6.02, 1)
    })

    it("returns null levels for silence", () => {
        const levels = computeLevels([new Float32Array(48000)], 48000)
        expect(levels.rmsDbfs).toBeNull()
        expect(levels.peakDbfs).toBeNull()
    })

    it("averages channel power for stereo", () => {
        const stereo = computeLevels([sine(1000, 0.5, 48000, 1), sine(1000, 0.5, 48000, 1)], 48000)
        const mono = computeLevels([sine(1000, 0.5, 48000, 1)], 48000)
        expect(stereo.rmsDbfs).toBeCloseTo(mono.rmsDbfs ?? 0, 2)
    })
})
