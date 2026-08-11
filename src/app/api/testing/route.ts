import { getLLMProvider, getMediaProvider, getAudioProvider } from '@/providers/registry'
import { uploadAsset, getAssetUrl } from '@/lib/supabase/storage'
import { providerForModel, type MediaModelType } from '@/lib/models'
import {
  REFERENCE_SYSTEM_PROMPT,
  IMAGE_UNDERSTANDING_PROMPT,
  VIDEO_UNDERSTANDING_PROMPT,
  AUDIO_UNDERSTANDING_PROMPT,
} from '@/agent/prompts/reference'
import type { LabCapability, LabFile, LabOutput, LabRunResult } from '@/types/testing'

/** Storage prefix for lab uploads/outputs — keeps bench files out of real projects. */
export const LAB_PROJECT_ID = 'model-lab'

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

async function runVideo(model: string, prompt: string, files: LabFile[]) {
  // The pipeline is image-to-video only (see lib/models.ts VIDEO_MODELS), so a
  // first-frame image is required here too — testing t2v would test nothing the
  // graph can use.
  const source = firstOfKind(files, 'image')
  if (!source) throw new BadInput('Video models are image-to-video: attach a first-frame image.')
  if (!prompt.trim()) throw new BadInput('Video generation needs a text prompt describing the motion.')

  const res = await getMediaProvider(model).generateVideo({
    prompt,
    model,
    imageUrl: source.url,
    width: 1080,
    height: 1920,
    duration: 5,
  })
  return {
    outputs: res.url ? [{ kind: 'video' as const, label: `from ${source.name}`, url: res.url }] : [],
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
    }

    capability = body.capability ?? 'understanding'
    model = body.model ?? ''
    const prompt = body.prompt ?? ''
    const files = Array.isArray(body.files) ? body.files : []

    if (!model) return Response.json({ error: 'model is required' }, { status: 400 })

    let result: { outputs: LabOutput[]; cost: number; metadata?: Record<string, unknown> }
    switch (capability) {
      case 'understanding':
        result = await runUnderstanding(model, prompt, files)
        break
      case 'image':
        result = await runImage(model, prompt)
        break
      case 'video':
        result = await runVideo(model, prompt, files)
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

    const payload: LabRunResult = {
      ok: true,
      capability,
      model,
      provider:
        capability === 'understanding'
          ? 'openrouter'
          : providerForModel(capability as MediaModelType, model),
      ms: Date.now() - startedAt,
      cost: result.cost,
      outputs: result.outputs,
      metadata: result.metadata,
    }
    console.log(`[model-lab] ${capability} model=${model} ms=${payload.ms} cost=$${payload.cost}`)
    return Response.json(payload)
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
