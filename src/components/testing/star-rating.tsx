'use client'

import { Star, X } from 'lucide-react'
import { MAX_STARS } from '@/lib/rating-axes'
import { cn } from '@/lib/utils'

interface StarRatingProps {
  /** Undefined means "not scored" — which is different from a score of zero. */
  value?: number
  onChange: (value: number | undefined) => void
  disabled?: boolean
}

/**
 * Five stars plus a clear button. The cleared state matters: an axis the rater
 * chose not to judge must not be saved as a low score, so an unrated axis is
 * left out of the payload entirely.
 */
export function StarRating({ value, onChange, disabled }: StarRatingProps) {
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: MAX_STARS }, (_, i) => i + 1).map((star) => {
        const filled = value !== undefined && star <= value
        return (
          <button
            key={star}
            type="button"
            disabled={disabled}
            aria-label={`${star} of ${MAX_STARS}`}
            // Clicking the current score clears it, so a mis-click is one click
            // to undo rather than a value you can't get rid of.
            onClick={() => onChange(value === star ? undefined : star)}
            className="rounded p-0.5 transition-colors disabled:opacity-40"
          >
            <Star
              className={cn(
                'h-4 w-4 transition-colors',
                filled ? 'fill-amber-400 text-amber-400' : 'text-white/20 hover:text-white/45'
              )}
            />
          </button>
        )
      })}

      <button
        type="button"
        onClick={() => onChange(undefined)}
        disabled={disabled || value === undefined}
        aria-label="Clear score"
        className={cn(
          'ml-1 rounded p-0.5 text-white/25 transition-opacity hover:text-white/60',
          value === undefined && 'invisible'
        )}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
