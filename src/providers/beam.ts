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
 *     and Beam's promotional credit applies to serverless (a task queue scales
 *     to zero, so it qualifies — a Pod would not).
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

  /** Submit a task and poll until it finishes. Returns the handler's output. */
  private async runTask(
    url: string,
    input: Record<string, unknown>,
    opts: { timeoutMs?: number; pollMs?: number } = {}
  ): Promise<{ output: Record<string, unknown>; executionMs: number }> {
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

    const timeoutMs = opts.timeoutMs ?? 25 * 60_000
    const pollMs = opts.pollMs ?? 5_000
    const deadline = Date.now() + timeoutMs

    for (;;) {
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

      if (Date.now() > deadline) {
        throw new Error(
          `Beam task timed out after ${Math.round(timeoutMs / 1000)}s while ${status || 'PENDING'} (${taskId})`
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

    const opts = params.options ?? {}
    const aspectRatio = (opts.aspectRatio as LtxAspectRatio) ?? '16:9 (Widescreen)'
    const megapixels = opts.megapixels ?? LTX_DEFAULTS.megapixels
    const fps = opts.fps ?? LTX_DEFAULTS.fps

    const firstFrame = await encodeImageInput(params.imageUrl, 'first_frame')
    const workflow = buildLtxI2vWorkflow({
      prompt: params.prompt,
      imageName: firstFrame.name,
      aspectRatio,
      megapixels,
      durationSec: params.duration,
      fps,
      seed: opts.seed,
      enhancePrompt: opts.enhancePrompt ?? LTX_DEFAULTS.enhancePrompt,
      negativePrompt: opts.negativePrompt ?? LTX_DEFAULTS.negativePrompt,
    })

    // Not retried by default, for the same reason as the RunPod path: a run
    // costs minutes of GPU time and the usual cause is a deterministic graph
    // error, so a silent second attempt just doubles a real bill.
    return withRetry(async () => {
      const { output, executionMs } = await this.runTask(
        url,
        comfyJobInput(workflow, [firstFrame], 'generic')
      )

      if (typeof output.error === 'string') {
        throw new Error(`Beam worker: ${output.error}`)
      }

      const result = normalizeComfyOutput(output)
      const video = pickComfyFile(result.files, 'video/')
      if (!video) {
        throw new Error(`ComfyUI returned no video — got ${describeComfyOutput(result)}`)
      }

      const extras = result.files.filter((f) => f !== video)
      const { width, height } = resolveDimensions(aspectRatio, megapixels)

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
          frames: frameCount(params.duration, fps),
          aspectRatio,
          megapixels,
          fps,
          errors: result.errors.length ? result.errors : undefined,
          extraFiles: extras.length
            ? extras.map((f) => ({ filename: f.filename, mime: f.mime, size: f.size }))
            : undefined,
          values: result.values.length ? result.values : undefined,
        },
      }
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
