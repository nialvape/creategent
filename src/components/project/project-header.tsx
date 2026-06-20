'use client'

import { useState, useEffect, useRef } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Settings2, Pencil, Check, X } from 'lucide-react'
import type { Project } from '@/types/project'
import { DeleteProjectDialog } from '@/components/project/delete-project-dialog'

interface ProjectHeaderProps {
  project: Project
  onOpenSettings?: () => void
  /** Persist a manual title rename. */
  onRename?: (title: string) => void | Promise<void>
  onDelete?: () => void
}

const STATUS_LABELS = {
  draft: 'Draft',
  planning: 'Planning',
  generating: 'Generating',
  completed: 'Completed',
  failed: 'Failed',
}

const STATUS_COLORS = {
  draft: 'text-white/40 border-white/10',
  planning: 'text-blue-400 border-blue-500/30',
  generating: 'text-indigo-400 border-indigo-500/30',
  completed: 'text-emerald-400 border-emerald-500/30',
  failed: 'text-red-400 border-red-500/30',
}

export function ProjectHeader({ project, onOpenSettings, onRename, onDelete }: ProjectHeaderProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(project.title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const startEditing = () => {
    setDraft(project.title)
    setEditing(true)
  }

  const commit = () => {
    const next = draft.trim()
    setEditing(false)
    if (next && next !== project.title) {
      onRename?.(next)
    }
  }

  const cancel = () => setEditing(false)

  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
      <div className="flex items-center gap-3 min-w-0">
        {editing ? (
          <div className="flex items-center gap-1.5 min-w-0">
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') cancel()
              }}
              autoFocus
              maxLength={80}
              className="bg-white/5 border border-white/15 rounded px-2 py-0.5 text-sm font-semibold text-white outline-none focus:border-indigo-500/50 min-w-0 w-56"
            />
            <button
              type="button"
              onClick={commit}
              className="text-white/40 hover:text-emerald-400 transition-colors"
              aria-label="Save title"
            >
              <Check className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={cancel}
              className="text-white/40 hover:text-red-400 transition-colors"
              aria-label="Cancel"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="group flex items-center gap-1.5 min-w-0">
            <h1 className="text-sm font-semibold text-white truncate">{project.title}</h1>
            {onRename && (
              <button
                type="button"
                onClick={startEditing}
                className="text-white/30 hover:text-white/70 transition-colors opacity-0 group-hover:opacity-100"
                aria-label="Rename project"
                title="Rename"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
        <Badge
          variant="outline"
          className={`text-xs capitalize shrink-0 ${STATUS_COLORS[project.status]}`}
        >
          {STATUS_LABELS[project.status]}
        </Badge>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex gap-1">
          {project.settings.targetPlatforms.map((p) => (
            <Badge key={p} variant="secondary" className="text-[10px] capitalize">
              {p}
            </Badge>
          ))}
        </div>
        {onOpenSettings && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenSettings}
            className="h-7 w-7 text-white/40 hover:text-white"
          >
            <Settings2 className="h-4 w-4" />
          </Button>
        )}
        <DeleteProjectDialog
          projectId={project.id}
          projectTitle={project.title}
          onDeleted={onDelete}
          withLabel
        />
      </div>
    </div>
  )
}
