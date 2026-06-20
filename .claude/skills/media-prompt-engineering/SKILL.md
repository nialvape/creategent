---
name: media-prompt-engineering
description: Best practices for writing and editing the system/instruction prompts that drive AI media generation in CreateGent — text-to-image (Flux), image-to-video (Kling), talking-head/avatar lip-sync, TTS voiceover, and the orchestration planner that routes between them. Use when editing files under src/agent/prompts/ or src/agent/nodes/, when an agent is producing the wrong asset type, or when generated media doesn't match the user's intent.
---

# Media prompt engineering (CreateGent)

CreateGent turns a user idea into a dependency-ordered plan of assets, executed by specialist agents. The output quality depends almost entirely on the prompts in `src/agent/prompts/*` and the node prompts in `src/agent/nodes/*`. This skill captures how to write them well.

## 0. The model-capability map (read first — most bugs start here)

Each model class can only do one thing. Route to the right one. Source of truth: `src/lib/models.ts`.

| Asset type | Model class | Input → output | Can it make a person SPEAK? |
|-----------|-------------|----------------|------------------------------|
| `image`   | Flux (t2i)  | text → still frame | no |
| `video`   | Kling i2v   | image + motion text → **silent** clip | **NO** — only mouth-flapping that looks wrong |
| `avatar`  | Kling AI Avatar | portrait image + voice audio → **lip-synced** talking video | **YES** — this is the only one |
| `audio`   | ElevenLabs TTS | text → speech | (it *is* the voice) |
| `text`    | LLM (OpenRouter) | brief → copy/script | n/a |

**The #1 rule: speaking to camera ⇒ `avatar`; `video` is silent b-roll.** The most common failure is the planner emitting a `video` for someone telling a story, which forces the video agent to fake speech ("as if speaking") and yields a silent, wrong clip. Talking + movement (e.g. narrating at the gym): use an `avatar` for the spoken delivery **plus** `image`/`video` b-roll for the action — the avatar model lip-syncs a portrait, it does not animate a walking body.

## 1. Teach the formula, don't pile on prohibitions

When a model produces bad prompts, the fix is almost never another "NEVER do X" line. It's teaching the positive formula + a good example. State the goal, give the ordered recipe, show 1-2 concrete examples. Reserve hard "don't"s for the one or two things that genuinely break (e.g. clarifying that a video is silent).

## 2. Text-to-image (Flux) recipe — `prompts/visual.ts`

Flux weights **earliest words most** and has **no negative prompts** (describe what *should* be there).

Order: **SUBJECT** (focal person/object first, concrete visible detail) → **SETTING** (environment, props, time of day; use foreground/midground/background) → **CAMERA & LIGHT** (shot size, angle, lens like *85mm*, depth of field, lighting) → **STYLE** (a *concrete* reference — "1970s Kodachrome film still", "National Geographic wildlife" — beats "professional, high quality").

- Good (subject-first): `A red fox with rust-colored fur and alert amber eyes, photorealistic, dramatic side lighting, 85mm, shallow depth of field`
- Bad (tech-first, vague): `A photorealistic 8K image with dramatic lighting of a fox`
- **Avatar portraits** (first frame for an avatar): single subject, front-facing, face fills much of the frame, eyes open, even light, no occlusion (no hands/mics/sunglasses), simple background.

## 3. Image-to-video (Kling) recipe — `prompts/video.ts`

The model is *given* the first frame — it already sees the scene. "Describe the action and the camera, not the picture."

Order: **SUBJECT MOTION** (what moves, natural detail) → **CAMERA LANGUAGE** (precise terms: dolly-in/push-in, pull-out, tracking, orbit, pan, tilt, crane, handheld) → **PACING & END-STATE** (speed + how the shot resolves) → **LIGHT/atmosphere continuity** only.

- Replace vague effect names with the move that produces them: "POV/TikTok feel" → `handheld push-in with subtle shake`; "make it dynamic" → `fast whip-pan following the subject`. Never name an abstract effect.
- **Always give a motion end-state** ("...settling as she meets the camera") — open-ended motion causes drift, looping, or stalled generations.
- Example: `She turns from the window and breaks into a grin, slow push-in to a soft close-up, gentle handheld sway, warm light flickering, settling as she meets the camera`

## 4. Avatar (talking head) — `prompts/avatar.ts` + `nodes/avatar-agent.ts`

The Kling avatar model takes **only image + audio** (no text prompt today), so `AVATAR_AGENT_SYSTEM_PROMPT` is effectively documentation. Avatar quality is driven by **(a)** the portrait image prompt (§2 avatar portraits) and **(b)** the voiceover (§5). If a future avatar model accepts a style prompt, direct **role** (storyteller, presenter), **emotion** (warm, confident), **gesture** (subtle nods, eyebrow lifts), and **pace** (conversational).

**Both inputs must be fal-FETCHABLE public URLs.** fal's servers download `image_url`/`audio_url` by URL, so a base64 `data:` URL (the audio agent's fallback when Supabase Storage upload fails) or a private-bucket URL leaves the avatar with no voice. `FalAdapter.ensureFalFetchable` re-hosts any non-http URL on fal storage, but the real fix is a working public `assets` bucket (`SUPABASE_SERVICE_ROLE_KEY` + public bucket). A "selfie POV" idea still needs a CLEAN front-facing portrait (§2) — the lip-sync shows a talking head, never the arm/phone, so the phone must not occlude the face.

## 5. TTS voiceover — `prompts/audio.ts` + `nodes/audio-agent.ts`

Output **only the spoken words** — no scene/stage directions, names, labels, or quotes (those would be read aloud). Natural spoken rhythm, ~120-150 wpm. The director supplies the script slice + delivery direction; this agent just produces the exact words.

## 6. Orchestration / planner — `prompts/planner.ts` + `nodes/planner.ts`

- **Script-first**: the first asset is always the text Script; everything derives from it.
- **Dependency waves**: assets list the ids they depend on; keep chains shallow to preserve parallelism. Schema enforces: `video` needs an image dep; `avatar` needs an image + an audio dep.
- **Decide asset type deliberately** using §0. Make decisive routing rules with worked examples — descriptive guidance alone lets the model drift to `video` for talking-head content.

## 7. Language layering (two separate layers)

- **Working language = English.** The plan (title, summary, asset names/descriptions, style) and ALL generation prompts (image/video prompts, director briefs) are authored in English — the agents are English-only. Image/video prompts stay English regardless of audience.
- **Content language(s) = the audience's.** Only audience-facing output — the script's spoken dialogue, voiceover words, captions — is produced in `plan.contentLanguages` (`prompts/audio.ts`, `prompts/copy.ts`, director MODE B).
- **User language = for approval.** `plan.userLanguage` records the user's language; the English plan is translated into it by a cheap/free model (`src/agent/translate-plan.ts`) for the approval view only — the canonical English plan still drives generation.

## 8. Anti-patterns gallery (real failures from this project)

| Symptom | Why | Fix |
|---|---|---|
| Silent video of a man "filming himself", mouth moving | Talking-head idea typed as `video` not `avatar` | §0 decision rule in the planner |
| Prompt said "facial expression… as if speaking" | A `video` can't speak, so the agent faked it | Route to `avatar`; §3 clarifies video is silent |
| Prompt said "creating a POV effect" | Named an abstract effect instead of the camera move | §3 vague→precise: `handheld push-in with subtle shake` |
| Entire plan written in Spanish | "produce ALL text in the user's language" conflated the layers | §7 — English plan + `userLanguage`/`contentLanguages` |
| Generic, flat image | Tech-words first, vague subject | §2 subject-first, concrete detail, concrete style ref |
| Avatar generated but with NO voice | Audio `public_url` was a base64 `data:` URL (Storage upload failed); fal can't fetch it | §4 — `ensureFalFetchable` re-hosts on fal storage; fix the public bucket |
| Avatar portrait was a full-body selfie, phone over the face | Visual agent didn't know the image was an avatar first-frame | §2/§4 — `visual-agent` detects avatar-dependent images and forces a clean front-facing close-up |

## References
- fal.ai Flux prompt guide — https://fal.ai/learn/devs/flux-2-max-prompt-guide
- Atlas Kling image-to-video guide — https://www.atlascloud.ai/blog/guides/kling-ai-video-prompt-guide
- VEED Kling prompting guide — https://www.veed.io/learn/kling-ai-prompting-guide
- Eachlabs Kling Avatar guide — https://www.eachlabs.ai/blog/kling-avatar-ai-avatar-generation-guide
