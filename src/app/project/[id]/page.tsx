'use client'

import { useState, useEffect, useCallback, use } from 'react'
import { useRouter } from 'next/navigation'
import { ProjectSidebar } from '@/components/project/project-sidebar'
import { ProjectHeader } from '@/components/project/project-header'
import { ProjectSettingsModal } from '@/components/project/project-settings-modal'
import { ChatPanel } from '@/components/chat/chat-panel'
import { AssetGrid } from '@/components/assets/asset-grid'
import type { Project, ProjectSettings } from '@/types/project'
import type { Asset } from '@/types/asset'

const POLL_INTERVAL_MS = 3000

function isActivelyGenerating(assets: Asset[]): boolean {
  return assets.some((a) => a.status === 'pending' || a.status === 'generating')
}

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const [project, setProject] = useState<Project | null>(null)
  const [assets, setAssets] = useState<Asset[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [polling, setPolling] = useState(false)

  const fetchAssets = useCallback(async () => {
    const res = await fetch(`/api/assets?projectId=${id}`)
    const data = await res.json()
    return Array.isArray(data) ? data as Asset[] : []
  }, [id])

  useEffect(() => {
    if (!id) return
    // Reset to loading state when navigating between projects (route reuses this component)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    Promise.all([
      fetch(`/api/projects/${id}`).then(async (r) => {
        if (!r.ok) return null
        const text = await r.text()
        if (!text) return null
        try { return JSON.parse(text) } catch { return null }
      }),
      fetchAssets(),
    ]).then(([proj, assetData]) => {
      setProject(proj)
      setAssets(assetData)
      if (isActivelyGenerating(assetData)) setPolling(true)
    }).finally(() => setLoading(false))
  }, [id, fetchAssets])

  // Poll for asset updates while generation is in progress
  useEffect(() => {
    if (!polling) return
    const timer = setInterval(async () => {
      const updated = await fetchAssets()
      setAssets(updated)
      if (!isActivelyGenerating(updated)) {
        setPolling(false)
      }
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [polling, fetchAssets])

  const handleSaveSettings = async (settings: ProjectSettings) => {
    const res = await fetch(`/api/projects/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    })
    const updated = await res.json()
    setProject(updated)
  }

  const handleGenerationStarted = useCallback(() => {
    setPolling(true)
  }, [])

  const handleGenerationComplete = useCallback(async () => {
    // Assets are inserted as 'completed' directly, so polling may have already
    // stopped. Do a final explicit fetch now that the agent has finished.
    const updated = await fetchAssets()
    setAssets(updated)
    setPolling(false)
  }, [fetchAssets])

  const handleTitleGenerated = useCallback((title: string) => {
    setProject((prev) => (prev ? { ...prev, title } : prev))
  }, [])

  const handleRename = useCallback(async (title: string) => {
    setProject((prev) => (prev ? { ...prev, title } : prev))
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      if (res.ok) {
        const updated = await res.json()
        setProject(updated)
      }
    } catch {
      /* keep optimistic title */
    }
  }, [id])

  const handleDownloadAll = useCallback(async () => {
    const completed = assets.filter((a) => a.status === 'completed' && a.public_url)
    for (const asset of completed) {
      const a = document.createElement('a')
      a.href = asset.public_url!
      a.download = asset.name
      a.target = '_blank'
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      await new Promise((r) => setTimeout(r, 200))
    }
  }, [assets])

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span key={i} className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
          ))}
        </div>
      </div>
    )
  }

  if (!project) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <p className="text-white/40">Project not found</p>
      </div>
    )
  }

  const completedCount = assets.filter((a) => a.status === 'completed').length
  const failedCount = assets.filter((a) => a.status === 'failed').length

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <ProjectSidebar />

      <div className="flex flex-col flex-1 min-w-0">
        <ProjectHeader
          project={project}
          onOpenSettings={() => setSettingsOpen(true)}
          onRename={handleRename}
          onDelete={() => router.push('/')}
        />

        <div className="flex flex-1 min-h-0">
          {/* Chat panel */}
          <div className="flex flex-col flex-1 min-w-0 border-r border-white/10">
            <ChatPanel
              projectId={id}
              projectSettings={project.settings}
              onGenerationStarted={handleGenerationStarted}
              onGenerationComplete={handleGenerationComplete}
              onTitleGenerated={handleTitleGenerated}
            />
          </div>

          {/* Asset panel */}
          <div className="w-72 flex flex-col border-l border-white/10 bg-black/20 overflow-y-auto">
            <div className="px-3 py-3 border-b border-white/10 flex items-center justify-between">
              <div>
                <p className="text-xs text-white/40 uppercase tracking-wider">Generated Assets</p>
                {assets.length > 0 && (
                  <p className="text-[10px] text-white/25 mt-0.5">
                    {completedCount}/{assets.length} done
                    {failedCount > 0 && <span className="text-red-400/60 ml-1">· {failedCount} failed</span>}
                    {polling && <span className="text-indigo-400/60 ml-1">· syncing…</span>}
                  </p>
                )}
              </div>
              {completedCount > 0 && (
                <button
                  onClick={handleDownloadAll}
                  className="text-[10px] text-white/30 hover:text-white/60 transition-colors px-2 py-1 rounded border border-white/10 hover:border-white/20"
                >
                  ↓ All
                </button>
              )}
            </div>
            <AssetGrid assets={assets} />
          </div>
        </div>
      </div>

      {settingsOpen && (
        <ProjectSettingsModal
          project={project}
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onSave={handleSaveSettings}
        />
      )}
    </div>
  )
}
