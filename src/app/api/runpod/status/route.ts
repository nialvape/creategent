/**
 * RunPod account balance + video endpoint readiness for the Model Lab header.
 *
 * Two different APIs, because neither covers both:
 *  - balance lives only in GraphQL (`myself.clientBalance`); REST v2 exposes
 *    spend history but not the remaining credit.
 *  - worker counts come from the serverless endpoint's own /health.
 *
 * Reported together so the header can answer the two questions worth asking
 * before spending minutes of GPU time: can I afford it, and is there a worker.
 */

import { videoEndpointId } from '@/providers/runpod'

const RUNPOD_GRAPHQL = 'https://api.runpod.io/graphql'
const RUNPOD_REST = 'https://api.runpod.ai/v2'

const BALANCE_QUERY = `query {
  myself {
    clientBalance
    currentSpendPerHr
    clientLifetimeSpend
  }
}`

export interface RunPodStatus {
  credits: {
    balance: number
    spendPerHour: number
    lifetimeSpend: number
  } | null
  /** Null when /health couldn't be read — unknown, not "broken". */
  endpoint: {
    id: string
    idle: number
    initializing: number
    ready: number
    running: number
    throttled: number
    unhealthy: number
    /** Workers that can pick up a job now or are on their way to being able to. */
    available: number
  } | null
  /** Present when part of the lookup failed; the other half may still be set. */
  error?: string
}

async function fetchCredits(apiKey: string): Promise<RunPodStatus['credits']> {
  const res = await fetch(RUNPOD_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query: BALANCE_QUERY }),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`GraphQL ${res.status}`)

  const body = (await res.json()) as {
    data?: { myself?: { clientBalance?: number; currentSpendPerHr?: number; clientLifetimeSpend?: number } }
    errors?: Array<{ message?: string }>
  }
  // GraphQL reports auth failures as a 200 with an errors array, so a non-ok
  // status is not enough to detect them.
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).filter(Boolean).join('; ') || 'GraphQL error')
  }
  const me = body.data?.myself
  if (!me) throw new Error('no account data')

  return {
    balance: me.clientBalance ?? 0,
    spendPerHour: me.currentSpendPerHr ?? 0,
    lifetimeSpend: me.clientLifetimeSpend ?? 0,
  }
}

async function fetchEndpoint(apiKey: string, id: string): Promise<RunPodStatus['endpoint']> {
  const res = await fetch(`${RUNPOD_REST}/${id}/health`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`health ${res.status}`)

  const body = (await res.json()) as {
    workers?: {
      idle?: number
      initializing?: number
      ready?: number
      running?: number
      throttled?: number
      unhealthy?: number
    }
  }
  const w = body.workers ?? {}
  const idle = w.idle ?? 0
  const initializing = w.initializing ?? 0
  const ready = w.ready ?? 0
  const running = w.running ?? 0

  return {
    id,
    idle,
    initializing,
    ready,
    running,
    throttled: w.throttled ?? 0,
    unhealthy: w.unhealthy ?? 0,
    available: idle + initializing + ready + running,
  }
}

export async function GET() {
  const apiKey = process.env.RUNPOD_API_KEY
  if (!apiKey) {
    return Response.json({ error: 'RUNPOD_API_KEY is not set' }, { status: 503 })
  }

  // Settled, not all: a rejected balance lookup shouldn't hide a healthy
  // endpoint, which is the half that matters before starting a run.
  const [credits, endpoint] = await Promise.allSettled([
    fetchCredits(apiKey),
    fetchEndpoint(apiKey, videoEndpointId()),
  ])

  const failures = [credits, endpoint]
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)))

  const payload: RunPodStatus = {
    credits: credits.status === 'fulfilled' ? credits.value : null,
    endpoint: endpoint.status === 'fulfilled' ? endpoint.value : null,
    ...(failures.length ? { error: failures.join('; ') } : {}),
  }

  // Still a 200 when one half worked — the client renders what it got.
  return Response.json(payload, { status: failures.length === 2 ? 502 : 200 })
}
