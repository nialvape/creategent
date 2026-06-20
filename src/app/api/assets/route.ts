import { getAssets } from '@/lib/supabase/db'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const projectId = url.searchParams.get('projectId')

  if (!projectId) {
    return Response.json({ error: 'projectId is required' }, { status: 400 })
  }

  try {
    const assets = await getAssets(projectId)
    return Response.json(assets)
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
