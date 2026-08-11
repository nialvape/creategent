import { getGraph, getGraphState } from '@/agent/graph'
import { iterateGraphEvents } from '@/lib/stream-adapter'
import type { ProjectSettings } from '@/types/project'
import type { ReferenceMedium } from '@/types/graph-state'

export const runtime = 'nodejs'
export const maxDuration = 300

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
} as const

function sseEvent(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)
}

const SSE_DONE = new TextEncoder().encode('data: [DONE]\n\n')

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const {
      messages,
      threadId,
      projectId,
      projectSettings,
      command,
      attachments,
    }: {
      messages?: Array<{ role: string; content: string }>
      threadId: string
      projectId: string
      projectSettings?: ProjectSettings
      command?: { type: 'approve' | 'reject'; feedback?: string }
      attachments?: ReferenceMedium[]
    } = body

    const graph = await getGraph()

    let streamOptions

    if (command) {
      const resumeValue = command.type === 'approve'
        ? 'approved'
        : { rejected: true, feedback: command.feedback }
      streamOptions = { threadId, command: { resume: resumeValue } }
    } else {
      const lastMessage = messages?.[messages.length - 1]
      const userIdea = lastMessage?.content ?? ''
      const defaultSettings: ProjectSettings = {
        preferredImageModel: 'fal-ai/flux/schnell',
        preferredVideoModel: 'fal-ai/kling-video/v2.1/standard/image-to-video',
        preferredAvatarModel: 'fal-ai/kling-video/ai-avatar/v2/pro',
        preferredAudioModel: 'eleven_multilingual_v2',
        orchestrationModel: 'anthropic/claude-sonnet-4-6',
        writingModel: 'anthropic/claude-sonnet-4-6',
        translationModel: 'meta-llama/llama-3.3-70b-instruct:free',
        targetPlatforms: ['instagram'],
        qualityPreset: 'standard',
        ...projectSettings,
      }
      streamOptions = {
        threadId,
        input: {
          userIdea,
          projectId,
          projectSettings: defaultSettings,
          messages: [{ role: 'user', content: userIdea }],
          status: 'planning',
          // Attached reference files. The intake node describes each before the
          // planner runs. Sanitized to the fields the graph needs.
          referenceMedia: (attachments ?? [])
            .filter((a) => a && a.url && a.kind)
            .map((a) => ({ url: a.url, kind: a.kind, name: a.name ?? '', mimeType: a.mimeType ?? '' })),
        },
      }
    }

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of iterateGraphEvents(graph, streamOptions)) {
            if (event.type === 'text') {
              controller.enqueue(sseEvent({ type: 'text', text: event.text }))
            } else if (event.type === 'node') {
              controller.enqueue(sseEvent({ type: 'status', node: event.node }))
            }
          }

          // Graph has fully run — safe to read checkpoint state now
          const state = await getGraphState(graph, threadId)
          // interruptBefore leaves state.next populated with the pending node;
          // tasks[].interrupts is only populated when interrupt() is called inside a node
          const interrupted = Array.isArray(state?.next) && state.next.length > 0

          if (interrupted && state?.values) {
            controller.enqueue(
              sseEvent({
                type: 'interrupt',
                // Show the plan in the user's language when available; the canonical
                // English plan (state.values.plan) still drives generation.
                plan: state.values.displayPlan ?? state.values.plan,
                estimatedCost: state.values.estimatedCost ?? 0,
                status: state.values.status,
              })
            )
          } else if (state?.values) {
            const v = state.values
            const completedAssets = (v.assets ?? []).filter(
              (a: { status: string; public_url?: string | null }) => a.status === 'completed' && a.public_url
            )
            controller.enqueue(
              sseEvent({
                type: 'complete',
                status: v.status,
                assets: completedAssets.map((a: { id: string; type: string; name: string; public_url: string; specs: unknown }) => ({
                  id: a.id,
                  type: a.type,
                  name: a.name,
                  public_url: a.public_url,
                  specs: a.specs,
                })),
                assetsCount: (v.assets ?? []).length,
                completedCount: (v.assets ?? []).filter((a: { status: string }) => a.status === 'completed').length,
                failedCount: (v.assets ?? []).filter((a: { status: string }) => a.status === 'failed').length,
                actualCost: v.actualCost ?? 0,
                reviewScore: v.reviewResult?.overallScore ?? null,
              })
            )
          }
        } catch (err) {
          controller.enqueue(sseEvent({ type: 'error', message: String(err) }))
        } finally {
          controller.enqueue(SSE_DONE)
          controller.close()
        }
      },
    })

    return new Response(stream, { headers: SSE_HEADERS })
  } catch (err) {
    console.error('Chat API error:', err)
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
