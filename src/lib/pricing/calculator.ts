import { getPricing } from './catalog'
import type { PlanAsset, ContentPlan } from '@/types/plan'

export function calculateAssetCost(asset: PlanAsset): number {
  const pricing = getPricing(asset.provider, asset.model)
  if (!pricing) return 0

  switch (pricing.unitType) {
    case 'per_image':
      return pricing.priceUsd

    case 'per_5s_segment': {
      const duration = asset.specs.duration ?? 5
      const segments = Math.ceil(duration / 5)
      return segments * pricing.priceUsd
    }

    case 'per_1k_characters': {
      // estimate 500 chars for audio assets
      const chars = 500
      return (chars / 1000) * pricing.priceUsd
    }

    case 'per_1k_tokens': {
      // rough estimate for copy/text generation
      const tokens = 2000
      return (tokens / 1000) * pricing.priceUsd
    }

    case 'per_second': {
      const duration = asset.specs.duration ?? 5
      return duration * pricing.priceUsd
    }

    default:
      return 0
  }
}

export function calculatePlanCost(plan: ContentPlan): number {
  return plan.assets.reduce((sum, asset) => sum + asset.estimatedCost, 0)
}
