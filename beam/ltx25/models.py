"""Weight manifest for the LTX-2.5 ComfyUI worker.

Taken from the official ComfyUI template `video_ltx2_5_t2v` (Comfy-Org/
workflow_templates), not guessed: every entry below is a model the template's
loader nodes actually reference.

Sizes are the real blob sizes from the HF API, and they matter — the whole
question is whether this fits an RTX 5090's 32 GB.

Note the transformer is the `comfy-int8-convrot` build, which is what the
template ships with. Lightricks also publishes an `nvfp4` build of the same
distilled transformer at 18.72 GB (2.8 GB less). nvfp4 needs Blackwell, which
the 5090 is — but that file lacks the `comfy-` prefix the int8 builds carry,
so it may target Lightricks' own runtime rather than ComfyUI. Try it as an
optimization only after the int8 path is confirmed working; see NVFP4_SWAP.
"""

REPO = "Lightricks/LTX-2.5"

# (hf repo, subdir under the volume root, filename in the repo, GB)
MODELS = [
    (REPO, "diffusion_models", "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", 21.50),
    (REPO, "text_encoders", "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", 15.37),
    (REPO, "vae", "ltx-2.5-video-vae-bf16.safetensors", 1.47),
    (REPO, "vae", "ltx-2.5-audio-vae-bf16.safetensors", 0.36),
    (REPO, "latent_upscale_models", "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors", 1.00),
]

# The `TextGenerateLTX2Prompt` node in every LTX-2.5 template is an on-GPU prompt
# rewriter fed by this model.
#
# It is required on disk whether or not you use it. ComfyUI's missing-model check
# is a *static* scan of every loader in the graph, so it blocks execution over
# this file even when `Boolean (Enable Prompt Enhance)` is False and the branch
# never runs.
#
# Whether to actually enable it is a free choice, and NOT a VRAM question:
# ComfyUI loads models sequentially, so the ceiling is the sampling phase
# (~24.3 GB), and this model at 10.28 GB is smaller than the 15.37 GB text
# encoder that loads regardless. Enabling it costs time — one extra 10 GB load
# from the volume plus LLM generation per run — not headroom.
#
# For CreateGent it should stay off: the agent writes prompts deliberately
# upstream (see the media-prompt-engineering skill and src/agent/prompts/), and
# a model silently rewriting them defeats that. For hand experimentation it is
# genuinely useful — LTX responds to long structured prompts (shot lists,
# per-second timelines, explicit audio direction) and the enhancer produces that
# shape for you.
#
# Do not use ComfyUI's in-UI "Download" button for it: that pulls the file on
# the GPU pod, paying RTX 5090 rates for a transfer a CPU container does for
# cents.
PROMPT_ENHANCER = (
    "Comfy-Org/gemma-4",
    "text_encoders",
    "gemma4_e2b_it_bf16.safetensors",
    10.28,
)

# Swap to shave 2.8 GB of VRAM once the int8 path works. See module docstring.
NVFP4_SWAP = ("diffusion_models", "ltx-2.5-22b-distilled-transformer-nvfp4.safetensors", 18.72)

TOTAL_GB = sum(gb for _, _, _, gb in MODELS)
