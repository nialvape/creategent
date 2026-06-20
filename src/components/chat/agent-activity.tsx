'use client'

import { useEffect, useRef, useState } from 'react'
import type { GraphStatus } from '@/types/graph-state'

interface AgentActivityProps {
  status: GraphStatus
  activeNode?: string | null
  progress?: { total: number; completed: number; failed: number }
}

// See message-list.tsx: the supervisor emits full human-readable status strings
// via custom stream events, shown verbatim. Only node names need mapping here.
const NODE_LABELS: Record<string, string> = {
  planner: 'Planning your content',
  creative_director: 'Crafting the creative brief',
  review: 'Reviewing quality',
}

const STATUS_FALLBACK: Partial<Record<GraphStatus, string>> = {
  planning: 'Planning your content',
  generating: 'Generating assets',
  reviewing: 'Reviewing quality',
}

function useTypewriter(target: string) {
  const [displayed, setDisplayed] = useState('')
  const anim = useRef<{
    displayed: string
    target: string
    phase: 'idle' | 'typing' | 'deleting'
    timer: ReturnType<typeof setTimeout> | null
  }>({ displayed: '', target: '', phase: 'idle', timer: null })

  useEffect(() => {
    const a = anim.current
    const prev = a.target
    a.target = target

    function tick() {
      if (a.phase === 'typing') {
        if (a.displayed.length >= a.target.length) {
          a.phase = 'idle'
          return
        }
        a.displayed = a.target.slice(0, a.displayed.length + 1)
        setDisplayed(a.displayed)
        a.timer = setTimeout(tick, 32)
      } else if (a.phase === 'deleting') {
        if (a.displayed.length === 0) {
          a.phase = a.target.length > 0 ? 'typing' : 'idle'
          if (a.phase === 'typing') a.timer = setTimeout(tick, 32)
          return
        }
        a.displayed = a.displayed.slice(0, -1)
        setDisplayed(a.displayed)
        a.timer = setTimeout(tick, 16)
      }
    }

    if (a.timer) { clearTimeout(a.timer); a.timer = null }

    if (target === '') {
      if (a.displayed.length > 0) { a.phase = 'deleting'; a.timer = setTimeout(tick, 16) }
      else { a.phase = 'idle' }
    } else if (a.displayed === '' && a.phase === 'idle') {
      a.phase = 'typing'; a.timer = setTimeout(tick, 32)
    } else if (target !== prev) {
      a.phase = 'deleting'; a.timer = setTimeout(tick, 16)
    }

    return () => { if (a.timer) { clearTimeout(a.timer); a.timer = null } }
  }, [target])

  return displayed
}

export function AgentActivity({ status, activeNode, progress }: AgentActivityProps) {
  const isActive =
    status !== 'idle' &&
    status !== 'awaiting_approval' &&
    status !== 'completed' &&
    status !== 'failed'

  const label =
    (activeNode ? (NODE_LABELS[activeNode] ?? activeNode) : null) ??
    STATUS_FALLBACK[status] ??
    ''

  const displayed = useTypewriter(isActive ? label : '')

  if (!isActive) return null

  const showProgress = progress && progress.total > 0

  return (
    <div className="flex gap-3 items-start">
      <div className="w-7 h-7 rounded-full bg-indigo-500/30 border border-indigo-500/50 flex items-center justify-center flex-shrink-0">
        <span className="text-xs text-indigo-300">G</span>
      </div>
      <div className="flex-1 text-sm text-white/80 leading-7">
        <span>{displayed}</span>
        <span className="inline-block w-[2px] h-[1em] bg-indigo-400 ml-[2px] align-text-bottom animate-[blink_1s_step-end_infinite]" />
        {showProgress && (
          <span className="ml-3 text-xs text-white/30">
            {progress.completed}/{progress.total} assets
          </span>
        )}
      </div>
    </div>
  )
}
