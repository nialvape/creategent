'use client'

import { useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Clock, DollarSign, Loader2, Copy, Check } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { LabCapability, LabRunResult } from '@/types/testing'

/** One entry in the lab's run history: the input that was sent + what came back. */
export interface LabRunRecord {
  id: string
  capability: LabCapability
  model: string
  modelName: string
  prompt: string
  fileNames: string[]
  status: 'running' | 'done' | 'error'
  result?: LabRunResult
  error?: string
}

const CAPABILITY_LABELS: Record<LabCapability, string> = {
  understanding: 'intake',
  image: 'image',
  video: 'video',
  avatar: 'avatar',
  audio: 'voice',
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function formatCost(cost: number): string {
  if (!cost) return '—'
  return cost < 0.01 ? `$${cost.toFixed(5)}` : `$${cost.toFixed(3)}`
}

export function LabRunCard({ run }: { run: LabRunRecord }) {
  const [showRaw, setShowRaw] = useState(false)
  const failed = run.status === 'error' || run.result?.ok === false
  const errorMessage = run.error ?? run.result?.error

  return (
    <div
      className={`rounded-xl border bg-white/[0.03] ${
        failed ? 'border-red-500/30' : 'border-white/10'
      }`}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/8 px-4 py-3">
        <span className="text-sm font-medium text-white">{run.modelName}</span>
        <Badge variant="outline" className="border-indigo-500/30 text-[10px] text-indigo-300">
          {CAPABILITY_LABELS[run.capability]}
        </Badge>
        <span className="font-mono text-[10px] text-white/25">{run.model}</span>

        <div className="ml-auto flex items-center gap-3 text-[11px] text-white/40">
          {run.status === 'running' ? (
            <span className="flex items-center gap-1.5 text-indigo-300">
              <Loader2 className="h-3 w-3 animate-spin" />
              running
            </span>
          ) : (
            run.result && (
              <>
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {formatMs(run.result.ms)}
                </span>
                <span className="flex items-center gap-1 font-mono text-emerald-400/80">
                  <DollarSign className="h-3 w-3" />
                  {formatCost(run.result.cost)}
                </span>
              </>
            )
          )}
        </div>
      </div>

      {/* Input snapshot — what this run was actually given */}
      <div className="space-y-1 border-b border-white/8 px-4 py-2.5">
        {run.prompt && <p className="line-clamp-2 text-xs text-white/45">{run.prompt}</p>}
        {run.fileNames.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {run.fileNames.map((name) => (
              <span key={name} className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-white/35">
                {name}
              </span>
            ))}
          </div>
        )}
        {!run.prompt && run.fileNames.length === 0 && (
          <p className="text-xs text-white/25">no input</p>
        )}
      </div>

      {/* Output */}
      <div className="space-y-3 px-4 py-3">
        {failed && (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-400" />
            <p className="text-xs leading-relaxed text-red-300/90">{errorMessage ?? 'Run failed'}</p>
          </div>
        )}

        {run.status === 'running' && (
          <div className="h-16 animate-pulse rounded-lg bg-white/[0.04]" />
        )}

        {run.result?.outputs.map((output, i) => (
          <div key={i} className="space-y-1.5">
            {output.label && <p className="text-[10px] uppercase tracking-wider text-white/25">{output.label}</p>}

            {output.kind === 'text' && output.text && <TextOutput text={output.text} />}

            {output.kind === 'image' && output.url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={output.url}
                alt={output.label ?? 'result'}
                className="max-h-80 w-full rounded-lg border border-white/10 object-contain"
              />
            )}

            {output.kind === 'video' && output.url && (
              <video
                src={output.url}
                controls
                playsInline
                className="max-h-80 w-full rounded-lg border border-white/10"
              />
            )}

            {output.kind === 'audio' && output.url && (
              <audio src={output.url} controls className="w-full" />
            )}
          </div>
        ))}

        {/* Raw provider metadata — nothing hidden during testing */}
        {run.result?.metadata && Object.keys(run.result.metadata).length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              className="flex items-center gap-1 text-[11px] text-white/30 transition-colors hover:text-white/60"
            >
              {showRaw ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              raw metadata
            </button>
            {showRaw && (
              <pre className="mt-1.5 overflow-x-auto rounded-lg bg-black/40 p-3 font-mono text-[10px] leading-relaxed text-white/50">
                {JSON.stringify(run.result.metadata, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Text results get a copy button — they're what you paste into a prompt file. */
function TextOutput({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  return (
    <div className="group relative">
      <p className="whitespace-pre-wrap rounded-lg bg-white/[0.04] px-3 py-2.5 text-xs leading-relaxed text-white/75">
        {text}
      </p>
      <button
        type="button"
        onClick={copy}
        title="Copy"
        className="absolute right-1.5 top-1.5 rounded-md bg-black/50 p-1 text-white/40 opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
      >
        {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  )
}
