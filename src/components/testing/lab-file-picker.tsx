'use client'

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { Music, Upload, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export type LabAttachmentKind = 'image' | 'video' | 'audio'

export interface LabAttachment {
  id: string
  file: File
  /** Object URL for local preview. Revoked when the attachment is removed. */
  url: string
  kind: LabAttachmentKind
}

function kindOf(file: File): LabAttachmentKind | null {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return null
}

let counter = 0

interface LabFilePickerProps {
  attachments: LabAttachment[]
  onChange: (next: LabAttachment[]) => void
  disabled?: boolean
}

/**
 * Drop zone for the model lab's file half of the input. Same media rules as the
 * chat composer (image / video / audio only), but standalone — the lab has no
 * message to send them with.
 */
export function LabFilePicker({ attachments, onChange, disabled }: LabFilePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  // Revoke every outstanding object URL on unmount so previews don't leak.
  const attachmentsRef = useRef(attachments)
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])
  useEffect(() => {
    return () => {
      for (const a of attachmentsRef.current) URL.revokeObjectURL(a.url)
    }
  }, [])

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const media: LabAttachment[] = []
      for (const file of Array.from(files)) {
        const kind = kindOf(file)
        if (!kind) continue
        media.push({ id: `lab-${++counter}`, file, url: URL.createObjectURL(file), kind })
      }
      if (media.length > 0) onChange([...attachments, ...media])
    },
    [attachments, onChange]
  )

  const handleBrowse = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files)
    e.target.value = '' // allow re-selecting the same file
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    if (disabled) return
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files)
  }

  const remove = (id: string) => {
    const target = attachments.find((a) => a.id === id)
    if (target) URL.revokeObjectURL(target.url)
    onChange(attachments.filter((a) => a.id !== id))
  }

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*,audio/*"
        multiple
        onChange={handleBrowse}
        className="hidden"
      />

      <div
        onDragOver={(e) => {
          e.preventDefault()
          if (!disabled) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => !disabled && inputRef.current?.click()}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-6 transition-colors',
          dragging
            ? 'border-indigo-500/60 bg-indigo-500/10'
            : 'border-white/15 bg-white/[0.02] hover:border-white/25 hover:bg-white/[0.04]',
          disabled && 'pointer-events-none opacity-50'
        )}
      >
        <Upload className="h-4 w-4 text-white/40" />
        <p className="text-xs text-white/50">Drop files or click to browse</p>
        <p className="text-[10px] text-white/25">images · video · audio</p>
      </div>

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((att) => (
            <Thumb key={att.id} attachment={att} onRemove={() => remove(att.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

function Thumb({ attachment, onRemove }: { attachment: LabAttachment; onRemove: () => void }) {
  const { url, kind, file } = attachment
  return (
    <div className="group relative h-16 w-16 overflow-hidden rounded-lg border border-white/15 bg-white/5">
      {kind === 'image' && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={file.name} className="h-full w-full object-cover" />
      )}
      {kind === 'video' && (
        <video src={url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
      )}
      {kind === 'audio' && (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-1">
          <Music className="h-4 w-4 text-indigo-300" />
          <span className="w-full truncate text-center text-[9px] leading-tight text-white/50">{file.name}</span>
        </div>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        title="Remove"
        className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white/80 opacity-0 transition-opacity hover:bg-black hover:text-white group-hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
