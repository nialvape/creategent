import { OpenRouterAdapter } from './openrouter'
import { FalAdapter } from './fal'
import { ElevenLabsAdapter } from './elevenlabs'
import { RunPodAdapter, isRunPodModel } from './runpod'
import type { LLMProvider, MediaProvider, AudioProvider } from '@/types/provider'

let llmProvider: LLMProvider | null = null
let mediaProvider: MediaProvider | null = null
let audioProvider: AudioProvider | null = null
let runpodProvider: RunPodAdapter | null = null

export function getLLMProvider(): LLMProvider {
  if (!llmProvider) {
    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set')
    llmProvider = new OpenRouterAdapter(apiKey)
  }
  return llmProvider
}

function getRunPodProvider(): RunPodAdapter {
  if (!runpodProvider) {
    const apiKey = process.env.RUNPOD_API_KEY
    if (!apiKey) throw new Error('RUNPOD_API_KEY is not set')
    runpodProvider = new RunPodAdapter(apiKey)
  }
  return runpodProvider
}

/**
 * Media (image/video/avatar) provider. Routes by the asset's model id: a
 * `runpod/*` model goes to the user's GPU endpoints, everything else to Fal.
 */
export function getMediaProvider(model?: string): MediaProvider {
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
