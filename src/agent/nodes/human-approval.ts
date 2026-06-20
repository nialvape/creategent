import { interrupt } from '@langchain/langgraph'
import type { ContentState } from '@/agent/state'

export async function humanApprovalNode(
  state: typeof ContentState.State
): Promise<Partial<typeof ContentState.State>> {
  // Pause graph and wait for user to approve/reject via Command resume
  const decision = interrupt({
    type: 'plan_approval',
    plan: state.plan,
    estimatedCost: state.estimatedCost,
  })

  if (decision === 'approved') {
    return { planStatus: 'approved', status: 'generating' }
  } else if (decision === 'rejected') {
    return { planStatus: 'rejected', status: 'planning' }
  } else if (typeof decision === 'object' && decision !== null && 'feedback' in decision) {
    return { planStatus: 'rejected', status: 'planning' }
  }

  return { planStatus: 'rejected', status: 'planning' }
}
