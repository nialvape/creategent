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

from beam import Image, Output, Volume, function, task_queue

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
            failed.append({"name": name, "url": None, "http": None, "aria2": None})
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
        # Auth is per host, and the two sites want it in different places.
        #
        # Hugging Face takes a bearer header and rejects a token in the query
        # string. civitai's *download* endpoint is the other way round: the
        # header produced a flat 403 on a model that downloads fine with
        # `?token=` (measured 2026-08-20). Their API docs describe the query
        # parameter for downloads, so this follows the endpoint, not the API.
        if hf_token and host.endswith("huggingface.co"):
            cmd.append("--header=Authorization: Bearer %s" % hf_token)
        if civitai_token and "civitai" in host:
            separator = "&" if "?" in url else "?"
            url = "%s%stoken=%s" % (url, separator, civitai_token)
        cmd.append(url)

        print("  get   %s  <- %s" % (name, host))
        result = subprocess.run(cmd)
        if result.returncode != 0:
            # aria2's exit code says "it did not work", never why, and the
            # container log is not readable from a laptop (`beam logs` dies on
            # SSL here). Asking the server once more with the same headers turns
            # that into an HTTP status — which is the difference between a bad
            # URL (404), a token problem (401/403), and a page where a file was
            # expected (200 of text/html).
            status = _probe(url, cmd)
            print("  FAIL  %s (aria2c exit %d, server said %s)" % (name, result.returncode, status))
            failed.append(
                {
                    "name": name,
                    # The URL is echoed back with any token stripped: it is shown
                    # in the UI, and a credential in an error message is a
                    # credential in a screenshot.
                    "url": url.split("?token=")[0].split("&token=")[0],
                    "http": status,
                    "aria2": result.returncode,
                    # Length only, never the value. Distinguishes "no secret" and
                    # "truncated secret" from "the site said no".
                    "authLen": len(civitai_token or "") if "civitai" in host else None,
                }
            )

    print("\nVolume contents:")
    for path in sorted(Path(MOUNT_PATH).rglob("*")):
        if path.is_file() and path.stat().st_size > 1e8:
            print("  %7.2f GB  %s" % (path.stat().st_size / 1e9, path.relative_to(MOUNT_PATH)))

    if failed:
        print("\n%d file(s) did not land: %s" % (len(failed), ", ".join(f["name"] for f in failed)))
    return _returned({"failed": failed, "requested": len(models)})


def _probe(url, cmd):
    """The HTTP status the server returns for `url`, using the same auth headers."""
    import urllib.error
    import urllib.request

    headers = {}
    for arg in cmd:
        if arg.startswith("--header="):
            key, _, value = arg[len("--header=") :].partition(": ")
            headers[key] = value
    try:
        with urllib.request.urlopen(
            urllib.request.Request(url, headers=headers), timeout=30
        ) as res:
            return res.status
    except urllib.error.HTTPError as err:
        return err.code
    except Exception as err:  # noqa: BLE001
        return "%s: %s" % (type(err).__name__, err)


def _returned(result):
    """Return the result AND leave a copy behind as a retrievable file.

    `GET /v2/task/{id}/` does not echo a handler's return value — measured
    2026-08-19. Without this the weights panel can only report that a task
    finished, never "this file failed with 403", which is the only part worth
    knowing when a download goes wrong. Same reasoning, and same shape, as
    `_returned` in beam/comfy/app.py.
    """
    import json
    import os
    import tempfile

    try:
        path = os.path.join(tempfile.mkdtemp(prefix="weights-"), "result.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(result, handle)
        Output(path=path).save()
    except Exception as err:  # noqa: BLE001
        print("weights-downloader - could not save result.json: %s" % err)
    return result


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
