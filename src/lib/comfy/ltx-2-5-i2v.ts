/**
 * Builds the ComfyUI API-format workflow for MiniMax-style LTX 2.5 image-to-video
 * on the self-hosted RunPod endpoint (runpod/comfyui worker).
 *
 * The graph is the official Comfy-Org LTX 2.5 I2V template, exported via
 * "Workflow -> Export (API)" and parameterized. Node ids are preserved verbatim
 * (including the `398:` subgraph prefixes) so a re-export from ComfyUI can be
 * diffed against this file.
 *
 * Two things about this graph are easy to get wrong:
 *
 *  1. Output resolution comes from ResolutionSelector (aspect + megapixels),
 *     NOT from the input image. The image is rescaled to a 1536 long side and
 *     only conditions the first frame. Feeding a portrait image while asking for
 *     a landscape aspect produces a distorted first frame, so callers should
 *     derive the aspect from the image (see `aspectRatioForSize`).
 *
 *  2. Sampling runs in two stages: stage 1 at HALF the requested resolution,
 *     then LTXVLatentUpsampler doubles it for stage 2. The megapixel figure here
 *     is therefore the final output, not what the sampler sees.
 *
 * Step counts are deliberately not exposed. They are encoded in the ManualSigmas
 * schedules (8 steps + 3), which are tuned for the *distilled* checkpoint —
 * changing the count means designing a new sigma curve, not editing a number.
 */

/** Exactly the values ComfyUI's ResolutionSelector accepts (AspectRatio enum). */
export const LTX_ASPECT_RATIOS = [
  '1:1 (Square)',
  '2:3 (Portrait Photo)',
  '3:2 (Photo)',
  '3:4 (Portrait Standard)',
  '4:3 (Standard)',
  '9:16 (Portrait Widescreen)',
  '16:9 (Widescreen)',
  '21:9 (Ultrawide)',
] as const

export type LtxAspectRatio = (typeof LTX_ASPECT_RATIOS)[number]

/** Numerator/denominator per ratio, mirroring ComfyUI's ASPECT_RATIOS table. */
const RATIO_VALUES: Record<LtxAspectRatio, [number, number]> = {
  '1:1 (Square)': [1, 1],
  '2:3 (Portrait Photo)': [2, 3],
  '3:2 (Photo)': [3, 2],
  '3:4 (Portrait Standard)': [3, 4],
  '4:3 (Standard)': [4, 3],
  '9:16 (Portrait Widescreen)': [9, 16],
  '16:9 (Widescreen)': [16, 9],
  '21:9 (Ultrawide)': [21, 9],
}

/**
 * Picks the listed aspect ratio closest to a real image's proportions, so
 * "auto" in the UI can keep the generated frame from being stretched.
 */
export function aspectRatioForSize(width: number, height: number): LtxAspectRatio {
  if (!width || !height) return '16:9 (Widescreen)'
  const target = width / height
  let best: LtxAspectRatio = '1:1 (Square)'
  let bestDelta = Infinity
  for (const [name, [w, h]] of Object.entries(RATIO_VALUES) as [LtxAspectRatio, [number, number]][]) {
    // Compare in log space so 21:9 isn't unfairly favoured over 9:16 by the
    // larger absolute distance a plain difference would give wide ratios.
    const delta = Math.abs(Math.log(target) - Math.log(w / h))
    if (delta < bestDelta) {
      bestDelta = delta
      best = name
    }
  }
  return best
}

/**
 * Mirrors ComfyUI's ResolutionSelector.execute so the UI can show the real
 * output size before a run. Two details matter and are easy to get wrong:
 * "megapixels" is binary (1024*1024, not 1e6), and width and height are each
 * rounded to `multiple` independently from a shared scale — deriving one from
 * the other's rounded value drifts by up to a full step.
 */
export function resolveDimensions(
  aspectRatio: LtxAspectRatio,
  megapixels: number,
  multiple = 32
): { width: number; height: number } {
  const [rw, rh] = RATIO_VALUES[aspectRatio]
  const totalPixels = megapixels * 1024 * 1024
  const scale = Math.sqrt(totalPixels / (rw * rh))
  const snap = (v: number) => Math.max(multiple, Math.round(v / multiple) * multiple)
  return { width: snap(rw * scale), height: snap(rh * scale) }
}

/** Frames the graph will render: `duration * fps + 1` (node 398:378). */
export function frameCount(durationSec: number, fps: number): number {
  return durationSec * fps + 1
}

export interface LtxI2vParams {
  /** Motion/scene description. Fed to the enhancer, or used raw when it's off. */
  prompt: string
  /** Filename of the first frame, as uploaded through `input.images[].name`. */
  imageName: string
  aspectRatio: LtxAspectRatio
  /** Final output megapixels. ComfyUI snaps the derived size to a multiple of 32. */
  megapixels: number
  durationSec: number
  fps: number
  /** Stage-1 noise seed. Omit for a random one so repeat runs differ. */
  seed?: number
  /**
   * Runs the prompt through TextGenerateLTX2Prompt (a Gemma 4 E2B pass that
   * rewrites it with the input image in view). Off sends the prompt verbatim.
   */
  enhancePrompt: boolean
  negativePrompt: string
}

export const LTX_DEFAULTS = {
  megapixels: 0.7,
  durationSec: 5,
  fps: 24,
  enhancePrompt: true,
  negativePrompt: 'pc game, console game, video game, cartoon, childish, ugly',
} as const

/** Model files this workflow loads — all resolved from the network volume. */
export const LTX_MODEL_FILES = {
  transformer: 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors',
  textEncoder: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors',
  promptEncoder: 'gemma4_e2b_it_bf16.safetensors',
  videoVae: 'ltx-2.5-video-vae-bf16.safetensors',
  audioVae: 'ltx-2.5-audio-vae-bf16.safetensors',
  spatialUpscaler: 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors',
} as const

type ComfyNode = { inputs: Record<string, unknown>; class_type: string }

export function buildLtxI2vWorkflow(params: LtxI2vParams): Record<string, ComfyNode> {
  const seed = params.seed ?? Math.floor(Math.random() * 1e15)

  return {
    '75': {
      inputs: {
        filename_prefix: 'video/LTX-2.5_i2v',
        format: 'auto',
        codec: 'auto',
        video: ['398:370', 0],
      },
      class_type: 'SaveVideo',
    },
    '395': { inputs: { image: params.imageName }, class_type: 'LoadImage' },
    '403': {
      inputs: {
        aspect_ratio: params.aspectRatio,
        megapixels: params.megapixels,
        multiple: 32,
      },
      class_type: 'ResolutionSelector',
    },

    // --- text encoders -------------------------------------------------------
    '398:393': {
      inputs: { clip_name: LTX_MODEL_FILES.promptEncoder, type: 'ltxv', device: 'default' },
      class_type: 'CLIPLoader',
    },
    '398:387': {
      inputs: { clip_name: LTX_MODEL_FILES.textEncoder, type: 'ltxv', device: 'default' },
      class_type: 'CLIPLoader',
    },

    // --- prompt path ---------------------------------------------------------
    '398:376': { inputs: { value: params.prompt }, class_type: 'PrimitiveStringMultiline' },
    '398:380': {
      inputs: {
        prompt: ['398:376', 0],
        max_length: 600,
        sampling_mode: 'on',
        'sampling_mode.temperature': 0.7,
        'sampling_mode.top_k': 64,
        'sampling_mode.top_p': 0.95,
        'sampling_mode.min_p': 0.05,
        'sampling_mode.repetition_penalty': 1.15,
        'sampling_mode.seed': 0,
        'sampling_mode.presence_penalty': 0,
        thinking: false,
        use_default_template: true,
        clip: ['398:393', 0],
        image: ['398:350', 0],
      },
      class_type: 'TextGenerateLTX2Prompt',
    },
    '398:383': { inputs: { value: params.enhancePrompt }, class_type: 'PrimitiveBoolean' },
    '398:382': {
      inputs: { switch: ['398:383', 0], on_false: ['398:376', 0], on_true: ['398:380', 0] },
      class_type: 'ComfySwitchNode',
    },
    '398:381': { inputs: { source: ['398:382', 0] }, class_type: 'PreviewAny' },
    '398:364': {
      inputs: { text: ['398:382', 0], clip: ['398:387', 0] },
      class_type: 'CLIPTextEncode',
    },
    '398:373': {
      inputs: { text: params.negativePrompt, clip: ['398:387', 0] },
      class_type: 'CLIPTextEncode',
    },
    '398:365': {
      inputs: {
        frame_rate: ['398:359', 0],
        positive: ['398:364', 0],
        negative: ['398:373', 0],
      },
      class_type: 'LTXVConditioning',
    },

    // --- models --------------------------------------------------------------
    '398:384': {
      inputs: { unet_name: LTX_MODEL_FILES.transformer, weight_dtype: 'default' },
      class_type: 'UNETLoader',
    },
    '398:385': { inputs: { vae_name: LTX_MODEL_FILES.videoVae }, class_type: 'VAELoader' },
    '398:386': { inputs: { vae_name: LTX_MODEL_FILES.audioVae }, class_type: 'VAELoader' },
    '398:371': {
      inputs: { model_name: LTX_MODEL_FILES.spatialUpscaler },
      class_type: 'LatentUpscaleModelLoader',
    },

    // --- geometry: duration/fps -> frames, resolution -> half-res latent ------
    '398:362': { inputs: { value: params.durationSec }, class_type: 'PrimitiveInt' },
    '398:361': { inputs: { value: params.fps }, class_type: 'PrimitiveInt' },
    '398:359': { inputs: { expression: 'a', 'values.a': ['398:361', 0] }, class_type: 'ComfyMathExpression' },
    '398:378': {
      inputs: { expression: 'a * b + 1', 'values.a': ['398:362', 0], 'values.b': ['398:361', 0] },
      class_type: 'ComfyMathExpression',
    },
    '398:372': { inputs: { value: ['403', 0] }, class_type: 'PrimitiveInt' },
    '398:360': { inputs: { value: ['403', 1] }, class_type: 'PrimitiveInt' },
    '398:353': { inputs: { expression: 'a/2', 'values.a': ['398:372', 0] }, class_type: 'ComfyMathExpression' },
    '398:355': { inputs: { expression: 'a/2', 'values.a': ['398:360', 0] }, class_type: 'ComfyMathExpression' },
    '398:356': {
      inputs: {
        width: ['398:353', 1],
        height: ['398:355', 1],
        length: ['398:378', 1],
        batch_size: 1,
      },
      class_type: 'EmptyLTXVLatentVideo',
    },

    // --- first frame ---------------------------------------------------------
    '398:351': {
      inputs: {
        resize_type: 'scale longer dimension',
        'resize_type.longer_size': 1536,
        scale_method: 'lanczos',
        input: ['395', 0],
      },
      class_type: 'ResizeImageMaskNode',
    },
    '398:350': {
      inputs: { img_compression: 18, image: ['398:351', 0] },
      class_type: 'LTXVPreprocess',
    },
    '398:363': { inputs: { value: false }, class_type: 'PrimitiveBoolean' },
    '398:357': {
      inputs: {
        strength: 0.7,
        bypass: ['398:363', 0],
        vae: ['398:385', 0],
        image: ['398:350', 0],
        latent: ['398:356', 0],
      },
      class_type: 'LTXVImgToVideoInplace',
    },
    '398:366': {
      inputs: {
        frames_number: ['398:378', 1],
        frame_rate: ['398:359', 1],
        batch_size: 1,
        audio_vae: ['398:386', 0],
      },
      class_type: 'LTXVEmptyLatentAudio',
    },
    '398:377': {
      inputs: { video_latent: ['398:357', 0], audio_latent: ['398:366', 0] },
      class_type: 'LTXVConcatAVLatent',
    },

    // --- stage 1: 8 steps at half resolution ---------------------------------
    '398:339': { inputs: { noise_seed: seed }, class_type: 'RandomNoise' },
    '398:352': { inputs: { sampler_name: 'euler_ancestral' }, class_type: 'KSamplerSelect' },
    '398:397': {
      inputs: { sigmas: '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0' },
      class_type: 'ManualSigmas',
    },
    '398:388': {
      inputs: {
        video_cfg: 1,
        audio_cfg: 1,
        model: ['398:384', 0],
        positive: ['398:365', 0],
        negative: ['398:365', 1],
      },
      class_type: 'LTXVDualCFGGuider',
    },
    '398:344': {
      inputs: {
        noise: ['398:339', 0],
        guider: ['398:388', 0],
        sampler: ['398:352', 0],
        sigmas: ['398:397', 0],
        latent_image: ['398:377', 0],
      },
      class_type: 'SamplerCustomAdvanced',
    },
    '398:367': { inputs: { av_latent: ['398:344', 0] }, class_type: 'LTXVSeparateAVLatent' },

    // --- upscale, then stage 2: 3 steps at full resolution --------------------
    '398:348': {
      inputs: {
        samples: ['398:367', 0],
        upscale_model: ['398:371', 0],
        vae: ['398:385', 0],
      },
      class_type: 'LTXVLatentUpsampler',
    },
    '398:349': {
      inputs: {
        strength: 1,
        bypass: ['398:363', 0],
        vae: ['398:385', 0],
        image: ['398:350', 0],
        latent: ['398:348', 0],
      },
      class_type: 'LTXVImgToVideoInplace',
    },
    '398:340': {
      inputs: { video_latent: ['398:349', 0], audio_latent: ['398:367', 1] },
      class_type: 'LTXVConcatAVLatent',
    },
    '398:338': { inputs: { noise_seed: 42 }, class_type: 'RandomNoise' },
    '398:341': { inputs: { sampler_name: 'euler_ancestral' }, class_type: 'KSamplerSelect' },
    '398:396': { inputs: { sigmas: '0.85, 0.7250, 0.4219, 0.0' }, class_type: 'ManualSigmas' },
    '398:391': {
      inputs: {
        video_cfg: 1,
        audio_cfg: 1,
        model: ['398:384', 0],
        positive: ['398:365', 0],
        negative: ['398:365', 1],
      },
      class_type: 'LTXVDualCFGGuider',
    },
    '398:368': {
      inputs: {
        noise: ['398:338', 0],
        guider: ['398:391', 0],
        sampler: ['398:341', 0],
        sigmas: ['398:396', 0],
        latent_image: ['398:340', 0],
      },
      class_type: 'SamplerCustomAdvanced',
    },
    '398:369': { inputs: { av_latent: ['398:368', 0] }, class_type: 'LTXVSeparateAVLatent' },

    // --- decode to an mp4 with its audio track -------------------------------
    '398:374': {
      inputs: {
        tile_size: 768,
        overlap: 64,
        temporal_size: 4096,
        temporal_overlap: 32,
        samples: ['398:369', 0],
        vae: ['398:385', 0],
      },
      class_type: 'VAEDecodeTiled',
    },
    '398:358': {
      inputs: { samples: ['398:369', 1], audio_vae: ['398:386', 0] },
      class_type: 'LTXVAudioVAEDecode',
    },
    '398:370': {
      inputs: {
        fps: ['398:359', 0],
        bit_depth: 8,
        images: ['398:374', 0],
        audio: ['398:358', 0],
      },
      class_type: 'CreateVideo',
    },
  }
}
