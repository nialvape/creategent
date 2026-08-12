/**
 * RunPod account balance for the Model Lab header.
 *
 * The REST v2 API only exposes spend *history* (/v2/billing/*), not the
 * remaining balance, so this goes through RunPod's GraphQL API — the documented
 * home of `myself.clientBalance` (see https://graphql-spec.runpod.io/).
 */

const RUNPOD_GRAPHQL = 'https://api.runpod.io/graphql'

const QUERY = `query {
  myself {
    clientBalance
    currentSpendPerHr
    clientLifetimeSpend
  }
}`

export interface RunPodCredits {
  /** Remaining prepaid credit, USD. */
  balance: number
  /** Current burn rate across every running pod/worker, USD per hour. */
  spendPerHour: number
  /** Total spent on the account to date, USD. */
  lifetimeSpend: number
}

export async function GET() {
  const apiKey = process.env.RUNPOD_API_KEY
  if (!apiKey) {
    return Response.json({ error: 'RUNPOD_API_KEY is not set' }, { status: 503 })
  }

  try {
    const res = await fetch(RUNPOD_GRAPHQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query: QUERY }),
      cache: 'no-store',
    })

    if (!res.ok) {
      return Response.json(
        { error: `RunPod GraphQL failed (${res.status})` },
        { status: 502 }
      )
    }

    const body = (await res.json()) as {
      data?: { myself?: { clientBalance?: number; currentSpendPerHr?: number; clientLifetimeSpend?: number } }
      errors?: Array<{ message?: string }>
    }

    // GraphQL reports auth/permission problems as a 200 with an errors array,
    // so a non-ok status is not enough to detect failure here.
    if (body.errors?.length) {
      return Response.json(
        { error: body.errors.map((e) => e.message).filter(Boolean).join('; ') || 'RunPod GraphQL error' },
        { status: 502 }
      )
    }

    const me = body.data?.myself
    if (!me) return Response.json({ error: 'RunPod returned no account data' }, { status: 502 })

    const credits: RunPodCredits = {
      balance: me.clientBalance ?? 0,
      spendPerHour: me.currentSpendPerHr ?? 0,
      lifetimeSpend: me.clientLifetimeSpend ?? 0,
    }
    return Response.json(credits)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: message }, { status: 502 })
  }
}
