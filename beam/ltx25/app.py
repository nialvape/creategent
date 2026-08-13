"""ComfyUI serving LTX-2.5 (22B, distilled) on a Beam RTX 5090.

Why LTX-2.5 and not MiniMax H3 (runpod/comfyui):
    H3 does not fit. Its weights are 42.5 GB, and its video VAE alone is 5.2 GB
    resident through the whole sampling loop. Beam's largest serverless GPU is
    the RTX 5090 at 32 GB. LTX-2.5 is the same generation and also generates
    native joint audio+video, but its VAE is 1.47 GB, which is what makes the
    difference. H3 stays on RunPod where the 96 GB Blackwell pool exists.

Why a Pod and not an endpoint:
    Phase 1 is "does this run at all on 32 GB". A Pod gives the real ComfyUI web
    UI, where the official `video_ltx2_5_t2v` template can be loaded from the
    built-in template browser and the VRAM behaviour watched directly. Once a
    configuration is known to fit, export the API-format workflow and move it
    behind a Beam endpoint for CreateGent to call.

Run it:
    python beam/ltx25/download_models.py     # once — populates the volume
    python beam/ltx25/app.py                 # prints the ComfyUI URL

Cost note: a Pod's default keep-warm is 600s and Beam bills for every second a
container runs. This does NOT scale to zero between prompts the way an endpoint
does. Stop it from the dashboard (or `beam container stop`) when you walk away,
or it will quietly eat the $30.
"""

from beam import Image, Pod, Volume

VOLUME_NAME = "ltx25-models"
MOUNT_PATH = "/models"
OUTPUT_VOLUME = "ltx25-outputs"
OUTPUT_PATH = "/outputs"
COMFY_DIR = "/comfy"

# A cold start costs ~19 minutes, almost all of it reading ~35 GB of weights off
# the distributed volume. That inverts the usual keep-warm logic: at $0.68/hr for
# a 5090, idling 10 extra minutes costs $0.11 while letting the pod die and
# reload costs $0.21 of GPU time doing nothing but I/O. A short timeout is the
# expensive option here, not the frugal one.
#
# 30 minutes is sized for a working session. Raise it while iterating, and stop
# the container outright when you walk away — that is what actually saves money,
# not a tight timeout.
KEEP_WARM_SECONDS = 1800

# Mirrored into ComfyUI's models/ as symlinks at build time. Symlinks resolve
# lazily, so it does not matter that the volume is not mounted during the build.
MODEL_DIRS = ["diffusion_models", "text_encoders", "vae", "latent_upscale_models", "loras"]

image = (
    Image(python_version="python3.12")
    .add_commands(
        [
            # ffmpeg is not optional here — CreateVideo/SaveVideo shell out to it,
            # and this workflow's whole point is muxed audio+video output.
            "apt-get update && apt-get install -y --no-install-recommends git ffmpeg"
            " && rm -rf /var/lib/apt/lists/*",
            # ComfyUI master, not a release tag. LTX-2.5 landed 2026-08-11 and the
            # nodes it needs (LTXVConcatAVLatent, LTXVDualCFGGuider,
            # LTXVLatentUpsampler, LTXVAudioVAEDecode) only exist on master. Same
            # reasoning as runpod/comfyui/Dockerfile.
            f"git clone --depth=1 https://github.com/comfyanonymous/ComfyUI {COMFY_DIR}",
            f"pip install --no-cache-dir -r {COMFY_DIR}/requirements.txt",
            # Torch LAST, and forced. ComfyUI's requirements.txt leaves torch
            # unpinned, so whatever it resolves to may be a CUDA 12.6 build — and
            # the 5090 is Blackwell (sm_120), which needs 12.8+. Installing after
            # requirements.txt makes the wheel choice deterministic instead of
            # depending on pip's resolution order.
            #
            # Unlike the RunPod worker there is no risk of the 12.8 runtime failing
            # on an older-driver host: a 5090 cannot function on a pre-570 driver
            # at all, so any host that has one is new enough by construction.
            "pip install --no-cache-dir --force-reinstall torch torchvision torchaudio"
            " --index-url https://download.pytorch.org/whl/cu128",
            f"mkdir -p {COMFY_DIR}/models",
            # The startup script lives in the image rather than in the Pod's
            # entrypoint array. An earlier version inlined this loop into
            # entrypoint and the container died on boot: the SDK puts that string
            # through shell-word processing, which mangles the `\;` and `{}` that
            # find requires. Single-quoted printf args here are immune, and the
            # entrypoint becomes a bare filename with nothing left to quote.
            "printf '%s\\n'"
            " '#!/bin/sh'"
            f" 'mkdir -p {OUTPUT_PATH}'"
            # Copy only files untouched for a minute, so a half-muxed MP4 is
            # never captured — cp -n would then pin the broken copy forever.
            f" '(while true; do find {COMFY_DIR}/output -type f -mmin +1"
            f" -exec cp -n {{}} {OUTPUT_PATH}/ \\; 2>/dev/null; sleep 30; done) &'"
            f" 'cd {COMFY_DIR}'"
            " 'exec python main.py --listen 0.0.0.0 --port 8000'"
            " > /usr/local/bin/start-comfy.sh",
            "chmod +x /usr/local/bin/start-comfy.sh",
            # Beam's Image has no add_local_file, so the RunPod worker's
            # extra_model_paths.yaml trick is not available. Symlinks do the job.
            f"for d in {' '.join(MODEL_DIRS)}; do"
            f" rm -rf {COMFY_DIR}/models/$d; ln -s {MOUNT_PATH}/$d {COMFY_DIR}/models/$d; done",
        ]
    )
)

comfyui = Pod(
    name="ltx25-comfyui",
    image=image,
    ports=[8000],
    cpu=12,
    # Generous on purpose. ComfyUI survives a 32 GB card here by evicting models
    # to system RAM between phases — the 15.4 GB text encoder gets pushed out to
    # make room for the 21.5 GB transformer. Too little RAM turns that into disk
    # thrash. Lower it if the scheduler cannot place the container.
    memory="48Gi",
    gpu="RTX5090",
    # Weights only. Do NOT point ComfyUI's output directory at a volume.
    #
    # The first version of this file mounted a second volume and passed
    # --output-directory to it. Every generated MP4 came out unplayable: the
    # box tree was ftyp / free(8) / mdat / garbage, with no moov atom at all.
    #
    # That is the signature of an interrupted +faststart. The muxer writes the
    # file, then seeks back to relocate moov to the front and leaves a free box
    # as filler. A distributed volume does not give the seek-and-rewrite-in-place
    # semantics that needs, so mdat survived and moov was lost — silently, with
    # nothing in the ComfyUI log. The giveaway was that the volume read 0 bytes
    # while the container could still serve the file over /view.
    #
    # Reading weights from a volume is fine; that is sequential. It is
    # finalizing a container format that breaks.
    volumes=[
        Volume(name=VOLUME_NAME, mount_path=MOUNT_PATH),
        # Mounted, but NOT as ComfyUI's output directory — see above. Finished
        # files are copied here by the sync loop in the entrypoint.
        Volume(name=OUTPUT_VOLUME, mount_path=OUTPUT_PATH),
    ],
    keep_warm_seconds=KEEP_WARM_SECONDS,
    # ComfyUI writes to its default /comfy/output, which is container-local disk,
    # so the muxer gets the seek-and-rewrite it needs. A background loop then
    # copies *settled* files to the output volume, which survives the pod.
    #
    # -mmin +1 is the "settled" test: only files untouched for a minute get
    # copied, so a half-muxed MP4 is never captured. That matters because cp -n
    # will not overwrite, so copying a file mid-write would pin the broken
    # version on the volume permanently.
    entrypoint=["sh", "/usr/local/bin/start-comfy.sh"],
)


if __name__ == "__main__":
    res = comfyui.create()
    print("ComfyUI hosted at:", res.url)
    print()
    print("In the UI: Workflow > Browse Templates > Video > 'LTX-2.5: ...'.")
    print("  - t2v, i2v and flf2v all run on the weights already downloaded;")
    print("    the i2v template also has a 'Switch to Text to Video?' node.")
    print("  - 'Boolean (Enable Prompt Enhance)' is your call. It does not")
    print("    affect the VRAM ceiling (10.28 GB, under the 15.37 GB encoder")
    print("    that loads anyway) — it costs a load and an LLM pass per run.")
    print("  - measured peak on a 5s i2v: 31.8 GB of 33.7. It fits, barely.")
    print("  - outputs are container-local and ephemeral. Download anything")
    print("    worth keeping before the pod spins down.")
