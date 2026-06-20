import { getProject, updateProject, deleteProject } from '@/lib/supabase/db'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const project = await getProject(id)
    if (!project) return Response.json({ error: 'Not found' }, { status: 404 })
    return Response.json(project)
  } catch (err) {
    console.error('GET /api/projects/[id] error:', err)
    return Response.json({ error: String(err) }, { status: 500 })
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const updates = await req.json()
    const project = await updateProject(id, updates)
    return Response.json(project)
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    await deleteProject(id)
    return new Response(null, { status: 204 })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
