import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { SESSION_COOKIE, isAuthDisabled, verifySessionToken } from '@/lib/auth'
import { LoginForm } from './login-form'

/**
 * `next` arrives from the URL, so it's attacker-controlled: anything that
 * isn't a path on this site is dropped rather than turned into a redirect to
 * someone else's domain. `//evil.com` and `/\evil.com` are browser-protocol
 * relative URLs, not local paths, which is why a leading `/` alone isn't
 * enough of a check.
 */
function safeRedirectTarget(next: string | string[] | undefined): string {
  if (typeof next !== 'string') return '/'
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/'
  return next
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const target = safeRedirectTarget((await searchParams).next)

  if (isAuthDisabled()) redirect(target)

  const session = (await cookies()).get(SESSION_COOKIE)?.value
  if (await verifySessionToken(session)) redirect(target)

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <LoginForm next={target} />
    </main>
  )
}
