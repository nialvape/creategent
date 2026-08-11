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

/**
 * A media file the user attached to the conversation. A per-type understanding
 * sub-agent (see reference-intake node) fills in `description`; the planner then
 * reasons about each file's PURPOSE for the project.
 */
export interface ReferenceMedium {
  url: string
  kind: 'image' | 'video' | 'audio'
  name: string
  mimeType: string
  /** Natural-language description produced by the understanding sub-agent. */
  description?: string
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
  referenceMedia: ReferenceMedium[]
}
