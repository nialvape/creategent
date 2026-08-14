import {
  getLLMProvider,
  getMediaProvider,
  getAudioProvider,
  getBeamProvider,
  getRunPodProvider,
} from '@/providers/registry'
import { isBeamModel } from '@/providers/beam'
import { isRunPodModel } from '@/providers/runpod'
import type { GenerationResult } from '@/types/provider'
import { uploadAsset, getAssetUrl } from '@/lib/supabase/storage'
import { providerForModel, type MediaModelType } from '@/lib/models'
import {
  REFERENCE_SYSTEM_PROMPT,
  IMAGE_UNDERSTANDING_PROMPT,
  VIDEO_UNDERSTANDING_PROMPT,
  AUDIO_UNDERSTANDING_PROMPT,
} from '@/agent/prompts/reference'
import {
  resolveDimensions,
  LTX_DEFAULTS,
  type LtxAspectRatio,
} from '@/lib/comfy/ltx-2-5-i2v'
import type {
  LabCapability,
  LabFile,
  LabOutput,
  LabPendingResult,
  LabRunResult,
  LabVideoParams,
} from '@/types/testing'

export const runtime = 'nodejs'
// A ComfyUI render is minutes of GPU time, not seconds — longer than any ceiling
// this route can raise, so waiting inside the request was always going to lose
// races. Backends that can hand back a job id (Beam today) are submitted here
// and collected by a later request instead; see `runVideoAsync`. Everything else
// still has to fit inside this budget.
export const maxDuration = 300

/** Storage prefix for lab uploads/outputs — keeps bench files out of real projects. */
export const LAB_PROJECT_ID = 'model-lab'

/**
 * Largest inline data: URL allowed in the response. The host caps a serverless
 * response body at 4.5 MB, so a video returned inline fails the run *after* the
 * GPU time has been paid for — anything above this goes to storage and travels
 * as a link instead.
 */
const MAX_INLINE_BYTES = 3 * 1024 * 1024

const EXT_BY_TYPE: Record<string, string> = {
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'image/png': 'png',
  'image/jpeg': 'jpg',
}

/**
 * Moves oversized inline outputs into storage. The RunPod ComfyUI worker returns
 * the finished mp4 base64-encoded (there's no S3 configured on the endpoint), so
 * without this the whole video would be embedded in the JSON response.
 */
async function externalizeLargeOutputs(outputs: LabOutput[]): Promise<LabOutput[]> {
  return Promise.all(
    outputs.map(async (out) => {
      const match = out.url && /^data:([^;,]+);base64,/.exec(out.url)
      if (!match) return out

      const contentType = match[1]
      const bytes = Buffer.from(out.url!.slice(match[0].length), 'base64')
      if (bytes.byteLength <= MAX_INLINE_BYTES) return out

      const ext = EXT_BY_TYPE[contentType] ?? contentType.split('/')[1] ?? 'bin'
      try {
        const path = await uploadAsset(LAB_PROJECT_ID, bytes, `lab_${Date.now()}.${ext}`, contentType)
        return { ...out, url: await getAssetUrl(path) }
      } catch (err) {
        const mb = (bytes.byteLength / 1024 / 1024).toFixed(1)
        const detail = err instanceof Error ? err.message : String(err)
        throw new Error(
          `The model produced a ${mb} MB ${ext} that could not be stored, and it is too large to return inline: ${detail}`
        )
      }
    })
  )
}

/** Same voice the audio agent uses, so TTS comparisons match production. */
const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL' // Bella — multilingual

const INTAKE_PROMPT_BY_KIND: Record<LabFile['kind'], string> = {
  image: IMAGE_UNDERSTANDING_PROMPT,
  video: VIDEO_UNDERSTANDING_PROMPT,
  audio: AUDIO_UNDERSTANDING_PROMPT,
}

class BadInput extends Error {}

function firstOfKind(files: LabFile[], kind: LabFile['kind']): LabFile | undefined {
  return files.find((f) => f.kind === kind)
}

/**
 * Reference intake: run each attached file through the chosen multimodal model
 * and return its description. With no files, the model just answers the text —
 * which is how you sanity-check a model before feeding it media.
 */
async function runUnderstanding(
  model: string,
  prompt: string,
  files: LabFile[]
): Promise<{ outputs: LabOutput[]; cost: number }> {
  const llm = getLLMProvider()

  if (files.length === 0) {
    if (!prompt.trim()) throw new BadInput('Attach a file or write a prompt.')
    const res = await llm.generateText({ prompt, model, systemPrompt: REFERENCE_SYSTEM_PROMPT })
    return { outputs: [{ kind: 'text', label: 'text-only', text: res.data ?? '' }], cost: res.cost }
  }

  // One call per file, in parallel — mirrors reference-intake's fan-out. A file
  // that fails comes back as an error line instead of sinking the whole run.
  const settled = await Promise.all(
    files.map(async (file) => {
      try {
        const res = await llm.describeMedia({
          url: file.url,
          mediaType: file.mimeType,
          kind: file.kind,
          prompt: prompt.trim() || INTAKE_PROMPT_BY_KIND[file.kind],
          model,
          systemPrompt: REFERENCE_SYSTEM_PROMPT,
        })
        return { output: { kind: 'text' as const, label: file.name, text: res.data ?? '' }, cost: res.cost }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          output: { kind: 'text' as const, label: `${file.name} — FAILED`, text: message },
          cost: 0,
        }
      }
    })
  )

  return {
    outputs: settled.map((s) => s.output),
    cost: settled.reduce((sum, s) => sum + s.cost, 0),
  }
}

async function runImage(model: string, prompt: string): Promise<{ outputs: LabOutput[]; cost: number; metadata?: Record<string, unknown> }> {
  if (!prompt.trim()) throw new BadInput('Image generation needs a text prompt.')
  const res = await getMediaProvider(model).generateImage({
    prompt,
    model,
    width: 1024,
    height: 1024,
  })
  return {
    outputs: res.url ? [{ kind: 'image', label: '1024×1024', url: res.url }] : [],
    cost: res.cost,
    metadata: res.metadata,
  }
}

/**
 * Validates a video request and derives everything both the sync and async
 * paths need from it. Shared so the two cannot disagree about what was asked.
 */
function videoRequest(
  model: string,
  prompt: string,
  files: LabFile[],
  videoParams?: LabVideoParams
) {
  // The pipeline is image-to-video only (see lib/models.ts VIDEO_MODELS), so a
  // first-frame image is required here too — testing t2v would test nothing the
  // graph can use.
  const source = firstOfKind(files, 'image')
  if (!source) throw new BadInput('Video models are image-to-video: attach a first-frame image.')
  if (!prompt.trim()) throw new BadInput('Video generation needs a text prompt describing the motion.')

  const aspectRatio = videoParams?.aspectRatio
  if (aspectRatio === 'auto') {
    // The browser resolves 'auto' against the real image size; reaching the
    // server means that failed, and guessing here would silently stretch the
    // frame — the exact failure this setting exists to prevent.
    throw new BadInput('Could not read the image dimensions — pick an aspect ratio explicitly.')
  }

  const megapixels = videoParams?.megapixels ?? LTX_DEFAULTS.megapixels
  const duration = videoParams?.durationSec ?? LTX_DEFAULTS.durationSec

  // Hosted providers still take a pixel size, so derive one from the same
  // settings the ComfyUI graph will use. Keeps both paths on one control set.
  const { width, height } = resolveDimensions(
    (aspectRatio as LtxAspectRatio) ?? '16:9 (Widescreen)',
    megapixels
  )

  return {
    source,
    duration,
    width,
    height,
    options: videoParams && {
      aspectRatio,
      megapixels,
      fps: videoParams.fps,
      seed: videoParams.seed,
      enhancePrompt: videoParams.enhancePrompt,
      negativePrompt: videoParams.negativePrompt,
    },
  }
}

async function runVideo(
  model: string,
  prompt: string,
  files: LabFile[],
  videoParams?: LabVideoParams
) {
  const { source, duration, width, height, options } = videoRequest(
    model,
    prompt,
    files,
    videoParams
  )

  const res = await getMediaProvider(model).generateVideo({
    prompt,
    model,
    imageUrl: source.url,
    width,
    height,
    duration,
    options,
  })
  return {
    outputs: res.url ? [{ kind: 'video' as const, label: `from ${source.name}`, url: res.url }] : [],
    cost: res.cost,
    metadata: res.metadata,
  }
}

/**
 * A backend that can hand back a job id instead of a finished render.
 *
 * Both self-hosted backends work this way, and both had the same hole: the
 * render outlives the request, the gateway cuts the connection at 300s, and GPU
 * time that was already paid for is thrown away. Hosted providers (Fal) are
 * fast enough to stay synchronous.
 */
interface AsyncVideoBackend {
  submitVideo(params: {
    prompt: string
    model: string
    imageUrl: string
    duration: number
    options?: ReturnType<typeof videoRequest>['options']
  }): Promise<string>
  collectVideo(
    taskId: string,
    params: { model: string; duration: number; options?: ReturnType<typeof videoRequest>['options'] },
    opts?: { queuedForMs?: number }
  ): Promise<GenerationResult | null>
}

/**
 * Whether an error while collecting means the render is dead, as opposed to the
 * status call having had a bad moment.
 *
 * Deliberately a whitelist: anything unrecognised is treated as transient and
 * polled again, because the cost of guessing wrong in that direction is a
 * slower answer, while guessing wrong in the other direction throws away a
 * generation that is still running and still being billed.
 */
const TERMINAL_RENDER_ERRORS = [
  /RunPod job (FAILED|CANCELLED|TIMED_OUT)/i,
  /job not found/i,
  /endpoint can't run this job/i,
  /Beam task (ERROR|FAILED|TIMEOUT|CANCELLED|EXPIRED)/i,
  /Beam worker:/i,
  /ComfyUI returned no video/i,
  /completed but returned no output/i,
  /no readable result/i,
]

function isTerminalRenderError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return TERMINAL_RENDER_ERRORS.some((re) => re.test(message))
}

function asyncVideoBackend(model: string): AsyncVideoBackend | null {
  if (isBeamModel(model)) return getBeamProvider()
  if (isRunPodModel(model)) {
    const runpod = getRunPodProvider()
    return runpod.supportsAsyncVideo(model) ? runpod : null
  }
  return null
}

/**
 * The video path for a backend that renders asynchronously.
 *
 * Without a `taskId` it queues the render and returns the id; with one it looks
 * for the result. Either way the request returns in seconds, so the GPU work is
 * no longer coupled to an HTTP connection anything can cut.
 */
async function runVideoAsync(
  backend: AsyncVideoBackend,
  model: string,
  prompt: string,
  files: LabFile[],
  videoParams: LabVideoParams | undefined,
  taskId: string | undefined,
  queuedForMs: number | undefined
): Promise<
  | { pending: true; taskId: string }
  | { pending: false; outputs: LabOutput[]; cost: number; metadata?: Record<string, unknown> }
> {
  const { duration, options, source } = videoRequest(model, prompt, files, videoParams)

  if (!taskId) {
    const id = await backend.submitVideo({ prompt, model, imageUrl: source.url, duration, options })
    return { pending: true, taskId: id }
  }

  let res: GenerationResult | null
  try {
    res = await backend.collectVideo(taskId, { model, duration, options }, { queuedForMs })
  } catch (err) {
    // A poll that fails is not a render that failed. Treating every error as
    // terminal would reintroduce the bug this path exists to fix — one blip
    // from the backend's status API and a running generation gets written off.
    if (!isTerminalRenderError(err)) {
      console.warn(`[model-lab] transient poll error for ${taskId}, still waiting:`, err)
      return { pending: true, taskId }
    }
    throw err
  }
  if (!res) return { pending: true, taskId }

  return {
    pending: false,
    outputs: res.url ? [{ kind: 'video', label: `from ${source.name}`, url: res.url }] : [],
    cost: res.cost,
    metadata: res.metadata,
  }
}

async function runAvatar(model: string, files: LabFile[]) {
  const image = firstOfKind(files, 'image')
  const audio = firstOfKind(files, 'audio')
  if (!image) throw new BadInput('Avatar models need a portrait image.')
  if (!audio) throw new BadInput('Avatar models need a voice audio clip to lip-sync to.')

  const res = await getMediaProvider(model).generateAvatarVideo({
    imageUrl: image.url,
    audioUrl: audio.url,
    model,
  })
  return {
    outputs: res.url ? [{ kind: 'video' as const, label: `${image.name} + ${audio.name}`, url: res.url }] : [],
    cost: res.cost,
    metadata: res.metadata,
  }
}

/**
 * TTS. An attached audio file is treated as a voice-clone reference, which is
 * what the audio agent does for Chatterbox — providers without cloning ignore it.
 */
async function runAudio(model: string, prompt: string, files: LabFile[]) {
  if (!prompt.trim()) throw new BadInput('Voice generation needs the text to speak.')

  let referenceAudioB64: string | undefined
  const reference = firstOfKind(files, 'audio')
  if (reference) {
    const bytes = await fetch(reference.url).then((r) => r.arrayBuffer())
    referenceAudioB64 = Buffer.from(bytes).toString('base64')
  }

  const res = await getAudioProvider(model).generateSpeech({
    text: prompt,
    voiceId: DEFAULT_VOICE_ID,
    modelId: model,
    referenceAudioB64,
  })

  // Output format varies by provider: ElevenLabs returns mp3, Chatterbox wav.
  const ext = (res.metadata?.ext as string) ?? 'mp3'
  const contentType = (res.metadata?.contentType as string) ?? 'audio/mpeg'

  let url = res.url
  if (!url && res.data) {
    try {
      const path = await uploadAsset(LAB_PROJECT_ID, res.data, `lab_${Date.now()}.${ext}`, contentType)
      url = await getAssetUrl(path)
    } catch (uploadErr) {
      // Storage RLS commonly blocks the anon key — fall back to an inline data
      // URL so the clip is still playable in the bench.
      console.warn('[model-lab] audio upload failed, using inline data URL:', uploadErr)
      url = `data:${contentType};base64,${res.data.toString('base64')}`
    }
  }

  return {
    outputs: url ? [{ kind: 'audio' as const, label: reference ? `cloned from ${reference.name}` : 'default voice', url }] : [],
    cost: res.cost,
    metadata: res.metadata,
  }
}

/** Assembles the run record the bench displays, from whichever path produced it. */
async function labResult(
  result: { outputs: LabOutput[]; cost: number; metadata?: Record<string, unknown> },
  capability: LabCapability,
  model: string,
  startedAt: number
): Promise<LabRunResult> {
  const payload: LabRunResult = {
    ok: true,
    capability,
    model,
    outputs: await externalizeLargeOutputs(result.outputs),
    provider:
      capability === 'understanding'
        ? 'openrouter'
        : providerForModel(capability as MediaModelType, model),
    // On the async path this measures the collecting request, not the render;
    // the client overwrites it with its own elapsed time, and the real GPU time
    // is in metadata.executionMs either way.
    ms: Date.now() - startedAt,
    cost: result.cost,
    metadata: result.metadata,
  }
  console.log(`[model-lab] ${capability} model=${model} ms=${payload.ms} cost=$${payload.cost}`)
  return payload
}

/**
 * Runs a single model against raw input (files + text) and reports what came
 * back plus how long it took and what it cost. Deliberately bypasses the graph:
 * the point is to measure the model, not the orchestration around it.
 */
export async function POST(req: Request) {
  const startedAt = Date.now()
  let capability: LabCapability = 'understanding'
  let model = ''

  try {
    const body = (await req.json()) as {
      capability?: LabCapability
      model?: string
      prompt?: string
      files?: LabFile[]
      videoParams?: LabVideoParams
      /** Present when the client is collecting a render it already queued. */
      taskId?: string
      /** When that render was queued — only used to time the capacity check. */
      startedAt?: number
    }

    capability = body.capability ?? 'understanding'
    model = body.model ?? ''
    const prompt = body.prompt ?? ''
    const files = Array.isArray(body.files) ? body.files : []

    if (!model) return Response.json({ error: 'model is required' }, { status: 400 })

    // Asynchronous backends short-circuit the whole request/response shape: the
    // reply is either "queued, here is the id" or "still working", and the run
    // outlives both.
    const backend = capability === 'video' ? asyncVideoBackend(model) : null
    if (backend) {
      const async = await runVideoAsync(
        backend,
        model,
        prompt,
        files,
        body.videoParams,
        body.taskId,
        body.startedAt ? Date.now() - body.startedAt : undefined
      )
      if (async.pending) {
        const pending: LabPendingResult = { pending: true, taskId: async.taskId, model, capability }
        return Response.json(pending, { status: 202 })
      }
      return Response.json(await labResult(async, capability, model, startedAt))
    }

    let result: { outputs: LabOutput[]; cost: number; metadata?: Record<string, unknown> }
    switch (capability) {
      case 'understanding':
        result = await runUnderstanding(model, prompt, files)
        break
      case 'image':
        result = await runImage(model, prompt)
        break
      case 'video':
        result = await runVideo(model, prompt, files, body.videoParams)
        break
      case 'avatar':
        result = await runAvatar(model, files)
        break
      case 'audio':
        result = await runAudio(model, prompt, files)
        break
      default:
        return Response.json({ error: `Unknown capability "${capability}"` }, { status: 400 })
    }

    return Response.json(await labResult(result, capability, model, startedAt))
  } catch (err) {
    const message = err instanceof Error ? err.message : JSON.stringify(err)
    if (err instanceof BadInput) {
      return Response.json({ error: message }, { status: 400 })
    }
    // A provider failure IS a test result — return it as a failed run so the UI
    // can show it next to the runs that worked.
    console.error('[model-lab] run failed:', message)
    const payload: LabRunResult = {
      ok: false,
      capability,
      model,
      provider: 'unknown',
      ms: Date.now() - startedAt,
      cost: 0,
      outputs: [],
      error: message,
    }
    return Response.json(payload)
  }
}
