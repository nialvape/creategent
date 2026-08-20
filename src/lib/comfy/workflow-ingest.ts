/**
 * Reads a ComfyUI **UI-format** workflow and works out what it would take to run
 * it on the Beam worker: which weights, from where, into which folder, and which
 * custom node packs have to be pinned in the image.
 *
 * This is the TypeScript half of `scripts/ingest_workflow.py`. Both exist on
 * purpose: the script is what you reach for in a terminal and what emits build
 * lines to paste, this one is what the Model Lab's weights panel calls so none
 * of that needs a terminal at all. They read the same fields and must agree.
 *
 * Why the UI format and not the API export
 * ----------------------------------------
 * The information only exists in the UI file. Per node it carries
 *
 *     properties.models   [{name, url, directory}]   the download URL and folder
 *     properties.cnr_id   "comfy-core" | registry id whether it is a custom node
 *     properties.ver      the version the author used
 *
 * while an API export is `class_type` + `inputs` and nothing else. So a workflow
 * is kept as a pair: the UI JSON is the recipe, the export is what executes.
 */

/** Node types that live only in the frontend and need nothing installed. */
const FRONTEND_ONLY = new Set(['MarkdownNote', 'Note', 'Reroute', 'PrimitiveNode'])

const WEIGHT_EXTENSIONS = ['.safetensors', '.gguf', '.ckpt', '.pt', '.pth', '.bin']

/**
 * The model folders the Beam worker symlinks into ComfyUI at build time.
 *
 * A copy of the `MODEL_DIRS` literal in `beam/comfy/app.py`, and it has to be
 * kept in step by hand. Sharing one definition is not possible: Beam syncs only
 * the directory of the app it deploys, so `beam/comfy/app.py` cannot import a
 * file from the repo root — the same constraint that makes it copy
 * `comfy_worker/` in at deploy time.
 */
export const WORKER_MODEL_DIRS = [
  'checkpoints',
  'clip',
  'clip_vision',
  'controlnet',
  'diffusers',
  'diffusion_models',
  'embeddings',
  'gligen',
  'hypernetworks',
  'latent_upscale_models',
  'loras',
  'model_patches',
  'photomaker',
  'style_models',
  'text_encoders',
  'unet',
  'upscale_models',
  'vae',
  'vae_approx',
  'audio_encoders',
  'background_removal',
  'classifiers',
  'detection',
  'frame_interpolation',
  'geometry_estimation',
  'optical_flow',
] as const

export interface WorkflowModel {
  name: string
  directory: string
  /** null when the workflow names a file without saying where it came from. */
  url: string | null
  /** Node types that load it, for showing the user where it is used. */
  nodes: string[]
}

export interface NodePack {
  cnrId: string
  ver: string | null
  types: string[]
}

export interface IngestReport {
  models: WorkflowModel[]
  packs: NodePack[]
  /** Non-frontend nodes with no registry id: source unknown, needs a human. */
  unknownNodes: { type: string; count: number }[]
  /** Weight filenames named by a widget that nothing in the workflow declares. */
  unsourced: { name: string; nodeType: string }[]
  /** Folders this workflow needs that the worker does not map. */
  missingDirs: string[]
  /** True when something here cannot be resolved automatically. */
  needsAttention: boolean
}

interface RawNode {
  type?: string
  properties?: {
    models?: { name?: string; url?: string; directory?: string }[]
    cnr_id?: string | null
    ver?: string | null
  }
  widgets_values?: unknown
}

interface RawWorkflow {
  nodes?: RawNode[]
  definitions?: { subgraphs?: { nodes?: RawNode[] }[] }
}

/** True for a parsed JSON that is a UI workflow rather than an API export. */
export function isUiWorkflow(data: unknown): data is RawWorkflow {
  return typeof data === 'object' && data !== null && Array.isArray((data as RawWorkflow).nodes)
}

/**
 * Every node, including those inside subgraph definitions.
 *
 * Subgraphs are not an edge case: the LTX 2.5 template keeps half its loaders in
 * one, which is why its API export has ids like `398:393`. Reading only the top
 * level silently under-reports what a graph needs.
 */
function* walkNodes(workflow: RawWorkflow): Generator<RawNode> {
  for (const node of workflow.nodes ?? []) yield node
  for (const sub of workflow.definitions?.subgraphs ?? []) {
    for (const node of sub.nodes ?? []) yield node
  }
}

export function ingestWorkflow(workflow: RawWorkflow): IngestReport {
  const models = new Map<string, WorkflowModel>()
  const packs = new Map<string, NodePack>()
  const unknown = new Map<string, number>()
  const unsourced = new Map<string, string>()

  // Declared names are gathered across the whole workflow before anything is
  // judged unsourced. A subgraph instance is a node whose type is the
  // subgraph's uuid, and it re-lists the widget values of every node inside it
  // while declaring no models of its own — per node that makes each model look
  // undeclared, globally it resolves against the real loader inside.
  const declared = new Set<string>()
  for (const node of walkNodes(workflow)) {
    for (const entry of node.properties?.models ?? []) {
      if (entry.name) declared.add(entry.name)
    }
  }

  for (const node of walkNodes(workflow)) {
    const type = node.type ?? '(unnamed)'
    const props = node.properties ?? {}

    for (const entry of props.models ?? []) {
      if (!entry.name) continue
      const key = `${entry.directory ?? ''}/${entry.name}`
      const existing = models.get(key)
      if (existing) {
        existing.nodes.push(type)
      } else {
        models.set(key, {
          name: entry.name,
          directory: entry.directory ?? '',
          url: entry.url ?? null,
          nodes: [type],
        })
      }
    }

    const cnr = props.cnr_id
    if (cnr && cnr !== 'comfy-core') {
      const pack = packs.get(cnr)
      if (pack) {
        if (!pack.types.includes(type)) pack.types.push(type)
      } else {
        packs.set(cnr, { cnrId: cnr, ver: props.ver ?? null, types: [type] })
      }
    } else if (!cnr && !FRONTEND_ONLY.has(type)) {
      unknown.set(type, (unknown.get(type) ?? 0) + 1)
    }

    if (Array.isArray(node.widgets_values)) {
      for (const value of node.widgets_values) {
        if (typeof value !== 'string') continue
        if (!WEIGHT_EXTENSIONS.some((ext) => value.endsWith(ext))) continue
        if (declared.has(value)) continue
        if (!unsourced.has(value)) unsourced.set(value, type)
      }
    }
  }

  const modelList = [...models.values()]
  const dirsNeeded = [...new Set(modelList.map((m) => m.directory).filter(Boolean))]
  const missingDirs = dirsNeeded.filter(
    (d) => !(WORKER_MODEL_DIRS as readonly string[]).includes(d)
  )

  return {
    models: modelList,
    packs: [...packs.values()],
    unknownNodes: [...unknown.entries()].map(([type, count]) => ({ type, count })),
    unsourced: [...unsourced.entries()].map(([name, nodeType]) => ({ name, nodeType })),
    missingDirs,
    needsAttention:
      missingDirs.length > 0 ||
      unknown.size > 0 ||
      unsourced.size > 0 ||
      modelList.some((m) => !m.url),
  }
}

/** The manifest shape `beam/models/download.py` consumes. */
export interface DownloadEntry {
  url: string
  directory: string
  name: string
  size: number | null
}

/**
 * Turn a report into a download manifest, dropping anything with no URL.
 *
 * `size` is left null here and filled in by the caller with a HEAD request when
 * it can: it is what lets the downloader tell "already there" from "half of it
 * is already there", since the only other available check is exists-and-nonempty
 * and that passes a truncated file straight through.
 */
export function toManifest(report: IngestReport): DownloadEntry[] {
  return report.models
    .filter((m): m is WorkflowModel & { url: string } => Boolean(m.url))
    .map((m) => ({ url: m.url, directory: m.directory, name: m.name, size: null }))
}
