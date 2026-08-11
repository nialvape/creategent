'use client'

import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Plus, FolderOpen, Sparkles, FlaskConical } from 'lucide-react'
import { cn } from '@/lib/utils'
import { loadDefaultSettings } from '@/lib/default-settings'
import type { Project } from '@/types/project'
import { DeleteProjectDialog } from '@/components/project/delete-project-dialog'

const STATUS_COLORS = {
  draft: 'bg-white/10',
  planning: 'bg-blue-500/20',
  generating: 'bg-indigo-500/20',
  completed: 'bg-emerald-500/20',
  failed: 'bg-red-500/20',
}

export function ProjectSidebar() {
  const router = useRouter()
  const params = useParams()
  const currentId = params?.id as string | undefined
  const [projects, setProjects] = useState<Project[]>([])
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((data) => Array.isArray(data) && setProjects(data))
      .catch(() => {})
  }, [])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New Project', settings: loadDefaultSettings() }),
      })
      const project = await res.json()
      setProjects((prev) => [project, ...prev])
      router.push(`/project/${project.id}`)
    } catch {
      // ignore
    } finally {
      setCreating(false)
    }
  }

  return (
    <aside className="w-56 flex flex-col h-full border-r border-white/10 bg-black/20">
      {/* Logo */}
      <div className="px-4 py-4 border-b border-white/10">
        <button
          type="button"
          onClick={() => router.push('/')}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <div className="w-7 h-7 rounded-lg bg-indigo-500 flex items-center justify-center">
            <Sparkles className="h-4 w-4 text-white" />
          </div>
          <span className="font-semibold text-white text-sm">Creategent</span>
        </button>
      </div>

      {/* New project button */}
      <div className="px-3 py-3">
        <Button
          onClick={handleCreate}
          disabled={creating}
          size="sm"
          className="w-full bg-indigo-600 hover:bg-indigo-500 text-white text-xs gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          New Project
        </Button>
      </div>

      {/* Project list */}
      <div className="flex-1 overflow-y-auto px-2 space-y-0.5 pb-4">
        {projects.length === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-white/30">
            No projects yet
          </div>
        ) : (
          projects.map((project) => (
            <div key={project.id} className="relative group/item">
              <button
                onClick={() => router.push(`/project/${project.id}`)}
                className={cn(
                  'w-full text-left px-2.5 py-2 rounded-lg text-xs transition-colors group',
                  currentId === project.id
                    ? 'bg-indigo-600/30 text-white'
                    : 'text-white/60 hover:bg-white/5 hover:text-white'
                )}
              >
                <div className="flex items-center gap-2">
                  <FolderOpen className="h-3.5 w-3.5 flex-shrink-0 opacity-60" />
                  <span className="truncate flex-1 pr-4">{project.title}</span>
                  <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', STATUS_COLORS[project.status])} />
                </div>
              </button>
              <DeleteProjectDialog
                projectId={project.id}
                projectTitle={project.title}
                onDeleted={() => {
                  setProjects((prev) => prev.filter((p) => p.id !== project.id))
                  if (currentId === project.id) router.push('/')
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover/item:opacity-100 transition-opacity"
              />
            </div>
          ))
        )}
      </div>

      {/* Model lab */}
      <div className="border-t border-white/10 px-2 py-2">
        <button
          onClick={() => router.push('/testing')}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-white/60 transition-colors hover:bg-white/5 hover:text-white"
        >
          <FlaskConical className="h-3.5 w-3.5 flex-shrink-0 opacity-60" />
          Model Lab
        </button>
      </div>
    </aside>
  )
}
