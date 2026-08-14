'use client'

import { useMemo, useState } from 'react'
import { Loader2, Plus, Star } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { StarRating } from '@/components/testing/star-rating'
import type { LabRunRecord } from '@/components/testing/lab-run-card'
import { axesFor, defaultAxesFor, type RatingAxis } from '@/lib/rating-axes'
import { readJson } from '@/lib/upload-client'
import { isRatedCapability, type PromptRating } from '@/types/rating'
import { cn } from '@/lib/utils'

interface RateRunDialogProps {
  run: LabRunRecord
  onClose: () => void
  onSaved: (rating: PromptRating) => void
}

function describeAttachments(run: LabRunRecord): string {
  if (run.files.length === 0) return 'no files'
  const byKind = run.files.reduce<Record<string, number>>((acc, f) => {
    acc[f.kind] = (acc[f.kind] ?? 0) + 1
    return acc
  }, {})
  const parts = Object.entries(byKind).map(([kind, n]) => `${n} ${kind}${n > 1 ? 's' : ''}`)
  return `${run.files.length} file${run.files.length > 1 ? 's' : ''} · ${parts.join(', ')}`
}

/**
 * The evaluation form. Axes are opt-in on purpose: forcing a number onto every
 * axis would fill the corpus with guesses, and a guessed 3 is worse than a gap
 * when the whole point is teaching a model what actually went wrong.
 */
export function RateRunDialog({ run, onClose, onSaved }: RateRunDialogProps) {
  const capability = isRatedCapability(run.capability) ? run.capability : null

  const [scores, setScores] = useState<Record<string, number>>({})
  const [notes, setNotes] = useState('')
  const [extraAxisIds, setExtraAxisIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { shown, available } = useMemo(() => {
    if (!capability) return { shown: [] as RatingAxis[], available: [] as RatingAxis[] }
    const defaults = defaultAxesFor(capability)
    const defaultIds = new Set(defaults.map((a) => a.id))
    const rest = axesFor(capability).filter((a) => !defaultIds.has(a.id))
    return {
      shown: [...defaults, ...rest.filter((a) => extraAxisIds.includes(a.id))],
      available: rest.filter((a) => !extraAxisIds.includes(a.id)),
    }
  }, [capability, extraAxisIds])

  if (!capability) return null

  const scoredCount = Object.keys(scores).length

  const setScore = (axisId: string, value: number | undefined) =>
    setScores((prev) => {
      const next = { ...prev }
      if (value === undefined) delete next[axisId]
      else next[axisId] = value
      return next
    })

  const handleSave = async () => {
    if (saving || scoredCount === 0) return
    setSaving(true)
    setError(null)

    try {
      const { negativePrompt, ...settings } = run.videoParams ?? {}
      const res = await fetch('/api/lab/ratings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capability,
          model: run.model,
          model_name: run.modelName,
          provider: run.result?.provider,
          prompt: run.prompt,
          negative_prompt: negativePrompt ?? null,
          attachments: run.files.map((f) => ({
            name: f.name,
            mimeType: f.mimeType,
            kind: f.kind,
          })),
          settings,
          run_metadata: run.result?.metadata ?? {},
          duration_ms: run.result?.ms ?? null,
          cost_usd: run.result?.cost ?? null,
          output_url: run.result?.outputs.find((o) => o.url)?.url ?? null,
          scores,
          notes: notes.trim(),
        }),
      })
      const data = await readJson<PromptRating & { error?: string }>(res)
      if (!res.ok) throw new Error(data.error ?? `Could not save the rating (${res.status})`)
      onSaved(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Rate this prompt</DialogTitle>
          <DialogDescription>
            Score only the axes you have an opinion on — a skipped axis is saved as skipped, not as
            a bad score.
          </DialogDescription>
        </DialogHeader>

        {/* What is being judged, so the scores are never recorded against the
            wrong run when several are on screen. */}
        <div className="space-y-1.5 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-white">{run.modelName}</span>
            <span className="font-mono text-[10px] text-white/25">{run.model}</span>
          </div>
          <p className="line-clamp-3 text-xs leading-relaxed text-white/45">
            {run.prompt || 'no prompt'}
          </p>
          <p className="font-mono text-[10px] text-white/30">
            {capability} · {describeAttachments(run)}
            {run.videoParams &&
              ` · ${run.videoParams.aspectRatio} · ${run.videoParams.durationSec}s @ ${run.videoParams.fps}fps`}
          </p>
        </div>

        {/* Axes */}
        <div className="space-y-2.5">
          {shown.map((axis) => (
            <div key={axis.id} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-white/70">{axis.label}</p>
                <p className="text-[10px] leading-relaxed text-white/30">{axis.hint}</p>
              </div>
              <StarRating
                value={scores[axis.id]}
                onChange={(v) => setScore(axis.id, v)}
                disabled={saving}
              />
            </div>
          ))}

          {available.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-t border-white/8 pt-2.5">
              {available.map((axis) => (
                <button
                  key={axis.id}
                  type="button"
                  title={axis.hint}
                  onClick={() => setExtraAxisIds((prev) => [...prev, axis.id])}
                  disabled={saving}
                  className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-white/40 transition-colors hover:border-indigo-500/30 hover:text-white/70 disabled:opacity-50"
                >
                  <Plus className="h-3 w-3" />
                  {axis.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Notes */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-white/50">
            Notes
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Why these scores? What the model honoured, what it ignored, and what you would change in the prompt next time."
            rows={4}
            disabled={saving}
            className="w-full resize-y rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/25 transition-colors focus:border-indigo-500/50 focus:outline-none disabled:opacity-50"
          />
        </div>

        {error && (
          <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300/90">
            {error}
          </p>
        )}

        <DialogFooter>
          <span className="mr-auto self-center text-[11px] text-white/30">
            {scoredCount === 0 ? 'Score at least one axis' : `${scoredCount} axes scored`}
          </span>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || scoredCount === 0}
            className={cn('gap-2 bg-indigo-600 text-white hover:bg-indigo-500')}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Star className="h-4 w-4" />}
            {saving ? 'Saving...' : 'Save rating'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
