import { AudioTrack, type Track } from "@ableton-extensions/sdk"
import { parseQuery, selectNodes } from "@live-connector/cypher"
import { BadRequestError, toMcpError } from "@live-connector/error"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ServerDeps, TargetApiVersion } from "../deps"
import type { LomNode } from "../lom/adapter"
import { createAdapterFromDeps } from "../lom/create-adapter"
import {
    countRunningRenderJobs,
    nextRenderJobId,
    RENDER_JOB_STORE_MAX,
    setRenderJob,
} from "../render/jobs"
import { textResult } from "./common"

type RenderAudioParams = {
    select: string
    startTime: number
    endTime: number
    background: boolean | undefined
}

function validateBeatRange(start_time: number, end_time: number): void {
    if (end_time <= start_time) {
        throw new BadRequestError("endTime must be greater than startTime", {
            hint: "Pass a positive beat range, e.g. startTime:0 and endTime:16.",
        })
    }
}

function resolveSingleAudioTrack(nodes: LomNode[]): LomNode {
    if (nodes.length !== 1) {
        throw new BadRequestError(
            `render requires exactly one AudioTrack, but matched ${nodes.length}`,
            { hint: 'MATCH (t:AudioTrack {name:"Print"}) RETURN t' },
        )
    }
    const node = nodes[0]
    if (node === undefined || node.type !== "object" || !(node.value instanceof AudioTrack)) {
        throw new BadRequestError("select must return an AudioTrack")
    }
    return node
}

function trackIndex(
    tracks: Track<TargetApiVersion>[],
    track: AudioTrack<TargetApiVersion>,
): number {
    const index = tracks.findIndex((candidate) => candidate.handle === track.handle)
    if (index < 0) {
        throw new BadRequestError("selected AudioTrack is not in Song.tracks")
    }
    return index
}

export async function runRender(
    deps: ServerDeps,
    params: RenderAudioParams,
): Promise<Record<string, unknown>> {
    validateBeatRange(params.startTime, params.endTime)
    const adapter = createAdapterFromDeps(deps)
    const node = resolveSingleAudioTrack(await selectNodes(parseQuery(params.select), adapter))
    if (node.type !== "object") {
        throw new BadRequestError("select must return an AudioTrack object node")
    }
    const track = node.value as AudioTrack<TargetApiVersion>
    const track_index = trackIndex(deps.context.application.song.tracks, track)
    const track_info = { index: track_index, name: track.name, kind: "audio" as const }
    const duration = params.endTime - params.startTime
    const job_query_hint = 'Poll status with do: MATCH (j:RenderJob {id:"<jobId>"}) RETURN j'

    if (params.background === true) {
        const running_count = countRunningRenderJobs()
        if (running_count >= RENDER_JOB_STORE_MAX) {
            throw new BadRequestError(
                `${running_count} render job(s) are already running (max ${RENDER_JOB_STORE_MAX})`,
                {
                    hint: "Wait for jobs to finish or render synchronously without background:true.",
                },
            )
        }
        const job_id = nextRenderJobId()
        const job = {
            id: job_id,
            status: "running" as const,
            at: new Date().toISOString(),
            track: track_info,
            startTime: params.startTime,
            endTime: params.endTime,
            duration,
        }
        setRenderJob(job)
        deps.context.resources
            .renderPreFxAudio(track, params.startTime, params.endTime)
            .then((file_path) => {
                setRenderJob({ ...job, status: "done", filePath: file_path })
            })
            .catch((error: unknown) => {
                setRenderJob({ ...job, status: "error", error: String(error) })
                deps.log.error("render job failed", { jobId: job_id, error: String(error) })
            })
        return {
            status: "started",
            jobId: job_id,
            track: track_info,
            startTime: params.startTime,
            endTime: params.endTime,
            duration,
            hint: job_query_hint,
        }
    }

    const file_path = await deps.context.resources.renderPreFxAudio(
        track,
        params.startTime,
        params.endTime,
    )
    return {
        status: "ok",
        filePath: file_path,
        startTime: params.startTime,
        endTime: params.endTime,
        duration,
        track: track_info,
        hint: job_query_hint,
    }
}

export function registerRenderTool(server: McpServer, deps: ServerDeps): void {
    server.registerTool(
        "render",
        {
            title: "オーディオレンダリング",
            description:
                "AudioTrack の指定範囲を Pre-FX オーディオとしてレンダリングする。background:true で非同期ジョブ（RenderJob 仮想ラベルで照会）。",
            inputSchema: {
                select: z
                    .string()
                    .min(1)
                    .describe(
                        'AudioTrack を RETURN する MATCH。例: MATCH (t:AudioTrack {name:"Print"}) RETURN t',
                    ),
                startTime: z.number().min(0),
                endTime: z.number().min(0),
                background: z.boolean().optional().describe("非同期ジョブとして開始"),
            },
        },
        async ({ select, startTime, endTime, background }) => {
            try {
                return textResult(await runRender(deps, { select, startTime, endTime, background }))
            } catch (error) {
                deps.log.error("render failed", { error: String(error) })
                return textResult(toMcpError(error), true)
            }
        },
    )
}

export { clearRenderJobsForTest } from "../render/jobs"
