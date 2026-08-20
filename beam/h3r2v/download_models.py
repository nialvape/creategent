"""Add the MiniMax H3 ref2v weights to the existing Beam volume. Run once.

Deliberately CPU-only: Beam bills container runtime, and pulling ~44 GB has no
reason to hold a 5090 while it happens.

    cd beam/h3r2v && uv run --with beam-client python download_models.py

This is a sibling of `beam/ltx25/download_models.py` rather than a shared
module, and the duplication is on purpose. Beam syncs the *working directory*
into the container, so anything imported has to live beside the entrypoint —
`beam/comfy/app.py` copies `comfy_worker/` in at deploy time for exactly this
reason. A shared downloader would need the same vendoring hack to save forty
lines. Each Beam app directory stays self-contained instead.

The volume is `ltx25-models`, the one `beam/ltx25/download_models.py` already
populated. That name is now a misnomer — it holds two model families — but
renaming it means re-uploading 40 GB, and the point of sharing it is that
`beam/comfy/app.py` (the task_queue CreateGent actually calls) already mounts it
and already symlinks all four subdirectories H3 needs. Nothing downstream has to
change for a second model to appear there.

Volume storage is free under 1 TB. ~84 GB parked across both families costs
nothing between sessions, and a cold container only reads what its graph
references — a second model on the volume does not slow the first one down.
"""

from beam import Image, Volume, function

from models import MODELS, TOTAL_GB

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
    # ~44 GB. The default task timeout would kill it partway and leave the
    # volume half-populated.
    timeout=7200,
    secrets=["HF_TOKEN"],
    # The difference between ~40 min and ~5 min on this payload.
    env={"HF_HUB_ENABLE_HF_TRANSFER": "1"},
)
def download():
    import os
    from pathlib import Path

    from huggingface_hub import hf_hub_download

    # Comfy-Org/MiniMax-H3 is public, so unlike the LTX pull this does not fail
    # without a token — it just gets anonymous rate limits.
    token = os.environ.get("HF_TOKEN") or None

    print(f"Fetching {len(MODELS)} files (~{TOTAL_GB:.1f} GB) into {MOUNT_PATH}")

    for repo, subdir, filename, gb in MODELS:
        dest_dir = Path(MOUNT_PATH) / subdir
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / filename

        if dest.exists():
            # Resuming after a timeout: skip what is there, but only if the size
            # looks right — a truncated file would otherwise sail through here
            # and fail confusingly at load time.
            actual_gb = dest.stat().st_size / 1e9
            if abs(actual_gb - gb) / gb < 0.02:
                print(f"  skip  {filename} ({actual_gb:.2f} GB, already present)")
                continue
            print(f"  redo  {filename} ({actual_gb:.2f} GB, expected {gb:.2f} GB)")
            dest.unlink()

        print(f"  get   {filename} ({gb:.2f} GB)")
        # local_dir puts the real file on the volume rather than a symlink into
        # a cache dir the Pod container will not have.
        hf_hub_download(
            repo_id=repo,
            filename=f"{subdir}/{filename}",
            local_dir=MOUNT_PATH,
            token=token,
        )

    print("\nVolume contents (both model families):")
    for path in sorted(Path(MOUNT_PATH).rglob("*.safetensors")):
        print(f"  {path.stat().st_size / 1e9:7.2f} GB  {path.relative_to(MOUNT_PATH)}")


if __name__ == "__main__":
    download.remote()
