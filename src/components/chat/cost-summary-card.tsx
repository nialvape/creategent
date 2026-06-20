'use client'

import { TrendingUp, TrendingDown, Minus, AlertTriangle } from 'lucide-react'

interface CostSummaryCardProps {
  estimated: number
  actual: number
}

export function CostSummaryCard({ estimated, actual }: CostSummaryCardProps) {
  const variance = estimated > 0 ? (actual - estimated) / estimated : 0
  const pct = Math.abs(variance * 100).toFixed(1)
  const over = variance > 0.1
  const under = variance < -0.1
  const anomaly = variance > 0.5  // actual > 150% of estimated

  return (
    <div className={`rounded-xl border p-4 space-y-3 backdrop-blur-sm ${anomaly ? 'border-red-500/40 bg-red-500/8' : 'border-white/10 bg-white/5'}`}>
      <div className="flex items-center justify-between">
        <p className="text-xs text-white/40 uppercase tracking-wider">Cost Summary</p>
        {anomaly && (
          <div className="flex items-center gap-1 text-red-400">
            <AlertTriangle className="h-3 w-3" />
            <span className="text-[10px] font-medium">Cost anomaly</span>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-white/50 mb-0.5">Estimated</p>
          <p className="text-lg font-mono text-white/80">${estimated.toFixed(4)}</p>
        </div>
        <div>
          <p className="text-xs text-white/50 mb-0.5">Actual</p>
          <p className={`text-lg font-mono ${anomaly ? 'text-red-400' : over ? 'text-amber-400' : under ? 'text-emerald-400' : 'text-white/80'}`}>
            ${actual.toFixed(4)}
          </p>
        </div>
      </div>
      {estimated > 0 && actual > 0 && (
        <div className="flex items-center gap-1.5 text-xs">
          {over ? (
            <>
              <TrendingUp className={`h-3.5 w-3.5 ${anomaly ? 'text-red-400' : 'text-amber-400'}`} />
              <span className={anomaly ? 'text-red-400' : 'text-amber-400'}>{pct}% over estimate</span>
            </>
          ) : under ? (
            <>
              <TrendingDown className="h-3.5 w-3.5 text-emerald-400" />
              <span className="text-emerald-400">{pct}% under estimate</span>
            </>
          ) : (
            <>
              <Minus className="h-3.5 w-3.5 text-white/40" />
              <span className="text-white/40">On budget</span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
