import { getLLMProvider } from '@/providers/registry'

/**
 * Ridiculously cheap / effectively-free model used only for generating short
 * project titles from a user's first idea. Title generation is a tiny,
 * low-stakes task, so we never want to spend orchestration-model money on it.
 *
 * Gemini 2.5 Flash Lite on OpenRouter is ~$0.0001/1k tokens — a title costs a
 * fraction of a cent. Override with TITLE_MODEL env var if desired (e.g. a
 * `:free` model such as `meta-llama/llama-3.3-70b-instruct:free`).
 *
 * NOTE: must be a slug OpenRouter currently routes. `google/gemini-2.0-flash`
 * and `...-2.0-flash-001` are rejected ("not a valid model ID" / "no endpoints").
 */
const TITLE_MODEL = process.env.TITLE_MODEL || 'google/gemini-2.5-flash-lite'

const SYSTEM_PROMPT = `You are an assistant that creates short titles for social media content projects.
Rules:
- Return ONLY the title, no quotes, no trailing period, no prefixes like "Title:".
- Maximum 6 words.
- Use the same language as the user's idea.
- Be descriptive and specific, not generic.`

function clean(raw: string): string {
  // Strip quotes/whitespace, take first line, cap length defensively.
  let title = raw.trim().split('\n')[0].trim()
  title = title.replace(/^["'“”]+|["'“”]+$/g, '').trim()
  title = title.replace(/^(t[íi]tulo|title)\s*:\s*/i, '').trim()
  if (title.length > 80) title = title.slice(0, 80).trim()
  return title
}

/**
 * Generate a smart project title from the user's idea. Returns null on any
 * failure so callers can keep the default title instead of breaking the flow.
 */
export async function generateProjectTitle(idea: string): Promise<string | null> {
  const trimmed = idea.trim()
  if (!trimmed) return null

  try {
    const { data } = await getLLMProvider().generateText({
      prompt: trimmed.slice(0, 2000),
      model: TITLE_MODEL,
      systemPrompt: SYSTEM_PROMPT,
      maxTokens: 32,
    })
    const title = clean(data ?? '')
    return title || null
  } catch (err) {
    console.error('[title] generation failed:', err)
    return null
  }
}
