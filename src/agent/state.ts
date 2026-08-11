import { Annotation, messagesStateReducer } from '@langchain/langgraph'
import { BaseMessage } from '@langchain/core/messages'
import type { ContentPlan, ContentType, PlanStatus } from '@/types/plan'
import type { Asset } from '@/types/asset'
import type { AssetBrief } from '@/types/director'
import type { ProjectSettings } from '@/types/project'
import type { GraphStatus, GenerationProgress, ReviewResult, ReferenceMedium } from '@/types/graph-state'

function last<T>(a: T, b: T): T { return b }

function mergeAssets(existing: Asset[], incoming: Asset[]): Asset[] {
  const map = new Map(existing.map((a) => [a.id, a]))
  for (const asset of incoming) {
    map.set(asset.id, asset)
  }
  return Array.from(map.values())
}

const defaultSettings: ProjectSettings = {
  preferredImageModel: 'fal-ai/flux/schnell',
  preferredVideoModel: 'fal-ai/kling-video/v2.1/standard/image-to-video',
  preferredAvatarModel: 'fal-ai/kling-video/ai-avatar/v2/pro',
  preferredAudioModel: 'eleven_multilingual_v2',
  orchestrationModel: 'anthropic/claude-sonnet-4-6',
  writingModel: 'anthropic/claude-sonnet-4-6',
  translationModel: 'meta-llama/llama-3.3-70b-instruct:free',
  targetPlatforms: ['instagram'],
  qualityPreset: 'standard',
}

/** Default free OpenRouter model for the cheap plan-translation step. */
export const DEFAULT_TRANSLATION_MODEL = 'meta-llama/llama-3.3-70b-instruct:free'

/**
 * Multimodal model used by the reference-media understanding sub-agents. Gemini
 * 2.5 Flash accepts image, audio AND video inputs, so one model covers all three
 * file kinds the user can attach.
 */
export const DEFAULT_MEDIA_UNDERSTANDING_MODEL = 'google/gemini-2.5-flash'

/** Resolve orchestration model, falling back to legacy preferredLLM for old projects */
export function getOrchestrationModel(settings: ProjectSettings): string {
  return settings.orchestrationModel ?? settings.preferredLLM ?? 'anthropic/claude-sonnet-4-6'
}

/** Resolve writing model, falling back to orchestration model then legacy preferredLLM */
export function getWritingModel(settings: ProjectSettings): string {
  return settings.writingModel ?? settings.orchestrationModel ?? settings.preferredLLM ?? 'anthropic/claude-sonnet-4-6'
}

/** Resolve the cheap translation model, falling back to a free OpenRouter model */
export function getTranslationModel(settings: ProjectSettings): string {
  return settings.translationModel ?? DEFAULT_TRANSLATION_MODEL
}

export const ContentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  userIdea: Annotation<string>({ reducer: last, default: () => '' }),
  projectId: Annotation<string>({ reducer: last, default: () => '' }),
  projectSettings: Annotation<ProjectSettings>({ reducer: last, default: () => defaultSettings }),
  plan: Annotation<ContentPlan | null>({ reducer: last, default: () => null }),
  // Canonical `plan` is always authored in English (it drives the agents). When
  // the user's language isn't English, this holds a translated copy shown ONLY
  // for approval; null means "show `plan` as-is".
  displayPlan: Annotation<ContentPlan | null>({ reducer: last, default: () => null }),
  planStatus: Annotation<PlanStatus | null>({ reducer: last, default: () => null }),
  contentType: Annotation<ContentType>({ reducer: last, default: () => 'viral_short' as ContentType }),
  estimatedCost: Annotation<number>({ reducer: last, default: () => 0 }),
  actualCost: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  // Short global creative anchor (set once by the director); per-asset briefs supersede it.
  styleBrief: Annotation<string | null>({ reducer: last, default: () => null }),
  // Per-asset detailed briefs written by the director, keyed by plan-asset id.
  assetBriefs: Annotation<Record<string, AssetBrief>>({ reducer: last, default: () => ({}) }),
  // The director's running notes/memory across waves (what's done, pending, corrected).
  directorContext: Annotation<string>({ reducer: last, default: () => '' }),
  assets: Annotation<Asset[]>({ reducer: mergeAssets, default: () => [] }),
  generationProgress: Annotation<GenerationProgress>({
    reducer: last,
    default: () => ({ total: 0, completed: 0, failed: 0, current: null }),
  }),
  reviewResult: Annotation<ReviewResult | null>({ reducer: last, default: () => null }),
  status: Annotation<GraphStatus>({ reducer: last, default: () => 'idle' as GraphStatus }),
  errors: Annotation<string[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  // User-attached reference files, enriched with descriptions by the intake node.
  referenceMedia: Annotation<ReferenceMedium[]>({ reducer: last, default: () => [] }),
})
