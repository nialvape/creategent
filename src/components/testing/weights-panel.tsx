'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  FileJson,
  HardDriveDownload,
  Link2,
  Loader2,
  RefreshCw,
  Upload,
} from 'lucide-react'
import { WORKER_MODEL_DIRS, type IngestReport } from '@/lib/comfy/workflow-ingest'
import { cn } from '@/lib/utils'

/**
 * Put weights on the Beam volume without opening a terminal.
 *
 * Two ways in, because there are two shapes the problem actually arrives in:
 *
 *  - a **workflow** (a civitai download, a ComfyUI template) that references
 *    several models. Its UI-format JSON carries a URL and a target folder per
 *    model, so the whole list is derivable and this panel just shows it and
 *    offers to fetch it.
 *  - a **single URL**, for the case the automation cannot rescue: a LoRA you
 *    found on its own, or a file the workflow names without saying where it
 *    came from.
 *
 * Both end at the same CPU container on Beam. Nothing here downloads onto the
 * GPU pod, which is the entire point — ComfyUI's own "download missing models"
 * button pulls at RTX 5090 rates for a transfer that costs cents on a CPU.
 */

const POLL_MS = 5_000

interface WorkflowFile {
  name: string
  bytes: number
  modifiedAt: string
  isApiExport: boolean
}

type ReportModel = IngestReport['models'][number] & { size?: number | null }
type Report = Omit<IngestReport, 'models'> & { models: ReportModel[] }

interface PreflightState {
  source: string
  report: Report
  totalBytes: number
}

interface JobState {
  taskId: string
  status: string
  done: boolean
  failed: boolean
  queued: number
}

/** Stable identity for a row: a workflow can name the same file in two folders. */
function keyOf(m: { directory: string; name: string }): string {
  return `${m.directory}/${m.name}`
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '—'
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
  return `${(bytes / 1e3).toFixed(0)} KB`
}

export function WeightsPanel() {
  const [tab, setTab] = useState<'workflow' | 'url'>('workflow')
  const [workflows, setWorkflows] = useState<WorkflowFile[]>([])
  const [configured, setConfigured] = useState(true)
  const [preflight, setPreflight] = useState<PreflightState | null>(null)
  // Which rows the Download button will actually fetch.
  //
  // Not a nicety: a workflow routinely names a variant of something already on
  // the volume — an int8 text encoder when the nvfp4 build is there, the
  // unpruned transformer when the pruned one is — and an all-or-nothing button
  // makes 27 GB of that the price of the 21 GB you wanted.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [job, setJob] = useState<JobState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Single-URL form
  const [url, setUrl] = useState('')
  const [directory, setDirectory] = useState('loras')
  const [name, setName] = useState('')

  const loadWorkflows = useCallback(async () => {
    try {
      const res = await fetch('/api/testing/weights')
      const data = (await res.json()) as {
        workflows?: WorkflowFile[]
        configured?: boolean
      }
      setWorkflows(data.workflows ?? [])
      setConfigured(data.configured !== false)
    } catch {
      // A listing that fails is not worth an error banner: the drop zone and the
      // URL form work regardless of whether the server can read the folder.
      setWorkflows([])
    }
  }, [])

  useEffect(() => {
    void loadWorkflows()
  }, [loadWorkflows])

  const post = useCallback(async (payload: Record<string, unknown>) => {
    const res = await fetch('/api/testing/weights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = (await res.json()) as Record<string, unknown>
    if (!res.ok || data.ok === false) {
      throw new Error(typeof data.error === 'string' ? data.error : `request failed (${res.status})`)
    }
    return data
  }, [])

  const runPreflight = useCallback(
    async (payload: Record<string, unknown>) => {
      setBusy(true)
      setError(null)
      setJob(null)
      try {
        const data = (await post({ action: 'preflight', ...payload })) as unknown as PreflightState
        setPreflight(data)
        // Everything downloadable starts selected: the common case is wanting
        // all of it, and unchecking is a cheaper mistake than forgetting to check.
        setSelected(new Set(data.report.models.filter((m) => m.url).map(keyOf)))
      } catch (err) {
        setPreflight(null)
        setSelected(new Set())
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [post]
  )

  const acceptFile = useCallback(
    async (file: File) => {
      if (!file.name.endsWith('.json')) {
        setError('That is not a .json workflow.')
        return
      }
      try {
        const workflow = JSON.parse(await file.text()) as unknown
        await runPreflight({ workflow })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [runPreflight]
  )

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) void acceptFile(file)
  }

  const handleBrowse = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) void acceptFile(file)
    e.target.value = ''
  }

  const startDownload = useCallback(
    async (models: unknown[]) => {
      setBusy(true)
      setError(null)
      try {
        const data = (await post({ action: 'download', models })) as {
          taskId: string
          queued: number
        }
        setJob({
          taskId: data.taskId,
          status: 'PENDING',
          done: false,
          failed: false,
          queued: data.queued,
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [post]
  )

  // Poll while a download is in flight. 30 GB takes minutes, and the tab being
  // open is not a requirement for it to finish — this only reports.
  useEffect(() => {
    if (!job || job.done || job.failed) return
    const timer = setInterval(async () => {
      try {
        const data = (await post({ action: 'status', taskId: job.taskId })) as unknown as {
          status: string
          done: boolean
          failed: boolean
        }
        setJob((prev) => (prev ? { ...prev, ...data } : prev))
      } catch {
        // A failed poll is not a failed download; keep trying.
      }
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [job, post])

  const downloadable = preflight?.report.models.filter((m) => m.url) ?? []
  const chosen = downloadable.filter((m) => selected.has(keyOf(m)))
  const chosenBytes = chosen.reduce((sum, m) => sum + (m.size ?? 0), 0)

  return (
    <section className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center gap-2">
        <HardDriveDownload className="h-3.5 w-3.5 text-indigo-400" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-white/50">Weights</h2>
        <div className="ml-auto flex gap-1">
          {(['workflow', 'url'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                'rounded-lg px-2 py-1 text-[11px] transition-colors',
                tab === t ? 'bg-indigo-600/30 text-white' : 'text-white/40 hover:text-white/70'
              )}
            >
              {t === 'workflow' ? 'From workflow' : 'From URL'}
            </button>
          ))}
        </div>
      </div>

      {!configured && (
        <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-2 text-[11px] text-amber-300/90">
          The downloader is not deployed yet. Run{' '}
          <code className="text-amber-200">cd beam/models && beam deploy download.py:handler</code>{' '}
          and put its URL in <code className="text-amber-200">BEAM_DOWNLOADER_URL</code>.
        </p>
      )}

      {tab === 'workflow' ? (
        <>
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileRef.current?.click()}
            className={cn(
              'flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed px-3 py-4 text-[11px] transition-colors',
              dragging
                ? 'border-indigo-400/60 bg-indigo-500/10 text-white/80'
                : 'border-white/15 text-white/40 hover:border-indigo-500/30 hover:text-white/70'
            )}
          >
            <Upload className="h-3.5 w-3.5" />
            Drop a workflow .json, or click to choose one
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleBrowse}
          />

          {workflows.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <p className="text-[10px] uppercase tracking-wider text-white/30">
                  comfy_workflows/
                </p>
                <button
                  type="button"
                  onClick={() => void loadWorkflows()}
                  className="text-white/25 transition-colors hover:text-white/60"
                  title="Rescan the folder"
                >
                  <RefreshCw className="h-3 w-3" />
                </button>
              </div>
              {workflows.map((wf) => (
                <button
                  key={wf.name}
                  type="button"
                  disabled={busy || wf.isApiExport}
                  onClick={() => void runPreflight({ file: wf.name })}
                  title={
                    wf.isApiExport
                      ? 'API exports carry no model URLs — pick the UI-format file'
                      : undefined
                  }
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg border border-white/5 px-2.5 py-1.5 text-left text-[11px] transition-colors',
                    wf.isApiExport
                      ? 'cursor-not-allowed text-white/20'
                      : 'text-white/60 hover:border-indigo-500/30 hover:text-white',
                    preflight?.source === wf.name && 'border-indigo-500/40 bg-indigo-500/10'
                  )}
                >
                  <FileJson className="h-3 w-3 shrink-0" />
                  <span className="truncate">{wf.name}</span>
                  <span className="ml-auto shrink-0 text-white/25">
                    {wf.isApiExport ? 'api export' : formatBytes(wf.bytes)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5">
            <Link2 className="h-3 w-3 shrink-0 text-white/30" />
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://civitai.com/api/download/models/…"
              className="w-full bg-transparent text-[11px] text-white/80 outline-none placeholder:text-white/20"
            />
          </div>
          <div className="flex gap-2">
            <select
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-[11px] text-white/70 outline-none"
            >
              {WORKER_MODEL_DIRS.map((d) => (
                <option key={d} value={d} className="bg-neutral-900">
                  {d}
                </option>
              ))}
            </select>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="filename.safetensors"
              className="w-full rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 text-[11px] text-white/80 outline-none placeholder:text-white/20"
            />
          </div>
          <p className="text-[10px] leading-relaxed text-white/30">
            civitai links have no filename in them, so set one here with the right extension —
            otherwise the file lands named after the id and ComfyUI will not list it. And check the
            LoRA&apos;s base model on the page first: one trained for another model will not load.
          </p>
          <button
            type="button"
            disabled={busy || !url.trim()}
            onClick={() => void startDownload([{ url: url.trim(), directory, name: name.trim() }])}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600/80 px-3 py-2 text-[11px] font-medium text-white transition-colors hover:bg-indigo-600 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <HardDriveDownload className="h-3 w-3" />}
            Download to volume
          </button>
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-red-500/20 bg-red-500/5 p-2 text-[11px] text-red-300/90">
          {error}
        </p>
      )}

      {preflight && tab === 'workflow' && (
        <div className="space-y-2 border-t border-white/5 pt-3">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/25">
            <span>{chosen.length} of {downloadable.length} selected</span>
            <button
              type="button"
              className="ml-auto transition-colors hover:text-white/60"
              onClick={() => setSelected(new Set(downloadable.map(keyOf)))}
            >
              all
            </button>
            <button
              type="button"
              className="transition-colors hover:text-white/60"
              onClick={() => setSelected(new Set())}
            >
              none
            </button>
          </div>

          <div className="space-y-1">
            {preflight.report.models.map((m) => {
              const key = keyOf(m)
              const isSelected = selected.has(key)
              return (
                <label
                  key={key}
                  className={cn(
                    'flex items-center gap-2 rounded-lg px-1 py-0.5 text-[11px]',
                    m.url ? 'cursor-pointer hover:bg-white/[0.03]' : 'cursor-default'
                  )}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    // A row with no URL cannot be fetched by anything here, so it
                    // is shown for what it is rather than offered as a choice.
                    disabled={!m.url}
                    onChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev)
                        if (next.has(key)) next.delete(key)
                        else next.add(key)
                        return next
                      })
                    }
                    className="h-3 w-3 shrink-0 accent-indigo-500 disabled:opacity-20"
                  />
                  <span className="w-32 shrink-0 truncate font-mono text-white/30">
                    {m.directory}
                  </span>
                  <span
                    className={cn(
                      'truncate',
                      !m.url ? 'text-amber-300/80' : isSelected ? 'text-white/70' : 'text-white/35'
                    )}
                  >
                    {m.name}
                  </span>
                  <span className="ml-auto shrink-0 text-white/30">
                    {m.url ? formatBytes(m.size) : 'no URL'}
                  </span>
                </label>
              )
            })}
          </div>

          {preflight.report.packs.length > 0 && (
            <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-2 text-[11px] text-amber-300/90">
              <AlertTriangle className="mr-1 inline h-3 w-3" />
              {preflight.report.packs.length} custom node pack
              {preflight.report.packs.length > 1 ? 's' : ''}:{' '}
              {preflight.report.packs.map((p) => p.cnrId).join(', ')}. Installing them in the lab
              pod does not put them in the worker — pin them with{' '}
              <code className="text-amber-200">ingest_workflow.py --build-commands</code>.
            </p>
          )}

          {preflight.report.missingDirs.length > 0 && (
            <p className="rounded-lg border border-red-500/20 bg-red-500/5 p-2 text-[11px] text-red-300/90">
              Folders the worker does not map: {preflight.report.missingDirs.join(', ')}. Add them to
              MODEL_DIRS in beam/comfy/app.py and redeploy.
            </p>
          )}

          {preflight.report.unsourced.length > 0 && (
            <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-2 text-[11px] text-amber-300/90">
              Named but not declared: {preflight.report.unsourced.map((u) => u.name).join(', ')}. The
              workflow does not say where these come from — find them and use the From URL tab.
            </p>
          )}

          <button
            type="button"
            disabled={busy || chosen.length === 0}
            onClick={() => void startDownload(chosen)}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600/80 px-3 py-2 text-[11px] font-medium text-white transition-colors hover:bg-indigo-600 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <HardDriveDownload className="h-3 w-3" />}
            {chosen.length === 0
              ? 'Nothing selected'
              : `Download ${chosen.length} file${chosen.length === 1 ? '' : 's'} (${formatBytes(chosenBytes)})`}
          </button>
        </div>
      )}

      {job && (
        <div
          className={cn(
            'flex items-center gap-2 rounded-lg border p-2 text-[11px]',
            job.failed
              ? 'border-red-500/20 bg-red-500/5 text-red-300/90'
              : job.done
                ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300/90'
                : 'border-white/10 bg-white/[0.02] text-white/50'
          )}
        >
          {job.done ? (
            <CheckCircle2 className="h-3 w-3 shrink-0" />
          ) : job.failed ? (
            <AlertTriangle className="h-3 w-3 shrink-0" />
          ) : (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
          )}
          <span>
            {job.done
              ? `${job.queued} file${job.queued === 1 ? '' : 's'} on the volume. Press R in ComfyUI to refresh the loaders.`
              : job.failed
                ? `Download ${job.status.toLowerCase()}.`
                : `Downloading ${job.queued} file${job.queued === 1 ? '' : 's'}… (${job.status.toLowerCase()})`}
          </span>
        </div>
      )}
    </section>
  )
}
