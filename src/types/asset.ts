export type AssetType = 'image' | 'video' | 'audio' | 'text' | 'avatar'
export type AssetStatus = 'pending' | 'generating' | 'completed' | 'failed'

export interface AssetSpecs {
  width?: number
  height?: number
  duration?: number
  format?: string
  aspectRatio?: string
  fps?: number
  bitrate?: number
  sampleRate?: number
  characterCount?: number
}

export interface Asset {
  id: string
  project_id: string
  plan_id: string | null
  type: AssetType
  name: string
  description: string | null
  status: AssetStatus
  storage_path: string | null
  public_url: string | null
  specs: AssetSpecs
  provider: string | null
  model: string | null
  estimated_cost: number | null
  actual_cost: number | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}
