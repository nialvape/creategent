import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { generateText, generateObject } from 'ai'
import { z } from 'zod'
import type { LLMProvider, GenerationResult } from '@/types/provider'

/**
 * Slugs that were once used in the catalog / saved into project settings but
 * are NOT routable on OpenRouter (cause "not a valid model ID" / "no endpoints"
 * errors). Mapped to the closest currently-available model so legacy DB rows
 * keep working without a migration.
 */
const MODEL_ALIASES: Record<string, string> = {
  'google/gemini-2.0-flash': 'google/gemini-2.5-flash-lite',
  'google/gemini-2.0-flash-001': 'google/gemini-2.5-flash-lite',
}

function resolveModel(model: string): string {
  return MODEL_ALIASES[model] ?? model
}

export class OpenRouterAdapter implements LLMProvider {
  private client: ReturnType<typeof createOpenRouter>

  constructor(apiKey: string) {
    this.client = createOpenRouter({
      apiKey,
      headers: {
        'HTTP-Referer': 'https://creategent.app',
        'X-Title': 'CreateGent',
      },
    })
  }

  async generateText(params: {
    prompt: string
    model: string
    systemPrompt?: string
    maxTokens?: number
  }): Promise<GenerationResult<string>> {
    const model = resolveModel(params.model)
    console.log(`[llm] generateText: model=${model}`)
    try {
      const result = await generateText({
        model: this.client(model),
        prompt: params.prompt,
        system: params.systemPrompt,
        maxOutputTokens: params.maxTokens ?? 4096,
      })

      const cost = this.extractCost(result)
      console.log(`[llm] generateText: done model=${model} cost=$${cost}`)

      return {
        data: result.text,
        cost,
        model,
        provider: 'openrouter',
      }
    } catch (err) {
      console.error(`[llm] generateText: FAILED model=${model} —`, err instanceof Error ? err.message : err)
      throw err
    }
  }

  async generateStructuredOutput<T>(params: {
    prompt: string
    model: string
    schema: z.ZodSchema<T>
    systemPrompt?: string
  }): Promise<GenerationResult<T>> {
    const model = resolveModel(params.model)
    console.log(`[llm] generateStructuredOutput: model=${model}`)
    try {
      const result = await generateObject({
        model: this.client(model),
        prompt: params.prompt,
        system: params.systemPrompt,
        schema: params.schema as z.ZodSchema,
      })

      const cost = this.extractCost(result)
      console.log(`[llm] generateStructuredOutput: done model=${model} cost=$${cost}`)

      return {
        data: result.object as T,
        cost,
        model,
        provider: 'openrouter',
      }
    } catch (err) {
      console.error(`[llm] generateStructuredOutput: FAILED model=${model} —`, err instanceof Error ? err.message : err)
      // AI_NoObjectGeneratedError carries the raw model text + the validation
      // cause; log them so schema mismatches are actually diagnosable.
      const e = err as { cause?: unknown; text?: string }
      if (e?.cause) console.error('[llm]   cause:', e.cause)
      if (e?.text) console.error('[llm]   raw text:', e.text.slice(0, 2000))
      throw err
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractCost(result: any): number {
    try {
      const meta = result?.providerMetadata ?? result?.experimental_providerMetadata
      if (meta?.openrouter?.cost) return Number(meta.openrouter.cost)
    } catch {}
    return 0
  }
}
