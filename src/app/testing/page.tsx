'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, FlaskConical, Play, Loader2, Trash2, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ModelPicker } from '@/components/ui/model-picker'
import { LabFilePicker, type LabAttachment } from '@/components/testing/lab-file-picker'
import { LabRunCard, type LabRunRecord } from '@/components/testing/lab-run-card'
import { VideoParamsPanel } from '@/components/testing/video-params'
import { RunPodStatus } from '@/components/testing/runpod-status'
import { ExportRatingsDialog } from '@/components/testing/export-ratings-dialog'
import { LTX_DEFAULTS, aspectRatioForSize } from '@/lib/comfy/ltx-2-5-i2v'
import { readJson, uploadFile } from '@/lib/upload-client'
import {
  UNDERSTANDING_MODELS,
  IMAGE_MODELS,
  VIDEO_MODELS,
  AVATAR_MODELS,
  AUDIO_MODELS,
  type ModelDef,
} from '@/lib/models'
import type { LabCapability, LabFile, LabRunResult, LabVideoParams } from '@/types/testing'
import { cn } from '@/lib/utils'

/** Storage prefix for lab uploads — mirrors LAB_PROJECT_ID on the server. */
const LAB_PROJECT_ID = 'model-lab'

const DEFAULT_VIDEO_PARAMS: LabVideoParams = {
  aspectRatio: 'auto',
  megapixels: LTX_DEFAULTS.megapixels,
  durationSec: LTX_DEFAULTS.durationSec,
  fps: LTX_DEFAULTS.fps,
  enhancePrompt: LTX_DEFAULTS.enhancePrompt,
  negativePrompt: LTX_DEFAULTS.negativePrompt,
}

/**
 * Turns `aspectRatio: 'auto'` into a concrete ratio using the attached image's
 * real proportions. Done here rather than on the server because only the
 * browser has the decoded image — and the workflow takes its output size from
 * this setting, not from the image, so guessing would stretch the frame.
 */
function resolveAutoAspect(objectUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(aspectRatioForSize(img.naturalWidth, img.naturalHeight))
    img.onerror = () => resolve(null)
    img.src = objectUrl
  })
}

interface CapabilityGroup {
  capability: LabCapability
  label: string
  /** What this kind of model consumes and produces. */
  io: string
  placeholder: string
  models: ModelDef[]
}

const GROUPS: CapabilityGroup[] = [
  {
    capability: 'understanding',
    label: 'Reference intake',
    io: 'files + text → description',
    placeholder:
      'Instructions for reading the files. Leave empty to use the intake prompt the agent uses today.',
    models: UNDERSTANDING_MODELS,
  },
  {
    capability: 'image',
    label: 'Image',
    io: 'text → image',
    placeholder: 'Describe the image to generate...',
    models: IMAGE_MODELS,
  },
  {
    capability: 'video',
    label: 'Image → video',
    io: 'image + text → video',
    placeholder: 'Describe the motion for the attached first frame...',
    models: VIDEO_MODELS,
  },
  {
    capability: 'avatar',
    label: 'Talking avatar',
    io: 'image + audio → video',
    placeholder: 'Not used — avatar models are driven by the attached image and audio.',
    models: AVATAR_MODELS,
  },
  {
    capability: 'audio',
    label: 'Voice',
    io: 'text (+ voice sample) → audio',
    placeholder: 'The words to speak...',
    models: AUDIO_MODELS,
  },
]

export default function ModelLabPage() {
  const [capability, setCapability] = useState<LabCapability>('understanding')
  const [modelByCapability, setModelByCapability] = useState<Record<string, string>>(() =>
    Object.fromEntries(GROUPS.map((g) => [g.capability, g.models[0].id]))
  )
  const [attachments, setAttachments] = useState<LabAttachment[]>([])
  const [prompt, setPrompt] = useState('')
  const [runs, setRuns] = useState<LabRunRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [inputError, setInputError] = useState<string | null>(null)
  const [videoParams, setVideoParams] = useState<LabVideoParams>(DEFAULT_VIDEO_PARAMS)
  // Bumped after each run so the balance reflects what the run just cost.
  const [creditsKey, setCreditsKey] = useState(0)
  const [exporting, setExporting] = useState(false)

  // Uploaded URL per attachment, so running the same files against a second
  // model re-uses the upload instead of paying for it again.
  const uploadedRef = useRef<Map<string, LabFile>>(new Map())

  const group = GROUPS.find((g) => g.capability === capability)!
  const model = modelByCapability[capability]
  const modelDef = group.models.find((m) => m.id === model)

  // Understanding models differ in which file kinds they can actually ingest —
  // flag mismatches before spending a call on a guaranteed failure.
  const unsupported = useMemo(() => {
    if (capability !== 'understanding') return []
    const def = UNDERSTANDING_MODELS.find((m) => m.id === model)
    if (!def) return []
    return Array.from(
      new Set(attachments.filter((a) => !def.supports.includes(a.kind)).map((a) => a.kind))
    )
  }, [capability, model, attachments])

  const uploadAll = async (): Promise<LabFile[]> => {
    return Promise.all(
      attachments.map(async (att) => {
        const cached = uploadedRef.current.get(att.id)
        if (cached) return cached

        const url = await uploadFile(att.file, LAB_PROJECT_ID)

        const uploaded: LabFile = {
          url,
          name: att.file.name,
          mimeType: att.file.type,
          kind: att.kind,
        }
        uploadedRef.current.set(att.id, uploaded)
        return uploaded
      })
    )
  }

  const handleRun = async () => {
    if (busy) return
    setInputError(null)
    setBusy(true)

    const record: LabRunRecord = {
      id: crypto.randomUUID(),
      capability,
      model,
      modelName: modelDef?.name ?? model,
      prompt: prompt.trim(),
      // Local object URLs for now — swapped for the uploaded ones below, so a
      // rating saved after the run never points at a blob: link.
      files: attachments.map((a) => ({
        url: a.url,
        name: a.file.name,
        mimeType: a.file.type,
        kind: a.kind,
      })),
      status: 'running',
    }
    setRuns((prev) => [record, ...prev])

    try {
      let params: LabVideoParams | undefined
      if (capability === 'video') {
        params = { ...videoParams }
        if (params.aspectRatio === 'auto') {
          const firstImage = attachments.find((a) => a.kind === 'image')
          const resolved = firstImage ? await resolveAutoAspect(firstImage.url) : null
          if (!resolved) {
            setInputError('Attach a first-frame image, or pick an aspect ratio explicitly.')
            setRuns((prev) => prev.filter((r) => r.id !== record.id))
            return
          }
          params.aspectRatio = resolved
        }
      }

      const files = await uploadAll()
      // Record what the run is actually being given, now that it's settled —
      // this is the snapshot a rating is saved against.
      setRuns((prev) =>
        prev.map((r) => (r.id === record.id ? { ...r, files, videoParams: params } : r))
      )

      const res = await fetch('/api/testing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capability,
          model,
          prompt: prompt.trim(),
          files,
          videoParams: params,
        }),
      })
      const data = await readJson<LabRunResult & { error?: string }>(res)

      if (!res.ok) {
        // 400s are input problems, not model results — surface them on the form
        // and drop the pending card.
        setInputError(data.error ?? `Request failed (${res.status})`)
        setRuns((prev) => prev.filter((r) => r.id !== record.id))
        return
      }

      const result = data as LabRunResult
      setRuns((prev) =>
        prev.map((r) =>
          r.id === record.id ? { ...r, status: result.ok ? 'done' : 'error', result } : r
        )
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setRuns((prev) =>
        prev.map((r) => (r.id === record.id ? { ...r, status: 'error', error: message } : r))
      )
    } finally {
      setBusy(false)
      setCreditsKey((k) => k + 1)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-white/10 px-6 py-4">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-xs text-white/40 transition-colors hover:text-white/70"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Projects
          </Link>
          <span className="text-white/15">/</span>
          <div className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-indigo-400" />
            <h1 className="text-sm font-semibold text-white">Model Lab</h1>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <p className="hidden text-xs text-white/30 lg:block">
              One model, raw input, no graph — compare before wiring it into the agent.
            </p>
            <button
              type="button"
              onClick={() => setExporting(true)}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-white/45 transition-colors hover:border-indigo-500/30 hover:text-white/80"
            >
              <Download className="h-3 w-3" />
              Export ratings
            </button>
            <RunPodStatus refreshKey={creditsKey} />
          </div>
        </div>
      </div>

      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-6 py-8 lg:grid-cols-[380px_1fr]">
        {/* Input side */}
        <div className="space-y-5">
          {/* Capability + model */}
          <section className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex flex-wrap gap-1">
              {GROUPS.map((g) => (
                <button
                  key={g.capability}
                  type="button"
                  onClick={() => setCapability(g.capability)}
                  className={cn(
                    'rounded-lg px-2.5 py-1.5 text-xs transition-colors',
                    capability === g.capability
                      ? 'bg-indigo-600/30 text-white'
                      : 'text-white/40 hover:bg-white/5 hover:text-white/70'
                  )}
                >
                  {g.label}
                </button>
              ))}
            </div>
            <p className="font-mono text-[10px] text-white/25">{group.io}</p>
            <ModelPicker
              models={group.models}
              value={model}
              onChange={(id) => setModelByCapability((prev) => ({ ...prev, [capability]: id }))}
            />
          </section>

          {/* Files */}
          <section className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-white/50">Files</h2>
            <LabFilePicker attachments={attachments} onChange={setAttachments} disabled={busy} />
            {unsupported.length > 0 && (
              <p className="text-[11px] text-amber-400/80">
                {modelDef?.name} can&apos;t read {unsupported.join(' or ')} input — those files will come back as errors.
              </p>
            )}
          </section>

          {/* Video knobs — only this capability has settings worth exposing. */}
          {capability === 'video' && (
            <VideoParamsPanel
              value={videoParams}
              onChange={setVideoParams}
              imageUrl={attachments.find((a) => a.kind === 'image')?.url}
              disabled={busy}
            />
          )}

          {/* Text */}
          <section className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-white/50">Text</h2>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={group.placeholder}
              rows={5}
              className="w-full resize-y rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/25 transition-colors focus:border-indigo-500/50 focus:outline-none"
            />
          </section>

          {inputError && (
            <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300/90">
              {inputError}
            </p>
          )}

          <Button
            onClick={handleRun}
            disabled={busy}
            className="w-full gap-2 bg-indigo-600 text-white hover:bg-indigo-500"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {busy ? 'Running...' : 'Run model'}
          </Button>
        </div>

        {/* Results side */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-white/50">
              Runs {runs.length > 0 && <span className="text-white/25">({runs.length})</span>}
            </h2>
            {runs.length > 0 && (
              <button
                type="button"
                onClick={() => setRuns([])}
                className="flex items-center gap-1 text-[11px] text-white/30 transition-colors hover:text-white/60"
              >
                <Trash2 className="h-3 w-3" />
                Clear
              </button>
            )}
          </div>

          {runs.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/10 text-center">
              <FlaskConical className="h-5 w-5 text-white/15" />
              <p className="text-sm text-white/30">No runs yet</p>
              <p className="max-w-xs text-xs text-white/20">
                Attach files, write the text, pick a model and run. Swap the model and run again —
                every run stays here so you can compare them.
              </p>
            </div>
          ) : (
            runs.map((run) => (
              <LabRunCard
                key={run.id}
                run={run}
                onRated={(runId, rating) =>
                  setRuns((prev) => prev.map((r) => (r.id === runId ? { ...r, rating } : r)))
                }
              />
            ))
          )}
        </div>
      </div>

      {exporting && <ExportRatingsDialog onClose={() => setExporting(false)} />}
    </div>
  )
}
