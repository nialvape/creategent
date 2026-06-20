export interface AssetCost {
  assetId: string
  assetName: string
  provider: string
  model: string
  estimated: number
  actual: number
}

export interface CostBreakdown {
  total: number
  estimated: number
  actual: number
  byAsset: AssetCost[]
  byProvider: Record<string, number>
}

export interface CostEvent {
  id: string
  project_id: string
  asset_id: string | null
  provider: string
  model: string
  operation: string
  units: number
  unit_type: string
  cost_usd: number
  metadata: Record<string, unknown>
  created_at: string
}

export interface PricingEntry {
  provider: string
  model: string
  unitType: 'per_image' | 'per_5s_segment' | 'per_1k_characters' | 'per_1k_tokens' | 'per_second'
  priceUsd: number
  notes?: string
}
