'use client'

import { useRef, useEffect, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { SendHorizonal, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface MessageInputProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  disabled?: boolean
  placeholder?: string
}

export function MessageInput({ value, onChange, onSend, disabled, placeholder }: MessageInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`
    }
  }, [value])

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (value.trim() && !disabled) onSend()
    }
  }

  return (
    <div className="border-t border-white/10 px-4 py-3">
      <div className="flex items-end gap-2 bg-white/5 border border-white/10 rounded-2xl px-4 py-3 focus-within:border-indigo-500/50 transition-colors">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKey}
          disabled={disabled}
          placeholder={placeholder ?? 'Describe your content idea...'}
          rows={1}
          className="flex-1 bg-transparent text-sm text-white placeholder-white/30 resize-none focus:outline-none min-h-[24px] max-h-40"
        />
        <Button
          size="icon"
          onClick={onSend}
          disabled={disabled || !value.trim()}
          className={cn(
            'h-8 w-8 rounded-xl flex-shrink-0 transition-all',
            value.trim() && !disabled
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
      <p className="text-center text-xs text-white/20 mt-2">Enter to send · Shift+Enter for new line</p>
    </div>
  )
}
