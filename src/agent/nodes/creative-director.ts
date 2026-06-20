import { getLLMProvider } from '@/providers/registry'
import {
  CREATIVE_DIRECTOR_SYSTEM_PROMPT,
  CONTENT_TYPE_PLAYBOOKS,
} from '@/agent/prompts/creative-director'
import { getOrchestrationModel } from '@/agent/state'
import { planAssetIdOf } from './_deps'
import type { ContentState } from '@/agent/state'
import type { Asset } from '@/types/asset'
import type { PlanAsset } from '@/types/plan'
import type { AssetBrief, AssetVerdict } from '@/types/director'
import type { ReviewResult } from '@/types/graph-state'
import { z } from 'zod'

// ─── Schemas (wrapped in objects — some providers reject top-level arrays) ─────

const AssetBriefSchema = z.object({
  planAssetId: z.string(),
  instruction: z.string(),
  voice: z
    .object({ scriptExcerpt: z.string(), direction: z.string() })
    .optional(),
})

const BriefBatchSchema = z.object({ briefs: z.array(AssetBriefSchema) })

const ReviewBatchSchema = z.object({
  verdicts: z.array(
    z.object({
      planAssetId: z.string(),
      pass: z.boolean(),
      feedback: z.string().optional(),
    })
  ),
  notes: z.string(),
})

const FinalReviewSchema = z.object({
  passed: z.boolean(),
  overallScore: z.number().min(0).max(100),
  assetScores: z.record(z.string(), z.number()),
  suggestions: z.record(z.string(), z.array(z.string())),
})

// ─── Helpers ───────────────────────────────────────────────────────────────

function playbook(state: typeof ContentState.State): string {
  return CONTENT_TYPE_PLAYBOOKS[state.contentType] ?? CONTENT_TYPE_PLAYBOOKS.viral_short
}

/** Compact, director-readable view of a produced asset for review/context. */
function summarizeAsset(a: Asset) {
  const m = (a.metadata ?? {}) as Record<string, unknown>
  return {
    planAssetId: planAssetIdOf(a) ?? a.id,
    type: a.type,
    name: a.name,
    status: a.status,
    content: typeof m.content === 'string' ? m.content : undefined,
    spokenText: typeof m.script === 'string' ? m.script : undefined,
    prompt: typeof m.prompt === 'string' ? m.prompt : undefined,
    error: typeof m.error === 'string' ? m.error : undefined,
  }
}

/** Plan-asset view the director needs to brief an asset. */
function describePlanAsset(a: PlanAsset) {
  return {
    planAssetId: a.id,
    type: a.type,
    name: a.name,
    description: a.description,
    platform: a.platform,
    specs: a.specs,
    dependencies: a.dependencies ?? [],
  }
}

function planHeader(state: typeof ContentState.State): string {
  const plan = state.plan!
  const contentLangs = plan.contentLanguages?.join(', ') || plan.userLanguage || 'the user\'s language'
  return `User's idea: ${state.userIdea}
Content language(s) for audience-facing copy (dialogue, voiceover, captions): ${contentLangs}
Content type: ${state.contentType}
Title: ${plan.title}
Summary: ${plan.summary}
Platforms: ${plan.targetPlatforms.join(', ')}
Style: ${JSON.stringify(plan.style)}

${playbook(state)}`
}

// ─── MODE A — Establish direction (once) ──────────────────────────────────────

export async function establishDirection(
  state: typeof ContentState.State
): Promise<{ styleBrief: string; directorContext: string }> {
  const llm = getLLMProvider()
  const result = await llm.generateText({
    prompt: `MODE A — Establish direction.

${planHeader(state)}

Write the SHORT global creative anchor (5-8 lines) for this package.`,
    model: getOrchestrationModel(state.projectSettings),
    systemPrompt: CREATIVE_DIRECTOR_SYSTEM_PROMPT,
    maxTokens: 400,
  })

  const styleBrief = result.data ?? ''
  const directorContext = `# Creative direction\n${styleBrief}\n\n# Progress log\n(nothing produced yet)`
  return { styleBrief, directorContext }
}

// ─── MODE B — Brief a wave ────────────────────────────────────────────────────

export async function briefWave(
  state: typeof ContentState.State,
  wave: PlanAsset[],
  directorContext: string
): Promise<AssetBrief[]> {
  const llm = getLLMProvider()
  const produced = state.assets.filter((a) => a.status === 'completed').map(summarizeAsset)

  const result = await llm.generateStructuredOutput<z.infer<typeof BriefBatchSchema>>({
    prompt: `MODE B — Brief this wave.

${planHeader(state)}

Global anchor: ${state.styleBrief ?? ''}

Your running notes so far:
${directorContext}

Already produced (earlier waves — note the Script especially):
${JSON.stringify(produced, null, 2)}

Write ONE brief per asset in this wave. Return a "briefs" array; each brief's "planAssetId" MUST match one of these. For audio/avatar voice assets include the "voice" object (scriptExcerpt = spoken words only, lifted from the Script's dialogue; direction = how to deliver it).

Assets to brief:
${JSON.stringify(wave.map(describePlanAsset), null, 2)}`,
    model: getOrchestrationModel(state.projectSettings),
    schema: BriefBatchSchema,
    systemPrompt: CREATIVE_DIRECTOR_SYSTEM_PROMPT,
  })

  const briefs = result.data?.briefs ?? []
  // Guarantee every asset in the wave gets a brief, even if the LLM missed one.
  const byId = new Map(briefs.map((b) => [b.planAssetId, b]))
  return wave.map(
    (a) =>
      byId.get(a.id) ?? { planAssetId: a.id, instruction: a.description }
  )
}

// ─── MODE C — Review a wave ───────────────────────────────────────────────────

export async function reviewWave(
  state: typeof ContentState.State,
  wave: PlanAsset[],
  produced: Asset[],
  briefs: AssetBrief[],
  directorContext: string
): Promise<{ verdicts: AssetVerdict[]; directorContext: string }> {
  const llm = getLLMProvider()

  const result = await llm.generateStructuredOutput<z.infer<typeof ReviewBatchSchema>>({
    prompt: `MODE C — Review this wave's output.

${planHeader(state)}

Your running notes so far:
${directorContext}

The briefs you issued for this wave:
${JSON.stringify(briefs, null, 2)}

What the agents produced:
${JSON.stringify(produced.map(summarizeAsset), null, 2)}

Return a verdict per produced asset (planAssetId, pass, and feedback when pass=false) plus updated "notes" capturing what's done well, what later waves must land, and any corrections issued. A failed asset (especially the Script) is re-run, so only fail what genuinely misses the brief.`,
    model: getOrchestrationModel(state.projectSettings),
    schema: ReviewBatchSchema,
    systemPrompt: CREATIVE_DIRECTOR_SYSTEM_PROMPT,
  })

  const verdicts = result.data?.verdicts ?? produced.map((a) => ({
    planAssetId: planAssetIdOf(a) ?? a.id,
    pass: true,
  }))
  const notes = result.data?.notes ?? directorContext
  return { verdicts, directorContext: `${directorContext}\n\n## Wave review\n${notes}` }
}

// ─── Final holistic pass (the director owns the verdict) ─────────────────────

export async function finalReview(
  state: typeof ContentState.State,
  produced: Asset[],
  directorContext: string
): Promise<ReviewResult> {
  const llm = getLLMProvider()
  const completed = produced.filter((a) => a.status === 'completed')
  const failed = produced.filter((a) => a.status === 'failed')

  if (completed.length === 0) {
    return { passed: false, overallScore: 0, assetScores: {}, suggestions: {}, retryCount: 0 }
  }

  try {
    const result = await llm.generateStructuredOutput<z.infer<typeof FinalReviewSchema>>({
      prompt: `Final holistic review — you are the only one with the full context.

${planHeader(state)}

Your running notes across the whole run:
${directorContext}

All produced assets:
${JSON.stringify(produced.map(summarizeAsset), null, 2)}
Failed assets: ${failed.length}

Score each asset (0-100, keyed by planAssetId) and the overall package; decide pass; list per-asset suggestions. Judge coherence with the idea, the content type, and your direction.`,
      model: getOrchestrationModel(state.projectSettings),
      schema: FinalReviewSchema,
      systemPrompt: CREATIVE_DIRECTOR_SYSTEM_PROMPT,
    })
    return { ...result.data!, retryCount: 0 }
  } catch {
    return { passed: true, overallScore: 75, assetScores: {}, suggestions: {}, retryCount: 0 }
  }
}
