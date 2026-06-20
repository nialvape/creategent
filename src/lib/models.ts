export interface ModelDef {
  id: string
  name: string
  provider: string
  description: string
  tags?: ('recommended' | 'fastest' | 'best quality' | 'cheapest')[]
  priceLabel: string
}

export const LLM_MODELS: ModelDef[] = [
  {
    id: 'anthropic/claude-opus-4-5',
    name: 'Claude Opus 4.5',
    provider: 'Anthropic',
    description: 'Most capable model. Ideal for complex tasks and deep reasoning.',
    tags: ['best quality'],
    priceLabel: '$0.015/1k tokens',
  },
  {
    id: 'anthropic/claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    provider: 'Anthropic',
    description: 'Best balance of intelligence and speed.',
    tags: ['recommended'],
    priceLabel: '$0.003/1k tokens',
  },
  {
    id: 'anthropic/claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'Anthropic',
    description: 'Fast and affordable. Ideal for high-volume tasks.',
    tags: ['fastest', 'cheapest'],
    priceLabel: '$0.0008/1k tokens',
  },
  {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    provider: 'OpenAI',
    description: 'Modelo multimodal insignia de OpenAI.',
    priceLabel: '$0.0025/1k tokens',
  },
  {
    id: 'openai/gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'OpenAI',
    description: 'Affordable and fast. Good for simple tasks.',
    tags: ['cheapest'],
    priceLabel: '$0.00015/1k tokens',
  },
  {
    id: 'google/gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'Google',
    description: "Google's most capable model. Solid reasoning.",
    tags: ['best quality'],
    priceLabel: '$0.0025/1k tokens',
  },
  {
    id: 'google/gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash Lite',
    provider: 'Google',
    description: 'Very fast and cheap. Excellent throughput.',
    tags: ['fastest', 'cheapest'],
    priceLabel: '$0.0001/1k tokens',
  },
  {
    id: 'deepseek/deepseek-r1',
    name: 'DeepSeek R1',
    provider: 'DeepSeek',
    description: 'Powerful reasoning model at very low cost.',
    tags: ['cheapest'],
    priceLabel: '$0.00055/1k tokens',
  },
]

export const IMAGE_MODELS: ModelDef[] = [
  {
    id: 'fal-ai/flux/schnell',
    name: 'Flux Schnell',
    provider: 'Black Forest Labs',
    description: 'Fast and affordable. Perfect for drafts and iteration.',
    tags: ['fastest', 'cheapest'],
    priceLabel: '$0.003/img',
  },
  {
    id: 'fal-ai/flux/dev',
    name: 'Flux Dev',
    provider: 'Black Forest Labs',
    description: 'Balance of quality and speed. Ideal for most use cases.',
    tags: ['recommended'],
    priceLabel: '$0.025/img',
  },
  {
    id: 'fal-ai/flux-pro',
    name: 'Flux Pro 1.1',
    provider: 'Black Forest Labs',
    description: 'Highest Flux quality. For final production assets.',
    tags: ['best quality'],
    priceLabel: '$0.05/img',
  },
  {
    id: 'fal-ai/ideogram/v3',
    name: 'Ideogram v3',
    provider: 'Ideogram',
    description: 'Excellent for text-in-image and stylized art.',
    priceLabel: '$0.08/img',
  },
  {
    id: 'fal-ai/recraft-v3',
    name: 'Recraft v3',
    provider: 'Recraft',
    description: 'Specialized in brand design and illustrations.',
    priceLabel: '$0.04/img',
  },
]

// IMAGE-TO-VIDEO ONLY. Every video in CreateGent is animated from a generated
// first-frame image (see the script-first workflow in prompts/planner.ts) — the
// pipeline never does text-to-video, so only i2v endpoints belong here.
export const VIDEO_MODELS: ModelDef[] = [
  {
    id: 'runpod/wan-2.6-i2v',
    name: 'Wan 2.6 (RunPod)',
    provider: 'RunPod (self-hosted)',
    description: 'Your own GPU. Image-to-video on a RunPod serverless endpoint. Billed per GPU-second.',
    tags: ['recommended', 'cheapest'],
    priceLabel: '~GPU/sec',
  },
  {
    id: 'fal-ai/kling-video/v2.1/standard/image-to-video',
    name: 'Kling v2.1 Standard',
    provider: 'Kuaishou',
    description: 'Affordable image-to-video with good motion coherence.',
    tags: ['recommended', 'cheapest'],
    priceLabel: '$0.25/5s',
  },
  {
    id: 'fal-ai/kling-video/v2.1/master/image-to-video',
    name: 'Kling v2.1 Master',
    provider: 'Kuaishou',
    description: 'Cinematic-quality image-to-video. Best for production.',
    tags: ['best quality'],
    priceLabel: '$0.28/5s',
  },
]

// Talking-head / lip-sync models. They take a first-frame image + a voice audio
// clip and produce a synced talking-avatar video (image+audio → video). Used by
// the avatar agent, never for plain b-roll (that's VIDEO_MODELS / i2v).
export const AVATAR_MODELS: ModelDef[] = [
  {
    id: 'fal-ai/kling-video/ai-avatar/v2/pro',
    name: 'Kling AI Avatar v2 Pro',
    provider: 'Kuaishou',
    description: 'High-fidelity talking avatar. Syncs lips and expression to voice.',
    tags: ['recommended', 'best quality'],
    priceLabel: '$0.115/s',
  },
]

export const AUDIO_MODELS: ModelDef[] = [
  {
    id: 'runpod/chatterbox',
    name: 'Chatterbox (RunPod)',
    provider: 'RunPod (self-hosted)',
    description: 'Your own GPU TTS with zero-shot voice cloning. Set a reference voice in settings to clone it.',
    tags: ['recommended', 'cheapest'],
    priceLabel: '~GPU/sec',
  },
  {
    id: 'eleven_multilingual_v2',
    name: 'Multilingual v2',
    provider: 'ElevenLabs',
    description: 'Natural voice in 29 languages. Best for narration.',
    tags: ['recommended'],
    priceLabel: '$0.30/1k chars',
  },
  {
    id: 'eleven_turbo_v2_5',
    name: 'Turbo v2.5',
    provider: 'ElevenLabs',
    description: 'Fast and affordable TTS. Good for high-volume audio.',
    tags: ['fastest', 'cheapest'],
    priceLabel: '$0.18/1k chars',
  },
]

export type MediaModelType = 'image' | 'video' | 'audio' | 'avatar'

export const MODEL_CATALOG_BY_TYPE: Record<MediaModelType, ModelDef[]> = {
  image: IMAGE_MODELS,
  video: VIDEO_MODELS,
  audio: AUDIO_MODELS,
  avatar: AVATAR_MODELS,
}

/**
 * Return `model` if it's a valid choice in the catalog for that type, otherwise
 * the catalog's default (first entry). Guards against stale model ids that linger
 * in old project settings / localStorage but are no longer offered in the UI
 * (e.g. a retired `fal-ai/wan/v2.1/1.3b` video model) reaching a provider.
 */
export function coerceMediaModel(type: MediaModelType, model: string | undefined | null): string {
  const catalog = MODEL_CATALOG_BY_TYPE[type]
  if (model && catalog.some((m) => m.id === model)) return model
  return catalog[0].id
}

/**
 * The execution provider for a media model id. RunPod (`runpod/*`) models run on
 * the user's own GPU endpoints; everything else uses the type's cloud default
 * (Fal for image/video/avatar, ElevenLabs for audio). This is what gets stamped
 * on the asset and used to route to the right adapter in the registry.
 */
export function providerForModel(type: MediaModelType, model: string): string {
  if (model?.startsWith('runpod/')) return 'runpod'
  return type === 'audio' ? 'elevenlabs' : 'fal'
}
