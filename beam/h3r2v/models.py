"""Weight manifest for the MiniMax H3 reference-to-video worker.

Taken from the official ComfyUI template `video_minimax_h3_r2v` (Comfy-Org/
workflow_templates), not guessed: every entry below is a file one of that
template's loader nodes actually names. Sizes are the real blob sizes from the
HF API.

Why this exists at all, given `beam/ltx25/README.md` says H3 does not fit
--------------------------------------------------------------------------
That verdict rested on one assumption, and the assumption is wrong. The README
compared "resident weights" and counted H3's 5.21 GB video VAE as live through
the whole sampling loop. ComfyUI does not work that way: `VAELoader` builds the
object, and the weights move to GPU at decode time, after sampling is done. The
two phases do not overlap, so the peak is the larger of them, not the sum.

Phase by phase on a 33.7 GB RTX 5090, against the LTX-2.5 run that measured
31.8 GB peak and fit:

    text encode   qwen3vl-32b nvfp4-awq        15.69 GB   (LTX: 15.37)
    sampling      ref2va pruned int8 + LoRA    22.93 GB   (LTX: 24.33)
    decode        video VAE + audio VAE         5.82 GB   (LTX:  1.83)

LTX's sampling figure is its transformer plus both VAEs plus the latent
upscaler, as its own README counts it; that configuration measured 31.8 GB of
33.7 in practice, a 7.5 GB gap over the projection from ComfyUI staging models
rather than loading them flat.

H3's transformer is *smaller* than LTX-2.5's 21.5 GB. Sampling is the ceiling in
both, and H3's is 1.4 GB *under* a configuration already proven to fit. That is
an argument for measuring, not for assuming — the README here has what to record
and what would still sink it.

The 42.5 GB number quoted in the ltx25 README is disk, not VRAM, and it is
these same pruned files.
"""

REPO = "Comfy-Org/MiniMax-H3"

# The repo is public — unlike `Lightricks/LTX-2.5`, no license needs accepting
# and HF_TOKEN is optional here. It is still passed, because the same Beam
# secret already exists for LTX and an authenticated pull gets better rate
# limits.

# (hf repo, subdir under the volume root, filename in the repo, GB)
MODELS = [
    # "pruned" is not a quality compromise bolted on by a third party — it is
    # Comfy-Org's own build, and it is the file the official r2v template
    # selects by default. The unpruned int8 is 34.04 GB and would not fit.
    (REPO, "diffusion_models", "minimax_h3_ref2va_pruned_int8_convrot.safetensors", 20.97),
    # nvfp4-awq, not the 27.14 GB int8 build. The 5090 is Blackwell so sm_120
    # satisfies nvfp4, and this is the variant the template names.
    (REPO, "text_encoders", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", 15.69),
    (REPO, "vae", "minimax_h3_video_vae_fp16.safetensors", 5.21),
    (REPO, "vae", "minimax_h3_audio_vae_fp32.safetensors", 0.61),
    # 4 steps instead of 20. The template ships with it wired but switched OFF
    # (`ComfySwitchNode` false, steps 20). Turn it on: at $0.68/hr a 5x cut in
    # sampling is the single biggest lever on cost, and the base model is still
    # there if the quality does not hold up.
    (REPO, "loras", "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", 1.96),
]

# If sampling OOMs, swap the transformer for a GGUF quant rather than dropping
# resolution to nothing. These are drop-in for the same graph EXCEPT that
# `UNETLoader` becomes `UnetLoaderGGUF`, which is NOT core — it needs
# city96/ComfyUI-GGUF cloned into custom_nodes at image build time. That is a
# real change to app.py, so treat it as the second thing to try, not the first.
GGUF_SWAP = [
    ("Abiray/MiniMax-H3-GGUF", "unet", "MiniMax-H3-Ref2VA-Q4_K_M.gguf", 19.85),  # -1.12 GB
    ("Abiray/MiniMax-H3-GGUF", "unet", "MiniMax-H3-Ref2VA-Q4_0.gguf", 18.64),    # -2.33 GB
]

# Same architecture, same size, different conditioning branch: first-and-last
# frame to video+audio. Downloading it costs 20.97 GB of free volume space and
# nothing else, but it is a different template (`video_minimax_h3_flf2v`) and a
# different graph builder, so it is out of scope until r2v is proven.
FL2VA_SWAP = (REPO, "diffusion_models", "minimax_h3_fl2va_pruned_int8_convrot.safetensors", 20.97)

TOTAL_GB = sum(gb for _, _, _, gb in MODELS)
