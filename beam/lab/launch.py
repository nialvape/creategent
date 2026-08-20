"""Start and stop the ComfyUI lab Pod over HTTP, so the Model Lab can do it.

Why this exists rather than the app shelling out to the CLI
-----------------------------------------------------------
CreateGent runs on Vercel. A serverless function there cannot spawn `uv`, cannot
run the Beam SDK, and has no `~/.beam/config.ini` — so "run `python app.py` from
the API route" was never going to work outside a laptop. The SDK does run
happily *inside* a Beam container, which is what this is: a task queue whose
whole job is to call `comfyui.create()` on the caller's behalf and hand back the
URL.

It imports the Pod definition from `app.py` next door, so there is exactly one
description of the lab container and this cannot drift from what
`python app.py` produces.

Deploy it once:

    cd beam/lab && beam secret create BEAM_TOKEN <your-token>
    cd beam/lab && beam deploy launch.py:handler --name comfy-lab-control

Then put the URL it prints into `BEAM_LAB_CONTROL_URL`.

The BEAM_TOKEN secret is what lets the SDK authenticate from inside the
container: `beta9/config.py` reads `BEAM_TOKEN` from the environment when the
`beam` module is loaded, exactly as it would read the config file on a laptop.
It is your own account token and it never leaves Beam.
"""

from beam import Image, Output, task_queue

# Port the Pod publishes. Kept in step with `ports=[8000]` in app.py.
POD_PORT = 8000

# A running container's URL, derived from its id.
#
# `create()` returns the authoritative URL, so this is only needed for a pod that
# is already up when the app asks. The rule is read off a real deployment:
# container `pod-384110cd-ac2b-478a-97e3-27e9541810d5` answered at
# `https://384110cd-ac2b-478a-97e3-27e9541810d5-8000.app.beam.cloud`. If Beam
# ever changes the template this goes stale while the create path stays correct,
# which is the right way round for a guess to fail.
URL_TEMPLATE = "https://%s-%d.app.beam.cloud"

# "Is one already running?" is answered by listing containers whose id starts
# with `pod-`, because the gateway's Container message carries only
# container_id / stub_id / status — no name. So this matches ANY running pod,
# not specifically the lab's.
#
# That is the conservative direction to be wrong in: the button will refuse to
# start a second GPU while ltx25 or h3r2v is up, rather than quietly running two.


def _url_for(container_id):
    """`pod-<uuid>-<suffix>` -> `https://<uuid>-8000.app.beam.cloud`.

    Only the uuid goes in the hostname. A running pod reported
    `pod-99d7892a-e926-46b0-8a1c-345ef7c37f91-b07e7cfb`, and keeping that last
    segment produced a URL that 404s while the uuid-only form answers 200 — so
    the container id carries a suffix the hostname does not.
    """
    import re

    match = re.match(
        r"^pod-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
        container_id,
    )
    return URL_TEMPLATE % (match.group(1) if match else container_id.removeprefix("pod-"), POD_PORT)


def _service():
    """A gateway client that will not try to interview you.

    `ServiceClient()` with no argument reaches `get_channel(None)`, and that
    calls `prompt_for_config_context()` — an interactive prompt. In a container
    there is no stdin, so the task hangs in RUNNING until it is killed, never
    reaching an exception handler and never writing a result. That is exactly
    what happened here on 2026-08-19.

    `get_config_context()` is the non-interactive path the SDK's own
    abstractions use: it reads the config file if there is one and otherwise
    builds a context from BEAM_TOKEN and the gateway defaults in the
    environment. Passing it explicitly is the whole fix.
    """
    from beta9.channel import ServiceClient
    from beta9.config import get_config_context

    return ServiceClient(get_config_context())


def _running_containers():
    """Every running pod container. See _service() for why the client is built."""
    from beta9.clients.gateway import ListContainersRequest

    res = _service().gateway.list_containers(ListContainersRequest())
    if not res.ok:
        return []
    return [
        c
        for c in res.containers
        if (c.status or "").upper() == "RUNNING" and c.container_id.startswith("pod-")
    ]


@task_queue(
    image=Image(python_version="python3.12").add_python_packages(["beam-client"]),
    cpu=1,
    memory="1Gi",
    # Creating a Pod means building or resolving its image first. Cached that is
    # seconds; the first time after an image change it is minutes.
    timeout=1800,
    secrets=["BEAM_TOKEN"],
)
def handler(**payload):
    """`{"action": "start" | "status" | "stop", "containerId": "..."}`."""
    # Every failure is returned, never raised.
    #
    # A raised exception here becomes a task in RETRY and then ERROR with an
    # empty `outputs`, and the only place the traceback exists is the container
    # log — which `beam logs` could not reach from this machine at all
    # (SSL: TLSV1_UNRECOGNIZED_NAME before it even connects). Returning the
    # traceback puts the cause in the task result, where both the poller and a
    # curl can see it. It also stops Beam burning three retries on a
    # deterministic error.
    import traceback

    try:
        return _returned(_handle(payload))
    except Exception as err:  # noqa: BLE001 - the whole point is to report it
        return _returned(
            {
                "state": "failed",
                "error": "%s: %s" % (type(err).__name__, err),
                "trace": traceback.format_exc()[-2000:],
            }
        )


def _returned(result):
    """Return the result AND leave a copy behind as a retrievable file.

    `GET /v2/task/{id}/` does **not** echo a handler's return value — measured
    2026-08-19, when a task that completed successfully still came back with
    `result: null` and `outputs: []`. `beam/comfy/README.md` listed that as an
    open question; this is the answer, and it is why the ComfyUI worker has done
    the same thing all along.

    So the return value travels as a saved file. `src/providers/beam.ts` already
    reads `result.json` out of `outputs` this way, and the weights route does
    the same.
    """
    import json
    import os
    import tempfile

    try:
        path = os.path.join(tempfile.mkdtemp(prefix="lab-control-"), "result.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(result, handle)
        Output(path=path).save()
    except Exception as err:  # noqa: BLE001
        print("comfy-lab-control - could not save result.json: %s" % err)
    return result


def _handle(payload):
    action = payload.get("action") or "start"

    if action == "ping":
        # Touches no SDK and no import. If this answers, the deployment and
        # the argument binding are fine and the fault is further in.
        import os

        token = os.environ.get("BEAM_TOKEN") or ""
        return {"state": "ok", "tokenLen": len(token)}

    if action == "status":
        running = _running_containers()
        if not running:
            return {"state": "stopped"}
        container = running[0]
        return {
            "state": "running",
            "containerId": container.container_id,
            "url": _url_for(container.container_id),
        }

    if action == "stop":
        from beta9.clients.gateway import StopContainerRequest

        targets = [payload["containerId"]] if payload.get("containerId") else [
            c.container_id for c in _running_containers()
        ]
        if not targets:
            return {"state": "stopped", "stopped": []}

        service = _service()
        stopped = []
        for container_id in targets:
            res = service.gateway.stop_container(StopContainerRequest(container_id=container_id))
            if res.ok:
                stopped.append(container_id)
        return {"state": "stopped", "stopped": stopped}

    if action != "start":
        return {"error": "unknown action: %s" % action}

    # Idempotent on purpose. A second click, a double-submit or a stale tab must
    # not start a second RTX 5090 — the existing one is returned instead.
    running = _running_containers()
    if running:
        container = running[0]
        return {
            "state": "running",
            "containerId": container.container_id,
            "url": _url_for(container.container_id),
            "reused": True,
        }

    # Imported here, not at module scope. `app.py` builds an Image and a Pod
    # at import time, and when that raised inside the container the module
    # never loaded: the task failed with an empty result and my own
    # try/except — which lives inside the function — never ran. Importing
    # lazily means any failure in it is reported like every other one.
    from app import comfyui

    res = comfyui.create()
    if not res.ok:
        return {"state": "failed", "error": res.error_msg or "Beam refused to create the pod"}
    return {
        "state": "running",
        "containerId": res.container_id,
        "url": res.url or _url_for(res.container_id),
        "reused": False,
    }
