import type { PricingEntry } from '@/types/cost'

export const PRICING_CATALOG: PricingEntry[] = [
  // Fal.ai image models
  { provider: 'fal', model: 'fal-ai/flux-pro', unitType: 'per_image', priceUsd: 0.05, notes: 'Flux Pro 1.1' },
  { provider: 'fal', model: 'fal-ai/flux/schnell', unitType: 'per_image', priceUsd: 0.003, notes: 'Flux Schnell fast' },
  { provider: 'fal', model: 'fal-ai/flux/dev', unitType: 'per_image', priceUsd: 0.025, notes: 'Flux Dev' },
  // Fal.ai video models (image-to-video only)
  { provider: 'fal', model: 'fal-ai/kling-video/v2.1/standard/image-to-video', unitType: 'per_5s_segment', priceUsd: 0.25 },
  { provider: 'fal', model: 'fal-ai/kling-video/v2.1/master/image-to-video', unitType: 'per_5s_segment', priceUsd: 0.28 },
  // Fal.ai talking-head / avatar lip-sync models (image + audio -> video)
  { provider: 'fal', model: 'fal-ai/kling-video/ai-avatar/v2/pro', unitType: 'per_second', priceUsd: 0.115 },
  // ElevenLabs
  { provider: 'elevenlabs', model: 'eleven_multilingual_v2', unitType: 'per_1k_characters', priceUsd: 0.30 },
  { provider: 'elevenlabs', model: 'eleven_turbo_v2_5', unitType: 'per_1k_characters', priceUsd: 0.18 },
  // RunPod self-hosted (billed per GPU-second; these are rough planner ESTIMATES —
  // actual_cost is derived at runtime from the endpoint's reported executionTime)
  { provider: 'runpod', model: 'runpod/wan-2.6-i2v', unitType: 'per_5s_segment', priceUsd: 0.10, notes: 'wan 2.6 i2v on H100 (est.)' },
  { provider: 'runpod', model: 'runpod/chatterbox', unitType: 'per_1k_characters', priceUsd: 0.01, notes: 'Chatterbox TTS on RTX 5090 (est.)' },
  // OpenRouter LLMs
  { provider: 'openrouter', model: 'anthropic/claude-sonnet-4-6', unitType: 'per_1k_tokens', priceUsd: 0.003 },
  { provider: 'openrouter', model: 'anthropic/claude-3-5-haiku', unitType: 'per_1k_tokens', priceUsd: 0.0008 },
  { provider: 'openrouter', model: 'openai/gpt-4o', unitType: 'per_1k_tokens', priceUsd: 0.0025 },
  { provider: 'openrouter', model: 'openai/gpt-4o-mini', unitType: 'per_1k_tokens', priceUsd: 0.00015 },
  { provider: 'openrouter', model: 'google/gemini-2.0-flash', unitType: 'per_1k_tokens', priceUsd: 0.0001 },
]

export function getPricing(provider: string, model: string): PricingEntry | undefined {
  return PRICING_CATALOG.find((e) => e.provider === provider && e.model === model)
}
