/**
 * The wire contract for running a ComfyUI graph on a serverless worker.
 *
 * This is deliberately backend-agnostic: RunPod and Beam run the same worker
 * code (`comfy_worker/` at the repo root) and speak the same shapes, so the
 * only thing an adapter contributes is how a job is submitted and polled.
 *
 * On the input side `files` and `images` carry the same thing. `images` is what
 * the stock `runpod/worker-comfyui` handler understands, and ComfyUI's upload
 * endpoint never inspects content, so audio and video ride that channel fine
 * despite the name. Which key a job uses is declared per endpoint by
 * `ComfyContract`, and only one is ever sent — putting the same base64 under
 * both doubles the payload against a hard body limit, which for a graph with a
 * voice track and a first frame is the difference between fitting and not.
 *
 * On the output side they are NOT the same thing. The stock handler only ever
 * returned a node's `images` output and dropped audio, video and text with a
 * warning in its own logs; ours returns every produced file under `files`, and
 * mirrors them into `images` for compatibility. `normalizeComfyOutput` accepts
 * either, so the app works against both worker builds.
 */

/** A file uploaded into ComfyUI's `input/` directory before the graph runs. */
export interface ComfyInputFile {
  /** Filename the graph's loader node references. The extension decides how
   *  ComfyUI treats it, so it has to match the real format. */
  name: string
  /** Base64 of the raw bytes, with no `data:` prefix. */
  data: string
}

/** A file the graph produced. */
export interface ComfyOutputFile {
  filename: string
  /** MIME derived from the extension by the worker; never empty. */
  mime: string
  /** `base64` means `data` is the file; `url` means `data` points at it. */
  encoding: 'base64' | 'url'
  /** Raw base64 or a URL, per `encoding`. */
  data: string
  /** Graph node that emitted it, when the worker reports it. */
  nodeId?: string
  /** Node output key it came from — `images`, `audio`, `gifs`, … */
  key?: string
  subfolder?: string
  /** ComfyUI's own directory type: `output` | `temp` | `input`. */
  folder?: string
  /** Decoded size in bytes. */
  size?: number
}

/** A non-file output: a caption, a number, whatever a node chose to return. */
export interface ComfyOutputValue {
  nodeId?: string
  key?: string
  value: unknown
}

export interface ComfyJobOutput {
  files: ComfyOutputFile[]
  values: ComfyOutputValue[]
  /** Non-fatal problems. A job can return files AND errors. */
  errors: string[]
}

/** Shape of one entry in the legacy `images` array. */
interface LegacyImage {
  filename?: string
  type?: string
  data?: string
}

interface RawFile {
  filename?: string
  mime?: string
  encoding?: string
  data?: string
  node_id?: string
  key?: string
  subfolder?: string
  folder?: string
  size?: number
}

interface RawValue {
  node_id?: string
  key?: string
  value?: unknown
}

/**
 * Extension → MIME, for the legacy path where the worker reports no MIME.
 * Kept in step with `_MIME_OVERRIDES` in `comfy_worker/contract.py`.
 */
const MIME_BY_EXT: Record<string, string> = {
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
  gif: 'image/gif',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  json: 'application/json',
  txt: 'text/plain',
}

const DEFAULT_MIME = 'application/octet-stream'

export function mimeForFilename(filename: string | undefined): string {
  const ext = filename?.split('.').pop()?.toLowerCase()
  return (ext && MIME_BY_EXT[ext]) || DEFAULT_MIME
}

/** File extension for a MIME type, without the dot. Used when naming uploads. */
export function extensionForMime(mime: string, fallback = 'bin'): string {
  const hit = Object.entries(MIME_BY_EXT).find(([, m]) => m === mime)
  return hit?.[0] ?? fallback
}

/**
 * Which worker build an endpoint is running.
 *
 * `legacy` is the stock runpod/worker-comfyui handler: inputs go under
 * `images`, and only a node's `images` output ever comes back. `generic` is our
 * worker (`comfy_worker/`), which takes `files` and returns everything.
 *
 * `legacy` is also the safe choice against an unknown worker, since ours
 * accepts both input keys — the cost of being wrong is only that non-image
 * outputs stay invisible.
 */
export type ComfyContract = 'legacy' | 'generic'

/** Builds the `input` payload for a Comfy job, under the key that worker reads. */
export function comfyJobInput(
  workflow: Record<string, unknown>,
  files: ComfyInputFile[],
  contract: ComfyContract = 'generic'
): Record<string, unknown> {
  if (contract === 'legacy') {
    return { workflow, images: files.map((f) => ({ name: f.name, image: f.data })) }
  }
  return { workflow, files }
}

/**
 * Reads a worker's `output` into the canonical shape, accepting either the
 * generic `files` array or the legacy image-only one.
 */
export function normalizeComfyOutput(output: Record<string, unknown>): ComfyJobOutput {
  const errors = Array.isArray(output.errors) ? (output.errors as string[]) : []

  const values: ComfyOutputValue[] = Array.isArray(output.values)
    ? (output.values as RawValue[]).map((v) => ({
        nodeId: v.node_id,
        key: v.key,
        value: v.value,
      }))
    : []

  if (Array.isArray(output.files)) {
    const files = (output.files as RawFile[])
      .filter((f) => f.filename && f.data)
      .map(
        (f): ComfyOutputFile => ({
          filename: f.filename!,
          mime: f.mime || mimeForFilename(f.filename),
          encoding: f.encoding === 'url' ? 'url' : 'base64',
          data: f.data!,
          nodeId: f.node_id,
          key: f.key,
          subfolder: f.subfolder,
          folder: f.folder,
          size: f.size,
        })
      )
    return { files, values, errors }
  }

  // Legacy worker: everything it managed to return is under `images`, typed
  // by how it was serialized rather than by what it is.
  const legacy = Array.isArray(output.images) ? (output.images as LegacyImage[]) : []
  const files = legacy
    .filter((i) => i.filename && i.data)
    .map(
      (i): ComfyOutputFile => ({
        filename: i.filename!,
        mime: mimeForFilename(i.filename),
        encoding: i.type === 's3_url' ? 'url' : 'base64',
        data: i.data!,
        key: 'images',
      })
    )
  return { files, values, errors }
}

/** A URL the app can hand to storage or a browser: the URL itself, or a data URI. */
export function comfyFileUrl(file: ComfyOutputFile): string {
  return file.encoding === 'url' ? file.data : `data:${file.mime};base64,${file.data}`
}

/**
 * Picks the file a caller actually wants out of everything the graph emitted.
 *
 * Matching is by MIME prefix (`video/`, `audio/`) rather than by node key,
 * because the key a file arrives under is an artifact of which Save node the
 * template used — LTX's mp4 comes back under `images`, since ComfyUI's
 * SaveVideo reports through PreviewVideo.
 */
export function pickComfyFile(
  files: ComfyOutputFile[],
  mimePrefix: string
): ComfyOutputFile | undefined {
  return files.find((f) => f.mime.startsWith(mimePrefix))
}

/**
 * Human-readable summary of what a graph returned, for error messages.
 * Without it, "no video in the output" gives no hint that the graph produced
 * a flac and nothing else.
 */
export function describeComfyOutput(out: ComfyJobOutput): string {
  const parts: string[] = []
  if (out.files.length) {
    parts.push(out.files.map((f) => `${f.filename} (${f.mime})`).join(', '))
  }
  if (out.values.length) {
    parts.push(`${out.values.length} non-file output(s)`)
  }
  if (!parts.length) parts.push('nothing')
  if (out.errors.length) parts.push(`errors: ${out.errors.join('; ')}`)
  return parts.join('; ')
}
