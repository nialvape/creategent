export type ProjectStatus = 'draft' | 'planning' | 'generating' | 'completed' | 'failed'
export type QualityPreset = 'draft' | 'standard' | 'premium'

export interface ProjectSettings {
  preferredImageModel: string
  /** Image-to-video model (b-roll animated from a first-frame image) */
  preferredVideoModel: string
  /** Talking-head lip-sync model (first-frame image + voice -> talking video) */
  preferredAvatarModel: string
  preferredAudioModel: string
  /**
   * Optional reference voice sample (public audio URL) for zero-shot voice
   * cloning. Used only by Chatterbox (runpod/chatterbox): when set, every
   * voiceover in the project is synthesized in this voice.
   */
  voiceCloneReferenceUrl?: string
  /** Used by planner, creative director, review — needs strong reasoning */
  orchestrationModel: string
  /** Used by copy, audio scripts, image/video prompt engineering — needs high-quality writing */
  writingModel: string
  /**
   * Cheap model used ONLY to translate the (English) plan into the user's language
   * for the approval view. A trivial task — a free OpenRouter model is plenty.
   */
  translationModel?: string
  /** @deprecated kept for backward compat with old DB rows — use orchestrationModel instead */
  preferredLLM?: string
  targetPlatforms: string[]
  qualityPreset: QualityPreset
}

export interface Project {
  id: string
  title: string
  description: string | null
  status: ProjectStatus
  settings: ProjectSettings
  created_at: string
  updated_at: string
}
