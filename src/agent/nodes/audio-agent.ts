import { getLLMProvider, getAudioProvider } from '@/providers/registry'
import { providerForModel } from '@/lib/models'
import { fetchAsBase64 } from '@/providers/runpod'
import { AUDIO_AGENT_SYSTEM_PROMPT } from '@/agent/prompts/audio'
import { uploadAsset, getAssetUrl } from '@/lib/supabase/storage'
import { trackCost } from '@/lib/pricing/tracker'
import { getWritingModel } from '@/agent/state'
import type { ContentState } from '@/agent/state'
import type { Asset } from '@/types/asset'
import type { PlanAsset } from '@/types/plan'
import { v4 as uuid } from 'uuid'

const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL' // Bella — multilingual
const QUALITY_ATTEMPTS: Record<string, number> = { draft: 1, standard: 2, premium: 3 }

export async function audioAgentNode(
  state: typeof ContentState.State,
  planAssets?: PlanAsset[]
): Promise<Partial<typeof ContentState.State>> {
  const llm = getLLMProvider()
  const plan = state.plan!
  const audioAssets = (planAssets ?? plan.assets).filter((a) => a.type === 'audio')
  const maxAttempts = QUALITY_ATTEMPTS[state.projectSettings.qualityPreset] ?? 2
  const writingModel = getWritingModel(state.projectSettings)
  // The audience-facing voiceover is written in the plan's content language(s).
  const contentLangs = plan.contentLanguages?.join(', ') || plan.userLanguage || 'the user\'s language'

  if (audioAssets.length === 0) return {}

  // Zero-shot voice cloning (Chatterbox only): when the project has a reference
  // voice sample, fetch + base64 it ONCE and clone it for every voiceover so the
  // whole package speaks in the same voice.
  let referenceAudioB64: string | undefined
  if (state.projectSettings.voiceCloneReferenceUrl) {
    try {
      referenceAudioB64 = await fetchAsBase64(state.projectSettings.voiceCloneReferenceUrl)
    } catch (refErr) {
      console.warn('[AudioAgent] Could not load voice-clone reference, using default voice:', refErr)
    }
  }

  const generatedAssets: Asset[] = []
  let totalCost = 0

  for (const planAsset of audioAssets) {
    const provider = providerForModel('audio', planAsset.model)
    const audio = getAudioProvider(planAsset.model)
    const brief = state.assetBriefs?.[planAsset.id]
    try {
      // The director decides WHAT to voice (the selected script slice) and HOW
      // (delivery direction). The writing model turns that into the EXACT spoken
      // words — and ONLY those words reach TTS, never the scene/stage directions.
      const excerpt = brief?.voice?.scriptExcerpt ?? planAsset.description
      const direction = brief?.voice?.direction ?? brief?.instruction ?? 'Natural, clear delivery.'

      const writeResult = await llm.generateText({
        prompt: `Write the EXACT words to be spoken aloud for this voiceover.

Source — the director's selected script slice (extract ONLY what is actually spoken; ignore any scene/stage directions):
${excerpt}
${brief?.correction ? `\nThe director sent this back for a fix — address it:\n${brief.correction}` : ''}
Delivery direction: ${direction}
Duration: approximately ${planAsset.specs.duration ?? 30} seconds.
Content language(s) — write the spoken words in: ${contentLangs}

Output ONLY the spoken words, in the content language(s) above. No scene/stage directions, no character names, no labels, no quotation marks — just what the voice says.`,
        model: writingModel,
        systemPrompt: AUDIO_AGENT_SYSTEM_PROMPT,
        maxTokens: 400,
      })
      totalCost += writeResult.cost
      const script = (writeResult.data ?? excerpt).trim()

      const result = await audio.generateSpeech({
        text: script,
        voiceId: DEFAULT_VOICE_ID,
        modelId: planAsset.model,
        referenceAudioB64,
        maxAttempts,
      })

      totalCost += result.cost

      // Output format varies by provider: ElevenLabs returns mp3, Chatterbox wav.
      const ext = (result.metadata?.ext as string) ?? 'mp3'
      const contentType = (result.metadata?.contentType as string) ?? 'audio/mpeg'

      // Upload audio to Supabase Storage
      let storagePath: string | null = null
      let publicUrl: string | null = null

      if (result.data) {
        try {
          storagePath = await uploadAsset(
            state.projectId,
            result.data,
            `${planAsset.name.replace(/\s/g, '_')}.${ext}`,
            contentType
          )
          publicUrl = await getAssetUrl(storagePath)
        } catch (uploadErr) {
          // Storage upload failed (commonly Storage RLS blocking the anon key —
          // set SUPABASE_SERVICE_ROLE_KEY). Fall back to an inline data URL so the
          // clip is still playable instead of silently saving an unplayable asset.
          console.warn('[AudioAgent] Storage upload failed, using inline data URL:', uploadErr)
          publicUrl = `data:${contentType};base64,${result.data.toString('base64')}`
        }
      }

      if (!publicUrl) {
        throw new Error('Audio generated but no playable URL could be produced')
      }

      await trackCost({
        project_id: state.projectId,
        asset_id: null,
        provider,
        model: planAsset.model,
        operation: 'text_to_speech',
        units: script.length,
        unit_type: 'characters',
        cost_usd: result.cost,
        metadata: {},
      })

      generatedAssets.push({
        id: uuid(),
        project_id: state.projectId,
        plan_id: null,
        type: 'audio',
        name: planAsset.name,
        description: planAsset.description,
        status: 'completed',
        storage_path: storagePath,
        public_url: publicUrl,
        specs: planAsset.specs,
        provider,
        model: planAsset.model,
        estimated_cost: planAsset.estimatedCost,
        actual_cost: result.cost,
        metadata: { script, platform: planAsset.platform, planAssetId: planAsset.id, voiceCloned: !!referenceAudioB64 },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
    } catch (err) {
      generatedAssets.push({
        id: uuid(),
        project_id: state.projectId,
        plan_id: null,
        type: 'audio',
        name: planAsset.name,
        description: planAsset.description,
        status: 'failed',
        storage_path: null,
        public_url: null,
        specs: planAsset.specs,
        provider,
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
