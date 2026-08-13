"""Populate the Beam volume with the LTX-2.5 weights. Run this once, before app.py.

Deliberately a CPU-only function. Beam bills for container runtime, and pulling
~40 GB takes minutes — there is no reason to hold a GPU while it happens. The
Pod in app.py then starts against an already-warm volume.

    beam secret create HF_TOKEN hf_xxx     # Lightricks/LTX-2.5 is a gated repo
    python beam/ltx25/download_models.py

Volume storage on Beam is free up to 1 TB, so the ~40 GB parked here costs
nothing between runs.
"""

from beam import Image, Volume, function

from models import MODELS, PROMPT_ENHANCER, TOTAL_GB

VOLUME_NAME = "ltx25-models"
MOUNT_PATH = "/models"

image = Image(python_version="python3.12").add_python_packages(
    ["huggingface_hub[hf_transfer]==0.36.0"]
)


@function(
    image=image,
    volumes=[Volume(name=VOLUME_NAME, mount_path=MOUNT_PATH)],
    cpu=8,
    memory="16Gi",
    # ~40 GB even on a fast link is not a 10-minute job every time; the default
    # task timeout would kill it partway and leave the volume half-populated.
    timeout=7200,
    secrets=["HF_TOKEN"],
    # hf_transfer is the difference between ~40 min and ~5 min on this payload.
    env={"HF_HUB_ENABLE_HF_TRANSFER": "1"},
)
def download(include_enhancer: bool = False):
    import os
    from pathlib import Path

    from huggingface_hub import hf_hub_download

    token = os.environ["HF_TOKEN"]

    wanted = list(MODELS)
    if include_enhancer:
        # Not because we want the enhancer to run — see PROMPT_ENHANCER in
        # models.py. ComfyUI refuses to execute a graph that references a model
        # it cannot find, even down a branch that is switched off.
        wanted.append(PROMPT_ENHANCER)

    total = TOTAL_GB + (PROMPT_ENHANCER[3] if include_enhancer else 0)
    print(f"Fetching {len(wanted)} files (~{total:.1f} GB) into {MOUNT_PATH}")

    for repo, subdir, filename, gb in wanted:
        dest_dir = Path(MOUNT_PATH) / subdir
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / filename

        if dest.exists():
            # Resuming after a timeout or a partial run: skip what is already
            # there, but only if the size looks right — a truncated file would
            # otherwise sail through and fail confusingly at load time.
            actual_gb = dest.stat().st_size / 1e9
            if abs(actual_gb - gb) / gb < 0.02:
                print(f"  skip  {filename} ({actual_gb:.2f} GB, already present)")
                continue
            print(f"  redo  {filename} ({actual_gb:.2f} GB, expected {gb:.2f} GB)")
            dest.unlink()

        print(f"  get   {filename} ({gb:.2f} GB)")
        # local_dir puts the real file on the volume rather than a symlink into
        # a cache dir that the Pod container will not have.
        hf_hub_download(
            repo_id=repo,
            filename=f"{subdir}/{filename}",
            local_dir=MOUNT_PATH,
            token=token,
        )

    print("\nVolume contents:")
    for path in sorted(Path(MOUNT_PATH).rglob("*.safetensors")):
        print(f"  {path.stat().st_size / 1e9:7.2f} GB  {path.relative_to(MOUNT_PATH)}")


if __name__ == "__main__":
    import sys

    download.remote(include_enhancer="--enhancer" in sys.argv)
