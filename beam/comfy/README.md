# ComfyUI on Beam

The second backend for CreateGent's ComfyUI graphs. The first is
`runpod/comfyui/`; both import the same contract from `comfy_worker/` at the
repo root, so a job means the same thing on either and the app picks between
them by model id.

| | RunPod | Beam |
|---|---|---|
| Primitive | serverless endpoint | **task queue** (endpoints cap at 180s) |
| GPU | RTX 5090, $0.99/hr | RTX 5090, $0.68/hr |
| Promotional credit | — | applies (grants are "Serverless only"; a Pod is not) |
| Results | base64 in the job output, 10 MiB body limit | URLs via `Output.public_url()`, no limit |
| Cold start | volume-backed, minutes | ~19 min measured on the ltx25 Pod |

Same weights, same graph, same quality. Choosing is a cost and availability
decision.

## Deploy

Everything runs **from inside this directory** — Beam syncs the working
directory, and from the repo root that means `node_modules` and the whole
Next.js app. `app.py` copies `comfy_worker/` in from the repo root on every run
(the copy is gitignored) because the sync cannot reach outside this folder.

```bash
cd beam/comfy && uv run --with beam-client beam deploy app.py:handler
```

The weights are **not** downloaded here. This mounts `ltx25-models`, the volume
`beam/ltx25/download_models.py` already populated. Volume storage is free under
1 TB, so the ~40 GB parked there costs nothing between sessions.

Then put the URL it prints into `.env.local`:

```
BEAM_TOKEN=...
BEAM_COMFYUI_URL=https://<id>.app.beam.cloud
```

## Use it

Pick **LTX 2.5 distilled (Beam)** as the video model in Project → Settings, or
in the model lab. That is the whole switch: `beam/ltx-2.5-i2v` routes to
`src/providers/beam.ts`, `runpod/ltx-2.5-i2v` to `src/providers/runpod.ts`, and
the graph builder (`src/lib/comfy/ltx-2-5-i2v.ts`) is shared.

## The contract

```jsonc
// in
{ "workflow": { /* API-format graph */ },
  "files": [{ "name": "voice.wav", "data": "<base64>" }] }

// out
{ "files": [{ "node_id": "9", "key": "images", "filename": "out.mp4",
              "mime": "video/mp4", "encoding": "url", "size": 4194304,
              "data": "https://..." }],
  "values": [], "images": [ /* legacy mirror */ ], "errors": [] }
```

Any file type goes in — ComfyUI's upload endpoint writes raw bytes under the
filename it is given and never inspects them, so audio and video ride the same
channel. Every produced file comes back, not just images: see
`comfy_worker/contract.py` for why that needed saying.

Output URLs **expire after an hour**. The app downloads and re-uploads to its
own storage as soon as the job is collected; nothing should persist a Beam URL.

## Cost discipline

- `retries=0`. Beam's default is 3, and retrying a twenty-minute job that failed
  on a deterministic graph error spends the money three times.
- `keep_warm_seconds=300`. Long enough that a second generation in a working
  session skips the reload, short enough that an idle GPU is not billed for
  long. It does not make an isolated job cheap — the real fix for the cold start
  is `DurableDisk` (local NVMe) via `disks=`, not a longer idle timer.
- One container, one task at a time. Two concurrent LTX runs do not fit in
  32 GB, and queueing is cheaper than thrashing.

## Unverified

- **The cold start has not been re-measured here.** The 19 minutes comes from
  the ltx25 Pod, which read the same volume. Until a warm and a cold run are
  both timed, the price advantage over RunPod is arithmetic, not a result.
- `LTX_DEFAULTS.enhancePrompt` is `true` in the app, and that requires
  `gemma4_e2b_it_bf16.safetensors` on the volume — ComfyUI's missing-model check
  is a static scan, so it blocks the graph even when the branch never runs.
  `download_models.py` skips it unless `include_enhancer=True`. Either download
  it or send `enhancePrompt: false`.
- ~~Whether `GET /v2/task/{id}/` echoes the handler's return value.~~ **Answered
  2026-08-19: it does not.** A task that completed successfully came back with
  `result: null` and the return value nowhere in the response. Saving
  `result.json` as an output is not a belt-and-braces fallback, it is the only
  channel — `beam/lab/launch.py` failed silently for exactly this reason until
  it was changed to do the same.
