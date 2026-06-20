import { createCostEvent, getCostEvents } from '@/lib/supabase/db'
import type { CostEvent } from '@/types/cost'

export async function trackCost(
  event: Omit<CostEvent, 'id' | 'created_at'>
): Promise<void> {
  await createCostEvent(event)
}

export async function getCostComparison(
  projectId: string,
  estimatedTotal: number
): Promise<{ estimated: number; actual: number; variance: number }> {
  const events = await getCostEvents(projectId)
  const actual = events.reduce((sum, e) => sum + e.cost_usd, 0)
  const variance = estimatedTotal > 0 ? (actual - estimatedTotal) / estimatedTotal : 0
  return { estimated: estimatedTotal, actual, variance }
}

export async function detectAnomalies(
  projectId: string,
  estimatedTotal: number
): Promise<boolean> {
  const { variance } = await getCostComparison(projectId, estimatedTotal)
  return variance > 0.5
}
