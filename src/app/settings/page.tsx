'use client'

import { useState, useEffect } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Eye, EyeOff, Check } from 'lucide-react'
import { PRICING_CATALOG } from '@/lib/pricing/catalog'
import { Badge } from '@/components/ui/badge'
import { ProjectSettingsForm } from '@/components/project/project-settings-form'
import { loadDefaultSettings, saveDefaultSettings } from '@/lib/default-settings'
import type { ProjectSettings } from '@/types/project'

function MaskedInput({ label, envKey, placeholder }: { label: string; envKey: string; placeholder: string }) {
  const [show, setShow] = useState(false)
  const [value, setValue] = useState('')

  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-white/50 uppercase tracking-wider">{label}</Label>
      <div className="relative">
        <Input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          className="bg-white/5 border-white/10 text-white pr-10"
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60"
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      <p className="text-xs text-white/30">
        Environment variable:{' '}
        <code className="font-mono text-indigo-400">{envKey}</code>
      </p>
    </div>
  )
}

export default function SettingsPage() {
  const [defaultSettings, setDefaultSettings] = useState<ProjectSettings | null>(null)
  const [saved, setSaved] = useState(false)

  // Load defaults from localStorage on mount (client only — hydration from storage)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDefaultSettings(loadDefaultSettings())
  }, [])

  const handleDefaultsChange = (settings: ProjectSettings) => {
    setDefaultSettings(settings)
    saveDefaultSettings(settings)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-2xl mx-auto space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Settings</h1>
          <p className="text-white/40 text-sm mt-1">API keys, default models and pricing</p>
        </div>

        {/* Default project settings */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-white uppercase tracking-wider">
                Default Settings
              </h2>
              <p className="text-xs text-white/40 mt-1">
                Applies to all new projects. Saved locally in your browser.
              </p>
            </div>
            {saved && (
              <span className="flex items-center gap-1 text-xs text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                Saved
              </span>
            )}
          </div>
          {defaultSettings ? (
            <ProjectSettingsForm settings={defaultSettings} onChange={handleDefaultsChange} />
          ) : (
            <div className="h-20 flex items-center justify-center text-white/20 text-sm">Loading...</div>
          )}
        </div>

        {/* API Keys */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 space-y-5">
          <h2 className="text-sm font-semibold text-white uppercase tracking-wider">API Keys</h2>
          <p className="text-xs text-white/40">
            API keys are configured via environment variables in{' '}
            <code className="font-mono text-indigo-400">.env.local</code>
          </p>
          <div className="space-y-4">
            {[
              { label: 'OpenRouter API Key', envKey: 'OPENROUTER_API_KEY', placeholder: 'sk-or-...' },
              { label: 'Fal.ai API Key', envKey: 'FAL_KEY', placeholder: 'fal-...' },
              { label: 'ElevenLabs API Key', envKey: 'ELEVENLABS_API_KEY', placeholder: 'el_...' },
              { label: 'Supabase URL', envKey: 'NEXT_PUBLIC_SUPABASE_URL', placeholder: 'https://xxx.supabase.co' },
              { label: 'Supabase Anon Key', envKey: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', placeholder: 'eyJ...' },
            ].map((item) => (
              <MaskedInput key={item.envKey} {...item} />
            ))}
          </div>
        </div>

        {/* Pricing catalog */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 space-y-4">
          <h2 className="text-sm font-semibold text-white uppercase tracking-wider">Pricing Catalog</h2>
          <div className="space-y-1">
            {PRICING_CATALOG.map((entry, i) => (
              <div key={i} className="flex items-center justify-between py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px] border-white/10 text-white/40 capitalize">
                    {entry.provider}
                  </Badge>
                  <span className="text-white/50 font-mono text-[10px]">
                    {entry.model.split('/').slice(-1)[0]}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-white/40">
                  <span className="font-mono text-emerald-400">${entry.priceUsd}</span>
                  <span>/ {entry.unitType.replace(/_/g, ' ')}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
