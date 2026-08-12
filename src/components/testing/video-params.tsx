'use client'

import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import {
  LTX_ASPECT_RATIOS,
  resolveDimensions,
  frameCount,
  aspectRatioForSize,
  type LtxAspectRatio,
} from '@/lib/comfy/ltx-2-5-i2v'
import type { LabVideoParams } from '@/types/testing'
import { cn } from '@/lib/utils'

interface VideoParamsPanelProps {
  value: LabVideoParams
  onChange: (next: LabVideoParams) => void
  /** Local object URL of the attached first frame, if any — drives "auto". */
  imageUrl?: string
  disabled?: boolean
}

/**
 * Reads an image's real pixel size so "auto" can match its proportions.
 *
 * The measurement is stored together with the url it came from and matched
 * during render rather than cleared in the effect: clearing would mean a
 * synchronous setState on every url change, and this way a stale size for a
 * previous attachment can never be read as the current one.
 */
function useImageSize(url?: string) {
  const [measured, setMeasured] = useState<{ url: string; width: number; height: number } | null>(
    null
  )

  useEffect(() => {
    if (!url) return
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (!cancelled) setMeasured({ url, width: img.naturalWidth, height: img.naturalHeight })
    }
    img.src = url
    return () => {
      cancelled = true
    }
  }, [url])

  if (!url || measured?.url !== url) return null
  return { width: measured.width, height: measured.height }
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-white/45">
        {label}
        {hint && <span className="ml-1 text-white/20">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

const inputClass =
  'w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-sm text-white transition-colors focus:border-indigo-500/50 focus:outline-none disabled:opacity-50'

export function VideoParamsPanel({ value, onChange, imageUrl, disabled }: VideoParamsPanelProps) {
  const imageSize = useImageSize(imageUrl)
  const set = <K extends keyof LabVideoParams>(key: K, v: LabVideoParams[K]) =>
    onChange({ ...value, [key]: v })

  // What "auto" will actually resolve to, so the choice is never invisible.
  const autoRatio = imageSize ? aspectRatioForSize(imageSize.width, imageSize.height) : null
  const effectiveRatio: LtxAspectRatio =
    value.aspectRatio === 'auto'
      ? (autoRatio ?? '16:9 (Widescreen)')
      : (value.aspectRatio as LtxAspectRatio)

  const { width, height } = resolveDimensions(effectiveRatio, value.megapixels)
  const frames = frameCount(value.durationSec, value.fps)
  const autoUnavailable = value.aspectRatio === 'auto' && !imageSize

  return (
    <section className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-white/50">Video settings</h2>

      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Aspect ratio">
          <select
            value={value.aspectRatio}
            onChange={(e) => set('aspectRatio', e.target.value)}
            disabled={disabled}
            className={inputClass}
          >
            <option value="auto">Auto (match image)</option>
            {LTX_ASPECT_RATIOS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Megapixels" hint="output">
          <input
            type="number"
            min={0.1}
            max={2}
            step={0.1}
            value={value.megapixels}
            onChange={(e) => set('megapixels', Number(e.target.value))}
            disabled={disabled}
            className={inputClass}
          />
        </Field>

        <Field label="Duration" hint="sec">
          <input
            type="number"
            min={1}
            max={20}
            step={1}
            value={value.durationSec}
            onChange={(e) => set('durationSec', Number(e.target.value))}
            disabled={disabled}
            className={inputClass}
          />
        </Field>

        <Field label="FPS">
          <input
            type="number"
            min={8}
            max={60}
            step={1}
            value={value.fps}
            onChange={(e) => set('fps', Number(e.target.value))}
            disabled={disabled}
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="Seed" hint="blank = random each run">
        <input
          type="number"
          value={value.seed ?? ''}
          onChange={(e) => set('seed', e.target.value === '' ? undefined : Number(e.target.value))}
          placeholder="random"
          disabled={disabled}
          className={inputClass}
        />
      </Field>

      <Field label="Negative prompt">
        <input
          type="text"
          value={value.negativePrompt}
          onChange={(e) => set('negativePrompt', e.target.value)}
          disabled={disabled}
          className={inputClass}
        />
      </Field>

      <button
        type="button"
        onClick={() => set('enhancePrompt', !value.enhancePrompt)}
        disabled={disabled}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-xs transition-colors disabled:opacity-50',
          value.enhancePrompt
            ? 'border-indigo-500/40 bg-indigo-600/15 text-white'
            : 'border-white/10 bg-white/5 text-white/50 hover:text-white/70'
        )}
      >
        <Sparkles className={cn('h-3.5 w-3.5', value.enhancePrompt ? 'text-indigo-400' : 'text-white/30')} />
        <span className="flex-1">Enhance prompt</span>
        <span className="text-[10px] text-white/30">{value.enhancePrompt ? 'on' : 'off'}</span>
      </button>
      <p className="text-[10px] leading-relaxed text-white/25">
        Rewrites your prompt with a Gemma pass that can see the first frame. Off sends it verbatim.
      </p>

      {/* Resolution comes from these settings, never from the image — show the
          real numbers so a mismatch is caught before spending GPU time. */}
      <div className="rounded-lg border border-white/10 bg-black/20 px-2.5 py-2 font-mono text-[10px] text-white/40">
        <div className="text-white/60">
          {width}×{height} · {frames} frames · {(frames / value.fps).toFixed(2)}s
        </div>
        {value.aspectRatio === 'auto' && autoRatio && imageSize && (
          <div className="mt-0.5">
            auto → {autoRatio} (image {imageSize.width}×{imageSize.height})
          </div>
        )}
      </div>

      {autoUnavailable && (
        <p className="text-[11px] text-amber-400/80">
          Attach a first-frame image so &quot;auto&quot; can read its proportions, or pick a ratio
          explicitly.
        </p>
      )}
    </section>
  )
}
