import { getLLMProvider } from '@/providers/registry'
import { DEFAULT_MEDIA_UNDERSTANDING_MODEL } from '@/agent/state'
import type { ContentState } from '@/agent/state'
import {
  REFERENCE_SYSTEM_PROMPT,
  IMAGE_UNDERSTANDING_PROMPT,
  VIDEO_UNDERSTANDING_PROMPT,
  AUDIO_UNDERSTANDING_PROMPT,
} from '@/agent/prompts/reference'
import type { ReferenceMedium } from '@/types/graph-state'

const PROMPT_BY_KIND: Record<ReferenceMedium['kind'], string> = {
  image: IMAGE_UNDERSTANDING_PROMPT,
  video: VIDEO_UNDERSTANDING_PROMPT,
  audio: AUDIO_UNDERSTANDING_PROMPT,
}

/**
 * Reference-media intake. For every file the user attached, dispatch it to the
 * understanding sub-agent for its type (image / video / audio) and attach the
 * resulting description. Runs ONCE before the planner (the planner then reasons
 * about each file's purpose). Best-effort: a file that can't be analyzed gets a
 * fallback note rather than crashing the graph. Descriptions persist in the
 * checkpoint, so the re-plan loop never re-runs this.
 */
export async function referenceIntakeNode(
  state: typeof ContentState.State
): Promise<Partial<typeof ContentState.State>> {
  const media = state.referenceMedia ?? []
  if (media.length === 0) return {}

  const llm = getLLMProvider()
  let cost = 0

  const described = await Promise.all(
    media.map(async (m): Promise<ReferenceMedium> => {
      // Already described (e.g. resumed run) — leave as-is.
      if (m.description) return m
      try {
        const res = await llm.describeMedia({
          url: m.url,
          mediaType: m.mimeType,
          kind: m.kind,
          prompt: PROMPT_BY_KIND[m.kind],
          model: DEFAULT_MEDIA_UNDERSTANDING_MODEL,
          systemPrompt: REFERENCE_SYSTEM_PROMPT,
        })
        cost += res.cost
        const description = res.data?.trim()
        return { ...m, description: description || `(no description produced for this ${m.kind})` }
      } catch (err) {
        console.warn(`[reference-intake] failed to analyze ${m.kind} "${m.name}":`, err instanceof Error ? err.message : err)
        return { ...m, description: `(could not analyze this ${m.kind} — "${m.name}")` }
      }
    })
  )

  console.log(`[reference-intake] described ${described.length} file(s), cost=$${cost}`)
  return { referenceMedia: described, actualCost: cost }
}
