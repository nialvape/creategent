'use client'

import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { ModelPicker } from '@/components/ui/model-picker'
import { LLM_MODELS, IMAGE_MODELS, VIDEO_MODELS, AVATAR_MODELS, AUDIO_MODELS } from '@/lib/models'
import type { ProjectSettings, QualityPreset } from '@/types/project'

const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'x', 'linkedin', 'facebook']
const QUALITY_PRESETS: { value: QualityPreset; label: string; description: string }[] = [
  { value: 'draft', label: 'Draft', description: '1 attempt · fastest' },
  { value: 'standard', label: 'Standard', description: '2 attempts · balanced' },
  { value: 'premium', label: 'Premium', description: '3 attempts · best quality' },
]

interface ProjectSettingsFormProps {
  settings: ProjectSettings
  onChange: (settings: ProjectSettings) => void
}

export function ProjectSettingsForm({ settings, onChange }: ProjectSettingsFormProps) {
  const set = (patch: Partial<ProjectSettings>) => onChange({ ...settings, ...patch })

  const togglePlatform = (platform: string) => {
    const current = settings.targetPlatforms
    set({
      targetPlatforms: current.includes(platform)
        ? current.filter((p) => p !== platform)
        : [...current, platform],
    })
  }

  return (
    <div className="space-y-6">
      {/* Platforms */}
      <div className="space-y-2">
        <Label className="text-white/50 text-xs uppercase tracking-wider">Platforms</Label>
        <div className="flex flex-wrap gap-1.5">
          {PLATFORMS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => togglePlatform(p)}
              className={`px-3 py-1 rounded-lg text-xs capitalize border transition-colors ${
                settings.targetPlatforms.includes(p)
                  ? 'bg-indigo-600 border-indigo-500 text-white'
                  : 'bg-white/5 border-white/10 text-white/40 hover:text-white/70 hover:border-white/20'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* Quality */}
      <div className="space-y-2">
        <Label className="text-white/50 text-xs uppercase tracking-wider">Quality</Label>
        <div className="grid grid-cols-3 gap-2">
          {QUALITY_PRESETS.map(({ value, label, description }) => (
            <button
              key={value}
              type="button"
              onClick={() => set({ qualityPreset: value })}
              className={`py-2.5 px-3 rounded-lg text-left border transition-colors ${
                settings.qualityPreset === value
                  ? 'bg-indigo-600/20 border-indigo-500/60 ring-1 ring-inset ring-indigo-500/20'
                  : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.06] hover:border-white/20'
              }`}
            >
              <p className={`text-xs font-medium ${settings.qualityPreset === value ? 'text-indigo-300' : 'text-white/70'}`}>
                {label}
              </p>
              <p className="text-[10px] text-white/30 mt-0.5">{description}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Orchestration model */}
      <div className="space-y-2">
        <Label className="text-white/50 text-xs uppercase tracking-wider">Orchestration Model</Label>
        <p className="text-[11px] text-white/30 -mt-1">Planning, creative direction, quality review</p>
        <ModelPicker
          models={LLM_MODELS}
          value={settings.orchestrationModel ?? settings.preferredLLM ?? LLM_MODELS[1].id}
          onChange={(id) => set({ orchestrationModel: id })}
        />
      </div>

      {/* Writing model */}
      <div className="space-y-2">
        <Label className="text-white/50 text-xs uppercase tracking-wider">Writing Model</Label>
        <p className="text-[11px] text-white/30 -mt-1">Copy, scripts, image/video prompts</p>
        <ModelPicker
          models={LLM_MODELS}
          value={settings.writingModel ?? settings.preferredLLM ?? LLM_MODELS[1].id}
          onChange={(id) => set({ writingModel: id })}
        />
      </div>

      {/* Image model */}
      <div className="space-y-2">
        <Label className="text-white/50 text-xs uppercase tracking-wider">Image Model</Label>
        <ModelPicker
          models={IMAGE_MODELS}
          value={settings.preferredImageModel}
          onChange={(id) => set({ preferredImageModel: id })}
        />
      </div>

      {/* Video model */}
      <div className="space-y-2">
        <Label className="text-white/50 text-xs uppercase tracking-wider">Video Model (image→video)</Label>
        <ModelPicker
          models={VIDEO_MODELS}
          value={settings.preferredVideoModel}
          onChange={(id) => set({ preferredVideoModel: id })}
        />
      </div>

      {/* Avatar model */}
      <div className="space-y-2">
        <Label className="text-white/50 text-xs uppercase tracking-wider">Avatar Model (lip-sync)</Label>
        <p className="text-[11px] text-white/30 -mt-1">Talking head: image + voice → synced video</p>
        <ModelPicker
          models={AVATAR_MODELS}
          value={settings.preferredAvatarModel ?? AVATAR_MODELS[0].id}
          onChange={(id) => set({ preferredAvatarModel: id })}
        />
      </div>

      {/* Audio model */}
      <div className="space-y-2">
        <Label className="text-white/50 text-xs uppercase tracking-wider">Audio Model</Label>
        <ModelPicker
          models={AUDIO_MODELS}
          value={settings.preferredAudioModel}
          onChange={(id) => set({ preferredAudioModel: id })}
        />
      </div>

      {/* Voice cloning — only Chatterbox (runpod/chatterbox) supports it */}
      {settings.preferredAudioModel === 'runpod/chatterbox' && (
        <div className="space-y-2">
          <Label className="text-white/50 text-xs uppercase tracking-wider">Voice Clone Reference</Label>
          <p className="text-[11px] text-white/30 -mt-1">
            Public URL to a short voice sample. Chatterbox clones it, so every voiceover speaks in that voice. Leave empty for the default voice.
          </p>
          <Input
            type="url"
            placeholder="https://…/voice-sample.wav"
            value={settings.voiceCloneReferenceUrl ?? ''}
            onChange={(e) => set({ voiceCloneReferenceUrl: e.target.value || undefined })}
          />
        </div>
      )}
    </div>
  )
}
