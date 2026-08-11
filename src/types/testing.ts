/**
 * Types for the Model Lab (/testing) — a bench that runs ONE model against a
 * bare input (attached files + a text prompt) with no graph, no planner and no
 * project settings in the way. Used to compare models head-to-head before
 * wiring the winner into the agent graph.
 */

/** What the selected model is being asked to do. Derived from the model id. */
export type LabCapability = 'understanding' | 'image' | 'video' | 'avatar' | 'audio'

/** A file the user attached, already uploaded to storage and publicly readable. */
export interface LabFile {
  url: string
  name: string
  mimeType: string
  kind: 'image' | 'video' | 'audio'
}

export interface LabRunRequest {
  capability: LabCapability
  model: string
  /** The text half of the input: a prompt, a script, or intake instructions. */
  prompt: string
  files: LabFile[]
}

/** One piece of model output. A run can produce several (one per input file). */
export interface LabOutput {
  kind: 'text' | 'image' | 'video' | 'audio'
  /** Where the output came from, e.g. the input file name it describes. */
  label?: string
  text?: string
  url?: string
}

export interface LabRunResult {
  ok: boolean
  capability: LabCapability
  model: string
  provider: string
  /** Wall-clock time of the whole run, in milliseconds. */
  ms: number
  /** USD reported by the provider. 0 when the provider doesn't report one. */
  cost: number
  outputs: LabOutput[]
  /** Provider-reported extras, shown raw so nothing is hidden during testing. */
  metadata?: Record<string, unknown>
  error?: string
}
