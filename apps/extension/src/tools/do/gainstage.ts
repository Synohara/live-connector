/**
 * ゲインステージング手続き。
 * - `gainstage.measure`: トラックのライブメーターを一定拍数ポーリングして VU(RMS)/PEAK を返す。
 * - `gainstage.track` / `gainstage.device`: ライブメーターを指標に、トラック volume / デバイス Output を目標へ収束。
 * - `gainstage.main`: Main を捕捉して RMS(VU)/PEAK を測り、Main volume を目標へ収束。
 * パラメータの値域は正規化（dB 直ではない）ため、実測の傾きから収束させる。
 */

import type { Device, Track } from "@ableton-extensions/sdk"
import type { ProcedureArgument } from "@live-connector/cypher"
import { HybridError, NotFoundError } from "@live-connector/error"
import type { ServerDeps, TargetApiVersion } from "../../deps"
import type { OscRoutingAdapter } from "../../osc/routing"
import type { AudioLevels } from "../../render/levels"
import { captureMainSync } from "../../render/resampling"

type V = TargetApiVersion

const POLL_INTERVAL_MS = 50
const PLAY_TIMEOUT_MS = 10_000
const MEASURE_OVERHEAD_MS = 5_000
const PROBE_STEP_FRACTION = 0.1
const MIN_PARAMETER_STEP = 1e-4

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function levelsToDbfs(samples: number[]): AudioLevels & { samples: number } {
    if (samples.length === 0) {
        return { rmsDbfs: null, peakDbfs: null, samples: 0 }
    }
    let sum_squares = 0
    let peak = 0
    for (const sample of samples) {
        sum_squares += sample * sample
        if (sample > peak) {
            peak = sample
        }
    }
    const rms = Math.sqrt(sum_squares / samples.length)
    return {
        rmsDbfs: rms > 0 ? 20 * Math.log10(rms) : null,
        peakDbfs: peak > 0 ? 20 * Math.log10(peak) : null,
        samples: samples.length,
    }
}

async function findTrackIndex(routing: OscRoutingAdapter, track_name: string): Promise<number> {
    const names = await routing.listTrackNames()
    const matches: number[] = []
    for (const [index, name] of names.entries()) {
        if (name === track_name) {
            matches.push(index)
        }
    }
    if (matches.length === 0) {
        throw new NotFoundError(`No track named "${track_name}" was found`, {
            hint: "Pass an exact regular-track name.",
        })
    }
    if (matches.length > 1) {
        throw new HybridError(
            "SET_IDENTITY_MISMATCH",
            `Track name "${track_name}" is not unique (${matches.length} matches)`,
        )
    }
    const index = matches[0]
    if (index === undefined) {
        throw new NotFoundError(`Track "${track_name}" index could not be resolved`)
    }
    return index
}

/** ライブメーターを拍数分ポーリングして VU(RMS)/PEAK を測る。 */
export async function measureTrackMeter(
    deps: ServerDeps,
    index: number,
    beats: number,
): Promise<AudioLevels & { samples: number }> {
    const transport = deps.runtime.requireTransport()
    const routing = deps.runtime.requireRouting()
    const before = await transport.readState()
    if (before.isPlaying || before.recordMode) {
        throw new HybridError(
            "TRANSPORT_BUSY",
            "Stop playback and recording before measuring levels",
        )
    }
    const samples: number[] = []
    try {
        await transport.setLoop(false)
        await transport.setPunchIn(false)
        await transport.setPunchOut(false)
        await transport.seek(0)
        transport.play()
        await transport.waitForPlaying(PLAY_TIMEOUT_MS)
        const beats_per_second = before.tempo > 0 ? before.tempo / 60 : 2
        const deadline = Date.now() + (beats / beats_per_second) * 1000 + MEASURE_OVERHEAD_MS
        for (;;) {
            const current = await transport.readCurrentSongTime()
            const level = await routing.getOutputMeterLevel(index)
            if (Number.isFinite(level)) {
                samples.push(Math.min(1, Math.max(0, level)))
            }
            if (current >= beats) {
                break
            }
            if (Date.now() > deadline) {
                throw new HybridError(
                    "OSC_WRITE_UNCERTAIN",
                    "Level measurement exceeded its real-time budget",
                )
            }
            await sleep(POLL_INTERVAL_MS)
        }
    } finally {
        try {
            transport.stop()
        } catch (error) {
            deps.log.warn("measure stop failed", { error: String(error) })
        }
        try {
            await transport.setLoop(before.loop)
            await transport.setPunchIn(before.punchIn)
            await transport.setPunchOut(before.punchOut)
            await transport.seek(before.currentSongTime)
        } catch (error) {
            deps.log.warn("measure restore failed", { error: String(error) })
        }
    }
    return levelsToDbfs(samples)
}

type ParameterHandle = {
    label: string
    min: number
    max: number
    getValue: () => Promise<number>
    setValue: (value: number) => Promise<void>
}

export type ConvergenceResult = {
    converged: boolean
    iterations: number
    beforeDbfs: number | null
    afterDbfs: number | null
    appliedValue: number
    measuredValueBefore: number
}

/** 単調性（値を上げるとレベルが上がる）を仮定した二分探索で目標 dB へ寄せる。
 * 傾き外挿は fader の非線形性で発散し得るため使わない。未収束時は元値へ復元する。 */
async function convergeParameter(
    deps: ServerDeps,
    parameter: ParameterHandle,
    measure: () => Promise<AudioLevels>,
    target_db: number,
    metric: "rmsDbfs" | "peakDbfs",
): Promise<ConvergenceResult> {
    const tolerance = deps.runtime.gainstageToleranceDb()
    const max_iterations = deps.runtime.gainstageMaxIterations()
    const clamp = (value: number) => Math.min(parameter.max, Math.max(parameter.min, value))
    const finite = (value: number | null): number =>
        value === null ? Number.NEGATIVE_INFINITY : value

    const original = clamp(await parameter.getValue())
    const initial = (await measure())[metric]
    const before_db = initial
    if (before_db === null) {
        throw new HybridError(
            "GAINSTAGE_NOT_CONVERGED",
            "No measurable signal was detected during the measurement window",
        )
    }
    if (Math.abs(before_db - target_db) <= tolerance) {
        return {
            converged: true,
            iterations: 0,
            beforeDbfs: before_db,
            afterDbfs: before_db,
            appliedValue: original,
            measuredValueBefore: original,
        }
    }

    // 目標が現在より大きい（音を上げる）か小さい（下げる）かで探索区間を決める。
    const searching_up = before_db < target_db
    let low = searching_up ? original : parameter.min
    let high = searching_up ? parameter.max : original
    let best_value = original
    let best_level: number | null = before_db
    let best_error = Math.abs(before_db - target_db)
    let iterations = 0

    for (let iteration = 1; iteration <= max_iterations; iteration++) {
        iterations = iteration
        const mid = clamp((low + high) / 2)
        if (Math.abs(high - low) < MIN_PARAMETER_STEP) {
            break
        }
        await parameter.setValue(mid)
        const level = (await measure())[metric]
        const effective = finite(level)
        const error = Math.abs(effective - target_db)
        if (error < best_error) {
            best_error = error
            best_value = mid
            best_level = level
        }
        if (Math.abs(effective - target_db) <= tolerance) {
            return {
                converged: true,
                iterations,
                beforeDbfs: before_db,
                afterDbfs: level,
                appliedValue: mid,
                measuredValueBefore: original,
            }
        }
        if (effective < target_db) {
            low = mid
        } else {
            high = mid
        }
    }

    // 未収束: 元より目標に近ければその値を残し、そうでなければ元値へ戻す。
    const improved = best_error < Math.abs(before_db - target_db)
    if (!improved) {
        await parameter.setValue(original)
        return {
            converged: false,
            iterations,
            beforeDbfs: before_db,
            afterDbfs: before_db,
            appliedValue: original,
            measuredValueBefore: original,
        }
    }
    return {
        converged: false,
        iterations,
        beforeDbfs: before_db,
        afterDbfs: best_level,
        appliedValue: best_value,
        measuredValueBefore: original,
    }
}

function findDevice(track: Track<V>, device_name: string): Device<V> {
    const device = track.devices.find((candidate) => candidate.name === device_name)
    if (device === undefined) {
        throw new NotFoundError(`Device "${device_name}" was not found on track "${track.name}"`, {
            hint: `Available devices: ${track.devices.map((candidate) => candidate.name).join(", ") || "(none)"}`,
        })
    }
    return device
}

function findGainParameter(device: Device<V>, device_name: string) {
    const preferred = ["Output", "Gain", "Volume"]
    for (const name of preferred) {
        const parameter = device.parameters.find(
            (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
        )
        if (parameter !== undefined) {
            return parameter
        }
    }
    throw new NotFoundError(`Device "${device_name}" has no Output/Gain/Volume parameter`, {
        hint: `Available parameters: ${device.parameters
            .map((candidate) => candidate.name)
            .join(", ")}`,
    })
}

function findTrackByName(deps: ServerDeps, track_name: string): Track<V> {
    const track = deps.context.application.song.tracks.find(
        (candidate) => candidate.name === track_name,
    )
    if (track === undefined) {
        throw new NotFoundError(`Track "${track_name}" was not found`)
    }
    return track
}

export async function executeGainstage(
    deps: ServerDeps,
    procedure: string,
    args: ProcedureArgument[],
): Promise<Record<string, unknown>> {
    if (procedure === "gainstage.measure") {
        const track_name = String(args[0] ?? "")
        const beats = Number(args[1] ?? 0)
        const routing = deps.runtime.requireRouting()
        const index = await findTrackIndex(routing, track_name)
        const levels = await measureTrackMeter(deps, index, beats)
        return {
            status: "ok",
            operation: procedure,
            effect: "runtime",
            undoable: "none",
            trackName: track_name,
            trackIndex: index,
            beats,
            metric: "vu",
            rmsDbfs: levels.rmsDbfs,
            peakDbfs: levels.peakDbfs,
            samples: levels.samples,
        }
    }

    if (procedure === "gainstage.track") {
        const track_name = String(args[0] ?? "")
        const target_db = Number(args[1] ?? 0)
        const routing = deps.runtime.requireRouting()
        const index = await findTrackIndex(routing, track_name)
        const track = findTrackByName(deps, track_name)
        const volume = track.mixer.volume
        const result = await convergeParameter(
            deps,
            {
                label: "Track Volume",
                min: volume.min,
                max: volume.max,
                getValue: () => volume.getValue(),
                setValue: (value) => volume.setValue(value),
            },
            () => measureTrackMeter(deps, index, deps.runtime.gainstageMeasureBeats()),
            target_db,
            "rmsDbfs",
        )
        return convergenceResponse(procedure, "vu", target_db, result)
    }

    if (procedure === "gainstage.device") {
        const track_name = String(args[0] ?? "")
        const device_name = String(args[1] ?? "")
        const target_db = Number(args[2] ?? 0)
        const routing = deps.runtime.requireRouting()
        const index = await findTrackIndex(routing, track_name)
        const track = findTrackByName(deps, track_name)
        const device = findDevice(track, device_name)
        const parameter = findGainParameter(device, device_name)
        const result = await convergeParameter(
            deps,
            {
                label: `${device_name}.${parameter.name}`,
                min: parameter.min,
                max: parameter.max,
                getValue: () => parameter.getValue(),
                setValue: (value) => parameter.setValue(value),
            },
            () => measureTrackMeter(deps, index, deps.runtime.gainstageMeasureBeats()),
            target_db,
            "rmsDbfs",
        )
        return convergenceResponse(procedure, "vu", target_db, result)
    }

    if (procedure === "gainstage.main") {
        const metric_arg = String(args[0] ?? "vu").toLowerCase()
        if (metric_arg !== "vu" && metric_arg !== "peak") {
            throw new NotFoundError(
                `gainstage.main metric must be "vu" or "peak", received "${metric_arg}"`,
            )
        }
        const metric: "rmsDbfs" | "peakDbfs" = metric_arg === "vu" ? "rmsDbfs" : "peakDbfs"
        const target_db = Number(args[1] ?? 0)
        const beats = Number(args[2] ?? 0)
        const main_track = deps.context.application.song.mainTrack
        const volume = main_track.mixer.volume
        const result = await convergeMain(deps, volume, target_db, beats, metric)
        return {
            ...convergenceResponse("gainstage.main", metric_arg, target_db, result.result),
            lastJobId: result.lastJobId,
        }
    }

    throw new NotFoundError(`Procedure "${procedure}" is not implemented`)
}

function convergenceResponse(
    operation: string,
    metric: string,
    target_db: number,
    result: ConvergenceResult,
): Record<string, unknown> {
    return {
        status: result.converged ? "ok" : "not_converged",
        operation,
        effect: "runtime",
        undoable: "none",
        metric,
        targetDb: target_db,
        beforeDbfs: result.beforeDbfs,
        afterDbfs: result.afterDbfs,
        appliedValue: result.appliedValue,
        iterations: result.iterations,
        converged: result.converged,
        ...(result.converged
            ? {}
            : {
                  note: "Convergence did not reach the tolerance; the value was left at the last step.",
              }),
    }
}

/** Main の捕捉を繰り返して Main volume を収束させる。 */
async function convergeMain(
    deps: ServerDeps,
    volume: {
        min: number
        max: number
        getValue(): Promise<number>
        setValue(v: number): Promise<void>
    },
    target_db: number,
    beats: number,
    metric: "rmsDbfs" | "peakDbfs",
): Promise<{ result: ConvergenceResult; lastJobId: string | undefined }> {
    const tolerance = deps.runtime.gainstageToleranceDb()
    const max_iterations = deps.runtime.gainstageMaxIterations()
    const clamp = (value: number) => Math.min(volume.max, Math.max(volume.min, value))
    let value = clamp(await volume.getValue())
    let last_job_id: string | undefined

    const measure = async (): Promise<{ levels: AudioLevels; jobId: string }> => {
        const job = await captureMainSync(deps, beats)
        last_job_id = job.id
        if (job.audioStatus !== "ready" || job.audio === undefined) {
            throw new HybridError(
                "GAINSTAGE_NOT_CONVERGED",
                `Main capture did not produce audio (${job.error ?? job.status})`,
            )
        }
        return {
            levels: { rmsDbfs: job.audio.rmsDbfs ?? null, peakDbfs: job.audio.peakDbfs ?? null },
            jobId: job.id,
        }
    }

    const initial = await measure()
    let measured = initial.levels[metric]
    const before_db = measured
    if (measured === null) {
        throw new HybridError(
            "GAINSTAGE_NOT_CONVERGED",
            "Main capture produced silence during the measurement",
        )
    }
    if (Math.abs(measured - target_db) <= tolerance) {
        return {
            result: {
                converged: true,
                iterations: 0,
                beforeDbfs: before_db,
                afterDbfs: measured,
                appliedValue: value,
                measuredValueBefore: value,
            },
            lastJobId: last_job_id,
        }
    }

    const step = Math.max(MIN_PARAMETER_STEP, (volume.max - volume.min) * PROBE_STEP_FRACTION)
    const probe_value = clamp(value + step)
    if (Math.abs(probe_value - value) < MIN_PARAMETER_STEP) {
        throw new HybridError("GAINSTAGE_NOT_CONVERGED", "Main volume cannot be adjusted")
    }
    await volume.setValue(probe_value)
    const probed = await measure()
    if (probed.levels[metric] === null) {
        throw new HybridError("GAINSTAGE_NOT_CONVERGED", "The Main probe produced silence")
    }
    const slope = ((probed.levels[metric] ?? 0) - measured) / (probe_value - value)
    if (!Number.isFinite(slope) || Math.abs(slope) < 1e-6) {
        throw new HybridError(
            "GAINSTAGE_NOT_CONVERGED",
            "Main volume did not change the measured level",
        )
    }
    value = probe_value
    measured = probed.levels[metric]

    for (let iteration = 1; iteration <= max_iterations; iteration++) {
        if (Math.abs((measured ?? target_db) - target_db) <= tolerance) {
            return {
                result: {
                    converged: true,
                    iterations: iteration,
                    beforeDbfs: before_db,
                    afterDbfs: measured,
                    appliedValue: value,
                    measuredValueBefore: value,
                },
                lastJobId: last_job_id,
            }
        }
        const next = clamp(value + (target_db - (measured ?? target_db)) / slope)
        if (Math.abs(next - value) < MIN_PARAMETER_STEP) {
            break
        }
        await volume.setValue(next)
        const measured_next = await measure()
        value = next
        measured = measured_next.levels[metric]
        if (measured === null) {
            throw new HybridError("GAINSTAGE_NOT_CONVERGED", "The adjusted Main capture was silent")
        }
    }
    return {
        result: {
            converged: false,
            iterations: max_iterations,
            beforeDbfs: before_db,
            afterDbfs: measured,
            appliedValue: value,
            measuredValueBefore: value,
        },
        lastJobId: last_job_id,
    }
}
