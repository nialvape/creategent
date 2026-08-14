import { createPromptRating, getPromptRatings } from '@/lib/supabase/db'
import { AXIS_BY_ID, MAX_STARS } from '@/lib/rating-axes'
import {
  isRatedCapability,
  type PromptRatingInput,
  type RatedAttachment,
  type RatedCapability,
} from '@/types/rating'

export const runtime = 'nodejs'

/** Auth is handled by the proxy (src/proxy.ts) for every /api/* path. */

class BadInput extends Error {}

function asString(value: unknown, field: string, { required = false } = {}): string {
  if (typeof value !== 'string') {
    if (required) throw new BadInput(`${field} is required`)
    return ''
  }
  const trimmed = value.trim()
  if (required && !trimmed) throw new BadInput(`${field} is required`)
  return trimmed
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Scores are the point of the whole row, so they're checked strictly: an unknown
 * axis id or an out-of-range star would silently poison the corpus the export
 * feeds to an LLM.
 */
function parseScores(value: unknown, capability: RatedCapability): Record<string, number> {
  const raw = asRecord(value)
  const scores: Record<string, number> = {}

  for (const [id, star] of Object.entries(raw)) {
    const axis = AXIS_BY_ID[id]
    if (!axis) throw new BadInput(`Unknown rating axis "${id}"`)
    if (!axis.capabilities.includes(capability)) {
      throw new BadInput(`Axis "${id}" does not apply to ${capability}`)
    }
    if (typeof star !== 'number' || !Number.isInteger(star) || star < 1 || star > MAX_STARS) {
      throw new BadInput(`Score for "${id}" must be a whole number from 1 to ${MAX_STARS}`)
    }
    scores[id] = star
  }

  if (Object.keys(scores).length === 0) {
    throw new BadInput('Score at least one axis before saving.')
  }
  return scores
}

function parseAttachments(value: unknown): RatedAttachment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = asRecord(entry)
    const kind = item.kind
    if (kind !== 'image' && kind !== 'video' && kind !== 'audio') return []
    return [
      {
        name: typeof item.name === 'string' ? item.name : '',
        mimeType: typeof item.mimeType === 'string' ? item.mimeType : '',
        kind,
      },
    ]
  })
}

/**
 * Only an http(s) output is worth keeping. Small results come back as inline
 * `data:` URLs (see api/testing/route.ts) and storing megabytes of base64 in a
 * text column would bloat every export that reads this table.
 */
function parseOutputUrl(value: unknown): string | null {
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null
}

export async function POST(req: Request) {
  try {
    const body = asRecord(await req.json())

    const capability = body.capability
    if (!isRatedCapability(capability)) {
      throw new BadInput(`Cannot rate capability "${String(capability)}"`)
    }

    const attachments = parseAttachments(body.attachments)
    const attachmentKinds = attachments.reduce<Record<string, number>>((acc, file) => {
      acc[file.kind] = (acc[file.kind] ?? 0) + 1
      return acc
    }, {})

    const model = asString(body.model, 'model', { required: true })
    const notes = asString(body.notes, 'notes')

    const rating: PromptRatingInput = {
      capability,
      model,
      model_name: asString(body.model_name, 'model_name') || model,
      provider: asString(body.provider, 'provider') || 'unknown',
      prompt: asString(body.prompt, 'prompt', { required: true }),
      negative_prompt: asString(body.negative_prompt, 'negative_prompt') || null,
      attachment_count: attachments.length,
      attachment_kinds: attachmentKinds,
      attachments,
      settings: asRecord(body.settings),
      run_metadata: asRecord(body.run_metadata),
      duration_ms: asNumberOrNull(body.duration_ms),
      cost_usd: asNumberOrNull(body.cost_usd),
      output_url: parseOutputUrl(body.output_url),
      scores: parseScores(body.scores, capability),
      notes: notes || null,
    }

    const saved = await createPromptRating(rating)
    return Response.json(saved)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof BadInput) return Response.json({ error: message }, { status: 400 })
    console.error('[lab-ratings] save failed:', message)
    return Response.json({ error: message }, { status: 500 })
  }
}

/**
 * Returns the whole corpus by default. The export dialog fetches once and
 * filters in the browser: these are hand-written evaluations, so the volume is
 * small and switching a filter should not cost a round trip.
 */
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams
    const ratings = await getPromptRatings({
      model: params.get('model') ?? undefined,
      capability: params.get('capability') ?? undefined,
    })
    return Response.json({ ratings })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[lab-ratings] load failed:', message)
    return Response.json({ error: message }, { status: 500 })
  }
}
