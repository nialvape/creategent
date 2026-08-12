'use client'

import { useEffect, useState } from 'react'
import { Wallet, RefreshCw, AlertTriangle, Circle } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Status {
  credits: { balance: number; spendPerHour: number; lifetimeSpend: number } | null
  endpoint: {
    id: string
    idle: number
    initializing: number
    ready: number
    running: number
    throttled: number
    unhealthy: number
    available: number
  } | null
  error?: string
}

type Health = {
  tone: 'ok' | 'warn' | 'bad' | 'idle'
  label: string
  detail: string
}

/**
 * Reads worker counts as something a person can act on.
 *
 * Zero workers is deliberately NOT a warning: the endpoint runs at
 * workersMin 0, so scaling to zero while idle is its normal resting state and
 * the next run simply pays a cold start. The states worth interrupting someone
 * for are the two where starting a run would waste their time.
 */
function healthOf(endpoint: Status['endpoint']): Health | null {
  if (!endpoint) return null

  if (endpoint.unhealthy > 0 && endpoint.available === 0) {
    return {
      tone: 'bad',
      label: 'worker crash-looping',
      detail: `${endpoint.unhealthy} unhealthy worker(s). The container exits before the handler starts — a run will sit queued. Check the worker logs in the RunPod console.`,
    }
  }
  if (endpoint.throttled > 0) {
    return {
      tone: 'warn',
      label: 'no GPU capacity',
      detail: `${endpoint.throttled} worker(s) throttled: the endpoint's GPU pool has nothing free in its datacenter. Runs will queue until capacity frees up.`,
    }
  }
  if (endpoint.available > 0) {
    const warm = endpoint.idle + endpoint.ready + endpoint.running
    return {
      tone: 'ok',
      label: warm > 0 ? 'worker warm' : 'worker starting',
      detail: `idle ${endpoint.idle} · ready ${endpoint.ready} · running ${endpoint.running} · initializing ${endpoint.initializing}`,
    }
  }
  return {
    tone: 'idle',
    label: 'scaled to zero',
    detail: 'No worker running — normal while idle. The next run pays a cold start while the image is pulled.',
  }
}

const TONE_CLASS: Record<Health['tone'], string> = {
  ok: 'text-emerald-400/80',
  warn: 'text-amber-400/90',
  bad: 'text-red-400/90',
  idle: 'text-white/30',
}

/**
 * RunPod balance and video-endpoint readiness. Refetched after every run so
 * the cost of what you just generated, and any capacity problem it hit, show
 * up without a page reload.
 */
export function RunPodStatus({ refreshKey }: { refreshKey: number }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [manualKey, setManualKey] = useState(0)

  useEffect(() => {
    // Guards against a slow response overwriting a newer one when runs finish
    // back to back.
    let cancelled = false

    fetch('/api/runpod/status', { cache: 'no-store' })
      .then(async (res) => {
        const data = await res.json()
        if (cancelled) return
        if (!res.ok && !data.credits && !data.endpoint) {
          setFatal(data.error ?? `Failed (${res.status})`)
          setStatus(null)
        } else {
          setStatus(data as Status)
          setFatal(null)
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setFatal(err instanceof Error ? err.message : String(err))
        setStatus(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [refreshKey, manualKey])

  const health = healthOf(status?.endpoint ?? null)

  return (
    <div className="flex items-center gap-2">
      {/* Endpoint readiness first: it decides whether a run is worth starting. */}
      {health && (
        <span
          title={health.detail}
          className={cn('flex items-center gap-1.5 text-[11px]', TONE_CLASS[health.tone])}
        >
          {health.tone === 'bad' || health.tone === 'warn' ? (
            <AlertTriangle className="h-3.5 w-3.5" />
          ) : (
            <Circle
              className={cn('h-2 w-2', health.tone === 'ok' && 'fill-current')}
              strokeWidth={3}
            />
          )}
          {health.label}
        </span>
      )}

      <button
        type="button"
        onClick={() => {
          setLoading(true)
          setManualKey((k) => k + 1)
        }}
        title={fatal ?? 'RunPod account balance — click to refresh'}
        className="group flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-white/50 transition-colors hover:text-white/80"
      >
        <Wallet
          className={cn('h-3.5 w-3.5', fatal ? 'text-amber-400/70' : 'text-emerald-400/70')}
        />
        {status?.credits ? (
          <>
            <span className="font-mono text-white/80">${status.credits.balance.toFixed(2)}</span>
            {status.credits.spendPerHour > 0 && (
              // A non-zero burn rate means something is still running — worth
              // seeing, since idle pods are the usual way this bill grows.
              <span className="font-mono text-amber-400/70">
                −${status.credits.spendPerHour.toFixed(2)}/hr
              </span>
            )}
          </>
        ) : (
          <span className="text-white/30">{fatal || status?.error ? 'balance n/a' : '…'}</span>
        )}
        <RefreshCw
          className={cn(
            'h-3 w-3 text-white/20 transition-opacity group-hover:text-white/50',
            loading && 'animate-spin text-white/50'
          )}
        />
      </button>
    </div>
  )
}
