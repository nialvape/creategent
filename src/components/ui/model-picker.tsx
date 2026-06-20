'use client'

import type { ModelDef } from '@/lib/models'

const TAG_STYLES = {
  recommended: 'border-indigo-500/40 text-indigo-300 bg-indigo-500/10',
  fastest: 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10',
  'best quality': 'border-amber-500/40 text-amber-300 bg-amber-500/10',
  cheapest: 'border-zinc-500/40 text-zinc-300 bg-zinc-500/10',
} as const

interface ModelPickerProps {
  models: ModelDef[]
  value: string
  onChange: (id: string) => void
}

export function ModelPicker({ models, value, onChange }: ModelPickerProps) {
  return (
    <div className="space-y-1.5 max-h-56 overflow-y-auto pr-0.5 scrollbar-thin">
      {models.map((model) => {
        const selected = value === model.id
        return (
          <button
            key={model.id}
            type="button"
            onClick={() => onChange(model.id)}
            className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all ${
              selected
                ? 'border-indigo-500/60 bg-indigo-500/10 ring-1 ring-inset ring-indigo-500/20'
                : 'border-white/8 bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/15'
            }`}
          >
            <div className="flex items-start gap-3">
              {/* Radio dot */}
              <span className={`mt-0.5 flex-shrink-0 h-3.5 w-3.5 rounded-full border-2 flex items-center justify-center ${
                selected ? 'border-indigo-400' : 'border-white/20'
              }`}>
                {selected && <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" />}
              </span>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
                  <span className={`text-sm font-medium ${selected ? 'text-white' : 'text-white/80'}`}>
                    {model.name}
                  </span>
                  <span className="text-[10px] text-white/25">{model.provider}</span>
                  {model.tags?.map((tag) => (
                    <span
                      key={tag}
                      className={`text-[9px] px-1.5 py-px rounded-full border font-medium ${TAG_STYLES[tag]}`}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
                <p className={`text-xs leading-relaxed ${selected ? 'text-white/50' : 'text-white/30'}`}>
                  {model.description}
                </p>
              </div>

              {/* Price */}
              <span className="flex-shrink-0 text-[11px] text-white/25 font-mono pt-0.5">
                {model.priceLabel}
              </span>
            </div>
          </button>
        )
      })}
    </div>
  )
}
