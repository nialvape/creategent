'use client'

import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

interface DeleteProjectDialogProps {
  projectId: string
  projectTitle: string
  onDeleted?: () => void
  className?: string
  withLabel?: boolean
}

export function DeleteProjectDialog({
  projectId,
  projectTitle,
  onDeleted,
  className,
  withLabel = false,
}: DeleteProjectDialogProps) {
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState(false)

  const handleDelete = async () => {
    setDeleting(true)
    setError(false)
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' })
      if (!res.ok) {
        setError(true)
        return
      }
      setOpen(false)
      onDeleted?.()
    } catch {
      setError(true)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        className={cn(
          'inline-flex items-center gap-1.5 text-white/30 hover:text-red-400 transition-colors',
          className
        )}
        aria-label={`Delete project ${projectTitle}`}
        title="Delete project"
      >
        <Trash2 className="h-3.5 w-3.5" />
        {withLabel && <span className="text-xs">Delete</span>}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete project?</DialogTitle>
            <DialogDescription>
              <span className="font-medium text-foreground">{projectTitle}</span> and all of its
              generated assets will be permanently deleted. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="text-xs text-red-400">Couldn&apos;t delete the project. Please try again.</p>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={deleting} />}>
              Cancel
            </DialogClose>
            <Button
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-500 text-white"
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
