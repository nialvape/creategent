import { createServerClient } from './client'

const BUCKET = 'assets'

export async function uploadAsset(
  projectId: string,
  file: Buffer | Blob,
  fileName: string,
  contentType: string
): Promise<string> {
  const db = createServerClient()
  const path = `${projectId}/${Date.now()}_${fileName}`
  const { error } = await db.storage.from(BUCKET).upload(path, file, { contentType, upsert: false })
  if (error) throw error
  return path
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
