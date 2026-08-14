"""ComfyUI as a Beam task queue — the second backend for CreateGent's graphs.

This is the Beam half of the pair. The RunPod half is `runpod/comfyui/`, and
both import `comfy_worker.contract`, so a job means the same thing on either
side and the app can point at whichever it prefers.

Why a task_queue and not an endpoint
------------------------------------
Beam endpoints are synchronous and capped at 180 seconds. An LTX-2.5 generation
is minutes even warm, and ~19 of them on a cold container. A task_queue returns
a `task_id` immediately and the caller polls `GET /v2/task/{id}/`, which is what
`src/providers/beam.ts` does.

A task_queue is still serverless — it scales to zero, so Beam's promotional
credit (which cannot pay for a GPU pool or a Pod reservation) applies to it.

Why the weights are not downloaded here
---------------------------------------
The volume `ltx25-models` is already populated by `beam/ltx25/download_models.py`
and is reused as-is. Volume storage is free under 1 TB, so the ~40 GB parked
there costs nothing between sessions.

Run it::

    cd beam/comfy && uv run --with beam-client python app.py deploy

Deploying from this directory is load-bearing — see `beam/ltx25/README.md`: Beam
syncs the working directory, and from the repo root that means `node_modules`.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# --- vendoring -------------------------------------------------------------
# The shared contract lives at the repo root so the RunPod Dockerfile (whose
# build context is the repo root) can COPY it. Beam instead syncs *this*
# directory, so the package has to exist here at deploy time.
#
# Copying it on every run, rather than committing a second copy, keeps the repo
# root the single source of truth: there is no version of this file that can be
# stale, because it is overwritten seconds before it is uploaded. The copy is
# gitignored.
_HERE = Path(__file__).parent
_REPO_ROOT = _HERE.parent.parent
_VENDORED = _HERE / "comfy_worker"

if (_REPO_ROOT / "comfy_worker").is_dir():
    shutil.rmtree(_VENDORED, ignore_errors=True)
    shutil.copytree(
        _REPO_ROOT / "comfy_worker",
        _VENDORED,
        ignore=shutil.ignore_patterns("__pycache__"),
    )

sys.path.insert(0, str(_HERE))

from beam import Image, Output, QueueDepthAutoscaler, Volume, task_queue  # noqa: E402

from comfy_worker import build_result, collect_outputs, normalize_input  # noqa: E402
from comfy_worker.client import (  # noqa: E402
    ComfyError,
    make_fetcher,
    queue_prompt,
    upload_file,
    wait_for_prompt,
    wait_for_server,
)

VOLUME_NAME = "ltx25-models"
MOUNT_PATH = "/models"
COMFY_DIR = "/comfy"
COMFY_PORT = 8188
COMFY_URL = "http://127.0.0.1:%d" % COMFY_PORT

# Mirrored into ComfyUI's models/ as symlinks at build time. Symlinks resolve
# lazily, so it does not matter that the volume is not mounted during the build.
MODEL_DIRS = ["diffusion_models", "text_encoders", "vae", "latent_upscale_models", "loras"]

# A cold container spends ~19 minutes reading ~40 GB of weights off the
# distributed volume before it can answer at all, and Beam bills every second of
# it. Five minutes of keep-warm at $0.68/hr costs ~$0.06 and saves that reload
# for any job that follows within the window — a session of iterations pays for
# itself on the second generation.
#
# It does NOT make an isolated job cheap. The real fix for the cold start is
# DurableDisk (local NVMe) via `disks=`, not a longer idle timer; raising this
# to cover sporadic traffic just pays for an idle GPU.
KEEP_WARM_SECONDS = 300

image = (
    Image(python_version="python3.12")
    .add_commands(
        [
            # ffmpeg is not optional: SaveVideo shells out to it, and joint
            # audio+video output is the whole point of these graphs.
            "apt-get update && apt-get install -y --no-install-recommends git ffmpeg"
            " && rm -rf /var/lib/apt/lists/*",
            # ComfyUI master, not a release tag — LTX-2.5's nodes
            # (LTXVConcatAVLatent, LTXVDualCFGGuider, LTXVLatentUpsampler,
            # LTXVAudioVAEDecode) only exist there. Same reasoning as
            # runpod/comfyui/Dockerfile.
            "git clone --depth=1 https://github.com/comfyanonymous/ComfyUI %s" % COMFY_DIR,
            "pip install --no-cache-dir -r %s/requirements.txt" % COMFY_DIR,
            # Torch LAST and forced: ComfyUI leaves torch unpinned, so pip may
            # resolve a CUDA 12.6 build, and the 5090 is Blackwell (sm_120) which
            # needs 12.8+. Installing after requirements.txt makes the wheel
            # choice deterministic instead of dependent on resolution order.
            "pip install --no-cache-dir --force-reinstall torch torchvision torchaudio"
            " --index-url https://download.pytorch.org/whl/cu128",
            "mkdir -p %s/models" % COMFY_DIR,
            "for d in %s; do rm -rf %s/models/$d; ln -s %s/$d %s/models/$d; done"
            % (" ".join(MODEL_DIRS), COMFY_DIR, MOUNT_PATH, COMFY_DIR),
        ]
    )
    .add_python_packages(["requests"])
)


def start_comfy():
    """Boot ComfyUI once per container and wait for it to answer.

    Runs as `on_start`, so the cost is paid on the cold container rather than
    inside the first job's clock.
    """
    print("beam-comfyui - starting ComfyUI...")
    subprocess.Popen(
        [
            sys.executable,
            "main.py",
            "--listen",
            "127.0.0.1",
            "--port",
            str(COMFY_PORT),
            "--disable-auto-launch",
        ],
        cwd=COMFY_DIR,
        stdout=sys.stdout,
        stderr=sys.stderr,
    )
    wait_for_server(COMFY_URL, timeout_s=900)
    print("beam-comfyui - ComfyUI is up")


def _save_output(filename, data):
    """Persist one produced file and return a URL the app can fetch.

    Files go out as URLs, never inline base64. A graph emitting a video plus a
    separate audio track would otherwise put tens of megabytes through the task
    payload, and `public_url` costs nothing.

    The hour of expiry is ample: CreateGent downloads the result and re-uploads
    it to its own storage as soon as the job is collected.
    """
    # Written to container-local disk on purpose. Never finalize a container
    # format on a distributed volume — see the moov-atom note in
    # beam/ltx25/app.py.
    temp_dir = tempfile.mkdtemp(prefix="comfy-out-")
    path = os.path.join(temp_dir, os.path.basename(filename))
    with open(path, "wb") as handle:
        handle.write(data)

    output = Output(path=path).save()
    return output.public_url(expires=3600)


def _returned(result):
    """Return the result AND leave a copy behind as a retrievable file.

    Beam's task API is documented around `outputs` — the files a task saved —
    and whether `GET /v2/task/{id}/` echoes a handler's return value is not
    something to bet a twenty-minute generation on. Saving `result.json` costs a
    few kilobytes (every media file in it is already a URL) and gives
    `src/providers/beam.ts` a fallback that cannot be wrong.

    A failure to save it is not a failure of the job: the inline value may well
    be enough.
    """
    try:
        temp_dir = tempfile.mkdtemp(prefix="comfy-result-")
        path = os.path.join(temp_dir, "result.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(result, handle)
        Output(path=path).save()
    except Exception as err:  # noqa: BLE001
        print("beam-comfyui - could not save result.json: %s" % err)
    return result


@task_queue(
    name="creategent-comfyui",
    image=image,
    gpu="RTX5090",
    cpu=12,
    # ComfyUI survives a 32 GB card by evicting models to system RAM between
    # phases — the 15.4 GB text encoder is pushed out to make room for the
    # 21.5 GB transformer. At peak the ltx25 pod had 7.2 GB of VRAM free but only
    # 3.4 GB of RAM, so RAM is the tighter resource here, not VRAM.
    memory="48Gi",
    volumes=[Volume(name=VOLUME_NAME, mount_path=MOUNT_PATH)],
    on_start=start_comfy,
    keep_warm_seconds=KEEP_WARM_SECONDS,
    # Beam's default is 3. A retry of a job that already burned twenty GPU
    # minutes on a deterministic graph error just spends the money three times.
    retries=0,
    timeout=3600,
    # One container, one job at a time: two concurrent LTX runs do not fit in
    # 32 GB, and queueing is cheaper than thrashing.
    autoscaler=QueueDepthAutoscaler(max_containers=1, tasks_per_container=1),
)
def handler(**job_input):
    """Run one ComfyUI graph. Same input and output shape as the RunPod worker."""
    validated, error_message = normalize_input(job_input)
    if error_message:
        return _returned({"error": error_message})

    try:
        # on_start already waited, but a container that lost ComfyUI mid-life
        # would otherwise fail with a confusing connection error per job.
        wait_for_server(COMFY_URL, timeout_s=120)

        for entry in validated["files"]:
            upload_file(COMFY_URL, entry["name"], entry["data"])

        prompt_id = queue_prompt(
            COMFY_URL,
            validated["workflow"],
            comfy_org_api_key=validated.get("comfy_org_api_key"),
        )
        print("beam-comfyui - queued %s" % prompt_id)

        outputs, errors = wait_for_prompt(COMFY_URL, prompt_id, timeout_s=3000)

        files, values, collect_errors = collect_outputs(
            outputs, make_fetcher(COMFY_URL), _save_output
        )
        errors.extend(collect_errors)

        print("beam-comfyui - collected %d file(s), %d value(s)" % (len(files), len(values)))
        return _returned(build_result(files, values, errors))

    except ComfyError as err:
        return _returned({"error": str(err)})
    except Exception as err:  # noqa: BLE001 - the worker must always answer
        import traceback

        traceback.print_exc()
        return _returned({"error": "An unexpected error occurred: %s" % err})


if __name__ == "__main__":
    print("Deploy with:  uv run --with beam-client beam deploy app.py:handler")
    print()
    print("Then set in .env.local:")
    print("  BEAM_TOKEN=...            (Beam dashboard > API keys)")
    print("  BEAM_COMFYUI_URL=https://<id>.app.beam.cloud")
