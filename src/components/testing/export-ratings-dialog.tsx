'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, Download, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { AXIS_BY_ID, MAX_STARS } from '@/lib/rating-axes'
import { readJson } from '@/lib/upload-client'
import type { PromptRating, RatedCapability } from '@/types/rating'

const inputClass =
  'w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-sm text-white transition-colors focus:border-indigo-500/50 focus:outline-none disabled:opacity-50'

const ALL = '__all__'

/** The shape handed to an LLM. Keys are camelCase and self-describing so the
 *  file reads as documentation of itself, not as a database dump. */
interface ExportedRating {
  prompt: string
  negativePrompt: string | null
  model: string
  modelName: string
  provider: string
  modality: RatedCapability
  attachments: {
    count: number
    byKind: Record<string, number>
    files: Array<{ name: string; mimeType: string; kind: string }>
  }
  settings: Record<string, unknown>
  runMetadata: Record<string, unknown>
  scores: Record<string, number>
  averageScore: number
  notes: string | null
  ratedAt: string
}

function toExported(r: PromptRating): ExportedRating {
  const values = Object.values(r.scores)
  return {
    prompt: r.prompt,
    negativePrompt: r.negative_prompt,
    model: r.model,
    modelName: r.model_name,
    provider: r.provider,
    modality: r.capability,
    attachments: {
      count: r.attachment_count,
      byKind: r.attachment_kinds,
      files: r.attachments,
    },
    settings: r.settings,
    runMetadata: r.run_metadata,
    scores: r.scores,
    averageScore: values.length
      ? Number((values.reduce((s, v) => s + v, 0) / values.length).toFixed(2))
      : 0,
    notes: r.notes,
    ratedAt: r.created_at,
  }
}

function buildExport(rows: PromptRating[], model: string, capability: string) {
  const ratings = rows.map(toExported)

  // Only glossary the axes that actually appear, so the model reading this
  // isn't told about criteria no one used.
  const usedAxisIds = new Set(ratings.flatMap((r) => Object.keys(r.scores)))
  const axes = Object.fromEntries(
    [...usedAxisIds]
      .filter((id) => AXIS_BY_ID[id])
      .map((id) => [id, `${AXIS_BY_ID[id].label} — ${AXIS_BY_ID[id].hint}`])
  )

  return {
    exportedAt: new Date().toISOString(),
    source: 'CreateGent Model Lab',
    filter: {
      model: model === ALL ? null : model,
      capability: capability === ALL ? null : capability,
    },
    scale: `1-${MAX_STARS} stars, higher is better. Axes absent from \`scores\` were deliberately skipped by the rater, not scored zero.`,
    axes,
    count: ratings.length,
    ratings,
  }
}

/**
 * Reads the whole corpus once and filters in the browser. These are hand-written
 * evaluations, so the table is small and a filter change should be instant
 * rather than a round trip.
 */
export function ExportRatingsDialog({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<PromptRating[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [model, setModel] = useState<string>(ALL)
  const [capability, setCapability] = useState<string>(ALL)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/lab/ratings')
        const data = await readJson<{ ratings?: PromptRating[]; error?: string }>(res)
        if (!res.ok) throw new Error(data.error ?? `Could not load ratings (${res.status})`)
        if (!cancelled) setRows(data.ratings ?? [])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Model options come from the data, not the catalog: a model with no ratings
  // is a dead end in this dialog.
  const modelOptions = useMemo(() => {
    const counts = new Map<string, { name: string; count: number }>()
    for (const r of rows ?? []) {
      const entry = counts.get(r.model) ?? { name: r.model_name, count: 0 }
      entry.count += 1
      counts.set(r.model, entry)
    }
    return [...counts.entries()].sort((a, b) => b[1].count - a[1].count)
  }, [rows])

  const byModel = useMemo(
    () => (rows ?? []).filter((r) => model === ALL || r.model === model),
    [rows, model]
  )

  // Modality options narrow to what the chosen model actually produced.
  const capabilityOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of byModel) counts.set(r.capability, (counts.get(r.capability) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [byModel])

  // Switching model can strand the selected modality — a stale value would
  // silently filter everything out, so fall back to "all" while it doesn't
  // apply, rather than resetting state and re-rendering.
  const effectiveCapability =
    capability === ALL || capabilityOptions.some(([c]) => c === capability) ? capability : ALL

  const filtered = useMemo(
    () => byModel.filter((r) => effectiveCapability === ALL || r.capability === effectiveCapability),
    [byModel, effectiveCapability]
  )

  const payload = () => JSON.stringify(buildExport(filtered, model, effectiveCapability), null, 2)

  const handleDownload = () => {
    const blob = new Blob([payload()], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const slug = model === ALL ? 'all-models' : model.replace(/[^a-z0-9]+/gi, '-')
    const link = document.createElement('a')
    link.href = url
    link.download = `prompt-ratings_${slug}_${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(payload())
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export prompt ratings</DialogTitle>
          <DialogDescription>
            A JSON corpus of rated prompts, with a glossary of what each score means — paste it into
            an LLM and ask it to write better prompts.
          </DialogDescription>
        </DialogHeader>

        {rows === null && !error && (
          <div className="flex items-center gap-2 py-6 text-xs text-white/40">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading ratings...
          </div>
        )}

        {rows !== null && rows.length === 0 && (
          <p className="py-6 text-center text-xs text-white/30">
            No ratings yet. Run a model, then rate the result to start the corpus.
          </p>
        )}

        {rows !== null && rows.length > 0 && (
          <div className="space-y-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-white/45">Model</span>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className={inputClass}
              >
                <option value={ALL}>All models ({rows.length})</option>
                {modelOptions.map(([id, { name, count }]) => (
                  <option key={id} value={id}>
                    {name} ({count})
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-white/45">
                Modality <span className="text-white/20">optional</span>
              </span>
              <select
                value={effectiveCapability}
                onChange={(e) => setCapability(e.target.value)}
                disabled={capabilityOptions.length < 2}
                className={inputClass}
              >
                <option value={ALL}>All modalities</option>
                {capabilityOptions.map(([id, count]) => (
                  <option key={id} value={id}>
                    {id} ({count})
                  </option>
                ))}
              </select>
            </label>

            <p className="font-mono text-[10px] text-white/40">
              {filtered.length} rating{filtered.length === 1 ? '' : 's'} match
            </p>
          </div>
        )}

        {error && (
          <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300/90">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button variant="outline" onClick={handleCopy} disabled={filtered.length === 0} className="gap-2">
            {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button
            onClick={handleDownload}
            disabled={filtered.length === 0}
            className="gap-2 bg-indigo-600 text-white hover:bg-indigo-500"
          >
            <Download className="h-4 w-4" />
            Download JSON
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
