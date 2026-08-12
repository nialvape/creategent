'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Lock, Loader2 } from 'lucide-react'

export function LoginForm({ next }: { next: string }) {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setError(body?.error ?? 'Login failed')
        setSubmitting(false)
        return
      }

      // The gate lives in Proxy, so the cached router tree from before login
      // has to go or the destination can render from a stale entry.
      router.replace(next)
      router.refresh()
    } catch {
      setError('Network error — try again')
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-6">
      <div className="space-y-2 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-xl border border-white/10 bg-white/5">
          <Lock className="size-4 text-white/60" />
        </div>
        <h1 className="text-lg font-semibold">CreateGent</h1>
        <p className="text-sm text-muted-foreground">Enter the access password to continue</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          autoComplete="current-password"
          disabled={submitting}
          aria-invalid={error ? true : undefined}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <Button type="submit" className="w-full" disabled={submitting || password.length === 0}>
        {submitting && <Loader2 className="size-4 animate-spin" />}
        {submitting ? 'Checking…' : 'Enter'}
      </Button>
    </form>
  )
}
