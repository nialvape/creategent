import { createAssetUploadUrl, getAssetUrl } from '@/lib/supabase/storage'

/**
 * Hands the browser a one-shot URL to upload a file straight into the project's
 * storage bucket, plus the public URL that file will have.
 *
 * The bytes deliberately never touch this function: Vercel caps a serverless
 * request body at 4.5 MB and rejects anything larger at the edge with a
 * plain-text "Request Entity Too Large", before any handler code runs. A
 * first-frame photo or a voice sample clears that limit routinely, so uploads
 * go to Supabase directly and only the metadata comes through here.
 */
export async function POST(req: Request) {
  try {
    const { fileName, projectId } = (await req.json()) as {
      fileName?: string
      projectId?: string
    }

    if (!fileName) return Response.json({ error: 'fileName is required' }, { status: 400 })
    if (!projectId) return Response.json({ error: 'projectId is required' }, { status: 400 })

    const { signedUrl, path } = await createAssetUploadUrl(projectId, fileName)
    return Response.json({ signedUrl, path, url: await getAssetUrl(path) })
  } catch (err) {
    const message = err instanceof Error ? err.message : JSON.stringify(err)
    console.error('POST /api/upload/sign error:', message)
    return Response.json({ error: message }, { status: 500 })
  }
}
