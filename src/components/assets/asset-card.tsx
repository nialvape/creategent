'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { Image, Video, AudioLines, FileText, UserRound, CheckCircle, XCircle, Clock, Loader2 } from 'lucide-react'
import type { Asset } from '@/types/asset'

interface AssetCardProps {
  asset: Asset
  onClick?: (asset: Asset) => void
}

const TYPE_ICONS = {
  image: Image,
  video: Video,
  audio: AudioLines,
  text: FileText,
  avatar: UserRound,
}

const STATUS_STYLES = {
  pending: 'border-white/10 bg-white/5',
  generating: 'border-indigo-500/40 bg-indigo-500/8 shadow-[0_0_12px_rgba(99,102,241,0.08)]',
  completed: 'border-emerald-500/30 bg-emerald-500/5 shadow-[0_0_12px_rgba(52,211,153,0.06)]',
  failed: 'border-red-500/30 bg-red-500/5',
}

const STATUS_ICONS = {
  pending: Clock,
  generating: Loader2,
  completed: CheckCircle,
  failed: XCircle,
}

export function AssetCard({ asset, onClick }: AssetCardProps) {
  const TypeIcon = TYPE_ICONS[asset.type] ?? FileText
  const StatusIcon = STATUS_ICONS[asset.status] ?? Clock
  const isImage = asset.type === 'image' && asset.public_url

  return (
    <div
      className={cn(
        'rounded-xl border p-3 cursor-pointer transition-all duration-300',
        'hover:border-white/25 hover:scale-[1.02] hover:shadow-lg',
        'animate-in fade-in slide-in-from-bottom-2 duration-300',
        STATUS_STYLES[asset.status]
      )}
      onClick={() => onClick?.(asset)}
    >
      {/* Preview area */}
      <div className="aspect-square rounded-lg overflow-hidden bg-white/5 mb-2 flex items-center justify-center">
        {isImage ? (
          <img src={asset.public_url!} alt={asset.name} className="w-full h-full object-cover" />
        ) : (
          <TypeIcon className="h-8 w-8 text-white/20" />
        )}
      </div>

      {/* Info */}
      <div className="space-y-1">
        <p className="text-xs font-medium text-white/80 truncate">{asset.name}</p>
        <div className="flex items-center justify-between">
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-white/10 text-white/40 capitalize">
            {asset.type}
          </Badge>
          <div className="flex items-center gap-1">
            <StatusIcon
              className={cn(
                'h-3 w-3',
                asset.status === 'completed' && 'text-emerald-400',
                asset.status === 'failed' && 'text-red-400',
                asset.status === 'generating' && 'text-indigo-400 animate-spin',
                asset.status === 'pending' && 'text-white/30'
              )}
            />
            {asset.actual_cost != null && (
              <span className="text-[10px] text-white/30 font-mono">${asset.actual_cost.toFixed(3)}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
