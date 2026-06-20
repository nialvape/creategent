import { getProject, updateProject } from '@/lib/supabase/db'
import { generateProjectTitle } from '@/lib/title'

const DEFAULT_TITLES = new Set(['New Project', 'Nuevo Proyecto'])

/**
 * Generate a smart title for a project from a user-provided idea and persist it.
 * Only overwrites titles that are still the default placeholder, so a user who
 * renamed the project manually never gets it clobbered.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const { idea } = await req.json()
    if (typeof idea !== 'string' || !idea.trim()) {
      return Response.json({ error: 'idea is required' }, { status: 400 })
    }

    const project = await getProject(id)
    if (!project) return Response.json({ error: 'Not found' }, { status: 404 })
    if (!DEFAULT_TITLES.has(project.title)) {
      // Respect a title the user already set.
      return Response.json(project)
    }

    const title = await generateProjectTitle(idea)
    if (!title) return Response.json(project)

    const updated = await updateProject(id, { title })
    return Response.json(updated)
  } catch (err) {
    console.error('POST /api/projects/[id]/title error:', err)
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
