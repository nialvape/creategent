import { OpenRouterAdapter } from './openrouter'
import { FalAdapter } from './fal'
import { ElevenLabsAdapter } from './elevenlabs'
import { RunPodAdapter, isRunPodModel } from './runpod'
import { BeamAdapter, isBeamModel } from './beam'
import type { LLMProvider, MediaProvider, AudioProvider } from '@/types/provider'

let llmProvider: LLMProvider | null = null
let mediaProvider: MediaProvider | null = null
let audioProvider: AudioProvider | null = null
let runpodProvider: RunPodAdapter | null = null
let beamProvider: BeamAdapter | null = null

export function getLLMProvider(): LLMProvider {
  if (!llmProvider) {
    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set')
    llmProvider = new OpenRouterAdapter(apiKey)
  }
  return llmProvider
}

/**
 * The RunPod adapter itself, not behind the MediaProvider interface — for
 * callers that need `submitVideo` / `collectVideo` (see `getBeamProvider`).
 */
export function getRunPodProvider(): RunPodAdapter {
  if (!runpodProvider) {
    const apiKey = process.env.RUNPOD_API_KEY
    if (!apiKey) throw new Error('RUNPOD_API_KEY is not set')
    runpodProvider = new RunPodAdapter(apiKey)
  }
  return runpodProvider
}

/**
 * The Beam adapter itself, not behind the MediaProvider interface.
 *
 * Callers that cannot block for a whole render (an HTTP handler with a gateway
 * ceiling) need `submitVideo` / `collectVideo`, which are Beam-specific and
 * deliberately outside the provider contract.
 */
export function getBeamProvider(): BeamAdapter {
  if (!beamProvider) {
    const token = process.env.BEAM_TOKEN
    if (!token) throw new Error('BEAM_TOKEN is not set')
    beamProvider = new BeamAdapter(token)
  }
  return beamProvider
}

/**
 * Media (image/video/avatar) provider. Routes by the asset's model id: a
 * `runpod/*` or `beam/*` model goes to the matching self-hosted GPU backend,
 * everything else to Fal.
 *
 * The two self-hosted backends run the same ComfyUI graphs (see
 * `src/lib/comfy/transport.ts`), so `runpod/ltx-2.5-i2v` and `beam/ltx-2.5-i2v`
 * are the same model on different hardware — picking one is a cost and
 * availability decision, not a quality one.
 */
export function getMediaProvider(model?: string): MediaProvider {
  if (isBeamModel(model)) return getBeamProvider()
  if (isRunPodModel(model)) return getRunPodProvider()
  if (!mediaProvider) {
    const apiKey = process.env.FAL_KEY
    if (!apiKey) throw new Error('FAL_KEY is not set')
    mediaProvider = new FalAdapter(apiKey)
  }
  return mediaProvider
}

/** Audio provider. `runpod/*` (Chatterbox) goes to RunPod, else ElevenLabs. */
export function getAudioProvider(model?: string): AudioProvider {
  if (isRunPodModel(model)) return getRunPodProvider()
  if (!audioProvider) {
    const apiKey = process.env.ELEVENLABS_API_KEY
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set')
    audioProvider = new ElevenLabsAdapter(apiKey)
  }
  return audioProvider
}
