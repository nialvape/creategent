/**
 * Single-password gate for the whole app.
 *
 * There is one user (the owner), so there is no user table and no provider —
 * just `APP_PASSWORD` compared against what was typed, and a signed cookie so
 * the browser doesn't have to hold the password itself.
 *
 * The signing key is derived from `APP_PASSWORD`, which keeps the deploy down
 * to a single env var and has the useful side effect that rotating the
 * password invalidates every session that was issued under the old one.
 *
 * Web Crypto (not node:crypto) is used throughout so this module is safe to
 * import from Proxy, route handlers, and server components alike.
 */

export const SESSION_COOKIE = 'creategent_session'

/** How long a successful login stays valid. */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30 // 30 days

const TOKEN_VERSION = 'v1'

export function getAppPassword(): string | undefined {
  const password = process.env.APP_PASSWORD
  return password && password.length > 0 ? password : undefined
}

/**
 * With no `APP_PASSWORD` set, local `next dev` stays open so the gate doesn't
 * get in the way of everyday work. A real deployment fails closed instead —
 * forgetting the env var on Vercel must not silently publish the app.
 */
export function isAuthDisabled(): boolean {
  return !getAppPassword() && process.env.NODE_ENV !== 'production'
}

function encoder() {
  return new TextEncoder()
}

function toBase64Url(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sign(payload: string, key: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder().encode(payload))
  return toBase64Url(signature)
}

/**
 * Compares two strings in time independent of how far they match, so a
 * response time can't be used to guess the password or a signature byte by
 * byte. Both sides are hashed first: HMAC output is fixed-width, but a typed
 * password isn't, and comparing raw strings of different lengths leaks length.
 */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder().encode(a)),
    crypto.subtle.digest('SHA-256', encoder().encode(b)),
  ])
  const bytesA = new Uint8Array(hashA)
  const bytesB = new Uint8Array(hashB)
  let diff = 0
  for (let i = 0; i < bytesA.length; i++) diff |= bytesA[i] ^ bytesB[i]
  return diff === 0
}

export async function isValidPassword(candidate: string): Promise<boolean> {
  const password = getAppPassword()
  if (!password) return false
  return safeEqual(candidate, password)
}

/** Mints the cookie value handed out after a correct password. */
export async function createSessionToken(): Promise<string> {
  const password = getAppPassword()
  if (!password) throw new Error('APP_PASSWORD is not set')

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS
  const payload = `${TOKEN_VERSION}.${expiresAt}`
  return `${payload}.${await sign(payload, password)}`
}

/** True only for a token this server signed that hasn't expired yet. */
export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false

  const password = getAppPassword()
  if (!password) return false

  const parts = token.split('.')
  if (parts.length !== 3) return false

  const [version, expiresAt, signature] = parts
  if (version !== TOKEN_VERSION) return false

  const expiry = Number(expiresAt)
  if (!Number.isFinite(expiry) || expiry * 1000 < Date.now()) return false

  const expected = await sign(`${version}.${expiresAt}`, password)
  return safeEqual(signature, expected)
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    // Vercel is always HTTPS; plain `next dev` is not, and a Secure cookie
    // would never be stored there.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  }
}
