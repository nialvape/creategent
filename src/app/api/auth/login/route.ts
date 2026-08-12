import { cookies } from 'next/headers'
import {
  SESSION_COOKIE,
  createSessionToken,
  getAppPassword,
  isValidPassword,
  sessionCookieOptions,
} from '@/lib/auth'

export async function POST(request: Request) {
  if (!getAppPassword()) {
    return Response.json(
      { error: 'APP_PASSWORD is not configured on the server' },
      { status: 503 }
    )
  }

  let password: unknown
  try {
    password = (await request.json())?.password
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (typeof password !== 'string' || password.length === 0) {
    return Response.json({ error: 'Password is required' }, { status: 400 })
  }

  if (!(await isValidPassword(password))) {
    return Response.json({ error: 'Incorrect password' }, { status: 401 })
  }

  const store = await cookies()
  store.set(SESSION_COOKIE, await createSessionToken(), sessionCookieOptions())

  return Response.json({ ok: true })
}
