/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServerClient } from './client'
import type { Project, ProjectSettings } from '@/types/project'
import type { Asset, AssetStatus } from '@/types/asset'
import type { CostEvent } from '@/types/cost'
import type { PromptRating, PromptRatingInput } from '@/types/rating'

function db() { return createServerClient() }

// --- Projects ---

export async function getProjects(): Promise<Project[]> {
  const { data, error } = await db()
    .from('projects')
    .select('*')
    .order('updated_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as Project[]
}

export async function getProject(id: string): Promise<Project | null> {
  const { data, error } = await db().from('projects').select('*').eq('id', id).single()
  if (error) return null
  return data as Project
}

export async function createProject(
  title: string,
  description: string | null,
  settings: ProjectSettings
): Promise<Project> {
  const { data, error } = await db()
    .from('projects')
    .insert({ title, description, settings, status: 'draft' })
    .select()
    .single()
  if (error) throw error
  return data as Project
}

export async function updateProject(
  id: string,
  updates: Partial<Pick<Project, 'title' | 'description' | 'status' | 'settings'>>
): Promise<Project> {
  const { data, error } = await db()
    .from('projects')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data as Project
}

export async function deleteProject(id: string): Promise<void> {
  const { error } = await db().from('projects').delete().eq('id', id)
  if (error) throw error
}

// --- Assets ---

export async function getAssets(projectId: string): Promise<Asset[]> {
  const { data, error } = await db()
    .from('assets')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as Asset[]
}

export async function createAsset(
  asset: Omit<Asset, 'id' | 'created_at' | 'updated_at'>
): Promise<Asset> {
  const { data, error } = await db().from('assets').insert(asset as any).select().single()
  if (error) throw error
  return data as Asset
}

export async function updateAsset(
  id: string,
  updates: Partial<Pick<Asset, 'status' | 'storage_path' | 'public_url' | 'actual_cost' | 'metadata'>>
): Promise<Asset> {
  const { data, error } = await db()
    .from('assets')
    .update({ ...updates, updated_at: new Date().toISOString() } as any)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data as Asset
}

export async function updateAssetStatus(id: string, status: AssetStatus): Promise<void> {
  const { error } = await db()
    .from('assets')
    .update({ status, updated_at: new Date().toISOString() } as any)
    .eq('id', id)
  if (error) throw error
}

// --- Conversations ---

export async function getConversation(projectId: string): Promise<{ messages: unknown[] } | null> {
  const { data, error } = await db()
    .from('conversations')
    .select('messages')
    .eq('project_id', projectId)
    .single()
  if (error) return null
  return data as { messages: unknown[] }
}

export async function upsertConversation(projectId: string, messages: unknown[]): Promise<void> {
  const { error } = await db().from('conversations').upsert(
    { project_id: projectId, messages, updated_at: new Date().toISOString() } as any,
    { onConflict: 'project_id' }
  )
  if (error) throw error
}

// --- Cost Events ---

export async function createCostEvent(
  event: Omit<CostEvent, 'id' | 'created_at'>
): Promise<CostEvent> {
  const { data, error } = await db().from('cost_events').insert(event as any).select().single()
  if (error) throw error
  return data as CostEvent
}

export async function getCostEvents(projectId: string): Promise<CostEvent[]> {
  const { data, error } = await db()
    .from('cost_events')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as CostEvent[]
}

export async function getCostSummary(
  projectId: string
): Promise<{ total: number; byProvider: Record<string, number> }> {
  const events = await getCostEvents(projectId)
  const total = events.reduce((sum, e) => sum + e.cost_usd, 0)
  const byProvider: Record<string, number> = {}
  for (const e of events) {
    byProvider[e.provider] = (byProvider[e.provider] ?? 0) + e.cost_usd
  }
  return { total, byProvider }
}

// --- Prompt Ratings (Model Lab) ---

export async function createPromptRating(rating: PromptRatingInput): Promise<PromptRating> {
  const { data, error } = await db()
    .from('prompt_ratings')
    .insert(rating as any)
    .select()
    .single()
  if (error) throw error
  return data as PromptRating
}

export async function getPromptRatings(
  filter: { model?: string; capability?: string } = {}
): Promise<PromptRating[]> {
  let query = db().from('prompt_ratings').select('*').order('created_at', { ascending: false })
  if (filter.model) query = query.eq('model', filter.model)
  if (filter.capability) query = query.eq('capability', filter.capability)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as PromptRating[]
}
