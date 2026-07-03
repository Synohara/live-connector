/** render ツールのジョブ状態（module singleton）。RenderJob 仮想ラベルの供給源。 */

export type RenderJobRecord = {
    id: string
    status: "running" | "done" | "error"
    at: string
    track: { index: number; name: string; kind: "audio" }
    startTime: number
    endTime: number
    duration: number
    filePath?: string
    error?: string
}

const MAX_RENDER_JOBS = 50

const render_jobs = new Map<string, RenderJobRecord>()
let render_job_counter = 0

export function nextRenderJobId(): string {
    render_job_counter = (render_job_counter + 1) % 1_000_000
    return `render-${Date.now().toString(36)}-${render_job_counter.toString(36)}`
}

export function getRenderJob(job_id: string): RenderJobRecord | undefined {
    return render_jobs.get(job_id)
}

export function setRenderJob(job: RenderJobRecord): void {
    render_jobs.set(job.id, job)
    pruneRenderJobs()
}

export function listRenderJobs(): RenderJobRecord[] {
    return [...render_jobs.values()]
}

export function countRunningRenderJobs(): number {
    let count = 0
    for (const job of render_jobs.values()) {
        if (job.status === "running") {
            count++
        }
    }
    return count
}

export function clearRenderJobsForTest(): void {
    render_jobs.clear()
}

function pruneRenderJobs(): void {
    if (render_jobs.size <= MAX_RENDER_JOBS) {
        return
    }
    for (const [job_id, job] of render_jobs) {
        if (render_jobs.size <= MAX_RENDER_JOBS) {
            break
        }
        if (job.status !== "running") {
            render_jobs.delete(job_id)
        }
    }
}

export const RENDER_JOB_STORE_MAX = MAX_RENDER_JOBS
