# LTX-2.5 on Beam (RTX 5090)

Text/image → video **with native joint audio**, on Beam's largest serverless GPU.

This exists because MiniMax H3 (`runpod/comfyui/`) does not fit in 32 GB. H3 stays
on RunPod's 96 GB Blackwell pool; this is the model that fits where Beam's free
credits actually apply.

## Why this model

Beam's promotional credits are **serverless-only** — they cannot pay for a GPU
pool or a managed compute reservation, which rules out the RTX PRO 6000 96 GB
($2.15/hr) on the marketplace. Serverless tops out at RTX 5090 / 32 GB.

| | MiniMax H3 | LTX-2.5 |
|---|---|---|
| Transformer | 21.0 GB | 21.5 GB |
| Text encoder | 15.7 GB (qwen3vl-32b nvfp4) | 15.4 GB (gemma4-12b int8) |
| **Video VAE** | **5.2 GB** | **1.47 GB** |
| Audio VAE | 0.6 GB | 0.36 GB |
| Fits 32 GB? | no | yes, tightly |

The transformers are nearly the same size. The VAE is what decides it — it stays
resident for the whole sampling loop, and H3's is 3.5× larger.

## Budget

39.70 GB of weights. Peak VRAM, given ComfyUI evicts the text encoder before
loading the transformer:

- text-encode phase: **15.4 GB**
- sampling phase: 21.5 + 1.47 + 0.36 + 1.00 ≈ **24.3 GB** + latents

That leaves roughly **7.7 GB** for latents and activations on a 32 GB card, and
the official template runs a *second* upscaler pass on top of the base sample.
Start small.

## Run it

Everything below runs **from inside this directory**, not the repo root. That is
not a style preference, it is load-bearing for two reasons:

- Beam syncs the working directory into the container. From the repo root that
  means `node_modules` and the whole Next.js app.
- This directory is named `beam/`, which shadows the `beam` SDK package when the
  repo root is on `sys.path`. From the root, `import beam` resolves to this
  folder as a namespace package and `from beam import Image` fails. Running from
  here puts `beam/ltx25` on `sys.path` instead, and the SDK resolves normally.

```bash
beam configure default --token YOUR_BEAM_TOKEN
```

```bash
beam secret create HF_TOKEN hf_xxxxxxxxxxxx
```

```bash
cd beam/ltx25 && uv run --with beam-client python download_models.py
```

```bash
cd beam/ltx25 && uv run --with beam-client python app.py
```

`uv tool install beam-client` gives you the `beam` CLI but installs it into an
isolated tool environment, so it is not importable by a plain `python`. Either
`uv run --with beam-client` as above, or `pip install beam-client` into whatever
interpreter you use.

The download runs on a **CPU-only** container on purpose — no reason to hold a
GPU for ~40 GB of transfer. Volume storage is free under 1 TB, so the weights
cost nothing parked between sessions. `app.py` prints the ComfyUI URL.

In the UI: **Workflow → Browse Templates → Video → "LTX-2.5: Text to Video"**.

## Before you hit Run

- **Turn the prompt-enhancer boolean off.** The template wires a
  `TextGenerateLTX2Prompt` node fed by a 10.28 GB `gemma4_e2b` model. We do not
  download it, and CreateGent writes its own prompts upstream anyway.
- **Start at ~768×448, ~3s.** Then climb until it OOMs, so you learn where the
  ceiling is rather than guessing.

## Verified on first deploy (2026-08-11)

Confirmed live against the running pod, not assumed:

- `NVIDIA GeForce RTX 5090`, **33.7 GB** VRAM total / 33.1 GB free
- `torch 2.11.0+cu128` with `nvidia-*-cu12-12.8.x` — the sm_120 requirement holds
- ComfyUI `0.32.0`, templates `0.11.39`, 66 GB system RAM
- All five weights visible to their loaders, so the build-time symlinks resolve
  against the mounted volume correctly
- `LTXVDualCFGGuider`, `LTXVConcatAVLatent`, `LTXVLatentUpsampler`,
  `LTXVAudioVAEDecode` all present
- **`TextGenerateLTX2Prompt` is present too.** An earlier note here claimed it
  was missing from master — that was wrong, it just was not in the files that
  were grepped. Disabling the enhancer is still the right call (it is 10.28 GB
  of model we did not download), but it is a choice, not a workaround.

## Measured on the first real generation (i2v, 5s)

**It fits — with 1.9 GB to spare.**

| | |
|---|---|
| Peak VRAM | **31.8 GB / 33.7** (94%) |
| Steps | 8 (the distilled transformer, not 20) |
| Wall clock | **19m 17s** |
| Transformer staged | 20484 MB |
| Text encoder staged | 14612 MB |

Two things the estimate got wrong:

- **The ~24.3 GB projection was low by 7.5 GB.** It counted resident weights
  only. ComfyUI *stages* a model and streams it in ("dynamic VRAM loading"),
  and that plus activations and latents is what actually fills the card.
- **System RAM is tighter than VRAM.** At peak there were 7.2 GB of VRAM free
  but only **3.4 GB of RAM** free out of 66.6. `memory="48Gi"` was sized for the
  wrong resource. ComfyUI logs `Using RAM pressure cache` and copes, but that is
  the number to watch, not VRAM.

Most of the 19 minutes is reading weights off the distributed volume, not
compute — CPU sits near 1% while a node appears frozen. That is I/O wait, not a
hang. `DurableDisk` (local SSD/NVMe, `disks=` on `Pod`) is the real fix.

## Known gotchas

1. **Never point `--output-directory` at a volume.** See the long comment in
   `app.py`. Produces silently unplayable MP4s with no moov atom.
2. **ComfyUI wants torch cu130+.** It logs `You need pytorch with cu130 or
   higher to use optimized CUDA operations`, and we install cu128. The
   quantized convrot kernels this model depends on are likely falling back to a
   slow path. cu130 wheels exist for torch 2.11–2.13, but CUDA 13.0 needs a host
   driver of 580+, and there is no guarantee Beam's 5090 hosts have one — it is
   a revert-if-it-breaks experiment, not a safe bump.
3. **`Lightricks/LTX-2.5` is a gated repo.** The license must be accepted with
   the same HF account the token belongs to, or `download_models.py` 401s.
4. **Refresh ComfyUI after downloading a model.** The missing-model check reads
   a cached folder listing; a fresh file is invisible until you refresh node
   definitions (R), and the run fails validation with `Value not in list`.

## If it OOMs

In rough order of cost to quality:

1. Lower resolution / duration first.
2. Add `--reserve-vram 1.0` to the entrypoint in `app.py`.
3. Swap the transformer for `models.NVFP4_SWAP` — the nvfp4 build is 18.72 GB,
   2.8 GB less, and the 5090 is Blackwell so sm_120 is satisfied. Caveat: that
   file lacks the `comfy-` prefix the int8 builds carry, so it may target
   Lightricks' own runtime rather than ComfyUI. Worth trying, not worth
   starting with.
4. Drop the upscaler pass and keep only the base sample.

## Cost discipline

A Pod does **not** scale to zero — default keep-warm is 600s and Beam bills every
second the container runs. Stop it from the dashboard when you step away.

Phase 2, once a configuration is known to fit: export the API-format workflow and
put it behind a Beam `endpoint`, which does scale to zero.
