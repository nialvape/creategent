'use client'

import { useEffect, useState } from 'react'
import { Wallet, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Credits {
  balance: number
  spendPerHour: number
  lifetimeSpend: number
}

/**
 * RunPod balance for the lab header. Refetched after every run so the cost of
 * what you just generated shows up without a page reload.
 *
 * All fetching lives inside the effect with state set only from its callbacks:
 * the manual refresh works by bumping `manualKey` rather than calling a loader
 * directly, which keeps the effect the single place that touches the network.
 */
export function RunPodCredits({ refreshKey }: { refreshKey: number }) {
  const [credits, setCredits] = useState<Credits | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [manualKey, setManualKey] = useState(0)

  useEffect(() => {
    // Guards against a slow first response overwriting a newer one when runs
    // finish back to back.
    let cancelled = false

    fetch('/api/runpod/credits', { cache: 'no-store' })
      .then(async (res) => {
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setError(data.error ?? `Failed (${res.status})`)
          setCredits(null)
        } else {
          setCredits(data as Credits)
          setError(null)
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setCredits(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [refreshKey, manualKey])

  if (error) {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-amber-400/70" title={error}>
        <Wallet className="h-3.5 w-3.5" />
        RunPod balance unavailable
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={() => {
        setLoading(true)
        setManualKey((k) => k + 1)
      }}
      title="RunPod account balance — click to refresh"
      className="group flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-white/50 transition-colors hover:text-white/80"
    >
      <Wallet className="h-3.5 w-3.5 text-emerald-400/70" />
      {credits ? (
        <>
          <span className="font-mono text-white/80">${credits.balance.toFixed(2)}</span>
          {credits.spendPerHour > 0 && (
            // A non-zero burn rate means something is still running — worth
            // seeing, since idle pods are the usual way this bill grows.
            <span className="font-mono text-amber-400/70">
              −${credits.spendPerHour.toFixed(2)}/hr
            </span>
          )}
        </>
      ) : (
        <span className="text-white/30">…</span>
      )}
      <RefreshCw
        className={cn(
          'h-3 w-3 text-white/20 transition-opacity group-hover:text-white/50',
          loading && 'animate-spin text-white/50'
        )}
      />
    </button>
  )
}
