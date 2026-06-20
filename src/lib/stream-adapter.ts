import type { StreamMode } from '@langchain/langgraph'
import type { CompiledGraph } from '@/agent/graph'

export interface StreamOptions {
  threadId: string
  input?: Record<string, unknown>
  command?: { resume: unknown }
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'node'; node: string }

function buildConfig(threadId: string) {
  return {
    configurable: { thread_id: threadId },
    // 'messages' streams LLM tokens (+ langgraph_node metadata); 'custom' surfaces
    // the fine-grained phase markers the supervisor emits via config.writer so the
    // UI can show "Generating images" / "Generating video & audio" etc. instead of
    // a single opaque "Generating assets".
    streamMode: ['messages', 'custom'] as StreamMode[],
  }
}

export async function* iterateGraphEvents(
  graph: CompiledGraph,
  options: StreamOptions
): AsyncIterable<StreamEvent> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stream: AsyncIterable<any>

  if (options.command) {
    const { Command } = await import('@langchain/langgraph')
    stream = await graph.stream(new Command({ resume: options.command.resume }), buildConfig(options.threadId))
  } else {
    stream = await graph.stream(options.input ?? null, buildConfig(options.threadId))
  }

  let currentNode: string | null = null

  for await (const item of stream) {
    // With an array streamMode, each item is a [mode, payload] tuple.
    if (!Array.isArray(item)) continue
    const [mode, payload] = item as [string, unknown]

    if (mode === 'custom') {
      // Phase markers written by the supervisor: { phase: '<label-key>' }.
      const phase = (payload as { phase?: string } | null)?.phase
      if (phase) yield { type: 'node', node: phase }
      continue
    }

    // mode === 'messages' → payload is an [AIMessageChunk, metadata] tuple.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [chunk, meta] = (payload as [any, any]) ?? []

    const nodeName = (meta as { langgraph_node?: string } | null)?.langgraph_node
    // The supervisor fans out to sub-agents internally; its progress is reported
    // via 'custom' phase markers, so don't emit the coarse 'supervisor' node here
    // (it would overwrite the granular phase label in the UI).
    if (nodeName && nodeName !== currentNode && nodeName !== 'supervisor') {
      currentNode = nodeName
      yield { type: 'node', node: nodeName }
    }

    if (!chunk) continue
    const content = chunk.content
    if (typeof content === 'string' && content) {
      yield { type: 'text', text: content }
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && block.text) yield { type: 'text', text: block.text }
      }
    }
  }
}
