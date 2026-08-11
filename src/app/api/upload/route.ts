import { uploadAsset, getAssetUrl } from '@/lib/supabase/storage'

/**
 * Uploads a user-provided media file (e.g. a voice-clone reference sample) to
 * the project's storage bucket and returns its public URL. Media the user hands
 * to the agent is always attached as a file — never pasted as a link.
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData()
    const file = form.get('file')
    const projectId = form.get('projectId')

    if (!(file instanceof File)) {
      return Response.json({ error: 'file is required' }, { status: 400 })
    }
    if (typeof projectId !== 'string' || !projectId) {
      return Response.json({ error: 'projectId is required' }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const contentType = file.type || 'application/octet-stream'
    const path = await uploadAsset(projectId, buffer, file.name, contentType)
    const url = await getAssetUrl(path)

    return Response.json({ url }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : JSON.stringify(err)
    console.error('POST /api/upload error:', message)
    return Response.json({ error: message }, { status: 500 })
  }
}
