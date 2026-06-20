import { getLLMProvider } from '@/providers/registry'
import { COPY_AGENT_SYSTEM_PROMPT } from '@/agent/prompts/copy'
import { trackCost } from '@/lib/pricing/tracker'
import { getWritingModel } from '@/agent/state'
import type { ContentState } from '@/agent/state'
import type { Asset } from '@/types/asset'
import type { PlanAsset } from '@/types/plan'
import { v4 as uuid } from 'uuid'

export async function copyAgentNode(
  state: typeof ContentState.State,
  planAssets?: PlanAsset[]
): Promise<Partial<typeof ContentState.State>> {
  const llm = getLLMProvider()
  const plan = state.plan!
  const textAssets = (planAssets ?? plan.assets).filter((a) => a.type === 'text')

  if (textAssets.length === 0) return {}

  const generatedAssets: Asset[] = []
  let totalCost = 0
  // Always use the writing model for copy — overrides whatever the plan specifies
  const writingModel = getWritingModel(state.projectSettings)
  // Audience-facing copy (script dialogue, captions) is written in the content language(s).
  const contentLangs = plan.contentLanguages?.join(', ') || plan.userLanguage || 'the user\'s language'

  for (const planAsset of textAssets) {
    const brief = state.assetBriefs?.[planAsset.id]
    const instruction = brief?.instruction ?? planAsset.description

    const prompt = `Generate ${planAsset.name} for ${planAsset.platform}.

Director's brief for this asset:
${instruction}
${brief?.correction ? `\nThe director sent this back for a fix — address it precisely:\n${brief.correction}` : ''}
Global creative anchor: ${state.styleBrief ?? 'Not provided'}
Content language(s) — write the copy in: ${contentLangs}

Return ONLY the copy text, ready to use. Write in the content language(s) above.`

    try {
      const result = await llm.generateText({
        prompt,
        model: writingModel,
        systemPrompt: COPY_AGENT_SYSTEM_PROMPT,
        maxTokens: 500,
      })

      totalCost += result.cost

      await trackCost({
        project_id: state.projectId,
        asset_id: null,
        provider: 'openrouter',
        model: writingModel,
        operation: 'generate_copy',
        units: 500,
        unit_type: 'tokens',
        cost_usd: result.cost,
        metadata: { asset_name: planAsset.name },
      })

      const asset: Asset = {
        id: uuid(),
        project_id: state.projectId,
        plan_id: null,
        type: 'text',
        name: planAsset.name,
        description: planAsset.description,
        status: 'completed',
        storage_path: null,
        public_url: null,
        specs: planAsset.specs,
        provider: 'openrouter',
        model: writingModel,
        estimated_cost: planAsset.estimatedCost,
        actual_cost: result.cost,
        metadata: { content: result.data ?? '', platform: planAsset.platform, planAssetId: planAsset.id },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      generatedAssets.push(asset)
    } catch (err) {
      generatedAssets.push({
        id: uuid(),
        project_id: state.projectId,
        plan_id: null,
        type: 'text',
        name: planAsset.name,
        description: planAsset.description,
        status: 'failed',
        storage_path: null,
        public_url: null,
        specs: planAsset.specs,
        provider: 'openrouter',
        model: writingModel,
        estimated_cost: planAsset.estimatedCost,
        actual_cost: 0,
        metadata: { error: String(err), planAssetId: planAsset.id },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
    }
  }

  return { assets: generatedAssets, actualCost: totalCost }
}
