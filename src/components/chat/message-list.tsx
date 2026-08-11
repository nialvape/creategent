'use client'

import { useRef, useEffect, useState } from 'react'
import { Music } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ContentPlanCard } from './content-plan-card'
import type { ContentPlan } from '@/types/plan'
import type { GraphStatus } from '@/types/graph-state'

export type AttachmentKind = 'image' | 'video' | 'audio'

export interface MessageAttachment {
  url: string
  kind: AttachmentKind
  name: string
  /** MIME type, needed by the agent's understanding sub-agents for audio/video. */
  mimeType?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  plan?: ContentPlan
  estimatedCost?: number
  interrupted?: boolean
  attachments?: MessageAttachment[]
}

// Maps graph node names to friendly labels. The supervisor emits full,
// human-readable status strings of its own (e.g. "Generating 3 images and the
// voiceover…") via custom stream events — those are shown verbatim (see below),
// so only the coarse node names need mapping here.
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
    phase: 'idle' | 'typing' | 'holding' | 'deleting'
    timer: ReturnType<typeof setTimeout> | null
  }>({ displayed: '', target: '', phase: 'idle', timer: null })

  useEffect(() => {
    const a = anim.current
    const prev = a.target
    a.target = target

    function tick() {
      if (a.phase === 'typing') {
        if (a.displayed.length >= a.target.length) {
          // Finished typing — hold, then delete
          a.phase = 'holding'
          a.timer = setTimeout(tick, 1600)
          return
        }
        a.displayed = a.target.slice(0, a.displayed.length + 1)
        setDisplayed(a.displayed)
        a.timer = setTimeout(tick, 38)
      } else if (a.phase === 'holding') {
        a.phase = 'deleting'
        a.timer = setTimeout(tick, 18)
      } else if (a.phase === 'deleting') {
        if (a.displayed.length === 0) {
          if (a.target.length > 0) {
            // Loop back: retype same (or new) target
            a.phase = 'typing'
            a.timer = setTimeout(tick, 220)
          } else {
            a.phase = 'idle'
          }
          return
        }
        a.displayed = a.displayed.slice(0, -1)
        setDisplayed(a.displayed)
        a.timer = setTimeout(tick, 18)
      }
    }

    if (a.timer) { clearTimeout(a.timer); a.timer = null }

    if (target === '') {
      // Stop looping — delete whatever's showing then go idle
      if (a.displayed.length > 0) { a.phase = 'deleting'; a.timer = setTimeout(tick, 18) }
      else a.phase = 'idle'
    } else if (a.phase === 'idle') {
      a.phase = 'typing'; a.timer = setTimeout(tick, 38)
    } else if (target !== prev) {
      // New text — interrupt and delete before typing new one
      a.phase = 'deleting'; a.timer = setTimeout(tick, 18)
    } else {
      // Same target, animation already running — restart timer (was cleared above)
      const delay = a.phase === 'holding' ? 1600 : a.phase === 'typing' ? 38 : 18
      a.timer = setTimeout(tick, delay)
    }

    return () => { if (a.timer) { clearTimeout(a.timer); a.timer = null } }
  }, [target])

  return displayed
}

function MessageAttachmentThumb({ attachment }: { attachment: MessageAttachment }) {
  const { url, kind, name } = attachment
  if (kind === 'audio') {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 max-w-[16rem]">
        <Music className="h-4 w-4 flex-shrink-0 text-indigo-300" />
        <audio src={url} controls className="h-8 max-w-[12rem]" />
      </div>
    )
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title={name}>
      <div className="h-24 w-24 overflow-hidden rounded-xl border border-white/15 bg-white/5">
        {kind === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={name} className="h-full w-full object-cover" />
        ) : (
          <video src={url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
        )}
      </div>
    </a>
  )
}

interface MessageListProps {
  messages: ChatMessage[]
  onApprove: () => void
  onReject: (feedback?: string) => void
  isStreaming?: boolean
  disabled?: boolean
  graphStatus?: GraphStatus
  activeNode?: string | null
}

export function MessageList({ messages, onApprove, onReject, isStreaming, disabled, graphStatus, activeNode }: MessageListProps) {
  const statusLabel =
    // A known node name maps to a friendly label; otherwise the value is already
    // a human-readable status string emitted by the supervisor → show as-is.
    (activeNode ? (NODE_LABELS[activeNode] ?? activeNode) : null) ??
    (graphStatus ? STATUS_FALLBACK[graphStatus] : null) ??
    ''
  const typedText = useTypewriter(isStreaming ? statusLabel : '')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3 max-w-sm">
          <div className="w-16 h-16 rounded-2xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center mx-auto">
            <span className="text-3xl">✨</span>
          </div>
          <h3 className="text-white/80 font-medium">Describe your content idea</h3>
          <p className="text-sm text-white/40">
            Tell me what you want to create — a product launch, tutorial, brand story, or anything else.
            I&apos;ll plan the full content package.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}
        >
          {msg.role === 'assistant' ? (
            <div className="space-y-3 max-w-2xl w-full">
              {msg.content && (
                <div className="flex gap-3 items-start">
                  <div className="w-7 h-7 rounded-full bg-indigo-500/30 border border-indigo-500/50 flex items-center justify-center flex-shrink-0">
                    <span className="text-xs">G</span>
                  </div>
                  <div className="flex-1 text-sm text-white/80 leading-7 whitespace-pre-wrap">
                    {msg.content}
                  </div>
                </div>
              )}
              {msg.plan && (
                <div className="ml-10">
                  <ContentPlanCard
                    plan={msg.plan}
                    estimatedCost={msg.estimatedCost ?? 0}
                    onApprove={onApprove}
                    onReject={onReject}
                    disabled={disabled}
                    resolved={!msg.interrupted}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="max-w-lg flex flex-col items-end gap-1.5">
              {msg.attachments && msg.attachments.length > 0 && (
                <div className="flex flex-wrap justify-end gap-1.5">
                  {msg.attachments.map((att, i) => (
                    <MessageAttachmentThumb key={`${att.url}-${i}`} attachment={att} />
                  ))}
                </div>
              )}
              {msg.content && (
                <div className="bg-indigo-600/80 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm">
                  {msg.content}
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      {isStreaming && (
        <div className="flex gap-3 items-start">
          <div className="w-7 h-7 rounded-full bg-indigo-500/30 border border-indigo-500/50 flex items-center justify-center flex-shrink-0">
            <span className="text-xs">G</span>
          </div>
          <div className="flex-1 text-sm text-white/80 leading-7 min-h-[1.75rem]">
            {typedText}
            <span className="inline-block w-[2px] h-[1em] bg-indigo-400 ml-[2px] align-text-bottom animate-[blink_1s_step-end_infinite]" />
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  )
}
