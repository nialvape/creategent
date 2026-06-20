'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ProjectSettingsForm } from './project-settings-form'
import { coerceSettings } from '@/lib/default-settings'
import type { Project, ProjectSettings } from '@/types/project'

interface ProjectSettingsModalProps {
  project: Project
  open: boolean
  onClose: () => void
  onSave: (settings: ProjectSettings) => Promise<void>
}

export function ProjectSettingsModal({ project, open, onClose, onSave }: ProjectSettingsModalProps) {
  // Coerce on load so a stale/retired model id stored on the project (e.g. an old
  // `fal-ai/wan/...` video model no longer offered) shows a valid selection and is
  // normalized when saved.
  const [settings, setSettings] = useState<ProjectSettings>(() => coerceSettings(project.settings))
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    await onSave(settings)
    setSaving(false)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-xl bg-zinc-900 border-white/10 text-white max-h-[85vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>Project Settings</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto pr-1 -mr-1">
          <ProjectSettingsForm settings={settings} onChange={setSettings} />
        </div>

        <div className="flex gap-2 pt-4 flex-shrink-0 border-t border-white/8 mt-4">
          <Button variant="ghost" onClick={onClose} className="flex-1 text-white/50">
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 bg-indigo-600 hover:bg-indigo-500"
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
