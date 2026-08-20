'use client'

import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Loader2, Power, Square } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Start and stop the ComfyUI lab Pod without leaving the app.
 *
 * The button does not talk to Beam directly and neither does the API route
 * behind it: creating a Pod needs the Beam SDK, which is Python and gRPC, and
 * Vercel cannot run it. Both hops end at `beam/lab/launch.py`, a task queue
 * whose job is to call `comfyui.create()` from inside Beam and hand back a URL.
 *
 * Starting is idempotent on the Beam side — a second click returns the pod that
 * is already up rather than a second RTX 5090.
 */

interface PodState {
  state: 'stopped' | 'running' | 'failed' | 'unknown'
  url?: string
  containerId?: string
  error?: string
}

export function ComfyLabControl() {
  const [pod, setPod] = useState<PodState>({ state: 'unknown' })
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const call = useCallback(async (action: string, extra: Record<string, unknown> = {}) => {
    const res = await fetch('/api/testing/weights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    })
    const data = (await res.json()) as Record<string, unknown>
    if (!res.ok || data.ok === false) {
      throw new Error(typeof data.error === 'string' ? data.error : `request failed (${res.status})`)
    }
    return data as unknown as PodState
  }, [])

  const refresh = useCallback(async () => {
    try {
      setPod(await call('pod-status'))
      setError(null)
    } catch (err) {
      setPod({ state: 'unknown' })
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [call])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const act = async (action: 'start' | 'stop') => {
    setBusy(action)
    setError(null)
    try {
      const next = await call(
        action === 'start' ? 'pod-start' : 'pod-stop',
        action === 'stop' && pod.containerId ? { containerId: pod.containerId } : {}
      )
      setPod(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const running = pod.state === 'running'

  return (
    <section className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            running ? 'bg-emerald-400' : pod.state === 'unknown' ? 'bg-white/20' : 'bg-white/25'
          )}
        />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-white/50">ComfyUI</h2>
        <span className="ml-auto text-[10px] text-white/25">
          {running ? 'running' : pod.state === 'unknown' ? '—' : 'stopped'}
        </span>
      </div>

      {running && pod.url && (
        <a
          href={pod.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 truncate rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 text-[11px] text-indigo-300 transition-colors hover:border-indigo-500/40"
        >
          <ExternalLink className="h-3 w-3 shrink-0" />
          <span className="truncate">{pod.url}</span>
        </a>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy !== null || running}
          onClick={() => void act('start')}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-indigo-600/80 px-3 py-2 text-[11px] font-medium text-white transition-colors hover:bg-indigo-600 disabled:opacity-40"
        >
          {busy === 'start' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Power className="h-3 w-3" />
          )}
          {busy === 'start' ? 'Starting…' : 'Launch ComfyUI'}
        </button>
        <button
          type="button"
          disabled={busy !== null || !running}
          onClick={() => void act('stop')}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-[11px] text-white/50 transition-colors hover:border-red-500/30 hover:text-red-300 disabled:opacity-30"
        >
          {busy === 'stop' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
          Stop
        </button>
      </div>

      <p className="text-[10px] leading-relaxed text-white/30">
        A pod does not scale to zero — stop it when you are done. And download weights{' '}
        <em className="not-italic text-white/45">before</em> launching: a running container cannot
        see files another container writes to the volume afterwards, so anything downloaded mid-session
        stays invisible until the pod restarts.
      </p>

      {error && (
        <p className="rounded-lg border border-red-500/20 bg-red-500/5 p-2 text-[11px] text-red-300/90">
          {error}
        </p>
      )}
    </section>
  )
}
