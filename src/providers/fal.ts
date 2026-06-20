import { fal } from '@fal-ai/client'
import { withRetry } from '@/lib/retry'
import type { MediaProvider, GenerationResult } from '@/types/provider'

/**
 * The planner LLM sometimes emits Fal model ids without the required `fal-ai/`
 * namespace (e.g. `minimax/video-01` instead of `fal-ai/minimax/video-01`),
 * which makes fal.subscribe 404. Prefix it defensively so generation still runs.
 */
function normalizeFalModel(model: string): string {
  if (!model) return model
  return model.startsWith('fal-ai/') ? model : `fal-ai/${model}`
}

/**
 * The pipeline is now image-to-video only. Old projects (and any stray planner
 * output) may still carry retired text-to-video slugs; remap them to the default
 * i2v endpoint so generation keeps working without a DB migration.
 */
const DEFAULT_I2V_MODEL = 'fal-ai/kling-video/v2.1/standard/image-to-video'

const VIDEO_MODEL_ALIASES: Record<string, string> = {
  'fal-ai/minimax/video-01': DEFAULT_I2V_MODEL,
  'fal-ai/kling-video/v2/master/text-to-video': 'fal-ai/kling-video/v2.1/master/image-to-video',
}

function resolveVideoModel(model: string): string {
  const normalized = normalizeFalModel(model)
  if (VIDEO_MODEL_ALIASES[normalized]) return VIDEO_MODEL_ALIASES[normalized]
  // Defensive: any lingering text-to-video slug becomes its image-to-video form.
  if (normalized.includes('text-to-video')) {
    return normalized.replace('text-to-video', 'image-to-video')
  }
  // The pipeline is image-to-video ONLY. A model that isn't an i2v endpoint
  // (e.g. a stale text-to-video slug like `fal-ai/wan/v2.1/1.3b` saved in old
  // project settings) cannot consume a first-frame image — fall back to the
  // default i2v endpoint instead of sending it params it will reject.
  if (!normalized.includes('image-to-video')) {
    console.warn(`[FalAdapter] "${normalized}" is not an image-to-video model — falling back to ${DEFAULT_I2V_MODEL}`)
    return DEFAULT_I2V_MODEL
  }
  return normalized
}

/** fal.subscribe resolves to `{ data, requestId }` — the model output is in `data`. */
function unwrap<T>(result: unknown): T {
  const r = result as { data?: T }
  return (r?.data ?? (result as T))
}

/**
 * fal's servers fetch input media (image_url / audio_url) by URL, so every input
 * must be a publicly reachable http(s) URL. The audio agent falls back to a base64
 * `data:` URL when Supabase Storage upload fails — fal cannot download that, which
 * silently leaves an avatar with no voice. So for any non-http URL, materialize the
 * bytes and re-host them on fal's own storage (which returns a public URL). http(s)
 * URLs pass straight through.
 */
async function ensureFalFetchable(url: string, kind: string): Promise<string> {
  if (/^https?:\/\//i.test(url)) return url
  try {
    const res = await fetch(url)
    const blob = await res.blob()
    const uploaded = await fal.storage.upload(blob)
    console.log(`[FalAdapter] re-hosted non-http ${kind} input on fal storage`)
    return uploaded
  } catch (err) {
    throw new Error(
      `Could not make ${kind} input fetchable for fal (got a non-http URL and re-hosting failed): ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * Kling i2v only accepts a `duration` ENUM of "5" or "10" seconds — any other
 * value (e.g. a 15-30s length the planner picks for the whole script) is rejected
 * with a 422. Snap the requested length to the nearest allowed value.
 */
function klingDuration(seconds: number): string {
  return seconds >= 8 ? '10' : '5'
}

/**
 * Build the per-model input payload for image→video. The source image is the
 * first frame, so the aspect ratio is taken from the image and only `prompt`,
 * `image_url` and a `duration` enum are sent — Kling i2v rejects raw pixel
 * dimensions and out-of-enum durations.
 */
function buildVideoInput(
  model: string,
  params: { prompt: string; imageUrl: string; duration: number }
): Record<string, unknown> {
  return {
    prompt: params.prompt,
    image_url: params.imageUrl,
    duration: klingDuration(params.duration),
  }
}

export class FalAdapter implements MediaProvider {
  constructor(apiKey: string) {
    fal.config({ credentials: apiKey })
  }

  async generateImage(params: {
    prompt: string
    model: string
    width: number
    height: number
    format?: string
    maxAttempts?: number
  }): Promise<GenerationResult> {
    const model = normalizeFalModel(params.model)
    const { url, cost } = await withRetry(async () => {
      const raw = await fal.subscribe(model, {
        input: {
          prompt: params.prompt,
          image_size: { width: params.width, height: params.height },
          output_format: params.format ?? 'jpeg',
          num_images: 1,
        },
      })
      const data = unwrap<{ images?: Array<{ url: string }>; cost?: number }>(raw)
      const u = data.images?.[0]?.url ?? ''
      // An empty URL means the model produced nothing usable; throw so withRetry
      // retries and, if it persists, the agent records a real failure (instead of
      // a "completed" image with no URL, which silently breaks downstream i2v).
      if (!u) throw new Error('Fal returned no image URL')
      return { url: u, cost: typeof data.cost === 'number' ? data.cost : 0 }
    }, params.maxAttempts ?? 3)

    return { url, cost, model, provider: 'fal' }
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
    const model = resolveVideoModel(params.model)
    // The first-frame image must be fal-fetchable (defensive: re-host non-http URLs).
    const imageUrl = await ensureFalFetchable(params.imageUrl, 'first-frame image')
    const { url, cost } = await withRetry(async () => {
      const raw = await fal.subscribe(model, {
        input: buildVideoInput(model, {
          prompt: params.prompt,
          imageUrl,
          duration: params.duration,
        }),
        pollInterval: 5000,
        logs: false,
      })
      const data = unwrap<{ video?: { url: string }; url?: string; cost?: number }>(raw)
      const u = data.video?.url ?? data.url ?? ''
      if (!u) throw new Error('Fal returned no video URL')
      return { url: u, cost: typeof data.cost === 'number' ? data.cost : 0 }
    }, params.maxAttempts ?? 3)

    return { url, cost, model, provider: 'fal' }
  }

  async generateAvatarVideo(params: {
    imageUrl: string
    audioUrl: string
    model: string
    maxAttempts?: number
  }): Promise<GenerationResult> {
    const model = normalizeFalModel(params.model)
    // Both inputs must be fal-fetchable; re-host any data:/non-http URL (e.g. the
    // audio agent's Storage-failure fallback) so the avatar actually gets the voice.
    const [imageUrl, audioUrl] = await Promise.all([
      ensureFalFetchable(params.imageUrl, 'avatar image'),
      ensureFalFetchable(params.audioUrl, 'avatar audio'),
    ])
    const { url, cost } = await withRetry(async () => {
      const raw = await fal.subscribe(model, {
        input: {
          image_url: imageUrl,
          audio_url: audioUrl,
        },
        pollInterval: 5000,
        logs: false,
      })
      const data = unwrap<{ video?: { url: string }; url?: string; cost?: number }>(raw)
      const u = data.video?.url ?? data.url ?? ''
      if (!u) throw new Error('Fal returned no avatar video URL')
      return { url: u, cost: typeof data.cost === 'number' ? data.cost : 0 }
    }, params.maxAttempts ?? 2)

    return { url, cost, model, provider: 'fal' }
  }

  async listModels(): Promise<string[]> {
    return [
      'fal-ai/flux/schnell',
      'fal-ai/flux-pro',
      'fal-ai/kling-video/v2.1/standard/image-to-video',
      'fal-ai/kling-video/v2.1/master/image-to-video',
      'fal-ai/kling-video/ai-avatar/v2/pro',
    ]
  }
}
