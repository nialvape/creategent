'use client'

import { useState, useCallback, useId, useRef, useEffect } from 'react'
import { MessageList, type ChatMessage } from './message-list'
import { MessageInput } from './message-input'
import { CostSummaryCard } from './cost-summary-card'
import type { ContentPlan } from '@/types/plan'
import type { GraphStatus, GenerationProgress } from '@/types/graph-state'
import type { ProjectSettings } from '@/types/project'

interface ChatPanelProps {
  projectId: string
  projectSettings?: ProjectSettings
  onGenerationStarted?: () => void
  /** Called when the agent finishes generating all assets (SSE 'complete' event). */
  onGenerationComplete?: () => void
  /** Called with a freshly generated smart title after the first idea is sent. */
  onTitleGenerated?: (title: string) => void
}

function storageKey(projectId: string) {
  return `chat_${projectId}`
}

interface PersistedChat {
  messages: ChatMessage[]
  threadId: string
}

function loadChat(projectId: string): PersistedChat {
  try {
    const raw = localStorage.getItem(storageKey(projectId))
    if (raw) return JSON.parse(raw) as PersistedChat
  } catch { /* ignore */ }
  return { messages: [], threadId: `thread_${projectId}` }
}

function saveChat(projectId: string, data: PersistedChat) {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(data))
  } catch { /* ignore */ }
}

export function ChatPanel({ projectId, projectSettings, onGenerationStarted, onGenerationComplete, onTitleGenerated }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const threadIdRef = useRef<string>(`thread_${projectId}`)
  const [graphStatus, setGraphStatus] = useState<GraphStatus>('idle')
  const [activeNode, setActiveNode] = useState<string | null>(null)
  const [progress, setProgress] = useState<GenerationProgress>({ total: 0, completed: 0, failed: 0, current: null })
  const [estimatedCost, setEstimatedCost] = useState(0)
  const [actualCost, setActualCost] = useState(0)
  const [pendingPlan, setPendingPlan] = useState<ContentPlan | null>(null)
  const [awaitingApproval, setAwaitingApproval] = useState(false)
  const idGen = useId()
  const msgCounter = useRef(0)

  // Load persisted messages and threadId on mount
  useEffect(() => {
    const stored = loadChat(projectId)
    threadIdRef.current = stored.threadId
    setMessages(stored.messages)
  }, [projectId])

  // Persist messages whenever they change
  const messagesRef = useRef<ChatMessage[]>([])
  useEffect(() => {
    messagesRef.current = messages
    if (messages.length > 0) {
      saveChat(projectId, { messages, threadId: threadIdRef.current })
    }
  }, [messages, projectId])

  const newId = useCallback(() => `${idGen}-${++msgCounter.current}`, [idGen])

  const sendToAPI = useCallback(async (body: Record<string, unknown>) => {
    setIsStreaming(true)
    const assistantId = newId()

    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: 'assistant' as const, content: '' },
    ])

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      let sseBuffer = ''
      let accumulated = ''
      // Local flag avoids stale closure when checking after stream ends
      let interruptReceived = false

      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          sseBuffer += decoder.decode(value, { stream: true })

          // SSE events are separated by double newlines
          const events = sseBuffer.split('\n\n')
          sseBuffer = events.pop() ?? ''

          for (const event of events) {
            const line = event.trim()
            if (!line.startsWith('data: ')) continue
            const payload = line.slice(6)
            if (payload === '[DONE]') continue

            let parsed: { type: string; text?: string; plan?: unknown; estimatedCost?: number; status?: string; node?: string; message?: string; completedCount?: number; failedCount?: number; actualCost?: number; reviewScore?: number | null }
            try {
              parsed = JSON.parse(payload)
            } catch {
              continue
            }

            if (parsed.type === 'text' && parsed.text) {
              accumulated += parsed.text
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: accumulated } : m
                )
              )
            } else if (parsed.type === 'complete') {
              const { completedCount = 0, failedCount = 0, actualCost: cost = 0, reviewScore } = parsed
              const parts = [`Generation complete: ${completedCount} asset${completedCount !== 1 ? 's' : ''} created.`]
              if (failedCount > 0) parts.push(` ${failedCount} failed.`)
              if (reviewScore != null) parts.push(` Quality score: ${reviewScore}/100.`)
              if (cost > 0) parts.push(` Cost: $${cost.toFixed(4)}.`)
              accumulated = parts.join('')
              setGraphStatus('completed')
              setActualCost(cost)
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: accumulated } : m
                )
              )
              onGenerationComplete?.()
            } else if (parsed.type === 'interrupt') {
              interruptReceived = true
              setPendingPlan(parsed.plan as ContentPlan)
              setEstimatedCost(parsed.estimatedCost ?? 0)
              setGraphStatus('awaiting_approval')
              setAwaitingApproval(true)
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        content: accumulated || "I've created a content plan. Please review it below:",
                        plan: parsed.plan as ContentPlan,
                        estimatedCost: parsed.estimatedCost,
                        interrupted: true,
                      }
                    : m
                )
              )
            } else if (parsed.type === 'status' && parsed.node) {
              setActiveNode(parsed.node)
            } else if (parsed.type === 'error') {
              throw new Error(parsed.message)
            }
          }
        }
      }

      if (!accumulated && !interruptReceived) {
        setMessages((prev) => prev.filter((m) => m.id !== assistantId))
      }
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: `Error: ${String(err)}` }
            : m
        )
      )
    } finally {
      setIsStreaming(false)
      setActiveNode(null)
    }
  }, [newId, onGenerationComplete])

  const handleSend = useCallback(() => {
    if (!input.trim() || isStreaming) return
    const userMessage: ChatMessage = { id: newId(), role: 'user', content: input }
    const isFirstMessage = messages.length === 0
    setMessages((prev) => [...prev, userMessage])
    setGraphStatus('planning')

    sendToAPI({
      messages: [...messages, userMessage],
      threadId: threadIdRef.current,
      projectId,
      projectSettings,
    })

    // Fire-and-forget smart title generation from the very first idea. The
    // endpoint only overwrites the default placeholder title, so this is a
    // no-op once the user has named the project themselves.
    if (isFirstMessage) {
      fetch(`/api/projects/${projectId}/title`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idea: input }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((p) => {
          if (p?.title) onTitleGenerated?.(p.title)
        })
        .catch(() => {})
    }

    setInput('')
  }, [input, isStreaming, messages, projectId, projectSettings, sendToAPI, onTitleGenerated])

  const handleApprove = useCallback(() => {
    setAwaitingApproval(false)
    setGraphStatus('generating')
    setMessages((prev) => prev.map((m) => m.interrupted ? { ...m, interrupted: false } : m))
    onGenerationStarted?.()
    sendToAPI({ threadId: threadIdRef.current, projectId, command: { type: 'approve' } })
  }, [projectId, sendToAPI, onGenerationStarted])

  const handleReject = useCallback((feedback?: string) => {
    setAwaitingApproval(false)
    setPendingPlan(null)
    setGraphStatus('planning')
    setMessages((prev) => prev.map((m) => m.interrupted ? { ...m, interrupted: false } : m))
    sendToAPI({ threadId: threadIdRef.current, projectId, command: { type: 'reject', feedback } })
  }, [projectId, sendToAPI])

  const showCostSummary = actualCost > 0 || (estimatedCost > 0 && graphStatus === 'completed')

  return (
    <div className="flex flex-col h-full">
      <MessageList
        messages={messages}
        onApprove={handleApprove}
        onReject={handleReject}
        isStreaming={isStreaming && !awaitingApproval}
        disabled={isStreaming}
        graphStatus={graphStatus}
        activeNode={activeNode}
      />

      {showCostSummary && (
        <div className="px-4 pb-2">
          <CostSummaryCard estimated={estimatedCost} actual={actualCost} />
        </div>
      )}

      <MessageInput
        value={input}
        onChange={setInput}
        onSend={handleSend}
        disabled={isStreaming || awaitingApproval}
        placeholder={awaitingApproval ? 'Waiting for plan approval...' : 'Describe your content idea...'}
      />
    </div>
  )
}
