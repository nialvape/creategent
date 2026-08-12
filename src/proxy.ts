import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { SESSION_COOKIE, isAuthDisabled, verifySessionToken } from '@/lib/auth'

/**
 * Password gate for every route, pages and API alike.
 *
 * The API routes matter as much as the pages here: they're the ones that spend
 * money on RunPod, fal, and OpenRouter, so leaving them open while gating the
 * UI would protect nothing.
 */

/** Reachable without a session — everything needed to get one. */
const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/auth/logout']

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))
}

export async function proxy(request: NextRequest) {
  if (isAuthDisabled()) return NextResponse.next()

  const { pathname, search } = request.nextUrl
  if (isPublic(pathname)) return NextResponse.next()

  if (await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next()
  }

  // A fetch from the app expects JSON back; redirecting it to the login page
  // would just hand the caller an HTML document it can't parse.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const loginUrl = new URL('/login', request.url)
  loginUrl.searchParams.set('next', `${pathname}${search}`)
  return NextResponse.redirect(loginUrl)
}

export const config = {
  // Static assets and the favicon are excluded so the login page can style
  // itself; everything else, including /api, goes through the gate.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
