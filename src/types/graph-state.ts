import type { ContentPlan, PlanStatus } from './plan'
import type { Asset } from './asset'
import type { ProjectSettings } from './project'

export interface GenerationProgress {
  total: number
  completed: number
  failed: number
  current: string | null
}

export interface ReviewResult {
  passed: boolean
  overallScore: number
  assetScores: Record<string, number>
  suggestions: Record<string, string[]>
  retryCount: number
}

export type GraphStatus =
  | 'idle'
  | 'planning'
  | 'awaiting_approval'
  | 'generating'
  | 'reviewing'
  | 'completed'
  | 'failed'

export interface ContentGraphState {
  messages: Array<{ role: string; content: string }>
  userIdea: string
  projectId: string
  projectSettings: ProjectSettings
  plan: ContentPlan | null
  planStatus: PlanStatus | null
  estimatedCost: number
  actualCost: number
  styleBrief: string | null
  assets: Asset[]
  generationProgress: GenerationProgress
  reviewResult: ReviewResult | null
  status: GraphStatus
  errors: string[]
}
