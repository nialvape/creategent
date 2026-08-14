/**
 * The axes a Model Lab result can be scored on.
 *
 * Rating exists to build a corpus of prompts good enough to hand an LLM so it
 * can write better ones. That only works if a low score says *what* went wrong,
 * so the axes are deliberately narrow — "the motion melted" and "it ignored half
 * the prompt" are different lessons and must not collapse into one number.
 *
 * Every axis carries a `hint`. It's the tooltip in the form AND the glossary
 * shipped in the export, so the model reading the data knows what a 2 on
 * `camera_control` meant without being told separately.
 */

import type { RatedCapability } from '@/types/rating'

export interface RatingAxis {
  id: string
  label: string
  /** One line explaining what a high score means. Travels into the export. */
  hint: string
  capabilities: RatedCapability[]
  /** Shown pre-listed for these capabilities; the rest sit behind "add axis". */
  byDefault: RatedCapability[]
}

const ALL: RatedCapability[] = ['image', 'video', 'avatar']

export const RATING_AXES: RatingAxis[] = [
  {
    id: 'prompt_adherence',
    label: 'Prompt adherence',
    hint: 'Did it render what the prompt actually asked for, element by element?',
    capabilities: ALL,
    byDefault: ALL,
  },
  {
    id: 'visual_quality',
    label: 'Visual quality',
    hint: 'Sharpness and cleanliness — free of artifacts, noise, banding, compression mush.',
    capabilities: ALL,
    byDefault: ALL,
  },
  {
    id: 'aesthetics',
    label: 'Aesthetics & composition',
    hint: 'Framing, lighting, colour and overall appeal, independent of accuracy.',
    capabilities: ALL,
    byDefault: ALL,
  },
  {
    id: 'detail_fidelity',
    label: 'Detail & anatomy',
    hint: 'Hands, faces, text and geometry hold up under a close look.',
    capabilities: ALL,
    byDefault: ['image'],
  },
  {
    id: 'motion',
    label: 'Motion & temporal coherence',
    hint: 'Movement is smooth and physical — no flicker, morphing or drifting identity.',
    capabilities: ['video', 'avatar'],
    byDefault: ['video'],
  },
  {
    id: 'camera_control',
    label: 'Camera control',
    hint: 'Did it obey the camera move the prompt described, at the right speed?',
    capabilities: ['video'],
    byDefault: ['video'],
  },
  {
    id: 'source_fidelity',
    label: 'Source-frame fidelity',
    hint: 'Keeps the subject, style and identity of the attached image.',
    capabilities: ['video', 'avatar'],
    byDefault: ['video', 'avatar'],
  },
  {
    id: 'lip_sync',
    label: 'Lip sync',
    hint: 'Mouth shapes and timing match the audio track.',
    capabilities: ['avatar'],
    byDefault: ['avatar'],
  },
  {
    id: 'expressiveness',
    label: 'Expressiveness',
    hint: 'Natural gestures, gaze and head movement rather than a frozen face.',
    capabilities: ['avatar'],
    byDefault: ['avatar'],
  },
  {
    id: 'prompt_economy',
    label: 'Prompt economy',
    hint: 'How much of the prompt the model actually used — low means most of it was ignored.',
    capabilities: ALL,
    byDefault: [],
  },
  {
    id: 'predictability',
    label: 'Predictability',
    hint: 'The output matched what you expected, rather than being a lucky roll.',
    capabilities: ALL,
    byDefault: [],
  },
  {
    id: 'overall',
    label: 'Overall',
    hint: 'Would you ship this result as-is?',
    capabilities: ALL,
    byDefault: ALL,
  },
]

export const AXIS_BY_ID: Record<string, RatingAxis> = Object.fromEntries(
  RATING_AXES.map((a) => [a.id, a])
)

/** Axes that apply to a capability, in catalog order. */
export function axesFor(capability: RatedCapability): RatingAxis[] {
  return RATING_AXES.filter((a) => a.capabilities.includes(capability))
}

/** The subset shown expanded when the rating form opens. */
export function defaultAxesFor(capability: RatedCapability): RatingAxis[] {
  return RATING_AXES.filter((a) => a.byDefault.includes(capability))
}

export const MAX_STARS = 5
