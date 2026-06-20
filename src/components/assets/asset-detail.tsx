'use client'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Download, Image, Video, AudioLines, FileText, UserRound } from 'lucide-react'
import type { Asset } from '@/types/asset'

interface AssetDetailProps {
  asset: Asset
  onClose: () => void
}

const TYPE_ICONS = {
  image: Image,
  video: Video,
  audio: AudioLines,
  text: FileText,
  avatar: UserRound,
}

export function AssetDetail({ asset, onClose }: AssetDetailProps) {
  const Icon = TYPE_ICONS[asset.type] ?? FileText
  const content = (asset.metadata as Record<string, string>)['content']

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-w-lg bg-zinc-900 border-white/10 text-white">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-white/50" />
            {asset.name}
          </DialogTitle>
        </DialogHeader>

        {/* Preview */}
        <div className="rounded-lg overflow-hidden bg-white/5 border border-white/10">
          {asset.type === 'image' && asset.public_url ? (
            <img src={asset.public_url} alt={asset.name} className="w-full object-cover max-h-64" />
          ) : asset.type === 'video' && asset.public_url ? (
            <video src={asset.public_url} controls className="w-full max-h-64" />
          ) : asset.type === 'audio' && asset.public_url ? (
            <div className="p-4">
              <audio src={asset.public_url} controls className="w-full" />
            </div>
          ) : asset.type === 'text' && content ? (
            <div className="p-4 text-sm text-white/70 whitespace-pre-wrap max-h-48 overflow-y-auto">
              {content}
            </div>
          ) : (
            <div className="h-24 flex items-center justify-center text-white/20">
              <Icon className="h-8 w-8" />
            </div>
          )}
        </div>

        {/* Metadata */}
        <div className="space-y-2 text-xs text-white/50">
          <div className="flex justify-between">
            <span>Provider</span>
            <span className="text-white/70">{asset.provider ?? '—'}</span>
          </div>
          <div className="flex justify-between">
            <span>Model</span>
            <span className="text-white/70 font-mono text-[10px]">{asset.model ?? '—'}</span>
          </div>
          <div className="flex justify-between">
            <span>Status</span>
            <Badge
              variant="outline"
              className={`text-[10px] capitalize border-white/10 ${
                asset.status === 'completed' ? 'text-emerald-400' :
                asset.status === 'failed' ? 'text-red-400' :
                'text-white/40'
              }`}
            >
              {asset.status}
            </Badge>
          </div>
          {asset.actual_cost != null && (
            <div className="flex justify-between">
              <span>Cost</span>
              <span className="text-emerald-400 font-mono">${asset.actual_cost.toFixed(4)}</span>
            </div>
          )}
          {asset.specs.width && (
            <div className="flex justify-between">
              <span>Dimensions</span>
              <span className="text-white/70">{asset.specs.width}×{asset.specs.height}</span>
            </div>
          )}
        </div>

        {/* Actions */}
        {asset.public_url && (
          <a
            href={asset.public_url}
            download
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full rounded-lg border border-white/10 text-white/70 hover:bg-white/10 px-4 py-2 text-sm transition-colors"
          >
            <Download className="h-4 w-4" />
            Download
          </a>
        )}
      </DialogContent>
    </Dialog>
  )
}
