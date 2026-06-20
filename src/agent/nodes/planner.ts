import { AIMessage } from '@langchain/core/messages'
import { getLLMProvider } from '@/providers/registry'
import { calculateAssetCost } from '@/lib/pricing/calculator'
import { coerceMediaModel, providerForModel } from '@/lib/models'
import { PLANNER_SYSTEM_PROMPT } from '@/agent/prompts/planner'
import { translatePlanForApproval, isEnglish } from '@/agent/translate-plan'
import { getOrchestrationModel, getWritingModel, getTranslationModel } from '@/agent/state'
import type { ContentState } from '@/agent/state'
import type { ContentPlan } from '@/types/plan'
import type { ProjectSettings } from '@/types/project'
import { z } from 'zod'

const SpecsSchema = z.object({
  width: z.number().optional(),
  height: z.number().optional(),
  duration: z.number().optional(),
  format: z.string().optional(),
  aspectRatio: z.string().optional(),
})

// FLAT object schema (no discriminated union). A union compiles to JSON-Schema
// `oneOf`, which some structured-output providers reject ("Schema type 'oneOf'
// is not supported"). So `dependencies` is loose here and the strict per-type
// rules (required deps) are enforced separately in validatePlanRules() —
// runtime-only, emits no union. provider/model are not the LLM's concern at all
// (assigned from settings in assignAssetModels).
const PlanAssetSchema = z.object({
  id: z.string(),
  type: z.enum(['image', 'video', 'audio', 'text', 'avatar']),
  name: z.string(),
  description: z.string().optional().default(''),
  platform: z.string().optional().default('instagram'),
  specs: SpecsSchema.optional().default({}),
  // provider/model are NOT chosen by the LLM. The user picks models in project
  // settings and the planner node assigns them deterministically per asset type
  // (see assignAssetModels). Kept optional so the LLM never has to emit them.
  provider: z.string().optional().default(''),
  model: z.string().optional().default(''),
  // We recompute cost from the pricing catalog, so the model's value is optional.
  estimatedCost: z.number().optional().default(0),
  dependencies: z.array(z.string()).optional().default([]),
})

// Provider per asset type. The MODEL itself is not chosen here or by the LLM —
// it comes from the user's project settings (assignAssetModels).
const PROVIDER_BY_TYPE: Record<string, string> = {
  image: 'fal',
  video: 'fal',
  audio: 'elevenlabs',
  avatar: 'fal',
  text: 'openrouter',
}

/**
 * Assign each asset's provider + model deterministically from the project's
 * settings — the user picks these in the UI, so the planner LLM never chooses
 * them. Returns a new assets array; unknown types are left untouched.
 */
function assignAssetModels(
  assets: ContentPlan['assets'],
  settings: ProjectSettings,
  writingModel: string
): ContentPlan['assets'] {
  // Coerce media models against the catalog so a stale id in settings (e.g. a
  // retired `fal-ai/wan/v2.1/1.3b` that's no longer offered in the UI) can never
  // be stamped on an asset or sent to a provider. Text uses the writing model
  // (OpenRouter alias map handles its dead slugs separately).
  const modelByType: Record<string, string> = {
    image: coerceMediaModel('image', settings.preferredImageModel),
    video: coerceMediaModel('video', settings.preferredVideoModel),
    audio: coerceMediaModel('audio', settings.preferredAudioModel),
    avatar: coerceMediaModel('avatar', settings.preferredAvatarModel),
    text: writingModel,
  }
  return assets.map((a) => {
    const model = modelByType[a.type] ?? a.model
    // Media providers depend on the chosen model (a runpod/* model routes to the
    // user's GPU endpoints); text/avatar keep their fixed provider.
    const provider =
      a.type === 'video' || a.type === 'audio' || a.type === 'image'
        ? providerForModel(a.type, model)
        : PROVIDER_BY_TYPE[a.type] ?? a.provider
    return { ...a, provider, model }
  })
}

// Structural schema sent to the LLM / generateObject. It is intentionally LOOSE
// (no business rules) so generation never hard-fails with the opaque
// AI_NoObjectGeneratedError — the strict rules are checked separately, after, via
// validatePlanRules() so we can log issues and attempt a repair.
export const PlanStructureSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  contentType: z
    .enum(['viral_short', 'long_form', 'carousel', 'ad', 'photo_post'])
    .optional()
    .default('viral_short'),
  targetPlatforms: z.array(z.string()),
  style: z.object({
    tone: z.string(),
    colorPalette: z.array(z.string()),
    visualStyle: z.string(),
    typography: z.string().optional(),
    mood: z.string().optional(),
  }),
  assets: z.array(PlanAssetSchema),
  totalEstimatedCost: z.number().optional().default(0),
  status: z.enum(['proposed', 'approved', 'rejected', 'modified']).optional().default('proposed'),
  // Language the user wrote in (used to talk to them / render the approval view).
  // The plan itself is authored in English; this just records the user's language.
  userLanguage: z.string().optional().default('en'),
  // Language(s) the finished audience-facing content must be in. Defaults to the
  // user's language; a list only when the user explicitly asks for more.
  contentLanguages: z.array(z.string()).optional().default([]),
})

/**
 * Business-rule validation, run AFTER structural parsing. Returns human-readable
 * issues (empty array = valid). Kept separate from the schema so a violation is
 * recoverable (repair re-prompt) rather than a fatal generation error.
 */
export function validatePlanRules(plan: ContentPlan): string[] {
  const issues: string[] = []
  const typeOf = new Map(plan.assets.map((a) => [a.id, a.type]))

  // The guion is always the FIRST asset and must be a text asset. Language-
  // agnostic: we do NOT match on the name (it may be "Guion", "Script", etc.).
  const firstText = plan.assets.find((a) => a.type === 'text')
  if (!firstText) {
    issues.push('The plan must include a text asset (the Script / Guion).')
  } else if (plan.assets[0]?.type !== 'text') {
    issues.push('The Script (a text asset) must be the FIRST asset in the assets array.')
  }

  for (const a of plan.assets) {
    const depTypes = (a.dependencies ?? []).map((d) => typeOf.get(d))

    // Image-to-video: each video must be animated from one first-frame image.
    if (a.type === 'video' && !depTypes.includes('image')) {
      issues.push(`Video asset "${a.name}" must depend on an image asset (its first frame). Videos are image-to-video only.`)
    }

    // Talking head: needs a first-frame image + a voice audio.
    if (a.type === 'avatar') {
      if (!depTypes.includes('image')) {
        issues.push(`Avatar asset "${a.name}" must depend on an image asset (the first-frame portrait).`)
      }
      if (!depTypes.includes('audio')) {
        issues.push(`Avatar asset "${a.name}" must depend on an audio asset (the voice).`)
      }
    }
  }

  return issues
}

export async function plannerNode(
  state: typeof ContentState.State
): Promise<Partial<typeof ContentState.State>> {
  const llm = getLLMProvider()

  const orchestrationModel = getOrchestrationModel(state.projectSettings)
  const writingModel = getWritingModel(state.projectSettings)

  const prompt = `User's content idea: ${state.userIdea}

Project settings:
- Target platforms: ${state.projectSettings.targetPlatforms.join(', ')}
- Quality preset: ${state.projectSettings.qualityPreset}

LANGUAGE: Author the ENTIRE plan (title, summary, every asset name + description, style) in ENGLISH — it drives English-only downstream agents. Detect the user's language and return it as "userLanguage" (e.g. "es"); set "contentLanguages" to the language(s) the finished audience-facing content must be in (default ["<userLanguage>"], a longer list only if the user explicitly asks for more). The system translates the plan into the user's language for approval — do NOT translate it yourself.

${state.planStatus === 'rejected' ? `Previous plan was rejected. User feedback from conversation — please revise accordingly.\n` : ''}
Do NOT pick AI models — the user already chose those in their settings and the system assigns them automatically. Just define the assets, their characteristics (type, aspect ratio, duration, content style) and their dependencies.

## Asset-type rule (REQUIRED): anyone SPEAKING on camera ⇒ an "avatar" asset (lip-synced image + voice), NEVER a silent "video". A "video" is b-roll motion only. For talking + movement (e.g. someone narrating while at the gym), use an avatar for the spoken delivery plus image/video b-roll for the action.

## Dependency rules (REQUIRED — the orchestrator parallelizes by these):
- The FIRST asset must be the text "Script". Every other asset lists, in its "dependencies" array, the asset ids it needs.
- image assets depend on the Script.
- video assets are image-to-video: each depends on its first-frame image id.
- audio (voice) assets depend on the Script and run in parallel with images.
- avatar assets depend on BOTH a first-frame image id AND a voice audio id.

Generate a complete content plan as a JSON object matching the ContentPlan schema.
Use uuid-style IDs (e.g., "asset-001", "asset-002").
Set status to "proposed".`

  const generate = (extra: string) =>
    llm.generateStructuredOutput<ContentPlan>({
      prompt: extra ? `${prompt}\n\n${extra}` : prompt,
      model: orchestrationModel,
      schema: PlanStructureSchema,
      systemPrompt: PLANNER_SYSTEM_PROMPT,
    })

  // Generate, then validate business rules. Strict rules are checked OUTSIDE the
  // schema so a violation is recoverable: we re-prompt once with the issues.
  let result = await generate('')
  let plan = result.data!
  const issues = validatePlanRules(plan)

  if (issues.length > 0) {
    console.warn('[planner] plan failed validation, attempting repair:', issues)
    result = await generate(
      `Your previous plan was INVALID. Fix these problems and regenerate the FULL plan:\n- ${issues.join('\n- ')}`
    )
    plan = result.data!
    const remaining = validatePlanRules(plan)
    if (remaining.length > 0) {
      // Proceed best-effort: the wave executor (script-first guard) and agents
      // fail gracefully per-asset, which is better UX than crashing the graph.
      console.warn('[planner] plan still has issues after repair, proceeding best-effort:', remaining)
    }
  }

  // Assign provider + model from the user's project settings (NOT the LLM), then
  // recompute every cost from the pricing catalog (don't trust the LLM's numbers).
  plan.assets = assignAssetModels(plan.assets, state.projectSettings, writingModel)
  plan.assets = plan.assets.map((a) => ({ ...a, estimatedCost: calculateAssetCost(a) }))
  plan.totalEstimatedCost = plan.assets.reduce((sum, a) => sum + a.estimatedCost, 0)
  plan.status = 'proposed'

  // Normalize language fields: default userLanguage to English and contentLanguages
  // to [userLanguage] if the model omitted them. The plan stays English regardless.
  plan.userLanguage = plan.userLanguage?.trim() || 'en'
  plan.contentLanguages =
    plan.contentLanguages && plan.contentLanguages.length > 0
      ? plan.contentLanguages
      : [plan.userLanguage]

  // The canonical `plan` is English (the agents run on it). For approval, translate
  // a copy into the user's language with a cheap/free model. Best-effort: on any
  // failure translatePlanForApproval returns the English plan unchanged.
  const displayPlan = isEnglish(plan.userLanguage)
    ? null
    : await translatePlanForApproval(plan, plan.userLanguage, llm, getTranslationModel(state.projectSettings))

  return {
    plan,
    displayPlan,
    planStatus: 'proposed',
    contentType: plan.contentType,
    estimatedCost: plan.totalEstimatedCost,
    status: 'awaiting_approval',
    messages: [new AIMessage(`I've created a content plan for you. Please review it below.`)],
  }
}
