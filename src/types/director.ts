/**
 * The creative director runs inside the supervisor's wave loop. For each asset it
 * writes a detailed, tailored brief; after the agents produce their assets it
 * reviews them and may flag individual assets for a single per-asset correction.
 */

/** Delivery direction for a spoken asset (audio / avatar voice). */
export interface VoiceDirection {
  /** The slice of the script the director wants voiced for this asset. */
  scriptExcerpt: string
  /** How it should be delivered: expression, humor, pauses, emphasis, pacing. */
  direction: string
}

/** A per-asset creative brief produced by the director before agents run. */
export interface AssetBrief {
  planAssetId: string
  /** Detailed, tailored creative instruction for this specific asset. */
  instruction: string
  /** Audio / avatar only — what to speak and how. The writing model turns this
   *  into the exact spoken words; only those words reach TTS. */
  voice?: VoiceDirection
  /** Set when re-running a flagged asset: what was wrong and how to fix it. */
  correction?: string
}

/** The director's verdict on a single produced asset during a wave review. */
export interface AssetVerdict {
  planAssetId: string
  pass: boolean
  /** When `pass` is false, the actionable feedback the agent must address. */
  feedback?: string
}
