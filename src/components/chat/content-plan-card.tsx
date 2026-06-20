'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { CheckCircle, XCircle, Image, Video, AudioLines, FileText, UserRound, DollarSign } from 'lucide-react'
import type { ContentPlan } from '@/types/plan'

interface ContentPlanCardProps {
  plan: ContentPlan
  estimatedCost: number
  onApprove: () => void
  onReject: (feedback?: string) => void
  disabled?: boolean
  resolved?: boolean
}

const ASSET_ICONS = {
  image: Image,
  video: Video,
  audio: AudioLines,
  text: FileText,
  avatar: UserRound,
}

export function ContentPlanCard({ plan, estimatedCost, onApprove, onReject, disabled, resolved }: ContentPlanCardProps) {
  const [showReject, setShowReject] = useState(false)
  const [feedback, setFeedback] = useState('')

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 backdrop-blur-sm p-4 space-y-4 max-w-2xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-white text-lg">{plan.title}</h3>
          <p className="text-sm text-white/60 mt-1">{plan.summary}</p>
        </div>
        <div className="flex gap-1">
          {plan.targetPlatforms.map((p) => (
            <Badge key={p} variant="secondary" className="text-xs capitalize">
              {p}
            </Badge>
          ))}
        </div>
      </div>

      {/* Style */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-white/40">Style:</span>
        <span className="text-xs text-white/70">{plan.style.tone}</span>
        <span className="text-xs text-white/40">·</span>
        <span className="text-xs text-white/70">{plan.style.visualStyle}</span>
        {plan.style.colorPalette.slice(0, 3).map((c, i) => (
          <span
            key={i}
            className="inline-block w-4 h-4 rounded-full border border-white/20"
            style={{ backgroundColor: c }}
            title={c}
          />
        ))}
      </div>

      <Separator className="bg-white/10" />

      {/* Assets */}
      <div className="space-y-2">
        <p className="text-xs text-white/40 uppercase tracking-wider">Assets ({plan.assets.length})</p>
        {plan.assets.map((asset) => {
          const Icon = ASSET_ICONS[asset.type] ?? FileText
          return (
            <div key={asset.id} className="flex items-center justify-between py-1.5 px-2 rounded-lg bg-white/5">
              <div className="flex items-center gap-2.5">
                <Icon className="h-4 w-4 text-white/40" />
                <div>
                  <p className="text-sm text-white/90">{asset.name}</p>
                  <p className="text-xs text-white/40">{asset.platform} · {asset.model.split('/').pop()}</p>
                </div>
              </div>
              <span className="text-xs text-emerald-400 font-mono">${asset.estimatedCost.toFixed(3)}</span>
            </div>
          )
        })}
      </div>

      <Separator className="bg-white/10" />

      {/* Cost total */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-white/60">
          <DollarSign className="h-4 w-4" />
          <span className="text-sm">Estimated total</span>
        </div>
        <span className="text-base font-semibold text-emerald-400 font-mono">${estimatedCost.toFixed(4)}</span>
      </div>

      {/* Actions */}
      {resolved ? null : !showReject ? (
        <div className="flex gap-2 pt-1">
          <Button
            onClick={onApprove}
            disabled={disabled}
            className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white gap-2"
          >
            <CheckCircle className="h-4 w-4" />
            Approve & Generate
          </Button>
          <Button
            variant="outline"
            onClick={() => setShowReject(true)}
            disabled={disabled}
            className="flex-1 border-white/20 text-white/70 hover:bg-white/10 gap-2"
          >
            <XCircle className="h-4 w-4" />
            Revise
          </Button>
        </div>
      ) : (
        <div className="space-y-2 pt-1">
          <textarea
            className="w-full text-sm bg-white/5 border border-white/20 rounded-lg px-3 py-2 text-white placeholder-white/30 resize-none focus:outline-none focus:border-indigo-500"
            rows={2}
            placeholder="What should be changed? (optional)"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              onClick={() => onReject(feedback || undefined)}
              disabled={disabled}
              variant="outline"
              className="flex-1 border-red-500/50 text-red-400 hover:bg-red-500/10"
            >
              Send Feedback
            </Button>
            <Button
              variant="ghost"
              onClick={() => setShowReject(false)}
              className="text-white/50"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
