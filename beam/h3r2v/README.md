# MiniMax H3 reference-to-video on Beam (RTX 5090)

Reference images of a subject → video with that subject's identity held across
the shot, with native joint audio. This is the capability LTX-2.5 does not have
at any size, and it is why this directory exists.

**Status: weights downloaded, not yet generated.** The VRAM section below is
arithmetic, not measurement.

This directory is now only the weight manifest and its downloader. The Pod that
used to live here was replaced by `beam/lab/`, which mounts the same volume,
maps every model folder instead of five, and carries ComfyUI Manager — so it
serves this template and any other one. Nothing about the numbers below changed.

## Why this contradicts `beam/ltx25/README.md`

That file says H3 does not fit in 32 GB. Its reasoning was:

> The transformers are nearly the same size. The VAE is what decides it — it
> stays resident for the whole sampling loop, and H3's is 3.5× larger.

The premise is wrong. ComfyUI's `VAELoader` constructs the object at graph load,
but the weights move to GPU at decode, after sampling has finished and the
transformer can be evicted. Sampling and decoding do not overlap, so the ceiling
is the larger phase, not their sum.

Redone phase by phase against the LTX-2.5 run that measured **31.8 GB of 33.7**
and fit:

| phase | LTX-2.5 (measured to fit) | H3 ref2v |
|---|---|---|
| text encode | 15.37 GB | 15.69 GB |
| **sampling** | 21.50 + 1.47 + 0.36 + 1.00 = **24.33** | 20.97 + 1.96 LoRA = **22.93** |
| decode | 1.83 GB | 5.82 GB |

H3's transformer is *smaller* than LTX-2.5's, and its sampling phase is lighter
even counting the turbo LoRA. Its decode phase is 4 GB heavier, but decode
happens with the transformer gone and is where `VAEDecodeTiled` exists if it
bites.

The "42.5 GB, RunPod-only" figure quoted in the ltx25 README is **disk**, not
peak VRAM, and it is these same pruned files.

Two things that could still sink it, and neither is settled by arithmetic:

1. ComfyUI *stages* a model and streams it in. On the LTX run that pushed a
   24.33 GB projection to a 31.8 GB reality — a 7.5 GB gap. The same overhead on
   22.93 GB lands near 30 GB, which fits, but the overhead is not guaranteed to
   scale linearly.
2. Whether ComfyUI actually frees the transformer before the VAE loads, or keeps
   both because it thinks there is room. If it keeps both: 22.93 + 5.82 = 28.75
   resident before staging overhead, and that is the scenario that OOMs.

## Weights

All from `Comfy-Org/MiniMax-H3`, which is **public** — no gated-repo license to
accept, unlike `Lightricks/LTX-2.5`. Every file is one the official
`video_minimax_h3_r2v` template names.

| file | GB |
|---|---|
| `diffusion_models/minimax_h3_ref2va_pruned_int8_convrot` | 20.97 |
| `text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq` | 15.69 |
| `vae/minimax_h3_video_vae_fp16` | 5.21 |
| `vae/minimax_h3_audio_vae_fp32` | 0.61 |
| `loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16` | 1.96 |
| | **44.44** |

They go on `ltx25-models`, the volume LTX-2.5 already uses. The name is a
misnomer now, and that is deliberate: `beam/comfy/app.py` (the credit-eligible
task_queue CreateGent actually calls) already mounts it and already symlinks all
four subdirectories H3 needs, so a second model family appears there with no
changes downstream. Renaming would cost a 40 GB re-upload.

Volume storage is free under 1 TB. ~84 GB across both families costs nothing
parked, and a cold container only reads what its graph references — the second
model does not slow the first one down.

## Zero custom nodes

Every node in the template is core ComfyUI on master:
`MiniMaxH3ReferenceToVideo` (`comfy_extras/nodes_minimax_h3.py`),
`ComfySwitchNode` (`nodes_logic.py`), `ResolutionSelector`
(`nodes_resolution.py`), `ComfyMathExpression` (`nodes_math.py`), plus stock
`UNETLoader` / `CLIPLoader` / `VAELoader` / `LoraLoaderModelOnly` /
`SamplerCustomAdvanced`.

That is the main reason this template was picked over the civitai filmmaking
workflows. Each custom node in one of those is a build-time clone, a version to
pin, and a thing that can break a deploy months later. The image here is the
ltx25 image with different symlink targets, nothing more.

## Run it

From **inside this directory** — Beam syncs the working directory, and from the
repo root that means `node_modules`; also, this tree is named `beam/`, which
shadows the `beam` SDK package when the repo root is on `sys.path`.

```bash
cd beam/h3r2v && uv run --with beam-client python download_models.py
```

```bash
cd beam/lab && uv run --with beam-client python app.py
```

On Windows, prefix both commands with `PYTHONIOENCODING=utf-8 PYTHONUTF8=1`.
Without it the Beam SDK crashes on its own progress output — it prints a `✓`
through `rich`, the console is cp1252, and you get a `UnicodeEncodeError`
traceback that looks like a deploy failure and is not. This applies to
`beam/ltx25/` too.

The download runs on a CPU-only container on purpose — no reason to hold a 5090
for 44 GB of transfer. `app.py` prints the ComfyUI URL.

In the UI: **Workflow → Browse Templates → Video → "MiniMax H3: Reference to
Video"**.

## Before you hit Run

- **Turn the turbo LoRA ON.** The template ships with it wired but switched off
  (both `ComfySwitchNode` false, steps 20; the LoRA path uses 4). At $0.68/hr,
  20 → 4 steps is the single biggest lever on cost. The base 20-step path is
  still there if quality does not hold up.
- **Do not touch the resolution on the first run.** It defaults to ~0.4 MP 16:9
  and 124 frames at 24 fps (~5s), which is the configuration the VRAM question
  is being asked about. Changing it first means learning nothing.
- **Never use the in-UI Download button.** It pulls weights on the GPU pod, at
  RTX 5090 rates, for a transfer a CPU container does for cents.
- **Refresh node definitions (R) after the download.** ComfyUI's missing-model
  check reads a cached folder listing; a freshly written file is invisible until
  then, and the run fails validation with `Value not in list`.

## What to record

The numbers that make this directory worth keeping:

- peak VRAM and peak free system RAM (the LTX run was RAM-bound, not VRAM-bound:
  7.2 GB VRAM free but only 3.4 GB of 66.6 RAM)
- staged sizes for the transformer and text encoder
- wall clock, split between cold-start I/O and actual sampling — most of LTX's
  19 minutes was reading the volume at ~1% CPU, which looks like a hang and is
  not

## If it OOMs

In rough order of cost to quality:

1. Lower resolution / frame count.
2. `--reserve-vram 1.0` on the entrypoint in `app.py`.
3. Swap `VAEDecode` for `VAEDecodeTiled` — decode is where H3 is 4 GB heavier
   than LTX, and tiling attacks exactly that.
4. Swap the transformer for a GGUF quant: `Abiray/MiniMax-H3-GGUF` has
   `Ref2VA-Q4_K_M` at 19.85 GB (−1.12) and `Ref2VA-Q4_0` at 18.64 (−2.33). This
   is not free — `UNETLoader` becomes `UnetLoaderGGUF`, which is **not** core and
   needs `city96/ComfyUI-GGUF` cloned into `custom_nodes` at build time. It is
   the first thing here that adds a build dependency, so it goes last.

## Known gotchas (inherited, all confirmed on the LTX pod)

1. **Never point `--output-directory` at a volume.** Silently unplayable MP4s,
   no moov atom. See the comment in `app.py`.
2. **ComfyUI wants torch cu130+** for its optimized CUDA ops and we install
   cu128. The int8-convrot kernels this model depends on are likely on a slow
   path. CUDA 13.0 needs a 580+ host driver and Beam's 5090 hosts are not known
   to have one — a revert-if-it-breaks experiment, not a safe bump.
3. **A Pod does not scale to zero** and the promotional credit does **not** pay
   for it (both grants are "Serverless only"). $0.68/hr, billed per second, until
   you stop it from the dashboard.

## Phase 2

Once a configuration is known to fit: export the API-format workflow, add a graph
builder beside `src/lib/comfy/ltx-2-5-i2v.ts`, and register a model id that
routes to `src/providers/beam.ts`. The `beam/comfy` task_queue needs no changes —
it already mounts this volume and speaks the workflow-JSON contract in
`comfy_worker/contract.py`.
