/**
 * Prompt ratings — the Model Lab's record of a generation that was judged worth
 * remembering. A run only reaches the database once it is rated, so every row
 * here is a deliberate evaluation rather than a log line.
 *
 * Field names are snake_case because these objects are Supabase rows.
 */

import type { LabCapability, LabFile } from './testing'

/** Only capabilities with a visual output can be rated. */
export type RatedCapability = Extract<LabCapability, 'image' | 'video' | 'avatar'>

export const RATED_CAPABILITIES: RatedCapability[] = ['image', 'video', 'avatar']

export function isRatedCapability(value: unknown): value is RatedCapability {
  return RATED_CAPABILITIES.includes(value as RatedCapability)
}

/** What was attached to the run, minus the storage URL — names and kinds are
 *  what tell you the shape of the input; the URLs expire in usefulness. */
export type RatedAttachment = Pick<LabFile, 'name' | 'mimeType' | 'kind'>

export interface PromptRating {
  id: string
  capability: RatedCapability
  model: string
  model_name: string
  provider: string
  prompt: string
  negative_prompt: string | null
  attachment_count: number
  /** Count per kind, e.g. `{ image: 1, audio: 1 }`. */
  attachment_kinds: Record<string, number>
  attachments: RatedAttachment[]
  /** The knobs the run used — LabVideoParams for video, empty otherwise. */
  settings: Record<string, unknown>
  /** Provider-reported extras: real width/height, frame count, seed. */
  run_metadata: Record<string, unknown>
  duration_ms: number | null
  cost_usd: number | null
  /** Null when the output came back as an inline data: URL. */
  output_url: string | null
  /** Axis id → 1-5. Only axes the rater actually scored appear here. */
  scores: Record<string, number>
  notes: string | null
  created_at: string
  updated_at: string
}

/** The payload the browser sends to POST /api/lab/ratings. */
export type PromptRatingInput = Omit<PromptRating, 'id' | 'created_at' | 'updated_at'>
