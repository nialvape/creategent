import { getLLMProvider, getMediaProvider } from '@/providers/registry'
import { VISUAL_AGENT_SYSTEM_PROMPT } from '@/agent/prompts/visual'
import { uploadAsset, getAssetUrl } from '@/lib/supabase/storage'
import { trackCost } from '@/lib/pricing/tracker'
import { getWritingModel } from '@/agent/state'
import { scriptText } from './_deps'
import type { ContentState } from '@/agent/state'
import type { Asset } from '@/types/asset'
import type { PlanAsset } from '@/types/plan'
import { v4 as uuid } from 'uuid'

const QUALITY_ATTEMPTS: Record<string, number> = { draft: 1, standard: 2, premium: 3 }

export async function visualAgentNode(
  state: typeof ContentState.State,
  planAssets?: PlanAsset[]
): Promise<Partial<typeof ContentState.State>> {
  const llm = getLLMProvider()
  const media = getMediaProvider()
  const plan = state.plan!
  const imageAssets = (planAssets ?? plan.assets).filter((a) => a.type === 'image')
  const maxAttempts = QUALITY_ATTEMPTS[state.projectSettings.qualityPreset] ?? 2
  const writingModel = getWritingModel(state.projectSettings)

  if (imageAssets.length === 0) return {}

  const generatedAssets: Asset[] = []
  let totalCost = 0
  // Images are derived from the script: it tells us what each scene must show.
  const script = scriptText(state.assets)

  for (const planAsset of imageAssets) {
    const brief = state.assetBriefs?.[planAsset.id]
    const instruction = brief?.instruction ?? planAsset.description
    // Is this image the first-frame portrait for a talking-head avatar? (an avatar
    // asset depends on it). If so, it will be lip-synced, so it must be framed as a
    // clean, unobstructed portrait — not a stylized full-body/selfie shot.
    const isAvatarPortrait = plan.assets.some(
      (a) => a.type === 'avatar' && (a.dependencies ?? []).includes(planAsset.id)
    )
    try {
      // Step 1: Engineer the image prompt
      const promptResult = await llm.generateText({
        prompt: `Create an optimized image generation prompt for: ${instruction}
${brief?.correction ? `\nThe director sent this back for a fix — address it:\n${brief.correction}` : ''}
${script ? `\nScript/scene context (what this frame must depict):\n${script}` : ''}
${isAvatarPortrait ? `\nIMPORTANT — this image is the FIRST FRAME for a talking-head avatar that will be lip-synced to a voice. Frame it as a clean talking-head portrait: a single person, front-facing, head-and-shoulders close-up with the face filling much of the frame, eyes open looking toward camera, and the mouth fully visible and UNOBSTRUCTED — no phone, hand, microphone, or sunglasses covering the face. Even lighting, simple background. Do NOT make it a full-body or selfie-with-phone shot.` : ''}
Global creative anchor: ${state.styleBrief ?? ''}
Platform: ${planAsset.platform}
Aspect ratio: ${planAsset.specs.aspectRatio ?? '1:1'}`,
        model: writingModel,
        systemPrompt: VISUAL_AGENT_SYSTEM_PROMPT,
        maxTokens: 200,
      })

      const imagePrompt = promptResult.data ?? planAsset.description

      // Step 2: Generate the image
      const result = await media.generateImage({
        prompt: imagePrompt,
        model: planAsset.model,
        width: planAsset.specs.width ?? 1080,
        height: planAsset.specs.height ?? 1080,
        format: planAsset.specs.format ?? 'jpeg',
        maxAttempts,
      })

      totalCost += result.cost

      await trackCost({
        project_id: state.projectId,
        asset_id: null,
        provider: 'fal',
        model: planAsset.model,
        operation: 'generate_image',
        units: 1,
        unit_type: 'image',
        cost_usd: result.cost,
        metadata: { prompt: imagePrompt },
      })

      // Download image from temporary Fal CDN URL and upload to Supabase Storage
      let storagePath: string | null = null
      let publicUrl: string | null = result.url ?? null

      if (result.url) {
        try {
          const response = await fetch(result.url)
          const buffer = Buffer.from(await response.arrayBuffer())
          const ext = (planAsset.specs.format ?? 'jpeg').replace('jpg', 'jpeg')
          storagePath = await uploadAsset(
            state.projectId,
            buffer,
            `${planAsset.name.replace(/\s/g, '_')}.${ext}`,
            `image/${ext}`
          )
          publicUrl = await getAssetUrl(storagePath)
        } catch (uploadErr) {
          console.warn('[VisualAgent] Storage upload failed, keeping temporary URL:', uploadErr)
        }
      }

      const asset: Asset = {
        id: uuid(),
        project_id: state.projectId,
        plan_id: null,
        type: 'image',
        name: planAsset.name,
        description: planAsset.description,
        status: 'completed',
        storage_path: storagePath,
        public_url: publicUrl,
        specs: planAsset.specs,
        provider: 'fal',
        model: planAsset.model,
        estimated_cost: planAsset.estimatedCost,
        actual_cost: result.cost,
        metadata: { prompt: imagePrompt, platform: planAsset.platform, planAssetId: planAsset.id },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      generatedAssets.push(asset)
    } catch (err) {
      generatedAssets.push({
        id: uuid(),
        project_id: state.projectId,
        plan_id: null,
        type: 'image',
        name: planAsset.name,
        description: planAsset.description,
        status: 'failed',
        storage_path: null,
        public_url: null,
        specs: planAsset.specs,
        provider: 'fal',
        model: planAsset.model,
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
