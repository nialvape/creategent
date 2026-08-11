'use client'

import { useRef, useEffect, useState, useCallback, type KeyboardEvent, type ClipboardEvent, type ChangeEvent } from 'react'
import { Button } from '@/components/ui/button'
import { SendHorizonal, Loader2, Paperclip, X, Music } from 'lucide-react'
import { cn } from '@/lib/utils'

export type AttachmentKind = 'image' | 'video' | 'audio'

export interface Attachment {
  id: string
  file: File
  /** Object URL for local preview. Revoked when the attachment is removed. */
  url: string
  kind: AttachmentKind
}

interface MessageInputProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  disabled?: boolean
  placeholder?: string
  /** Current media attachments. When provided, the parent owns attachment state. */
  attachments?: Attachment[]
  onAttachmentsChange?: (next: Attachment[]) => void
}

function kindOf(file: File): AttachmentKind | null {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return null
}

let attachmentCounter = 0

export function MessageInput({
  value,
  onChange,
  onSend,
  disabled,
  placeholder,
  attachments: controlledAttachments,
  onAttachmentsChange,
}: MessageInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Support both controlled (parent-owned) and uncontrolled (self-owned) usage.
  const [internalAttachments, setInternalAttachments] = useState<Attachment[]>([])
  const attachments = controlledAttachments ?? internalAttachments
  const setAttachments = useCallback(
    (updater: (prev: Attachment[]) => Attachment[]) => {
      if (onAttachmentsChange) {
        onAttachmentsChange(updater(controlledAttachments ?? []))
      } else {
        setInternalAttachments(updater)
      }
    },
    [controlledAttachments, onAttachmentsChange]
  )

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`
    }
  }, [value])

  // Revoke every outstanding object URL on unmount to avoid leaking memory.
  // Keep the ref current via an effect (not during render).
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
      const media: Attachment[] = []
      for (const file of Array.from(files)) {
        const kind = kindOf(file)
        if (!kind) continue
        media.push({ id: `att-${++attachmentCounter}`, file, url: URL.createObjectURL(file), kind })
      }
      if (media.length > 0) setAttachments((prev) => [...prev, ...media])
      return media.length
    },
    [setAttachments]
  )

  const removeAttachment = useCallback(
    (id: string) => {
      setAttachments((prev) => {
        const target = prev.find((a) => a.id === id)
        if (target) URL.revokeObjectURL(target.url)
        return prev.filter((a) => a.id !== id)
      })
    },
    [setAttachments]
  )

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = e.clipboardData?.files
    if (files && files.length > 0) {
      const added = addFiles(files)
      // Only swallow the paste when we actually captured media, so normal text
      // paste keeps working.
      if (added > 0) e.preventDefault()
    }
  }

  const handleBrowse = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files)
    e.target.value = '' // allow re-selecting the same file
  }

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if ((value.trim() || attachments.length > 0) && !disabled) onSend()
    }
  }

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !disabled

  return (
    <div className="border-t border-white/10 px-4 py-3">
      <div className="flex flex-col gap-2 bg-white/5 border border-white/10 rounded-2xl px-4 py-3 focus-within:border-indigo-500/50 transition-colors">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((att) => (
              <AttachmentThumb key={att.id} attachment={att} onRemove={() => removeAttachment(att.id)} />
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*,audio/*"
            multiple
            onChange={handleBrowse}
            className="hidden"
          />
          <Button
            size="icon"
            variant="ghost"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            title="Attach media"
            className="h-8 w-8 rounded-xl flex-shrink-0 text-white/40 hover:text-white/80 hover:bg-white/10"
          >
            <Paperclip className="h-4 w-4" />
          </Button>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKey}
            onPaste={handlePaste}
            disabled={disabled}
            placeholder={placeholder ?? 'Describe your content idea...'}
            rows={1}
            className="flex-1 bg-transparent text-sm text-white placeholder-white/30 resize-none focus:outline-none min-h-[24px] max-h-40 self-center"
          />
          <Button
            size="icon"
            onClick={onSend}
            disabled={!canSend}
            className={cn(
              'h-8 w-8 rounded-xl flex-shrink-0 transition-all',
              canSend
                ? 'bg-indigo-600 hover:bg-indigo-500 text-white'
                : 'bg-white/10 text-white/30'
            )}
          >
            {disabled ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <SendHorizonal className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
      <p className="text-center text-xs text-white/20 mt-2">Enter to send · Shift+Enter for new line · paste or attach media</p>
    </div>
  )
}

function AttachmentThumb({ attachment, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  const { url, kind, file } = attachment
  return (
    <div className="relative group h-16 w-16 rounded-lg overflow-hidden border border-white/15 bg-white/5">
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
        onClick={onRemove}
        title="Remove"
        className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white/80 opacity-0 transition-opacity hover:bg-black hover:text-white group-hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
