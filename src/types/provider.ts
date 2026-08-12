export interface GenerationResult<T = string> {
  url?: string
  data?: T
  cost: number
  model: string
  provider: string
  metadata?: Record<string, unknown>
}

export interface ProviderConfig {
  apiKey: string
  baseUrl?: string
  timeout?: number
}

/**
 * Generation settings for the self-hosted ComfyUI video endpoints, where the
 * workflow exposes more than a width/height/duration triple. Every field is
 * optional so callers that don't care get the workflow's own defaults.
 */
export interface VideoOptions {
  /** ComfyUI ResolutionSelector ratio, e.g. "9:16 (Portrait Widescreen)". */
  aspectRatio?: string
  /** Output megapixels. Combined with aspectRatio this sets the real size. */
  megapixels?: number
  fps?: number
  /** Sampler seed. Omitted means a random one per run. */
  seed?: number
  /** Rewrite the prompt with an LLM that can see the first frame. */
  enhancePrompt?: boolean
  negativePrompt?: string
}

export interface MediaProvider {
  generateImage(params: {
    prompt: string
    model: string
    width: number
    height: number
    format?: string
    maxAttempts?: number
  }): Promise<GenerationResult>

  generateVideo(params: {
    prompt: string
    model: string
    /** Source first-frame/reference image URL — required: every video is image-to-video */
    imageUrl: string
    width: number
    height: number
    duration: number
    format?: string
    maxAttempts?: number
    /**
     * Knobs only the self-hosted ComfyUI endpoints understand. Hosted providers
     * (Fal/Kling) take width/height/duration and ignore this.
     */
    options?: VideoOptions
  }): Promise<GenerationResult>

  /**
   * Talking-head animation: drive a first-frame portrait image with a voice
   * audio clip to produce a lip-synced avatar video (image + audio -> video).
   */
  generateAvatarVideo(params: {
    imageUrl: string
    audioUrl: string
    model: string
    maxAttempts?: number
  }): Promise<GenerationResult>

  listModels(): Promise<string[]>
}

export interface LLMProvider {
  generateText(params: {
    prompt: string
    model: string
    systemPrompt?: string
    maxTokens?: number
  }): Promise<GenerationResult<string>>

  generateStructuredOutput<T>(params: {
    prompt: string
    model: string
    schema: unknown
    systemPrompt?: string
  }): Promise<GenerationResult<T>>

  /**
   * Multimodal understanding: send a media file (image, video or audio) by URL to
   * a vision/audio-capable model and get a natural-language description back. Used
   * by the reference-media intake sub-agents.
   */
  describeMedia(params: {
    url: string
    /** MIME type, e.g. "image/png", "video/mp4", "audio/mpeg". */
    mediaType: string
    kind: 'image' | 'video' | 'audio'
    prompt: string
    model: string
    systemPrompt?: string
  }): Promise<GenerationResult<string>>
}

export interface AudioProvider {
  generateSpeech(params: {
    text: string
    voiceId: string
    modelId?: string
    /**
     * Base64-encoded reference voice sample for zero-shot voice cloning
     * (Chatterbox). When set, the synthesized speech mimics this voice.
     * Providers without cloning support (ElevenLabs) ignore it.
     */
    referenceAudioB64?: string
    maxAttempts?: number
  }): Promise<GenerationResult<Buffer>>

  listVoices(): Promise<Array<{ id: string; name: string; preview_url?: string }>>
}

export type ProviderRegistry = {
  llm: LLMProvider
  media: MediaProvider
  audio: AudioProvider
}
