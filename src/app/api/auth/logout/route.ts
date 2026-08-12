import { cookies } from 'next/headers'
import { SESSION_COOKIE } from '@/lib/auth'

/**
 * GET so it can be reached as a plain link from anywhere in the UI; the
 * session cookie is the only thing it touches.
 */
export async function GET(request: Request) {
  const store = await cookies()
  store.delete(SESSION_COOKIE)
  return Response.redirect(new URL('/login', request.url), 303)
}

export async function POST(request: Request) {
  return GET(request)
}
