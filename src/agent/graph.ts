import { StateGraph, START, END, type LangGraphRunnableConfig } from '@langchain/langgraph'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { ContentState } from './state'
import { plannerNode } from './nodes/planner'
import { humanApprovalNode } from './nodes/human-approval'
import { supervisorNode } from './nodes/supervisor'

// ─── Node logging wrapper ────────────────────────────────────────────────────

type NodeFn = (
  state: typeof ContentState.State,
  config?: LangGraphRunnableConfig
) => Promise<Partial<typeof ContentState.State>>

function loggedNode(name: string, fn: NodeFn): NodeFn {
  return async (state, config) => {
    const start = Date.now()
    console.log(`[graph] ${name}: running`)
    try {
      const result = await fn(state, config)
      console.log(`[graph] ${name}: done in ${Date.now() - start}ms`)
      return result
    } catch (err) {
      console.error(`[graph] ${name}: FAILED after ${Date.now() - start}ms —`, err instanceof Error ? err.message : err)
      throw err
    }
  }
}

// ─── Routing ─────────────────────────────────────────────────────────────────

function routeAfterApproval(state: typeof ContentState.State): string {
  if (state.planStatus === 'approved') return 'supervisor'
  console.log(`[graph] plan not approved (planStatus=${state.planStatus}), re-planning`)
  return 'planner'
}

// ─── Graph factory ───────────────────────────────────────────────────────────

// The supervisor is now the full generation engine: it sets the creative
// direction, then per wave it briefs each asset, runs the agents, reviews their
// output, issues per-asset corrections, and finally produces the holistic review.
function buildGraph(checkpointer: PostgresSaver) {
  const graph = new StateGraph(ContentState)
    .addNode('planner', loggedNode('planner', plannerNode))
    .addNode('await_approval', loggedNode('await_approval', humanApprovalNode))
    .addNode('supervisor', loggedNode('supervisor', supervisorNode))
    .addEdge(START, 'planner')
    .addEdge('planner', 'await_approval')
    .addConditionalEdges('await_approval', routeAfterApproval, {
      supervisor: 'supervisor',
      planner: 'planner',
    })
    .addEdge('supervisor', END)

  return graph.compile({ checkpointer })
}

export type CompiledGraph = ReturnType<typeof buildGraph>

// ─── Singleton ───────────────────────────────────────────────────────────────

let _graphPromise: Promise<CompiledGraph> | null = null

export async function getGraph(): Promise<CompiledGraph> {
  if (!_graphPromise) {
    _graphPromise = (async () => {
      const connString = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL
      if (!connString) throw new Error('DATABASE_URL or SUPABASE_DB_URL is not set')
      console.log('[graph] initializing PostgresSaver checkpointer')
      const checkpointer = PostgresSaver.fromConnString(connString)
      await checkpointer.setup()
      console.log('[graph] checkpointer ready')
      return buildGraph(checkpointer)
    })()
  }
  return _graphPromise
}

export async function getGraphState(graph: CompiledGraph, threadId: string) {
  return graph.getState({ configurable: { thread_id: threadId } })
}
