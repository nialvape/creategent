import { createServerClient } from './client'

const BUCKET = 'assets'

/**
 * Storage key for a new asset. Timestamped so the same name uploaded twice
 * never collides, and stripped of anything that would need escaping — the key
 * ends up inside both a public URL and a signed upload URL.
 */
function assetPath(projectId: string, fileName: string): string {
  const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${projectId}/${Date.now()}_${safeName}`
}

export async function uploadAsset(
  projectId: string,
  file: Buffer | Blob,
  fileName: string,
  contentType: string
): Promise<string> {
  const db = createServerClient()
  const path = assetPath(projectId, fileName)
  const { error } = await db.storage.from(BUCKET).upload(path, file, { contentType, upsert: false })
  if (error) throw error
  return path
}

/**
 * One-shot URL the browser can PUT a file to, uploading straight to Supabase.
 * Exists because a serverless request body is capped at 4.5 MB on Vercel:
 * anything bigger — a phone photo, any video — is rejected by the platform
 * before the route handler runs, so user media must not pass through the app.
 */
export async function createAssetUploadUrl(
  projectId: string,
  fileName: string
): Promise<{ signedUrl: string; path: string }> {
  const db = createServerClient()
  const path = assetPath(projectId, fileName)
  const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path)
  if (error) throw error
  return { signedUrl: data.signedUrl, path }
}

export async function getAssetUrl(path: string): Promise<string> {
  const db = createServerClient()
  const { data } = db.storage.from(BUCKET).getPublicUrl(path)
  return data.publicUrl
}

export async function downloadAsset(path: string): Promise<Blob> {
  const db = createServerClient()
  const { data, error } = await db.storage.from(BUCKET).download(path)
  if (error) throw error
  return data
}

export async function deleteAsset(path: string): Promise<void> {
  const db = createServerClient()
  const { error } = await db.storage.from(BUCKET).remove([path])
  if (error) throw error
}
