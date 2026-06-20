import type { ProjectSettings } from '@/types/project'
import { coerceMediaModel } from '@/lib/models'

const KEY = 'cg_default_settings'

/** Replace any retired/unknown media model ids with the current catalog default. */
export function coerceSettings(s: ProjectSettings): ProjectSettings {
  return {
    ...s,
    preferredImageModel: coerceMediaModel('image', s.preferredImageModel),
    preferredVideoModel: coerceMediaModel('video', s.preferredVideoModel),
    preferredAudioModel: coerceMediaModel('audio', s.preferredAudioModel),
    preferredAvatarModel: coerceMediaModel('avatar', s.preferredAvatarModel),
  }
}

export const FALLBACK_SETTINGS: ProjectSettings = {
  preferredImageModel: 'fal-ai/flux/schnell',
  // Video + audio default to the user's self-hosted RunPod GPU models.
  preferredVideoModel: 'runpod/wan-2.6-i2v',
  preferredAvatarModel: 'fal-ai/kling-video/ai-avatar/v2/pro',
  preferredAudioModel: 'runpod/chatterbox',
  orchestrationModel: 'anthropic/claude-sonnet-4-5',
  writingModel: 'anthropic/claude-sonnet-4-5',
  targetPlatforms: ['instagram'],
  qualityPreset: 'standard',
}

export function loadDefaultSettings(): ProjectSettings {
  if (typeof window === 'undefined') return FALLBACK_SETTINGS
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return FALLBACK_SETTINGS
    return coerceSettings({ ...FALLBACK_SETTINGS, ...JSON.parse(raw) })
  } catch {
    return FALLBACK_SETTINGS
  }
}

export function saveDefaultSettings(settings: ProjectSettings): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    // ignore storage errors
  }
}
