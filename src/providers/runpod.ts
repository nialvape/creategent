import { withRetry } from '@/lib/retry'
import type {
  MediaProvider,
  AudioProvider,
  GenerationResult,
} from '@/types/provider'

/**
 * RunPod Serverless adapter. The user hosts their own GPU models on RunPod
 * serverless endpoints (wan 2.6 image-to-video, Chatterbox TTS, MuseTalk avatar)
 * loaded from a network volume. Each endpoint exposes a tiny JSON handler:
 *
 *   wan i2v     in  { prompt, image_url, width, height, duration } -> { video_b64 }
 *   chatterbox  in  { text, reference_audio_b64? }                 -> { audio_b64, sample_rate }
 *   musetalk    in  { image_url, audio_b64 }                       -> { video_b64 }   (handler not deployed yet)
 *
 * Endpoints are async: POST /run returns a job id, then we poll /status/{id}
 * until COMPLETED. Cost is billed per GPU-second, so we derive actual_cost from
 * the `executionTime` RunPod reports rather than a fixed per-asset price.
 */

const RUNPOD_BASE = 'https://api.runpod.ai/v2'

// Model id -> serverless endpoint id. Overridable via env so the ids aren't
// baked into source (the defaults are the user's current endpoints).
const ENDPOINTS: Record<string, { envKey: string; defaultId: string; gpuUsdPerSec: number }> = {
  'runpod/wan-2.6-i2v': {
    envKey: 'RUNPOD_WAN_ENDPOINT_ID',
    defaultId: '0urbbihiwowt7f',
    gpuUsdPerSec: 0.00116, // ~H100 80GB serverless flex
  },
  'runpod/chatterbox': {
    envKey: 'RUNPOD_CHATTERBOX_ENDPOINT_ID',
    defaultId: '09bw6q1blhayzg',
    gpuUsdPerSec: 0.00044, // ~RTX 5090
  },
  'runpod/musetalk': {
    envKey: 'RUNPOD_MUSETALK_ENDPOINT_ID',
    defaultId: 'ebkllrlml5kij3',
    gpuUsdPerSec: 0.00031, // ~RTX 4090
  },
}

/** True for any model id this adapter handles (used by the registry to route). */
export function isRunPodModel(model: string | undefined | null): boolean {
  return !!model && model.startsWith('runpod/')
}

function endpointFor(model: string): { id: string; gpuUsdPerSec: number } {
  const def = ENDPOINTS[model]
  if (!def) throw new Error(`Unknown RunPod model "${model}"`)
  const id = process.env[def.envKey] || def.defaultId
  return { id, gpuUsdPerSec: def.gpuUsdPerSec }
}

interface RunStatus {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT'
  output?: Record<string, unknown>
  error?: string
  executionTime?: number // ms of GPU time, present once COMPLETED
}

export class RunPodAdapter implements MediaProvider, AudioProvider {
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  /** Submit a job and poll until it finishes. Returns the handler `output`. */
  private async runJob(
    endpointId: string,
    input: Record<string, unknown>,
    opts: { timeoutMs?: number; pollMs?: number } = {}
  ): Promise<{ output: Record<string, unknown>; executionMs: number }> {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    }

    const submit = await fetch(`${RUNPOD_BASE}/${endpointId}/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input }),
    })
    if (!submit.ok) {
      throw new Error(`RunPod /run failed (${submit.status}): ${await submit.text()}`)
    }
    const { id } = (await submit.json()) as { id?: string }
    if (!id) throw new Error('RunPod /run returned no job id')

    const timeoutMs = opts.timeoutMs ?? 5 * 60_000
    const pollMs = opts.pollMs ?? 3_000
    const deadline = Date.now() + timeoutMs

    for (;;) {
      const res = await fetch(`${RUNPOD_BASE}/${endpointId}/status/${id}`, { headers })
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
      if (Date.now() > deadline) {
        throw new Error(`RunPod job timed out after ${Math.round(timeoutMs / 1000)}s (status: ${body.status})`)
      }
      await new Promise((r) => setTimeout(r, pollMs))
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
  }): Promise<GenerationResult> {
    const { id, gpuUsdPerSec } = endpointFor(params.model)
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
