"""ComfyUI as a workbench: a Beam Pod with the real UI, the Manager, and
custom nodes that survive a restart.

This is where a workflow off civitai gets opened, run, and judged. It is NOT
where CreateGent calls anything — that is `beam/comfy/`, a task_queue whose
custom nodes are pinned in its image. The two are deliberately different
machines with different rules:

    here                              beam/comfy (the worker)
    ----------------------------      ---------------------------------
    install nodes from the UI         nodes are git clones in the image
    whatever version Manager picks    a pinned version you chose
    a Pod: has a URL, has a UI        a task_queue: takes jobs, no UI

Nothing installed here reaches the worker by itself. The path from one to the
other is `scripts/ingest_workflow.py`, which reads a saved workflow and prints
the exact build lines to add.

On what this costs (verified 2026-08-19, from the account's own usage log)
-------------------------------------------------------------------------
Nothing so far, and there is no mechanism for it to. The usage page for this
account lists only `function` entries, every one at $0.000 charged and fully
credited: $0.00 charged / $0.04 credited lifetime. Pod time does not appear in
it at all. Auto top-up is disabled and no credits have ever been purchased, so
the failure mode of running out is a workload that will not start, not a bill.

An earlier note in this repo hedged that a Pod "is not covered by the credit,
do not plan around Pods being free", and that hedge got restated as if the Pod
had charged the card. It had not. What remains true, and is a different claim,
is that both grants carry a "Serverless only" eligibility badge — which is why
production runs on the task_queue. Where Pod GPU time is metered is still
unexplained; that it has never produced a charge is now well evidenced.

Why custom nodes need a volume
------------------------------
A Pod's filesystem is ephemeral. Manager installs a node by git-cloning into
`custom_nodes/` and pip-installing its requirements, and both die when the
container stops — so without this, every session starts by reinstalling the same
twenty node packs. Two things are therefore redirected onto a volume:

    /comfy/custom_nodes -> /nodes/custom_nodes    the clones
    PIP_TARGET=/nodes/site                        what their pip installs pull

The second has a subtlety worth knowing. `/nodes/site` is added to sys.path by a
`.pth` file rather than by PYTHONPATH, and those are not interchangeable:
PYTHONPATH is *prepended*, a `.pth` path is *appended*. Since `pip --target`
does not know what the container already has, a node listing `torch` in its
requirements will happily download a second torch into `/nodes/site` — appended,
that copy is shadowed by the real cu128 build and never imported. Prepended, it
would take over and break the GPU. It also means such a node quietly eats a few
GB of volume; free, but worth recognising when an install seems huge.

Run it:
    cd beam/lab && uv run --with beam-client python app.py

On Windows prefix with `PYTHONIOENCODING=utf-8 PYTHONUTF8=1` — the Beam SDK
crashes printing its own progress bar against a cp1252 console otherwise.
"""

from beam import Image, Pod, Volume

MODELS_VOLUME = "ltx25-models"
MODELS_PATH = "/models"
NODES_VOLUME = "comfy-nodes"
NODES_PATH = "/nodes"
OUTPUT_VOLUME = "comfy-lab-outputs"
OUTPUT_PATH = "/outputs"
COMFY_DIR = "/comfy"
PIP_TARGET = NODES_PATH + "/site"

# A cold start reads tens of GB of weights off the distributed volume before the
# first generation can finish. Letting the container die between two experiments
# pays that twice. 30 minutes is sized for a working session; stop it from the
# dashboard when you walk away.
KEEP_WARM_SECONDS = 1800

# Every folder ComfyUI knows about, not just the ones today's models need.
#
# The ltx25 pod lists five, which is fine when you know the graph in advance.
# Here you do not: a civitai workflow reaches for `controlnet`, `clip_vision`,
# `upscale_models` or `detection` without warning, and a missing symlink shows up
# as an empty dropdown with nothing in the log to explain it. Mapping everything
# costs nothing — they are symlinks to directories the startup script creates —
# and saves a rebuild per surprise.
#
# Same list as runpod/comfyui/extra_model_paths.yaml, for the same reason, plus
# `unet` (where the GGUF loaders look) and `clip` (the older name some workflows
# still use for text encoders).
MODEL_DIRS = [
    "checkpoints",
    "clip",
    "clip_vision",
    "controlnet",
    "diffusers",
    "diffusion_models",
    "embeddings",
    "gligen",
    "hypernetworks",
    "latent_upscale_models",
    "loras",
    "model_patches",
    "photomaker",
    "style_models",
    "text_encoders",
    "unet",
    "upscale_models",
    "vae",
    "vae_approx",
    "audio_encoders",
    "background_removal",
    "classifiers",
    "detection",
    "frame_interpolation",
    "geometry_estimation",
    "optical_flow",
]

MANAGER_REPO = "https://github.com/Comfy-Org/ComfyUI-Manager"

# Manager's own dependencies, baked into the image rather than installed onto the
# volume at first boot. They are a short, stable list (its requirements.txt), so
# baking them means the first cold start does not spend minutes in pip before the
# UI answers. Node packs installed later still pip into PIP_TARGET; this is only
# about Manager itself.
MANAGER_DEPS = (
    "GitPython PyGithub matrix-nio transformers huggingface-hub typer rich"
    " typing-extensions toml uv chardet"
)

image = (
    Image(python_version="python3.12")
    .add_commands(
        [
            # ffmpeg is not optional — CreateVideo/SaveVideo shell out to it.
            # aria2 is there for the rare case of pulling something straight onto
            # the pod; prefer beam/models/download.py, which is a CPU container.
            "apt-get update && apt-get install -y --no-install-recommends git ffmpeg"
            " aria2 && rm -rf /var/lib/apt/lists/*",
            f"git clone --depth=1 https://github.com/comfyanonymous/ComfyUI {COMFY_DIR}",
            f"pip install --no-cache-dir -r {COMFY_DIR}/requirements.txt",
            f"pip install --no-cache-dir {MANAGER_DEPS}",
            # comfy-cli, for `comfy node install-deps --workflow=x.json`: it reads
            # a workflow and installs every custom node it references, which beats
            # clicking through Manager's missing-nodes dialog one at a time.
            "pip install --no-cache-dir comfy-cli",
            # Torch LAST and forced: ComfyUI leaves it unpinned, so pip may resolve
            # a CUDA 12.6 build, and the 5090 is Blackwell (sm_120) which needs
            # 12.8+. Installing after everything else makes the wheel choice
            # deterministic rather than dependent on resolution order.
            "pip install --no-cache-dir --force-reinstall torch torchvision torchaudio"
            " --index-url https://download.pytorch.org/whl/cu128",
            # Append PIP_TARGET to sys.path via a .pth in site-packages. Appended,
            # not prepended — see the module docstring for why that distinction is
            # the whole safety mechanism here. sysconfig's purelib rather than
            # site.getsitepackages()[0]: purelib is exactly where pip installs, is
            # always defined, and does not depend on how python was built.
            "python -c \"import sysconfig, pathlib;"
            f" pathlib.Path(sysconfig.get_paths()['purelib'], 'zz_beam_lab.pth')"
            f".write_text('{PIP_TARGET}\\n')\"",
            f"mkdir -p {COMFY_DIR}/models",
            f"for d in {' '.join(MODEL_DIRS)}; do"
            f" rm -rf {COMFY_DIR}/models/$d; ln -s {MODELS_PATH}/$d {COMFY_DIR}/models/$d; done",
            # custom_nodes is a symlink to the volume so anything Manager clones
            # outlives the container. It cannot be populated at build time — the
            # volume is not mounted then — which is why Manager itself is cloned
            # by the startup script instead.
            f"rm -rf {COMFY_DIR}/custom_nodes && ln -s {NODES_PATH}/custom_nodes"
            f" {COMFY_DIR}/custom_nodes",
            # The startup script lives in the image rather than in the Pod's
            # entrypoint array: the SDK puts an inlined entrypoint through
            # shell-word processing, which mangles the `\;` and `{}` find needs.
            # An earlier version of the ltx25 pod died on boot exactly there.
            "printf '%s\\n'"
            " '#!/bin/sh'"
            f" 'mkdir -p {OUTPUT_PATH} {NODES_PATH}/custom_nodes {PIP_TARGET}'"
            # Symlink targets have to exist before ComfyUI scans them, or the
            # loader dropdowns come up empty with nothing in the log.
            f" 'for d in {' '.join(MODEL_DIRS)}; do mkdir -p {MODELS_PATH}/$d; done'"
            # First boot only. After that it is on the volume.
            f" 'if [ ! -d {NODES_PATH}/custom_nodes/ComfyUI-Manager ]; then'"
            f" '  git clone --depth=1 {MANAGER_REPO}"
            f" {NODES_PATH}/custom_nodes/ComfyUI-Manager; fi'"
            # Copy only files untouched for a minute, so a half-muxed MP4 is never
            # captured — cp -n would then pin the broken copy forever.
            f" '(while true; do find {COMFY_DIR}/output -type f -mmin +1"
            f" -exec cp -n {{}} {OUTPUT_PATH}/ \\; 2>/dev/null; sleep 30; done) &'"
            f" 'cd {COMFY_DIR}'"
            " 'exec python main.py --listen 0.0.0.0 --port 8000'"
            " > /usr/local/bin/start-comfy.sh",
            "chmod +x /usr/local/bin/start-comfy.sh",
        ]
    )
)

comfyui = Pod(
    name="comfy-lab",
    image=image,
    ports=[8000],
    cpu=12,
    # ComfyUI survives a 32 GB card by evicting models to host RAM between
    # phases; the LTX run peaked with only 3.4 GB of 66.6 free, so RAM is the
    # tighter resource here, not VRAM.
    memory="64Gi",
    gpu="RTX5090",
    env={
        # Every pip run inside the container — Manager's included — lands on the
        # volume instead of in the ephemeral container filesystem.
        "PIP_TARGET": PIP_TARGET,
        # Manager will not install from arbitrary sources at its default security
        # level. This is a scratch box with no secrets on it and the entire point
        # is installing third-party nodes. Do NOT copy this into beam/comfy.
        "COMFYUI_MANAGER_NETWORK_MODE": "public",
    },
    volumes=[
        Volume(name=MODELS_VOLUME, mount_path=MODELS_PATH),
        Volume(name=NODES_VOLUME, mount_path=NODES_PATH),
        # Mounted, but NOT as ComfyUI's output directory. Pointing
        # --output-directory at a volume produces silently unplayable MP4s: the
        # muxer writes the file then seeks back to move moov to the front, and a
        # distributed volume does not give seek-and-rewrite-in-place. mdat
        # survives, moov is lost, nothing is logged. Reading weights off a volume
        # is fine, that is sequential; finalizing a container format is not.
        Volume(name=OUTPUT_VOLUME, mount_path=OUTPUT_PATH),
    ],
    keep_warm_seconds=KEEP_WARM_SECONDS,
    entrypoint=["sh", "/usr/local/bin/start-comfy.sh"],
)


if __name__ == "__main__":
    res = comfyui.create()
    print("ComfyUI hosted at:", res.url)
    print()
    print("First boot clones the Manager onto the volume, so give it a minute")
    print("longer than usual before the UI answers.")
    print()
    print("Loading a workflow off civitai:")
    print("  1. drag the JSON onto the canvas")
    print("  2. Manager > Install Missing Custom Nodes, restart when it asks")
    print("     (or, in a terminal on the pod: comfy node install-deps")
    print("      --workflow=<file>, which does the whole list at once)")
    print("  3. for weights, do NOT use the in-UI download button. Save the")
    print("     workflow, then locally:")
    print("       python scripts/ingest_workflow.py <file> --sizes")
    print("       python scripts/ingest_workflow.py <file> --download")
    print("     The second runs a CPU container instead of downloading onto")
    print("     a GPU pod.")
    print("  4. refresh node definitions (R) after a download, or the run")
    print("     fails validation with 'Value not in list'.")
    print()
    print("Custom nodes and their pip deps are on the 'comfy-nodes' volume and")
    print("survive a restart. Everything else in the container does not.")
    print()
    print("When a workflow is worth keeping:")
    print("  python scripts/ingest_workflow.py <file> --build-commands")
    print("pins its nodes into beam/comfy. Nothing here reaches the worker")
    print("on its own.")
