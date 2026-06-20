import { getLLMProvider, getMediaProvider } from '@/providers/registry'
import { providerForModel } from '@/lib/models'
import { VIDEO_AGENT_SYSTEM_PROMPT } from '@/agent/prompts/video'
import { uploadAsset, getAssetUrl } from '@/lib/supabase/storage'
import { trackCost } from '@/lib/pricing/tracker'
import { scriptText, sourceImageUrl } from './_deps'
import type { ContentState } from '@/agent/state'
import type { Asset } from '@/types/asset'
import type { PlanAsset } from '@/types/plan'
import { v4 as uuid } from 'uuid'

import { getWritingModel } from '@/agent/state'

const QUALITY_ATTEMPTS: Record<string, number> = { draft: 1, standard: 2, premium: 3 }

export async function videoAgentNode(
  state: typeof ContentState.State,
  planAssets?: PlanAsset[]
): Promise<Partial<typeof ContentState.State>> {
  const llm = getLLMProvider()
  const plan = state.plan!
  const videoAssets = (planAssets ?? plan.assets).filter((a) => a.type === 'video')
  const maxAttempts = QUALITY_ATTEMPTS[state.projectSettings.qualityPreset] ?? 2
  const writingModel = getWritingModel(state.projectSettings)

  if (videoAssets.length === 0) return {}

  const generatedAssets: Asset[] = []
  let totalCost = 0

  const script = scriptText(state.assets)

  for (const planAsset of videoAssets) {
    // Every video is image-to-video: it MUST be animated from a generated
    // first-frame image declared in its dependencies. Fail clearly if missing.
    const videoModel = planAsset.model || state.projectSettings.preferredVideoModel
    const provider = providerForModel('video', videoModel)
    const media = getMediaProvider(videoModel)
    const firstFrameUrl = sourceImageUrl(planAsset, state.assets)

    if (!firstFrameUrl) {
      generatedAssets.push({
        id: uuid(),
        project_id: state.projectId,
        plan_id: null,
        type: 'video',
        name: planAsset.name,
        description: planAsset.description,
        status: 'failed',
        storage_path: null,
        public_url: null,
        specs: planAsset.specs,
        provider,
        model: videoModel,
        estimated_cost: planAsset.estimatedCost,
        actual_cost: 0,
        metadata: {
          error: 'No completed first-frame image found for image-to-video (check dependencies)',
          planAssetId: planAsset.id,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      continue
    }

    const brief = state.assetBriefs?.[planAsset.id]
    const instruction = brief?.instruction ?? planAsset.description

    try {
      const promptResult = await llm.generateText({
        prompt: `Create an optimized video generation prompt for: ${instruction}
${brief?.correction ? `\nThe director sent this back for a fix — address it:\n${brief.correction}` : ''}
${script ? `\nScript/narration context (what the viewer should see at this moment):\n${script}` : ''}
Global creative anchor: ${state.styleBrief ?? ''}
Platform: ${planAsset.platform}
Duration: ${planAsset.specs.duration ?? 5} seconds`,
        model: writingModel,
        systemPrompt: VIDEO_AGENT_SYSTEM_PROMPT,
        maxTokens: 200,
      })

      const videoPrompt = promptResult.data ?? planAsset.description

      const result = await media.generateVideo({
        prompt: videoPrompt,
        model: videoModel,
        imageUrl: firstFrameUrl,
        width: planAsset.specs.width ?? 1080,
        height: planAsset.specs.height ?? 1920,
        duration: planAsset.specs.duration ?? 5,
        format: planAsset.specs.format ?? 'mp4',
        maxAttempts,
      })

      totalCost += result.cost

      await trackCost({
        project_id: state.projectId,
        asset_id: null,
        provider,
        model: videoModel,
        operation: 'generate_video',
        units: planAsset.specs.duration ?? 5,
        unit_type: 'seconds',
        cost_usd: result.cost,
        metadata: { prompt: videoPrompt },
      })

      // Download video from temporary Fal CDN URL and upload to Supabase Storage
      let storagePath: string | null = null
      let publicUrl: string | null = result.url ?? null

      if (result.url) {
        try {
          const response = await fetch(result.url)
          const buffer = Buffer.from(await response.arrayBuffer())
          const ext = planAsset.specs.format ?? 'mp4'
          storagePath = await uploadAsset(
            state.projectId,
            buffer,
            `${planAsset.name.replace(/\s/g, '_')}.${ext}`,
            `video/${ext}`
          )
          publicUrl = await getAssetUrl(storagePath)
        } catch (uploadErr) {
          console.warn('[VideoAgent] Storage upload failed, keeping temporary URL:', uploadErr)
        }
      }

      generatedAssets.push({
        id: uuid(),
        project_id: state.projectId,
        plan_id: null,
        type: 'video',
        name: planAsset.name,
        description: planAsset.description,
        status: 'completed',
        storage_path: storagePath,
        public_url: publicUrl,
        specs: planAsset.specs,
        provider,
        model: videoModel,
        estimated_cost: planAsset.estimatedCost,
        actual_cost: result.cost,
        metadata: { prompt: videoPrompt, platform: planAsset.platform, planAssetId: planAsset.id, firstFrameUrl },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
    } catch (err) {
      generatedAssets.push({
        id: uuid(),
        project_id: state.projectId,
        plan_id: null,
        type: 'video',
        name: planAsset.name,
        description: planAsset.description,
        status: 'failed',
        storage_path: null,
        public_url: null,
        specs: planAsset.specs,
        provider,
        model: videoModel,
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
