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
const STOP_TIMEOUT_MS = 10_000
const MEASURE_OVERHEAD_MS = 5_000
const MEASURE_SETTLE_MS = 800
const MIN_PARAMETER_STEP = 1e-4
const WRITE_TOLERANCE = 0.01
const AUTO_CREST_THRESHOLD_DB = 12
const AUTO_PEAK_OFFSET_DB = 12

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
        // 計測は Transport を占有する。再生中なら停止・録音解除してから計測する。
        try {
            transport.stop()
            await transport.waitForStopped(STOP_TIMEOUT_MS)
        } catch (error) {
            deps.log.warn("measure pre-stop failed", { error: String(error) })
        }
        try {
            await transport.setRecordMode(false)
        } catch (error) {
            deps.log.warn("measure record_mode clear failed", { error: String(error) })
        }
    }
    const samples: number[] = []
    try {
        await transport.setLoop(false)
        await transport.setPunchIn(false)
        await transport.setPunchOut(false)
        await transport.seek(0)
        transport.play()
        await transport.waitForPlaying(PLAY_TIMEOUT_MS)
        // メーターのリリース遅れで前の値が残るため、整定してから採取する。
        await sleep(MEASURE_SETTLE_MS)
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
    /** 変更前のパラメータ値（ゲイン）。 */
    originalValue: number
    measuredValueBefore: number
}

/** パラメータへ書き込み、読み戻して反映を確認する。 */
async function setParameter(parameter: ParameterHandle, value: number): Promise<void> {
    await parameter.setValue(value)
    const observed = await parameter.getValue()
    if (Math.abs(observed - value) > WRITE_TOLERANCE) {
        throw new HybridError(
            "OSC_WRITE_UNCERTAIN",
            `${parameter.label} write was not confirmed (set ${value}, read ${observed})`,
        )
    }
}

/** 単調性（値を上げるとレベルが上がる）を仮定した二分探索で目標 dB へ寄せる。
 * 傾き外挿は fader の非線形性で発散し得るため使わない。未収束時は元値へ復元する。
 * `ineffectiveHint` を渡した場合、レベルがまったく動かなければその理由を添えて失敗させる。 */
async function convergeBisection(
    deps: ServerDeps,
    parameter: ParameterHandle,
    measure: () => Promise<AudioLevels>,
    target_db: number,
    metric: "rmsDbfs" | "peakDbfs",
    ineffectiveHint?: string,
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
            originalValue: original,
        }
    }

    // 目標が現在より大きい（音を上げる）か小さい（下げる）かで探索区間を決める。
    const searching_up = before_db < target_db
    let low = searching_up ? original : parameter.min
    let high = searching_up ? parameter.max : original
    let best_level: number | null = before_db
    let best_error = Math.abs(before_db - target_db)
    let iterations = 0
    let responded = false

    for (let iteration = 1; iteration <= max_iterations; iteration++) {
        iterations = iteration
        const mid = clamp((low + high) / 2)
        if (Math.abs(high - low) < MIN_PARAMETER_STEP) {
            break
        }
        await setParameter(parameter, mid)
        await sleep(MEASURE_SETTLE_MS)
        const level = (await measure())[metric]
        const effective = finite(level)
        if (Math.abs(effective - before_db) > tolerance) {
            responded = true
        }
        const error = Math.abs(effective - target_db)
        if (error < best_error) {
            best_error = error
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
                originalValue: original,
            }
        }
        if (effective < target_db) {
            low = mid
        } else {
            high = mid
        }
    }

    // 未収束: 意図しない音の変化を残さないため、常に元の値へ復元する。
    await setParameter(parameter, original)
    if (!responded && ineffectiveHint !== undefined) {
        throw new HybridError("GAINSTAGE_NOT_CONVERGED", ineffectiveHint)
    }
    return {
        converged: false,
        iterations,
        beforeDbfs: before_db,
        afterDbfs: best_level,
        appliedValue: original,
        measuredValueBefore: original,
        originalValue: original,
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

const GAIN_PARAMETER_NAMES = ["Drive", "Input", "Input Gain", "In", "Gain", "Output", "Volume"]

/** デバイスのゲイン系パラメータを解決する。explicit 指定が無ければ候補名で探す。 */
function findGainParameter(device: Device<V>, device_name: string, explicit_name?: string) {
    if (explicit_name !== undefined && explicit_name.length > 0) {
        const named = device.parameters.find(
            (candidate) => candidate.name.toLowerCase() === explicit_name.toLowerCase(),
        )
        if (named === undefined) {
            throw new NotFoundError(
                `Device "${device_name}" has no parameter named "${explicit_name}"`,
                {
                    hint: `Available parameters: ${device.parameters.map((p) => p.name).join(", ")}`,
                },
            )
        }
        return named
    }
    for (const name of GAIN_PARAMETER_NAMES) {
        const parameter = device.parameters.find(
            (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
        )
        if (parameter !== undefined) {
            return parameter
        }
    }
    throw new NotFoundError(
        `Device "${device_name}" has no gain-like parameter (tried ${GAIN_PARAMETER_NAMES.join(", ")})`,
        { hint: `Available parameters: ${device.parameters.map((p) => p.name).join(", ")}` },
    )
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
        const metric_arg = String(args[2] ?? "auto").toLowerCase()
        if (metric_arg !== "vu" && metric_arg !== "peak" && metric_arg !== "auto") {
            throw new NotFoundError(
                `gainstage.track metric must be "vu", "peak" or "auto", received "${metric_arg}"`,
            )
        }
        const routing = deps.runtime.requireRouting()
        const index = await findTrackIndex(routing, track_name)
        const track = findTrackByName(deps, track_name)
        const volume = track.mixer.volume
        const measure = () => measureTrackMeter(deps, index, deps.runtime.gainstageMeasureBeats())

        let metric: "rmsDbfs" | "peakDbfs" = "rmsDbfs"
        let metric_label = "vu"
        let effective_target = target_db
        if (metric_arg === "peak") {
            metric = "peakDbfs"
            metric_label = "peak"
        } else if (metric_arg === "auto") {
            // クレストファクターが大きい（過渡依存の）音は PEAK を見る。
            const levels = await measure()
            const crest =
                levels.peakDbfs !== null && levels.rmsDbfs !== null
                    ? levels.peakDbfs - levels.rmsDbfs
                    : 0
            if (crest > AUTO_CREST_THRESHOLD_DB) {
                metric = "peakDbfs"
                metric_label = "peak"
                effective_target = target_db + AUTO_PEAK_OFFSET_DB
            }
        }
        const result = await convergeBisection(
            deps,
            {
                label: "Track Volume",
                min: volume.min,
                max: volume.max,
                getValue: () => volume.getValue(),
                setValue: (value) => volume.setValue(value),
            },
            measure,
            effective_target,
            metric,
        )
        return {
            ...convergenceResponse(procedure, metric_label, effective_target, result),
            metricMode: metric_label,
        }
    }

    if (procedure === "gainstage.device") {
        const track_name = String(args[0] ?? "")
        const device_name = String(args[1] ?? "")
        const target_db = Number(args[2] ?? 0)
        const metric_arg = String(args[3] ?? "auto").toLowerCase()
        const param_arg = String(args[4] ?? "")
        if (metric_arg !== "vu" && metric_arg !== "peak" && metric_arg !== "auto") {
            throw new NotFoundError(
                `gainstage.device metric must be "vu", "peak" or "auto", received "${metric_arg}"`,
            )
        }
        const routing = deps.runtime.requireRouting()
        const index = await findTrackIndex(routing, track_name)
        const track = findTrackByName(deps, track_name)
        const device = findDevice(track, device_name)
        const parameter = findGainParameter(device, device_name, param_arg)
        const measure = () => measureTrackMeter(deps, index, deps.runtime.gainstageMeasureBeats())

        let metric: "rmsDbfs" | "peakDbfs" = "rmsDbfs"
        let metric_label = "vu"
        let effective_target = target_db
        if (metric_arg === "peak") {
            metric = "peakDbfs"
            metric_label = "peak"
        } else if (metric_arg === "auto") {
            const levels = await measure()
            const crest =
                levels.peakDbfs !== null && levels.rmsDbfs !== null
                    ? levels.peakDbfs - levels.rmsDbfs
                    : 0
            if (crest > AUTO_CREST_THRESHOLD_DB) {
                metric = "peakDbfs"
                metric_label = "peak"
                effective_target = target_db + AUTO_PEAK_OFFSET_DB
            }
        }
        const result = await convergeBisection(
            deps,
            {
                label: `${device_name}.${parameter.name}`,
                min: parameter.min,
                max: parameter.max,
                getValue: () => parameter.getValue(),
                setValue: (value) => parameter.setValue(value),
            },
            measure,
            effective_target,
            metric,
            `${device_name}.${parameter.name} did not measurably change the level; on devices with Dry/Wet the dry signal bypasses the Output gain. The value was restored.`,
        )
        return {
            ...convergenceResponse(procedure, metric_label, effective_target, result),
            metricMode: metric_label,
        }
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

    if (procedure === "gainstage.chain") {
        const track_name = String(args[0] ?? "")
        const target_db = Number(args[1] ?? 0)
        const metric_arg = String(args[2] ?? "auto").toLowerCase()
        if (metric_arg !== "vu" && metric_arg !== "peak" && metric_arg !== "auto") {
            throw new NotFoundError(
                `gainstage.chain metric must be "vu", "peak" or "auto", received "${metric_arg}"`,
            )
        }
        const routing = deps.runtime.requireRouting()
        const index = await findTrackIndex(routing, track_name)
        const track = findTrackByName(deps, track_name)
        const devices = track.devices
        if (devices.length === 0) {
            throw new NotFoundError(`Track "${track_name}" has no devices`)
        }
        // 段の分離に Device On を使う。無いデバイスが1つでもあれば分離不可。
        const on_parameters = devices.map((device) =>
            device.parameters.find((candidate) => candidate.name.toLowerCase() === "device on"),
        )
        if (on_parameters.some((parameter) => parameter === undefined)) {
            throw new HybridError(
                "GAINSTAGE_NOT_CONVERGED",
                "gainstage.chain requires a 'Device On' parameter on every device to isolate stages",
            )
        }
        const handles = on_parameters as NonNullable<(typeof on_parameters)[number]>[]
        const original_on: number[] = []
        for (const handle of handles) {
            original_on.push(await handle.getValue())
        }
        const measure = () => measureTrackMeter(deps, index, deps.runtime.gainstageMeasureBeats())
        const stages: Record<string, unknown>[] = []
        try {
            for (let stage = 0; stage < devices.length; stage++) {
                const device = devices[stage]
                if (device === undefined) {
                    continue
                }
                for (let j = 0; j < handles.length; j++) {
                    await handles[j]?.setValue(j <= stage ? 1 : 0)
                }
                const gain = findGainParameter(device, device.name)
                let metric: "rmsDbfs" | "peakDbfs" = "rmsDbfs"
                let metric_label = "vu"
                let effective_target = target_db
                if (metric_arg === "peak") {
                    metric = "peakDbfs"
                    metric_label = "peak"
                } else if (metric_arg === "auto") {
                    const levels = await measure()
                    const crest =
                        levels.peakDbfs !== null && levels.rmsDbfs !== null
                            ? levels.peakDbfs - levels.rmsDbfs
                            : 0
                    if (crest > AUTO_CREST_THRESHOLD_DB) {
                        metric = "peakDbfs"
                        metric_label = "peak"
                        effective_target = target_db + AUTO_PEAK_OFFSET_DB
                    }
                }
                const result = await convergeBisection(
                    deps,
                    {
                        label: `${device.name}.${gain.name}`,
                        min: gain.min,
                        max: gain.max,
                        getValue: () => gain.getValue(),
                        setValue: (value) => gain.setValue(value),
                    },
                    measure,
                    effective_target,
                    metric,
                    `${device.name}.${gain.name} did not measurably change the stage level; the value was restored.`,
                )
                stages.push({
                    device: device.name,
                    param: gain.name,
                    metricMode: metric_label,
                    ...convergenceResponse(
                        "gainstage.chain",
                        metric_label,
                        effective_target,
                        result,
                    ),
                })
            }
        } finally {
            for (let j = 0; j < handles.length; j++) {
                try {
                    await handles[j]?.setValue(original_on[j] ?? 1)
                } catch (error) {
                    deps.log.warn("chain Device On restore failed", { error: String(error) })
                }
            }
        }
        return {
            status: "ok",
            operation: "gainstage.chain",
            effect: "runtime",
            undoable: "none",
            trackName: track_name,
            targetDb: target_db,
            stages,
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
        originalValue: result.originalValue,
        beforeDbfs: result.beforeDbfs,
        afterDbfs: result.afterDbfs,
        appliedValue: result.appliedValue,
        iterations: result.iterations,
        converged: result.converged,
        ...(result.converged
            ? {}
            : {
                  note: "Convergence did not reach the tolerance; the parameter was restored to originalValue.",
                  bestDbfs: result.afterDbfs,
              }),
    }
}

/** Main の捕捉を指標に、Main volume を二分探索で目標へ寄せる。各測定点は実時間キャプチャ。 */
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
    let last_job_id: string | undefined
    const measure = async (): Promise<AudioLevels> => {
        const job = await captureMainSync(deps, beats)
        last_job_id = job.id
        if (job.audioStatus !== "ready" || job.audio === undefined) {
            throw new HybridError(
                "GAINSTAGE_NOT_CONVERGED",
                `Main capture did not produce audio (${job.error ?? job.status})`,
            )
        }
        return { rmsDbfs: job.audio.rmsDbfs ?? null, peakDbfs: job.audio.peakDbfs ?? null }
    }
    const result = await convergeBisection(
        deps,
        {
            label: "Main Volume",
            min: volume.min,
            max: volume.max,
            getValue: () => volume.getValue(),
            setValue: (value) => volume.setValue(value),
        },
        measure,
        target_db,
        metric,
    )
    return { result, lastJobId: last_job_id }
}
