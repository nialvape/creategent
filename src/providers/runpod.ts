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
  type ComfyContract,
} from '@/lib/comfy/transport'
import type {
  MediaProvider,
  AudioProvider,
  GenerationResult,
  VideoOptions,
} from '@/types/provider'

/**
 * RunPod Serverless adapter. The user hosts their own GPU models on RunPod
 * serverless endpoints loaded from a network volume. Two handler protocols are
 * in play, which is what `kind` below distinguishes:
 *
 *   kind 'simple' — a purpose-built handler with a flat JSON contract:
 *     wan i2v     in  { prompt, image_url, width, height, duration } -> { video_b64 }
 *     chatterbox  in  { text, reference_audio_b64? }                 -> { audio_b64, sample_rate }
 *     musetalk    in  { image_url, audio_b64 }                       -> { video_b64 }
 *
 *   kind 'comfy' — a ComfyUI worker, which takes an entire API-format graph
 *     plus its input files. The shape lives in `@/lib/comfy/transport`, and is
 *     shared with the Beam backend running the same worker code. It tolerates
 *     the stock runpod/worker-comfyui handler too, which understands only
 *     `images` in both directions.
 *
 * Endpoints are async: POST /run returns a job id, then we poll /status/{id}
 * until COMPLETED. Cost is billed per GPU-second, so we derive actual_cost from
 * the `executionTime` RunPod reports rather than a fixed per-asset price.
 */

const RUNPOD_BASE = 'https://api.runpod.ai/v2'

/** RunPod rejects a larger /run body with a 400 before the worker ever sees it. */
const RUNPOD_MAX_BODY_BYTES = 10 * 1024 * 1024

interface EndpointDef {
  envKey: string
  defaultId: string
  gpuUsdPerSec: number
  kind: 'simple' | 'comfy'
  /** Which worker build is deployed there. Only meaningful when kind is 'comfy'. */
  contract?: ComfyContract
}

// Model id -> serverless endpoint id. Overridable via env so the ids aren't
// baked into source (the defaults are the user's current endpoints).
const ENDPOINTS: Record<string, EndpointDef> = {
  'runpod/ltx-2.5-i2v': {
    envKey: 'RUNPOD_COMFYUI_ENDPOINT_ID',
    // EUR-IS-1, pool ADA_32_PRO, weights on creategent-models-is1.
    defaultId: 'z8tadmgfo6gdvs',
    // RTX 5090 at $0.99/hr. The endpoint is pinned to that single pool on
    // purpose: with BLACKWELL_96 also allowed, RunPod kept picking the RTX PRO
    // 6000 at $2.09/hr. Re-add that pool only alongside a rate change here.
    gpuUsdPerSec: 0.000275,
    kind: 'comfy',
    // The deployed image still carries the stock handler. Flip to 'generic'
    // (or set RUNPOD_COMFYUI_CONTRACT=generic) once the endpoint has rebuilt
    // from runpod/comfyui/Dockerfile — until then, audio and text outputs are
    // dropped by the worker no matter what the app asks for.
    contract: 'legacy',
  },
  'runpod/wan-2.6-i2v': {
    envKey: 'RUNPOD_WAN_ENDPOINT_ID',
    // NOTE: this endpoint no longer exists — it was torn down along with the
    // US-NE-1 volume. Set RUNPOD_WAN_ENDPOINT_ID to a live one before using
    // this model, or it will fail with a 404 from /run.
    defaultId: 'vnnxonpsh1y7r8',
    gpuUsdPerSec: 0.00116, // ~H100 80GB serverless flex
    kind: 'simple',
  },
  'runpod/chatterbox': {
    envKey: 'RUNPOD_CHATTERBOX_ENDPOINT_ID',
    defaultId: 'ihl391rbv6ihr7',
    gpuUsdPerSec: 0.00016, // ~16GB-tier GPU (RTX 4090)
    kind: 'simple',
  },
  'runpod/musetalk': {
    envKey: 'RUNPOD_MUSETALK_ENDPOINT_ID',
    // NOTE: never deployed — no endpoint with this id exists on the account.
    defaultId: 'ebkllrlml5kij3',
    gpuUsdPerSec: 0.00031, // ~RTX 4090
    kind: 'simple',
  },
}

/** True for any model id this adapter handles (used by the registry to route). */
export function isRunPodModel(model: string | undefined | null): boolean {
  return !!model && model.startsWith('runpod/')
}

/**
 * Endpoint id backing the self-hosted video model, for status readouts that
 * need to check worker availability without going through a generation.
 */
export function videoEndpointId(): string {
  const def = ENDPOINTS['runpod/ltx-2.5-i2v']
  return process.env[def.envKey] || def.defaultId
}

function endpointFor(model: string): {
  id: string
  gpuUsdPerSec: number
  kind: EndpointDef['kind']
  contract: ComfyContract
} {
  const def = ENDPOINTS[model]
  if (!def) throw new Error(`Unknown RunPod model "${model}"`)
  const id = process.env[def.envKey] || def.defaultId
  // Env override so the app can follow a worker rebuild without a code deploy.
  const contract: ComfyContract =
    process.env.RUNPOD_COMFYUI_CONTRACT === 'generic'
      ? 'generic'
      : def.contract ?? 'legacy'
  return { id, gpuUsdPerSec: def.gpuUsdPerSec, kind: def.kind, contract }
}

interface RunStatus {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT'
  output?: Record<string, unknown>
  error?: string
  executionTime?: number // ms of GPU time, present once COMPLETED
}

interface WorkerCounts {
  idle?: number
  initializing?: number
  ready?: number
  running?: number
  throttled?: number
  unhealthy?: number
}

/**
 * How long a job may sit IN_QUEUE before we look at why. Cold starts on these
 * endpoints legitimately take minutes (the worker pulls a multi-GB image), so
 * this only needs to be long enough that a worker which *is* coming has been
 * reported as `initializing`.
 */
const QUEUE_DIAGNOSIS_AFTER_MS = 60_000

/**
 * Turns worker counts into the reason a job is stuck, or null when the queue is
 * healthy and the caller should keep waiting.
 *
 * The distinction matters because the fixes are opposites: throttled/absent
 * workers mean the endpoint's GPU pool has no capacity in its datacenter (wait,
 * or widen the pool), while unhealthy ones mean the container itself is
 * crash-looping and no amount of waiting will help.
 */
function diagnoseQueue(w: WorkerCounts): string | null {
  const unhealthy = w.unhealthy ?? 0
  const throttled = w.throttled ?? 0
  const live = (w.idle ?? 0) + (w.ready ?? 0) + (w.running ?? 0) + (w.initializing ?? 0)

  if (unhealthy > 0 && live === 0) {
    return `the worker is crash-looping (${unhealthy} unhealthy). The container fails before the handler starts — check the worker logs in the RunPod console.`
  }
  if (throttled > 0) {
    return `no GPU capacity (${throttled} worker${throttled > 1 ? 's' : ''} throttled). The endpoint's GPU pool has nothing free in its datacenter right now.`
  }
  if (live === 0) {
    return 'no worker could be allocated. The endpoint\'s GPU pool has no capacity in the datacenter its network volume is pinned to.'
  }
  return null
}

export class RunPodAdapter implements MediaProvider, AudioProvider {
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  private get headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    }
  }

  /** Queue a job. Returns its id immediately — nothing waits on the render. */
  private async submitJob(
    endpointId: string,
    input: Record<string, unknown>
  ): Promise<string> {
    const body = JSON.stringify({ input })
    const bodyBytes = Buffer.byteLength(body)
    if (bodyBytes > RUNPOD_MAX_BODY_BYTES) {
      // RunPod's own message names the limit but not what filled it, and the
      // request is one big base64 blob either way.
      throw new Error(
        `Payload is ${(bodyBytes / 1024 / 1024).toFixed(1)} MB, over RunPod's 10 MiB limit for /run. ` +
          'The attached media is too large to send inline.'
      )
    }

    const submit = await fetch(`${RUNPOD_BASE}/${endpointId}/run`, {
      method: 'POST',
      headers: this.headers,
      body,
    })
    if (!submit.ok) {
      throw new Error(`RunPod /run failed (${submit.status}): ${await submit.text()}`)
    }
    const { id } = (await submit.json()) as { id?: string }
    if (!id) throw new Error('RunPod /run returned no job id')
    return id
  }

  /**
   * One look at a job. `null` means still working — NOT a failure.
   *
   * Separating this from the wait loop is what lets a render outlive the
   * request that started it: an HTTP handler with a gateway ceiling can submit,
   * hand back the id, and collect the result from a later request instead of
   * paying for GPU time nobody is left to receive.
   *
   * `queuedForMs` is how long the caller has been waiting overall. It only
   * gates the capacity diagnosis, which would otherwise cry "no workers" about
   * a job that was submitted four seconds ago.
   */
  private async checkJob(
    endpointId: string,
    jobId: string,
    opts: { queuedForMs?: number; cancelOnFailure?: boolean } = {}
  ): Promise<{ output: Record<string, unknown>; executionMs: number } | null> {
    const res = await fetch(`${RUNPOD_BASE}/${endpointId}/status/${jobId}`, {
      headers: this.headers,
      cache: 'no-store',
    })
    if (!res.ok) {
      throw new Error(`RunPod /status failed (${res.status}): ${await res.text()}`)
    }
    const body = (await res.json()) as RunStatus

    if (body.status === 'COMPLETED') {
      if (!body.output) throw new Error('RunPod job completed but returned no output')
      return { output: body.output, executionMs: body.executionTime ?? 0 }
    }
    if (body.status === 'FAILED' || body.status === 'CANCELLED' || body.status === 'TIMED_OUT') {
      throw new Error(`RunPod job ${body.status}: ${body.error ?? 'no error detail'}`)
    }

    // A job that never leaves the queue looks identical to a slow one until the
    // timeout fires. Ask the endpoint why, so the caller gets "no GPU capacity"
    // in a minute instead of a bare timeout much later.
    if (body.status === 'IN_QUEUE' && (opts.queuedForMs ?? 0) > QUEUE_DIAGNOSIS_AFTER_MS) {
      const workers = await this.workerCounts(endpointId)
      const reason = workers && diagnoseQueue(workers)
      if (reason) {
        if (opts.cancelOnFailure !== false) await this.cancelJob(endpointId, jobId)
        throw new Error(`RunPod endpoint can't run this job: ${reason}`)
      }
    }

    return null
  }

  /** Submit and block until the job finishes. For callers that can wait. */
  private async runJob(
    endpointId: string,
    input: Record<string, unknown>,
    opts: { timeoutMs?: number; pollMs?: number } = {}
  ): Promise<{ output: Record<string, unknown>; executionMs: number }> {
    const id = await this.submitJob(endpointId, input)

    const timeoutMs = opts.timeoutMs ?? 5 * 60_000
    const pollMs = opts.pollMs ?? 3_000
    const startedAt = Date.now()
    const deadline = startedAt + timeoutMs

    for (;;) {
      const done = await this.checkJob(endpointId, id, { queuedForMs: Date.now() - startedAt })
      if (done) return done

      if (Date.now() > deadline) {
        const workers = await this.workerCounts(endpointId)
        const detail = workers ? ` Workers: ${JSON.stringify(workers)}.` : ''
        await this.cancelJob(endpointId, id)
        throw new Error(
          `RunPod job timed out after ${Math.round(timeoutMs / 1000)}s.${detail}`
        )
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }

  /** Worker counts for an endpoint, or null if /health can't be read. */
  private async workerCounts(endpointId: string): Promise<WorkerCounts | null> {
    try {
      const res = await fetch(`${RUNPOD_BASE}/${endpointId}/health`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        cache: 'no-store',
      })
      if (!res.ok) return null
      const body = (await res.json()) as { workers?: WorkerCounts }
      return body.workers ?? null
    } catch {
      // Diagnostics must never be the thing that fails a run.
      return null
    }
  }

  /**
   * Drops a job we've stopped waiting for. Without this an abandoned job stays
   * queued and can still be picked up later, burning GPU time for a result
   * nobody reads.
   */
  private async cancelJob(endpointId: string, jobId: string): Promise<void> {
    try {
      await fetch(`${RUNPOD_BASE}/${endpointId}/cancel/${jobId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
      })
    } catch {
      // Best effort — the caller is already failing for a better reason.
    }
  }

  async generateImage(): Promise<GenerationResult> {
    // Image generation stays on Fal — no RunPod image endpoint is configured.
    throw new Error('RunPod adapter does not provide image generation')
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
    const { id, gpuUsdPerSec, kind, contract } = endpointFor(params.model)
    if (kind === 'comfy') return this.generateVideoViaComfy(params, id, gpuUsdPerSec, contract)

    return withRetry(async () => {
      const { output, executionMs } = await this.runJob(id, {
        prompt: params.prompt,
        image_url: params.imageUrl,
        width: params.width,
        height: params.height,
        duration: params.duration,
      })
      const b64 = output.video_b64 as string | undefined
      if (!b64) throw new Error('RunPod wan returned no video_b64')
      return {
        url: `data:video/mp4;base64,${b64}`,
        cost: (executionMs / 1000) * gpuUsdPerSec,
        model: params.model,
        provider: 'runpod',
        metadata: { executionMs },
      }
    }, params.maxAttempts ?? 2)
  }

  /**
   * Video through a ComfyUI worker: send the whole graph plus its input files,
   * get back everything the graph produced and keep the video. Not retried by
   * default — a run costs minutes of GPU time, so a silent second attempt would
   * double a real bill to work around what is usually a deterministic graph
   * error.
   */
  private async generateVideoViaComfy(
    params: {
      prompt: string
      model: string
      imageUrl: string
      duration: number
      maxAttempts?: number
      options?: VideoOptions
    },
    endpointId: string,
    gpuUsdPerSec: number,
    contract: ComfyContract
  ): Promise<GenerationResult> {
    const input = await this.buildComfyVideoJob(params, contract)

    return withRetry(async () => {
      const { output, executionMs } = await this.runJob(
        endpointId,
        input,
        // Two sampling stages plus a tiled VAE decode: minutes, not seconds.
        { timeoutMs: 25 * 60_000, pollMs: 5_000 }
      )
      return this.comfyVideoResult(output, executionMs, params, gpuUsdPerSec)
    }, params.maxAttempts ?? 1)
  }

  /** The graph settings a result needs in order to be described. */
  private comfyContext(params: { duration: number; options?: VideoOptions }) {
    const opts = params.options ?? {}
    return {
      aspectRatio: (opts.aspectRatio as LtxAspectRatio) ?? '16:9 (Widescreen)',
      megapixels: opts.megapixels ?? LTX_DEFAULTS.megapixels,
      fps: opts.fps ?? LTX_DEFAULTS.fps,
      durationSec: params.duration,
    }
  }

  private async buildComfyVideoJob(
    params: { prompt: string; imageUrl: string; duration: number; options?: VideoOptions },
    contract: ComfyContract
  ): Promise<Record<string, unknown>> {
    const opts = params.options ?? {}
    const { aspectRatio, megapixels, fps } = this.comfyContext(params)

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

    return comfyJobInput(workflow, [firstFrame], contract)
  }

  /** Turns a finished job's output into the result the app expects. */
  private comfyVideoResult(
    output: Record<string, unknown>,
    executionMs: number,
    params: { model: string; duration: number; options?: VideoOptions },
    gpuUsdPerSec: number
  ): GenerationResult {
    const result = normalizeComfyOutput(output)

    // Match on MIME, not on the node key: LTX's mp4 arrives under `images`
    // because SaveVideo reports through PreviewVideo.
    const video = pickComfyFile(result.files, 'video/')
    if (!video) {
      // Non-fatal problems (a failed upload, a dropped output) arrive in the
      // result rather than as a job failure, and a graph that produced only
      // audio is a real thing to say out loud.
      throw new Error(`ComfyUI returned no video — got ${describeComfyOutput(result)}`)
    }

    // Anything else the graph emitted (a separate audio track, a caption)
    // rides along in metadata instead of being dropped on the floor.
    const extras = result.files.filter((f) => f !== video)
    const ctx = this.comfyContext(params)
    const { width, height } = resolveDimensions(ctx.aspectRatio, ctx.megapixels)

    return {
      url: comfyFileUrl(video),
      cost: (executionMs / 1000) * gpuUsdPerSec,
      model: params.model,
      provider: 'runpod',
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

  /** True when this model can be submitted now and collected later. */
  supportsAsyncVideo(model: string): boolean {
    return ENDPOINTS[model]?.kind === 'comfy'
  }

  /**
   * Queue a render and return its job id without waiting for it.
   *
   * The entry point for callers that cannot block for twenty minutes — an HTTP
   * handler with a gateway ceiling, chiefly. Pair with `collectVideo`, which
   * can be called from a later, unrelated request.
   */
  async submitVideo(params: {
    prompt: string
    model: string
    imageUrl: string
    duration: number
    options?: VideoOptions
  }): Promise<string> {
    const { id, kind, contract } = endpointFor(params.model)
    if (kind !== 'comfy') {
      throw new Error(`RunPod model "${params.model}" cannot be submitted asynchronously`)
    }
    const jobId = await this.submitJob(id, await this.buildComfyVideoJob(params, contract))
    console.log(`[runpod] queued ${params.model} as job ${jobId}`)
    return jobId
  }

  /**
   * Fetch a submitted render if it has finished. `null` means still running.
   *
   * `params` has to describe the same job that was submitted — it is only used
   * to label the result (dimensions, frame count), never to re-run anything.
   */
  async collectVideo(
    jobId: string,
    params: { model: string; duration: number; options?: VideoOptions },
    opts: { queuedForMs?: number } = {}
  ): Promise<GenerationResult | null> {
    const { id, gpuUsdPerSec } = endpointFor(params.model)
    const done = await this.checkJob(id, jobId, { queuedForMs: opts.queuedForMs })
    if (!done) return null
    return this.comfyVideoResult(done.output, done.executionMs, params, gpuUsdPerSec)
  }

  async generateAvatarVideo(params: {
    imageUrl: string
    audioUrl: string
    model: string
    maxAttempts?: number
  }): Promise<GenerationResult> {
    const { id, gpuUsdPerSec } = endpointFor(params.model)
    // MuseTalk takes the audio as base64, not a URL — materialize it.
    const audioB64 = await fetchAsBase64(params.audioUrl)
    return withRetry(async () => {
      const { output, executionMs } = await this.runJob(id, {
        image_url: params.imageUrl,
        audio_b64: audioB64,
      })
      const b64 = output.video_b64 as string | undefined
      if (!b64) throw new Error('RunPod musetalk returned no video_b64')
      return {
        url: `data:video/mp4;base64,${b64}`,
        cost: (executionMs / 1000) * gpuUsdPerSec,
        model: params.model,
        provider: 'runpod',
        metadata: { executionMs },
      }
    }, params.maxAttempts ?? 2)
  }

  async generateSpeech(params: {
    text: string
    voiceId: string
    modelId?: string
    referenceAudioB64?: string
    maxAttempts?: number
  }): Promise<GenerationResult<Buffer>> {
    const model = params.modelId && isRunPodModel(params.modelId) ? params.modelId : 'runpod/chatterbox'
    const { id, gpuUsdPerSec } = endpointFor(model)
    return withRetry(async () => {
      const input: Record<string, unknown> = { text: params.text }
      // Zero-shot voice cloning: when a reference voice sample is supplied,
      // Chatterbox mimics that voice instead of using its default speaker.
      if (params.referenceAudioB64) input.reference_audio_b64 = params.referenceAudioB64

      const { output, executionMs } = await this.runJob(id, input, { timeoutMs: 3 * 60_000 })
      const b64 = output.audio_b64 as string | undefined
      if (!b64) throw new Error('RunPod chatterbox returned no audio_b64')
      return {
        data: Buffer.from(b64, 'base64'),
        cost: (executionMs / 1000) * gpuUsdPerSec,
        model,
        provider: 'runpod',
        metadata: {
          executionMs,
          ext: 'wav',
          contentType: 'audio/wav',
          sampleRate: output.sample_rate ?? null,
        },
      }
    }, params.maxAttempts ?? 3)
  }

  async listVoices(): Promise<Array<{ id: string; name: string; preview_url?: string }>> {
    // Chatterbox has no fixed voice catalog — it uses its default speaker, or
    // clones whatever reference clip is supplied via the voice-clone setting.
    return [{ id: 'chatterbox-default', name: 'Chatterbox (default / cloned)' }]
  }

  async listModels(): Promise<string[]> {
    return Object.keys(ENDPOINTS)
  }
}

/** Fetch any http(s) or data: URL and return its bytes base64-encoded. */
export async function fetchAsBase64(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch reference media (${res.status})`)
  const buf = Buffer.from(await res.arrayBuffer())
  return buf.toString('base64')
}

