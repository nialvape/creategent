"""Download whatever a workflow asks for onto the models volume, by URL.

The other downloaders in this repo (`beam/ltx25`, `beam/h3r2v`) take a hardcoded
list of Hugging Face repo + filename pairs, which is right for a model family we
chose deliberately. This one is the generic half: it takes URLs, so it can pull
from civitai or anywhere else, and it takes them from a manifest generated out
of the workflow itself.

    python scripts/ingest_workflow.py my_workflow.json --download

That writes manifest.json here and runs this. To do it by hand:

    python scripts/ingest_workflow.py my_workflow.json --json > beam/models/manifest.json
    cd beam/models && uv run --with beam-client python download.py manifest.json

The manifest is a list of `{"url", "directory", "name"}`. Those three fields come
straight from the workflow's own `properties.models`, which is why this is not
guesswork: the file says where each weight came from and which ComfyUI folder it
belongs in.

CPU-only on purpose. Beam bills container runtime and this is pure I/O — there is
no reason to hold a 5090 while 40 GB transfers. Volume storage is free under
1 TB, so anything parked here costs nothing between sessions.

aria2c rather than a plain streaming GET: on a 20 GB file, sixteen connections is
the difference between minutes and most of an hour, and it resumes a partial
file instead of starting over.
"""

import json
import sys

from beam import Image, Volume, function, task_queue

VOLUME_NAME = "ltx25-models"
MOUNT_PATH = "/models"

image = Image(python_version="python3.12").add_commands(
    ["apt-get update && apt-get install -y --no-install-recommends aria2"
     " && rm -rf /var/lib/apt/lists/*"]
)


CONFIG = dict(
    image=image,
    volumes=[Volume(name=VOLUME_NAME, mount_path=MOUNT_PATH)],
    cpu=8,
    memory="16Gi",
    # Tens of GB is not a ten-minute job every time, and the default task timeout
    # would kill it partway and leave the volume half populated.
    timeout=7200,
    # HF_TOKEN covers gated repos (Lightricks/LTX-2.5 is one); CIVITAI_TOKEN
    # covers the civitai models that require a login. Both must exist as Beam
    # secrets (`beam secret create <NAME> <value>`) or the deploy is rejected.
    secrets=["HF_TOKEN", "CIVITAI_TOKEN"],
)


def _download(models):
    import os
    import subprocess
    from pathlib import Path
    from urllib.parse import urlparse

    hf_token = os.environ.get("HF_TOKEN")
    civitai_token = os.environ.get("CIVITAI_TOKEN")

    print("Fetching %d file(s) into %s" % (len(models), MOUNT_PATH))
    failed = []

    for entry in models:
        url = entry.get("url")
        directory = entry.get("directory") or ""
        name = entry.get("name")

        if not url:
            # ingest_workflow.py reports these too, but a manifest can be edited
            # by hand — say which file is unreachable rather than skipping quietly.
            print("  SKIP  %s (no URL in the manifest)" % name)
            failed.append(name)
            continue

        dest_dir = Path(MOUNT_PATH) / directory
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / name

        if dest.exists() and dest.stat().st_size > 0:
            actual = dest.stat().st_size
            expected = entry.get("size")
            if not expected:
                # The host would not report a Content-Length. Existence is the
                # only check available, and it cannot catch a truncated file.
                print("  skip? %s (%.2f GB, present; size unverified)" % (name, actual / 1e9))
                continue
            if abs(actual - expected) / expected < 0.02:
                print("  skip  %s (%.2f GB, already present)" % (name, actual / 1e9))
                continue
            # A partial file from an interrupted run. aria2c --continue would
            # resume it, which is right when the remainder is genuinely missing
            # and wrong when the file is corrupt in place; resuming is the cheap
            # bet on a 20 GB weight, and a size mismatch afterwards will show up
            # here again on the next run.
            print(
                "  resume %s (%.2f GB of %.2f GB)"
                % (name, actual / 1e9, expected / 1e9)
            )

        host = urlparse(url).netloc
        cmd = [
            "aria2c",
            "--continue=true",
            "--max-connection-per-server=16",
            "--split=16",
            "--min-split-size=8M",
            "--summary-interval=30",
            "--console-log-level=warn",
            "--dir=%s" % dest_dir,
            "--out=%s" % name,
        ]
        # Auth is per host, and it has to be a header for HF: a token in the
        # query string works for civitai and is rejected by huggingface.co.
        if hf_token and host.endswith("huggingface.co"):
            cmd.append("--header=Authorization: Bearer %s" % hf_token)
        if civitai_token and "civitai" in host:
            cmd.append("--header=Authorization: Bearer %s" % civitai_token)
        cmd.append(url)

        print("  get   %s  <- %s" % (name, host))
        result = subprocess.run(cmd)
        if result.returncode != 0:
            print("  FAIL  %s (aria2c exit %d)" % (name, result.returncode))
            failed.append(name)

    print("\nVolume contents:")
    for path in sorted(Path(MOUNT_PATH).rglob("*")):
        if path.is_file() and path.stat().st_size > 1e8:
            print("  %7.2f GB  %s" % (path.stat().st_size / 1e9, path.relative_to(MOUNT_PATH)))

    if failed:
        print("\n%d file(s) did not land: %s" % (len(failed), ", ".join(map(str, failed))))
    return {"failed": failed}


# The same job, reachable two ways, because it has two callers and neither
# should have to pretend to be the other:
#
#   `function`   - what `python download.py` uses from a terminal. Invoking it
#                  needs the Beam SDK, which a terminal has and a Next.js route
#                  does not.
#   `task_queue` - what the Model Lab's weights panel POSTs to. A deployed task
#                  queue has a stable URL and takes a bearer token; the app
#                  submits a manifest, gets a task id, and polls it exactly the
#                  way src/providers/beam.ts already polls a render.
#
# A task_queue rather than an endpoint for the usual reason: endpoints are
# synchronous and capped at 180 seconds, and 30 GB does not arrive in three
# minutes.


@function(**CONFIG)
def download(models):
    return _download(models)


@task_queue(**CONFIG)
def handler(**payload):
    """HTTP entry point. Body is `{"models": [{url, directory, name, size}]}`."""
    models = payload.get("models") or []
    if not isinstance(models, list):
        return {"failed": [], "error": "models must be a list"}
    if not models:
        return {"failed": [], "error": "no models in the request"}
    return _download(models)


USAGE = """usage:
  python download.py <manifest.json>
  python download.py --url <url> --dir <folder> [--name <filename>]

The manifest form comes from a workflow:
  python scripts/ingest_workflow.py <workflow> --json > beam/models/manifest.json

The --url form is for a single file a workflow does not know about yet: a LoRA
off civitai, a VAE variant someone renamed. --dir is the ComfyUI folder it
belongs in (loras, vae, diffusion_models, text_encoders, ...). --name is the
filename ComfyUI will show; it defaults to the last path segment of the URL,
which is wrong for civitai's /api/download/models/<id> style links -- pass it
explicitly there, and give it the extension the loader expects.
"""


def _parse_url_args(argv):
    args = {}
    key = None
    for token in argv:
        if token.startswith("--"):
            key = token[2:]
            args[key] = True
        elif key:
            args[key] = token
            key = None
    if not args.get("dir") or args["dir"] is True:
        raise SystemExit("--dir is required (loras, vae, diffusion_models, ...)\n\n" + USAGE)
    url = args["url"]
    name = args.get("name")
    if not name or name is True:
        name = url.split("?")[0].rstrip("/").split("/")[-1]
    return [{"url": url, "directory": args["dir"], "name": name, "size": None}]


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(USAGE)

    if "--url" in sys.argv:
        manifest = _parse_url_args(sys.argv[1:])
    else:
        manifest = json.loads(open(sys.argv[1], encoding="utf-8").read())
        if not isinstance(manifest, list):
            raise SystemExit("manifest must be a JSON list of {url, directory, name}")

    download.remote(models=manifest)
