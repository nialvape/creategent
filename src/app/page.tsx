'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Plus, Folder, ArrowRight, Zap, Settings2, ChevronDown, ChevronUp, Check } from 'lucide-react'
import type { Project, ProjectSettings } from '@/types/project'
import { ProjectSettingsForm } from '@/components/project/project-settings-form'
import { DeleteProjectDialog } from '@/components/project/delete-project-dialog'
import { loadDefaultSettings, saveDefaultSettings } from '@/lib/default-settings'
import { formatDistanceToNow } from 'date-fns'

const STATUS_COLORS = {
  draft: 'text-white/40 border-white/10',
  planning: 'text-blue-400 border-blue-500/30',
  generating: 'text-indigo-400 border-indigo-500/30',
  completed: 'text-emerald-400 border-emerald-500/30',
  failed: 'text-red-400 border-red-500/30',
}

export default function HomePage() {
  const router = useRouter()
  const [projects, setProjects] = useState<Project[]>([])
  const [creating, setCreating] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  const [settings, setSettings] = useState<ProjectSettings | null>(null)
  const [saved, setSaved] = useState(false)

  // Load settings from localStorage on mount (client only — can't read during SSR,
  // so this hydration-from-storage is the intended use of an effect here)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettings(loadDefaultSettings())
  }, [])

  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((data) => Array.isArray(data) && setProjects(data))
      .catch(() => {})
  }, [])

  const handleSettingsChange = (next: ProjectSettings) => {
    setSettings(next)
    saveDefaultSettings(next)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const handleCreate = async () => {
    if (!settings) return
    setCreating(true)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New Project', settings }),
      })
      const project = await res.json()
      router.push(`/project/${project.id}`)
    } finally {
      setCreating(false)
    }
  }

  if (!settings) return null // wait for localStorage

  return (
    <div className="min-h-screen bg-background">
      {/* Hero */}
      <div className="relative border-b border-white/10 px-6 py-16 text-center overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-indigo-500/10 via-transparent to-transparent pointer-events-none" />
        <div className="relative max-w-2xl mx-auto space-y-4">
          <div className="flex justify-center">
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 text-xs">
              <Zap className="h-3 w-3" />
              Multi-Agent AI Content Creation
            </div>
          </div>
          <h1 className="text-4xl font-bold text-white tracking-tight">
            From idea to <span className="text-indigo-400">ready-to-share</span> content
          </h1>
          <p className="text-white/50 text-lg max-w-xl mx-auto">
            Describe your idea in chat. Our AI team creates all your images, videos, copy, and audio automatically.
          </p>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-10 space-y-10">
        {/* Create new */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-5 border-b border-white/8">
            <h2 className="text-sm font-semibold text-white/70 uppercase tracking-wider">New Project</h2>
            <button
              type="button"
              onClick={() => setShowConfig((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition-colors"
            >
              <Settings2 className="h-3.5 w-3.5" />
              Configure models and quality
              {showConfig ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
            </button>
          </div>

          {/* Collapsible settings */}
          {showConfig && (
            <div className="px-6 pt-5 pb-2 border-b border-white/8">
              <div className="flex items-center justify-between mb-4">
                <p className="text-xs text-white/40">
                  These settings are saved as defaults for new projects.
                </p>
                {saved && (
                  <span className="flex items-center gap-1 text-xs text-emerald-400">
                    <Check className="h-3 w-3" />
                    Saved
                  </span>
                )}
              </div>
              <ProjectSettingsForm settings={settings} onChange={handleSettingsChange} />
            </div>
          )}

          {/* Action */}
          <div className="px-6 py-4">
            <Button
              onClick={handleCreate}
              disabled={creating}
              className="bg-indigo-600 hover:bg-indigo-500 text-white gap-2"
            >
              <Plus className="h-4 w-4" />
              {creating ? 'Creating...' : 'Start project'}
            </Button>
          </div>
        </div>

        {/* Recent projects */}
        {projects.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-white/70 uppercase tracking-wider">Recent Projects</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {projects.map((project) => (
                <div key={project.id} className="relative group rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/20 transition-all">
                  {/* Navigation area — no delete button inside */}
                  <button
                    onClick={() => router.push(`/project/${project.id}`)}
                    className="w-full text-left p-4 pb-10"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <Folder className="h-4 w-4 text-white/30" />
                      <Badge
                        variant="outline"
                        className={`text-[10px] capitalize ${STATUS_COLORS[project.status]}`}
                      >
                        {project.status}
                      </Badge>
                    </div>
                    <p className="text-sm font-medium text-white mb-1">{project.title}</p>
                    <p className="text-xs text-white/30">
                      {formatDistanceToNow(new Date(project.updated_at), { addSuffix: true })}
                    </p>
                    <div className="flex gap-1.5 mt-2 flex-wrap">
                      {project.settings.targetPlatforms.slice(0, 3).map((p) => (
                        <span key={p} className="text-[10px] text-white/30 capitalize">{p}</span>
                      ))}
                    </div>
                  </button>
                  {/* Delete + arrow sit below the nav button, not inside it */}
                  <div className="absolute bottom-3 left-4 right-4 flex items-center justify-between pointer-events-none">
                    <DeleteProjectDialog
                      projectId={project.id}
                      projectTitle={project.title}
                      onDeleted={() => setProjects((prev) => prev.filter((p) => p.id !== project.id))}
                      className="opacity-0 group-hover:opacity-100 transition-opacity pointer-events-auto"
                    />
                    <ArrowRight className="h-3.5 w-3.5 text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
