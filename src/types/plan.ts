import type { AssetType } from './asset'

export type PlanStatus = 'proposed' | 'approved' | 'rejected' | 'modified'

/**
 * The shape of the content package, classified by the planner. The creative
 * director loads a content-type–specific playbook for briefing each asset.
 */
export type ContentType =
  | 'viral_short'  // short-form viral video (Reel / TikTok / Short)
  | 'long_form'    // longer narrated / educational video
  | 'carousel'     // multi-slide image carousel
  | 'ad'           // advertising / publicity spot
  | 'photo_post'   // single or few-image post

export interface StyleDefinition {
  tone: string
  colorPalette: string[]
  visualStyle: string
  typography?: string
  mood?: string
}

export interface PlanAsset {
  id: string
  type: AssetType
  name: string
  description: string
  platform: string
  specs: {
    width?: number
    height?: number
    duration?: number
    format?: string
    aspectRatio?: string
  }
  provider: string
  model: string
  estimatedCost: number
  dependencies?: string[]
}

export interface ContentPlan {
  id: string
  title: string
  summary: string
  contentType: ContentType
  targetPlatforms: string[]
  style: StyleDefinition
  assets: PlanAsset[]
  totalEstimatedCost: number
  status: PlanStatus
  /**
   * Language the user wrote their idea in — used to talk to the user and to
   * render the plan for approval (the plan itself is authored in English).
   * An ISO-ish code or name as the planner detected it (e.g. "es", "Spanish").
   */
  userLanguage: string
  /**
   * Language(s) the finished, audience-facing content must be produced in
   * (script dialogue, voiceover, captions). Defaults to [userLanguage]; a list
   * only when the user explicitly asks for more than one.
   */
  contentLanguages: string[]
}
