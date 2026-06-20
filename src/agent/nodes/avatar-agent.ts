import { getMediaProvider } from '@/providers/registry'
import { uploadAsset, getAssetUrl } from '@/lib/supabase/storage'
import { trackCost } from '@/lib/pricing/tracker'
import { sourceImageUrl, sourceAudioUrl, scriptText } from './_deps'
import type { ContentState } from '@/agent/state'
import type { Asset } from '@/types/asset'
import type { PlanAsset } from '@/types/plan'
import { v4 as uuid } from 'uuid'

const QUALITY_ATTEMPTS: Record<string, number> = { draft: 1, standard: 2, premium: 2 }

/**
 * Talking-head agent. An avatar is produced with an image+audio → video lip-sync
 * model: it consumes the first-frame portrait image and the voice audio clip
 * (both declared in the plan asset's dependencies) and returns a synced talking
 * video. The voice and the first-frame image are generated in an earlier wave,
 * in parallel, before this node runs.
 */
export async function avatarAgentNode(
  state: typeof ContentState.State,
  planAssets?: PlanAsset[]
): Promise<Partial<typeof ContentState.State>> {
  const media = getMediaProvider()
  const plan = state.plan!
  const avatarAssets = (planAssets ?? plan.assets).filter((a) => a.type === 'avatar')
  const maxAttempts = QUALITY_ATTEMPTS[state.projectSettings.qualityPreset] ?? 2

  if (avatarAssets.length === 0) return {}

  const script = scriptText(state.assets)
  const generatedAssets: Asset[] = []
  let totalCost = 0

  for (const planAsset of avatarAssets) {
    const model = planAsset.model || state.projectSettings.preferredAvatarModel
    const imageUrl = sourceImageUrl(planAsset, state.assets)
    const audioUrl = sourceAudioUrl(planAsset, state.assets)

    if (!imageUrl || !audioUrl) {
      const missing = [!imageUrl && 'first-frame image', !audioUrl && 'voice audio']
        .filter(Boolean)
        .join(' and ')
      generatedAssets.push({
        id: uuid(),
        project_id: state.projectId,
        plan_id: null,
        type: 'avatar',
        name: planAsset.name,
        description: planAsset.description,
        status: 'failed',
        storage_path: null,
        public_url: null,
        specs: planAsset.specs,
        provider: 'fal',
        model,
        estimated_cost: planAsset.estimatedCost,
        actual_cost: 0,
        metadata: {
          error: `Missing ${missing} dependency for talking-head animation`,
          planAssetId: planAsset.id,
          script,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      continue
    }

    try {
      const result = await media.generateAvatarVideo({
        imageUrl,
        audioUrl,
        model,
        maxAttempts,
      })

      totalCost += result.cost

      await trackCost({
        project_id: state.projectId,
        asset_id: null,
        provider: 'fal',
        model,
        operation: 'animate_avatar',
        units: planAsset.specs.duration ?? 5,
        unit_type: 'seconds',
        cost_usd: result.cost,
        metadata: { imageUrl, audioUrl },
      })

      // Download from the temporary Fal CDN URL and persist to Supabase Storage.
      let storagePath: string | null = null
      let publicUrl: string | null = result.url ?? null

      if (result.url) {
        try {
          const response = await fetch(result.url)
          const buffer = Buffer.from(await response.arrayBuffer())
          storagePath = await uploadAsset(
            state.projectId,
            buffer,
            `${planAsset.name.replace(/\s/g, '_')}.mp4`,
            'video/mp4'
          )
          publicUrl = await getAssetUrl(storagePath)
        } catch (uploadErr) {
          console.warn('[AvatarAgent] Storage upload failed, keeping temporary URL:', uploadErr)
        }
      }

      if (!publicUrl) {
        throw new Error('Avatar animation produced no playable URL')
      }

      generatedAssets.push({
        id: uuid(),
        project_id: state.projectId,
        plan_id: null,
        type: 'avatar',
        name: planAsset.name,
        description: planAsset.description,
        status: 'completed',
        storage_path: storagePath,
        public_url: publicUrl,
        specs: planAsset.specs,
        provider: 'fal',
        model,
        estimated_cost: planAsset.estimatedCost,
        actual_cost: result.cost,
        metadata: { planAssetId: planAsset.id, imageUrl, audioUrl, script },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
    } catch (err) {
      generatedAssets.push({
        id: uuid(),
        project_id: state.projectId,
        plan_id: null,
        type: 'avatar',
        name: planAsset.name,
        description: planAsset.description,
        status: 'failed',
        storage_path: null,
        public_url: null,
        specs: planAsset.specs,
        provider: 'fal',
        model,
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
