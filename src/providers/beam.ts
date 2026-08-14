import { withRetry } from '@/lib/retry'
import {
  buildLtxI2vWorkflow,
  resolveDimensions,
  frameCount,
  LTX_DEFAULTS,
  type LtxAspectRatio,
} from '@/lib/comfy/ltx-2-5-i2v'
import { encodeImageInput } from '@/lib/comfy/files'
import {
  comfyFileUrl,
  comfyJobInput,
  describeComfyOutput,
  normalizeComfyOutput,
  pickComfyFile,
} from '@/lib/comfy/transport'
import type { MediaProvider, GenerationResult, VideoOptions } from '@/types/provider'

/**
 * Beam adapter — the second home for CreateGent's ComfyUI graphs.
 *
 * It runs the same worker code as the RunPod endpoint (`comfy_worker/`, via
 * `beam/comfy/app.py`) and speaks the same contract, so the only real
 * differences are transport and price:
 *
 *   - Beam **task queue**, not endpoint. Beam endpoints are synchronous and
 *     capped at 180 seconds; an LTX generation is minutes. A task queue returns
 *     a `task_id` immediately and results are polled from the task API.
 *   - Results come back as **URLs**, never inline base64: the worker saves each
 *     produced file with Beam's `Output` and returns `public_url()`. There is no
 *     equivalent of RunPod's 10 MiB body limit to design around, in either
 *     direction.
 *   - Beam's RTX 5090 is ~$0.68/hr against RunPod's $0.99/hr for the same card,
 *     and the promotional credit is flagged "Serverless only" — a task queue
 *     qualifies, the Pod in `beam/ltx25/` does not. That, plus scaling to zero,
 *     is why this is a task queue and not the Pod we prototyped on.
 *
 * What has NOT been measured here is the cold start. On the ltx25 Pod a cold
 * container spent ~19 minutes reading ~40 GB of weights off the distributed
 * volume before producing anything. `keep_warm_seconds` amortizes that across a
 * working session, but an isolated job still pays it, and Beam bills every
 * second. Treat the price advantage as unproven until a warm and a cold run
 * have both been timed.
 */

const BEAM_TASK_API = 'https://api.beam.cloud/v2/task'

/** Model id -> the deployed task queue's URL, which is account-specific. */
const ENDPOINTS: Record<string, { envKey: string; gpuUsdPerSec: number }> = {
  'beam/ltx-2.5-i2v': {
    envKey: 'BEAM_COMFYUI_URL',
    // RTX 5090 at ~$0.68/hr. Beam bills per second of container life, so this
    // is only the compute half — a cold start is billed at the same rate while
    // it reads weights.
    gpuUsdPerSec: 0.000189,
  },
}

/** True for any model id this adapter handles (used by the registry to route). */
export function isBeamModel(model: string | undefined | null): boolean {
  return !!model && model.startsWith('beam/')
}

function endpointFor(model: string): { url: string; gpuUsdPerSec: number } {
  const def = ENDPOINTS[model]
  if (!def) throw new Error(`Unknown Beam model "${model}"`)

  const url = process.env[def.envKey]
  if (!url) {
    // No default is possible: a Beam URL contains the deployment's own id.
    throw new Error(
      `${def.envKey} is not set. Deploy beam/comfy/app.py and put its URL there ` +
        `(https://<id>.app.beam.cloud).`
    )
  }
  return { url: url.replace(/\/$/, ''), gpuUsdPerSec: def.gpuUsdPerSec }
}

interface BeamTaskStatus {
  id?: string
  status?: string
  started_at?: string | null
  ended_at?: string | null
  outputs?: Array<{ name?: string; url?: string }>
  /** Present when Beam echoes the handler's return value. Not relied upon. */
  result?: unknown
  output?: unknown
}

const DONE_STATUSES = new Set(['COMPLETE', 'COMPLETED', 'SUCCESS'])
const FAILED_STATUSES = new Set(['ERROR', 'FAILED', 'TIMEOUT', 'CANCELLED', 'EXPIRED'])

/** Milliseconds of container time the task consumed, or 0 when unreported. */
function executionMsOf(task: BeamTaskStatus): number {
  if (!task.started_at || !task.ended_at) return 0
  const started = Date.parse(task.started_at)
  const ended = Date.parse(task.ended_at)
  if (Number.isNaN(started) || Number.isNaN(ended)) return 0
  return Math.max(0, ended - started)
}

export class BeamAdapter implements MediaProvider {
  private token: string

  constructor(token: string) {
    this.token = token
  }

  private get headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
    }
  }

  /** Queue a task. Returns its id immediately — nothing waits on the render. */
  private async submitTask(url: string, input: Record<string, unknown>): Promise<string> {
    const submit = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(input),
    })
    if (!submit.ok) {
      throw new Error(`Beam submit failed (${submit.status}): ${await submit.text()}`)
    }

    const { task_id: taskId } = (await submit.json()) as { task_id?: string }
    if (!taskId) throw new Error('Beam accepted the task but returned no task_id')
    return taskId
  }

  /**
   * One look at a task. `null` means still working — NOT a failure.
   *
   * Separating this from the wait loop is what makes a render survive the
   * caller: an HTTP request that dies (the lab route's 300s ceiling, a closed
   * tab) no longer takes the generation with it, because the task id is enough
   * to come back for the result later.
   */
  private async checkTask(
    taskId: string
  ): Promise<{ output: Record<string, unknown>; executionMs: number } | null> {
    const res = await fetch(`${BEAM_TASK_API}/${taskId}/`, {
      headers: this.headers,
      cache: 'no-store',
    })
    if (!res.ok) {
      throw new Error(`Beam task poll failed (${res.status}): ${await res.text()}`)
    }

    const task = (await res.json()) as BeamTaskStatus
    const status = (task.status ?? '').toUpperCase()

    if (DONE_STATUSES.has(status)) {
      return { output: await this.resolveOutput(task), executionMs: executionMsOf(task) }
    }
    if (FAILED_STATUSES.has(status)) {
      throw new Error(`Beam task ${status} (${taskId})`)
    }
    return null
  }

  /** Submit and block until the task finishes. For callers that can wait. */
  private async runTask(
    url: string,
    input: Record<string, unknown>,
    opts: { timeoutMs?: number; pollMs?: number } = {}
  ): Promise<{ output: Record<string, unknown>; executionMs: number }> {
    const taskId = await this.submitTask(url, input)

    const timeoutMs = opts.timeoutMs ?? 40 * 60_000
    const pollMs = opts.pollMs ?? 5_000
    const deadline = Date.now() + timeoutMs

    for (;;) {
      const done = await this.checkTask(taskId)
      if (done) return done

      if (Date.now() > deadline) {
        // The task keeps running on Beam — name it, so the result can still be
        // collected instead of paid for and thrown away.
        throw new Error(
          `Beam task ${taskId} did not finish within ${Math.round(timeoutMs / 60_000)} min. ` +
            'It is still running; collect it with this id.'
        )
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }

  /**
   * Recovers the handler's return value from a finished task.
   *
   * Beam's task API is documented around `outputs` — the files a task saved —
   * and whether it echoes the return value is not something to bet a generation
   * on. So the worker does both: it returns the result AND saves it as
   * `result.json`. Inline first, the file as the fallback.
   */
  private async resolveOutput(task: BeamTaskStatus): Promise<Record<string, unknown>> {
    const inline = task.result ?? task.output
    if (inline && typeof inline === 'object') {
      return inline as Record<string, unknown>
    }

    const resultFile = task.outputs?.find(
      (o) => o.name === 'result.json' || o.url?.includes('result.json')
    )
    if (resultFile?.url) {
      const res = await fetch(resultFile.url)
      if (!res.ok) {
        throw new Error(`Beam task finished but result.json could not be read (${res.status})`)
      }
      return (await res.json()) as Record<string, unknown>
    }

    throw new Error(
      'Beam task finished with no readable result — neither an inline value nor a result.json output.'
    )
  }

  async generateImage(): Promise<GenerationResult> {
    // Image generation stays on Fal: no Beam image graph is deployed.
    throw new Error('Beam adapter does not provide image generation')
  }

  /** The graph settings a result needs in order to be described. */
  private videoContext(params: { duration: number; options?: VideoOptions }) {
    const opts = params.options ?? {}
    return {
      aspectRatio: (opts.aspectRatio as LtxAspectRatio) ?? '16:9 (Widescreen)',
      megapixels: opts.megapixels ?? LTX_DEFAULTS.megapixels,
      fps: opts.fps ?? LTX_DEFAULTS.fps,
      durationSec: params.duration,
    }
  }

  private async buildVideoJob(params: {
    prompt: string
    imageUrl: string
    duration: number
    options?: VideoOptions
  }): Promise<Record<string, unknown>> {
    const opts = params.options ?? {}
    const ctx = this.videoContext(params)

    const firstFrame = await encodeImageInput(params.imageUrl, 'first_frame')
    const workflow = buildLtxI2vWorkflow({
      prompt: params.prompt,
      imageName: firstFrame.name,
      aspectRatio: ctx.aspectRatio,
      megapixels: ctx.megapixels,
      durationSec: ctx.durationSec,
      fps: ctx.fps,
      seed: opts.seed,
      enhancePrompt: opts.enhancePrompt ?? LTX_DEFAULTS.enhancePrompt,
      negativePrompt: opts.negativePrompt ?? LTX_DEFAULTS.negativePrompt,
    })

    return comfyJobInput(workflow, [firstFrame], 'generic')
  }

  /** Turns a finished task's output into the result the app expects. */
  private videoResult(
    output: Record<string, unknown>,
    executionMs: number,
    params: { model: string; duration: number; options?: VideoOptions },
    gpuUsdPerSec: number
  ): GenerationResult {
    if (typeof output.error === 'string') {
      throw new Error(`Beam worker: ${output.error}`)
    }

    const result = normalizeComfyOutput(output)
    const video = pickComfyFile(result.files, 'video/')
    if (!video) {
      throw new Error(`ComfyUI returned no video — got ${describeComfyOutput(result)}`)
    }

    const ctx = this.videoContext(params)
    const extras = result.files.filter((f) => f !== video)
    const { width, height } = resolveDimensions(ctx.aspectRatio, ctx.megapixels)

    return {
      // A Beam public_url expires (an hour by default), so whatever consumes
      // this has to persist it rather than store the link.
      url: comfyFileUrl(video),
      cost: (executionMs / 1000) * gpuUsdPerSec,
      model: params.model,
      provider: 'beam',
      metadata: {
        executionMs,
        filename: video.filename,
        width,
        height,
        frames: frameCount(ctx.durationSec, ctx.fps),
        aspectRatio: ctx.aspectRatio,
        megapixels: ctx.megapixels,
        fps: ctx.fps,
        errors: result.errors.length ? result.errors : undefined,
        extraFiles: extras.length
          ? extras.map((f) => ({ filename: f.filename, mime: f.mime, size: f.size }))
          : undefined,
        values: result.values.length ? result.values : undefined,
      },
    }
  }

  /**
   * Queue a render and return its task id without waiting for it.
   *
   * This is the entry point for callers that cannot block for twenty minutes —
   * an HTTP handler with a gateway ceiling, chiefly. Pair it with
   * `collectVideo`, which can be called from a later, unrelated request.
   */
  async submitVideo(params: {
    prompt: string
    model: string
    imageUrl: string
    duration: number
    options?: VideoOptions
  }): Promise<string> {
    const { url } = endpointFor(params.model)
    const taskId = await this.submitTask(url, await this.buildVideoJob(params))
    console.log(`[beam] queued ${params.model} as task ${taskId}`)
    return taskId
  }

  /**
   * Fetch a submitted render if it has finished. `null` means still running.
   *
   * `params` has to describe the same job that was submitted — it is only used
   * to label the result (dimensions, frame count), never to re-run anything.
   */
  async collectVideo(
    taskId: string,
    params: { model: string; duration: number; options?: VideoOptions }
  ): Promise<GenerationResult | null> {
    const { gpuUsdPerSec } = endpointFor(params.model)
    const done = await this.checkTask(taskId)
    if (!done) return null
    return this.videoResult(done.output, done.executionMs, params, gpuUsdPerSec)
  }

  async generateVideo(params: {
    prompt: string
    model: string
    imageUrl: string
    width: number
    height: number
    duration: number
    format?: string
    maxAttempts?: number
    options?: VideoOptions
  }): Promise<GenerationResult> {
    const { url, gpuUsdPerSec } = endpointFor(params.model)

    // Not retried by default, for the same reason as the RunPod path: a run
    // costs minutes of GPU time and the usual cause is a deterministic graph
    // error, so a silent second attempt just doubles a real bill.
    return withRetry(async () => {
      const { output, executionMs } = await this.runTask(
        url,
        await this.buildVideoJob(params)
      )
      return this.videoResult(output, executionMs, params, gpuUsdPerSec)
    }, params.maxAttempts ?? 1)
  }

  async generateAvatarVideo(): Promise<GenerationResult> {
    // No lip-sync graph is deployed on Beam yet; avatars stay on Fal/RunPod.
    throw new Error('Beam adapter does not provide avatar generation')
  }

  /** Model ids this adapter can serve, for status readouts. */
  async listModels(): Promise<string[]> {
    return Object.keys(ENDPOINTS)
  }
}
