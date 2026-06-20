import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any>

function getEnv(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`Missing env var: ${key}`)
  return v
}

export function createBrowserClient(): DB {
  return createClient(
    getEnv('NEXT_PUBLIC_SUPABASE_URL'),
    getEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY')
  )
}

export function createServerClient(): DB {
  // Prefer service_role key for full DB access; fall back to anon key
  // (works while RLS is disabled — add SUPABASE_SERVICE_ROLE_KEY when you enable RLS)
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  const key = serviceKey.length > 10 ? serviceKey : getEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY')
  return createClient(
    getEnv('NEXT_PUBLIC_SUPABASE_URL'),
    key,
    { auth: { persistSession: false } }
  )
}

let _serverClient: DB | null = null
export function getServerClient(): DB {
  if (!_serverClient) _serverClient = createServerClient()
  return _serverClient
}
