import { getProjects, createProject } from '@/lib/supabase/db'
import type { ProjectSettings } from '@/types/project'

const DEFAULT_SETTINGS: ProjectSettings = {
  preferredImageModel: 'fal-ai/flux/schnell',
  preferredVideoModel: 'fal-ai/kling-video/v2.1/standard/image-to-video',
  preferredAvatarModel: 'fal-ai/kling-video/ai-avatar/v2/pro',
  preferredAudioModel: 'eleven_multilingual_v2',
  orchestrationModel: 'anthropic/claude-sonnet-4-6',
  writingModel: 'anthropic/claude-sonnet-4-6',
  targetPlatforms: ['instagram'],
  qualityPreset: 'standard',
}

export async function GET() {
  try {
    const projects = await getProjects()
    return Response.json(projects)
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const { title, description, settings } = await req.json()
    const project = await createProject(
      title ?? 'New Project',
      description ?? null,
      { ...DEFAULT_SETTINGS, ...settings }
    )
    return Response.json(project, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : JSON.stringify(err)
    console.error('POST /api/projects error:', message)
    return Response.json({ error: message }, { status: 500 })
  }
}
