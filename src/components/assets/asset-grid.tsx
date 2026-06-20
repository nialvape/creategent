'use client'

import { useState } from 'react'
import { AssetCard } from './asset-card'
import { AssetDetail } from './asset-detail'
import type { Asset } from '@/types/asset'

interface AssetGridProps {
  assets: Asset[]
}

export function AssetGrid({ assets }: AssetGridProps) {
  const [selected, setSelected] = useState<Asset | null>(null)

  if (assets.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center space-y-2">
          <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center mx-auto">
            <span className="text-2xl">🎨</span>
          </div>
          <p className="text-sm text-white/30">Assets will appear here</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2 p-3">
        {assets.map((asset) => (
          <AssetCard key={asset.id} asset={asset} onClick={setSelected} />
        ))}
      </div>

      {selected && (
        <AssetDetail asset={selected} onClose={() => setSelected(null)} />
      )}
    </>
  )
}
