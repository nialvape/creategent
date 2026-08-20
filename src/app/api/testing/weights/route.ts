import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ingestWorkflow,
  isUiWorkflow,
  WORKER_MODEL_DIRS,
  type DownloadEntry,
} from '@/lib/comfy/workflow-ingest'

export const runtime = 'nodejs'

/** Auth is handled by the proxy (src/proxy.ts) for every /api/* path. */

/**
 * The Model Lab's weights panel: read a workflow, see what it needs, put it on
 * the Beam volume — without a terminal.
 *
 * Everything here funnels into one Beam task queue (`beam/models/download.py`,
 * deployed as `handler`), which is a CPU container. That is the whole reason
 * this route exists rather than a button that calls ComfyUI's own download:
 * ComfyUI would pull the weights onto the GPU pod at RTX 5090 rates, for a
 * transfer a CPU container does for cents.
 */

const WORKFLOW_DIR = 'comfy_workflows'
const BEAM_TASK_API = 'https://api.beam.cloud/v2/task'

/** Beam task states that mean "done", mirroring src/providers/beam.ts. */
const DONE = new Set(['COMPLETE', 'COMPLETED', 'SUCCESS', 'SUCCEEDED'])
const FAILED = new Set(['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'TIMEOUT', 'EXPIRED'])

class BadInput extends Error {}

function bad(message: string, status = 400) {
  return Response.json({ ok: false, error: message }, { status })
}

function beamAuth(): { url: string; token: string } {
  const url = process.env.BEAM_DOWNLOADER_URL
  const token = process.env.BEAM_TOKEN
  if (!url || !token) {
    throw new BadInput(
      'BEAM_DOWNLOADER_URL and BEAM_TOKEN must be set. Deploy the downloader with: ' +
        'cd beam/models && beam deploy download.py:handler'
    )
  }
  return { url, token }
}

/**
 * The lab-control task queue (`beam/lab/launch.py`), which starts and stops the
 * ComfyUI Pod.
 *
 * It is a separate deployment from the downloader because it is a separate job
 * with a separate blast radius: one moves bytes onto a volume, the other spends
 * GPU time. Neither can be done from here directly — Vercel cannot run the Beam
 * SDK — so both are containers on Beam that this route talks to over HTTP.
 */
function labControl(): { url: string; token: string } {
  const url = process.env.BEAM_LAB_CONTROL_URL
  const token = process.env.BEAM_TOKEN
  if (!url || !token) {
    throw new BadInput(
      'BEAM_LAB_CONTROL_URL and BEAM_TOKEN must be set. Deploy the controller with: ' +
        'cd beam/lab && beam deploy launch.py:handler --name comfy-lab-control'
    )
  }
  return { url, token }
}

/**
 * Call the lab controller and wait for its answer.
 *
 * Starting a Pod is seconds when the image is cached, so unlike a download this
 * is worth blocking on rather than handing back a task id to poll. The ceiling
 * is the route's own, and a slow create surfaces as a timeout the panel can
 * report — better than a success that is really "we asked".
 */
async function callLabControl(payload: Record<string, unknown>) {
  const { url, token } = labControl()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    throw new Error(`Beam lab control failed (${res.status}): ${await res.text()}`)
  }
  return (await res.json()) as Record<string, unknown>
}

async function startPod() {
  return Response.json({ ok: true, ...(await callLabControl({ action: 'start' })) })
}

async function podStatus() {
  return Response.json({ ok: true, ...(await callLabControl({ action: 'status' })) })
}

async function stopPod(body: Record<string, unknown>) {
  const containerId = typeof body.containerId === 'string' ? body.containerId : undefined
  return Response.json({
    ok: true,
    ...(await callLabControl({ action: 'stop', containerId })),
  })
}

/**
 * Content-Length for one URL, or null when the host will not say.
 *
 * This is what lets the downloader distinguish a file that is already there from
 * one that is half there. It is a HEAD per model, so it runs for the whole list
 * at once rather than serially — four of them behind a spinner is the difference
 * between a panel that feels instant and one that does not.
 */
async function headSize(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' })
    const length = res.headers.get('content-length')
    return length ? Number(length) : null
  } catch {
    return null
  }
}

/** Workflow JSONs sitting in comfy_workflows/. */
async function listWorkflows() {
  // Reading the repo's own files works in local development, which is where the
  // lab lives. A deployed serverless build has no such directory, and that is
  // not an error worth surfacing — the drop zone and the URL form still work,
  // so an empty list is the honest answer.
  try {
    const dir = join(process.cwd(), WORKFLOW_DIR)
    const names = await readdir(dir)
    const files = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const info = await stat(join(dir, name))
      if (!info.isFile()) continue
      files.push({
        name,
        bytes: info.size,
        modifiedAt: info.mtime.toISOString(),
        // `.api.json` is the export the worker runs; the plain `.json` is the
        // one that carries the download URLs. Only the latter can be ingested.
        isApiExport: name.endsWith('.api.json'),
      })
    }
    return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  } catch {
    return []
  }
}

async function readWorkflowFile(name: string): Promise<unknown> {
  // Anything but a bare filename is refused: this reads from a fixed directory
  // and must not become a way to read arbitrary paths off the server.
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new BadInput('invalid workflow name')
  }
  if (!name.endsWith('.json')) throw new BadInput('workflow must be a .json file')
  const raw = await readFile(join(process.cwd(), WORKFLOW_DIR, name), 'utf-8')
  return JSON.parse(raw)
}

export async function GET() {
  return Response.json({
    ok: true,
    workflows: await listWorkflows(),
    modelDirs: WORKER_MODEL_DIRS,
    configured: Boolean(process.env.BEAM_DOWNLOADER_URL && process.env.BEAM_TOKEN),
  })
}

export async function POST(req: Request) {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return bad('body must be JSON')
  }

  const action = typeof body.action === 'string' ? body.action : ''

  try {
    switch (action) {
      case 'preflight':
        return await preflight(body)
      case 'download':
        return await startDownload(body)
      case 'status':
        return await pollDownload(body)
      case 'pod-start':
        return await startPod()
      case 'pod-status':
        return await podStatus()
      case 'pod-stop':
        return await stopPod(body)
      default:
        return bad(`unknown action: ${action || '(none)'}`)
    }
  } catch (err) {
    if (err instanceof BadInput) return bad(err.message)
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

/** Parse a workflow — pasted, dropped, or picked from comfy_workflows/. */
async function preflight(body: Record<string, unknown>) {
  const source = typeof body.file === 'string' ? body.file : null
  const data = source ? await readWorkflowFile(source) : body.workflow

  if (!isUiWorkflow(data)) {
    // The most common mistake, and worth naming precisely rather than saying
    // "invalid": an API export parses fine as JSON and is simply the wrong file.
    const looksLikeApi =
      data !== null &&
      typeof data === 'object' &&
      Object.values(data as Record<string, unknown>).every(
        (v) => v && typeof v === 'object' && 'class_type' in (v as object)
      )
    throw new BadInput(
      looksLikeApi
        ? 'That is an API export. It carries no model URLs or node sources — ' +
          'use the UI-format workflow (the file ComfyUI saves, or the civitai download).'
        : 'Not a ComfyUI workflow: no "nodes" array.'
    )
  }

  const report = ingestWorkflow(data)
  const sizes = await Promise.all(
    report.models.map((m) => (m.url ? headSize(m.url) : Promise.resolve(null)))
  )
  const models = report.models.map((m, i) => ({ ...m, size: sizes[i] }))
  const totalBytes = sizes.reduce((sum: number, s) => sum + (s ?? 0), 0)

  return Response.json({
    ok: true,
    source: source ?? 'upload',
    report: { ...report, models },
    totalBytes,
  })
}

function asManifest(value: unknown): DownloadEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadInput('nothing to download')
  }
  return value.map((raw) => {
    const entry = (raw ?? {}) as Record<string, unknown>
    const url = typeof entry.url === 'string' ? entry.url.trim() : ''
    const directory = typeof entry.directory === 'string' ? entry.directory.trim() : ''
    let name = typeof entry.name === 'string' ? entry.name.trim() : ''

    if (!url) throw new BadInput('every entry needs a url')
    if (!directory) throw new BadInput('every entry needs a target folder')
    if (!(WORKER_MODEL_DIRS as readonly string[]).includes(directory)) {
      throw new BadInput(
        `"${directory}" is not a folder the worker maps. The loaders would never see the file.`
      )
    }
    if (!name) {
      // civitai's links are /api/download/models/<id> with no filename, so the
      // fallback lands on the bare id with no extension and ComfyUI will not
      // list it. Better to derive something and let the caller override.
      name = url.split('?')[0].replace(/\/+$/, '').split('/').pop() ?? ''
    }
    if (!name) throw new BadInput('could not work out a filename; set one explicitly')

    const size = typeof entry.size === 'number' && Number.isFinite(entry.size) ? entry.size : null
    return { url, directory, name, size }
  })
}

/** Queue the download. Returns a task id; nothing waits on 30 GB of transfer. */
async function startDownload(body: Record<string, unknown>) {
  const models = asManifest(body.models)
  const { url, token } = beamAuth()

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ models }),
  })
  if (!res.ok) {
    throw new Error(`Beam submit failed (${res.status}): ${await res.text()}`)
  }
  const { task_id: taskId } = (await res.json()) as { task_id?: string }
  if (!taskId) throw new Error('Beam accepted the job but returned no task_id')

  return Response.json({ ok: true, taskId, queued: models.length })
}

async function pollDownload(body: Record<string, unknown>) {
  const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : ''
  if (!taskId) throw new BadInput('taskId is required')
  const { token } = beamAuth()

  const res = await fetch(`${BEAM_TASK_API}/${taskId}/`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  })
  if (!res.ok) {
    throw new Error(`Beam task poll failed (${res.status}): ${await res.text()}`)
  }

  const task = (await res.json()) as { status?: string; outputs?: unknown; result?: unknown }
  const status = (task.status ?? '').toUpperCase()

  return Response.json({
    ok: true,
    taskId,
    status,
    done: DONE.has(status),
    failed: FAILED.has(status),
    result: task.result ?? null,
  })
}
