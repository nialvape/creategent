import { z } from 'zod'
import type { LLMProvider } from '@/types/provider'
import type { ContentPlan } from '@/types/plan'

/**
 * The plan is always authored in English (it's the machine spec the agents run
 * on). For the human approval view, we translate ONLY its human-readable fields
 * into the user's language with a cheap/free model. The canonical English plan is
 * never mutated — this returns a copy used purely for display.
 */

const TranslatedPlanSchema = z.object({
  title: z.string(),
  summary: z.string(),
  styleTone: z.string(),
  styleMood: z.string().optional().default(''),
  assets: z.array(z.object({ name: z.string(), description: z.string() })),
})

/** True when no translation is needed (target language is English / unset). */
export function isEnglish(lang: string | undefined | null): boolean {
  const l = (lang ?? '').trim().toLowerCase()
  return l === '' || l === 'en' || l.startsWith('en-') || l === 'english' || l === 'inglés' || l === 'ingles'
}

/**
 * Translate the user-facing fields of an (English) plan into `targetLang` for the
 * approval view. No-op when the target is English. Best-effort: if the model call
 * or shape check fails, the original English plan is returned so approval never
 * breaks over a translation hiccup (free models can be flaky/rate-limited).
 */
export async function translatePlanForApproval(
  plan: ContentPlan,
  targetLang: string,
  llm: LLMProvider,
  model: string
): Promise<ContentPlan> {
  if (isEnglish(targetLang)) return plan

  try {
    const payload = {
      title: plan.title,
      summary: plan.summary,
      styleTone: plan.style.tone,
      styleMood: plan.style.mood ?? '',
      assets: plan.assets.map((a) => ({ name: a.name, description: a.description })),
    }

    const result = await llm.generateStructuredOutput<z.infer<typeof TranslatedPlanSchema>>({
      prompt: `Translate the human-readable fields of this content plan into ${targetLang}, for display to the user who is reviewing the plan. Translate naturally and faithfully — keep meaning, tone, and length similar. Do NOT translate proper nouns, brand names, hashtags, URLs, or technical model ids. Return the assets array in the SAME order and with the SAME number of items.

${JSON.stringify(payload, null, 2)}`,
      model,
      schema: TranslatedPlanSchema,
    })

    const t = result.data
    // Shape guard: a mismatched asset count would corrupt the mapping below.
    if (!t || t.assets.length !== plan.assets.length) return plan

    return {
      ...plan,
      title: t.title,
      summary: t.summary,
      style: { ...plan.style, tone: t.styleTone, mood: t.styleMood || plan.style.mood },
      assets: plan.assets.map((a, i) => ({
        ...a,
        name: t.assets[i].name,
        description: t.assets[i].description,
      })),
    }
  } catch (err) {
    console.warn('[translate-plan] translation failed, showing the English plan:', err)
    return plan
  }
}
