import type { Asset, AssetType } from '@/types/asset'
import type { PlanAsset } from '@/types/plan'

/**
 * Plan assets reference each other by their plan-asset id (e.g. "asset-002") in
 * the `dependencies` array. Generated `Asset`s, however, get fresh UUIDs — so we
 * stamp the originating plan-asset id into `metadata.planAssetId` and resolve
 * dependencies through that, never through the runtime UUID.
 */
export function planAssetIdOf(asset: Asset): string | undefined {
  const id = (asset.metadata as Record<string, unknown>)?.planAssetId
  return typeof id === 'string' ? id : undefined
}

/** All COMPLETED generated assets a plan asset depends on. */
export function resolveDependencyAssets(
  planAsset: PlanAsset,
  accumulated: Asset[]
): Asset[] {
  const deps = planAsset.dependencies ?? []
  if (deps.length === 0) return []
  return accumulated.filter(
    (a) => a.status === 'completed' && deps.includes(planAssetIdOf(a) ?? '')
  )
}

/** First completed dependency of a given type (e.g. the first-frame image). */
export function firstDependencyOfType(
  planAsset: PlanAsset,
  accumulated: Asset[],
  type: AssetType
): Asset | undefined {
  return resolveDependencyAssets(planAsset, accumulated).find((a) => a.type === type)
}

/** Most recent COMPLETED asset of a type that actually has a playable URL. */
function lastUsableOfType(accumulated: Asset[], type: AssetType): Asset | undefined {
  return accumulated
    .filter((a) => a.type === type && a.status === 'completed' && !!a.public_url)
    .pop()
}

/**
 * Resolve a media input (first-frame image / voice audio) for a video or avatar.
 * Prefer the DECLARED dependency; if that doesn't resolve to a usable URL (planner
 * mis-wiring or a runtime ordering edge case), fall back to the most recent
 * completed asset of that type so an otherwise-ready asset isn't hard-failed.
 * Logs a diagnostic snapshot whenever the declared dependency fails to resolve.
 */
function resolveMediaInput(planAsset: PlanAsset, accumulated: Asset[], type: AssetType): string | null {
  const declared = firstDependencyOfType(planAsset, accumulated, type)
  if (declared?.public_url) return declared.public_url

  const fallback = lastUsableOfType(accumulated, type)
  // Diagnostic: declared dependency didn't resolve. Surface what WAS available so
  // the mismatch (deps vs produced planAssetIds/status) is debuggable from logs.
  console.warn(
    `[deps] ${planAsset.type} "${planAsset.name}" (${planAsset.id}): declared ${type} dependency [${(planAsset.dependencies ?? []).join(', ')}] did not resolve. ` +
      `Available: ${JSON.stringify(accumulated.map((a) => ({ planAssetId: planAssetIdOf(a), type: a.type, status: a.status, hasUrl: !!a.public_url })))}. ` +
      (fallback ? `Falling back to completed ${type} "${fallback.name}".` : `No completed ${type} to fall back to.`)
  )
  return fallback?.public_url ?? null
}

/** Playable URL of the first-frame image this asset depends on, if any. */
export function sourceImageUrl(planAsset: PlanAsset, accumulated: Asset[]): string | null {
  return resolveMediaInput(planAsset, accumulated, 'image')
}

/** Playable URL of the voice audio this asset depends on, if any. */
export function sourceAudioUrl(planAsset: PlanAsset, accumulated: Asset[]): string | null {
  return resolveMediaInput(planAsset, accumulated, 'audio')
}

/**
 * The script/guion text shared across the project. Language-agnostic: prefer text
 * assets whose name looks like a script ("script"/"guion"/"guión"); otherwise use
 * the FIRST completed text asset (the guion is always asset #1) so captions don't
 * get mistaken for the script.
 */
export function scriptText(accumulated: Asset[]): string {
  const texts = accumulated.filter((a) => a.type === 'text' && a.status === 'completed')
  const isScriptName = (n: string) => /script|gui[oó]n/i.test(n)
  const named = texts.filter((a) => isScriptName(a.name ?? ''))
  const source = named.length > 0 ? named : texts.slice(0, 1)
  return source.map((a) => (a.metadata as Record<string, string>)['content'] ?? '').join('\n\n')
}
