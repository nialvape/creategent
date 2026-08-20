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

from beam import Image, Volume, task_queue  # noqa: F401  (Volume via app import)

from app import comfyui

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
    return URL_TEMPLATE % (container_id.removeprefix("pod-"), POD_PORT)


def _running_containers():
    """Every running container, with the stub id that identifies what it is."""
    from beta9.channel import ServiceClient
    from beta9.clients.gateway import ListContainersRequest

    service = ServiceClient()
    res = service.gateway.list_containers(ListContainersRequest())
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
    action = payload.get("action") or "start"

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
        from beta9.channel import ServiceClient
        from beta9.clients.gateway import StopContainerRequest

        targets = [payload["containerId"]] if payload.get("containerId") else [
            c.container_id for c in _running_containers()
        ]
        if not targets:
            return {"state": "stopped", "stopped": []}

        service = ServiceClient()
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

    res = comfyui.create()
    if not res.ok:
        return {"state": "failed", "error": res.error_msg or "Beam refused to create the pod"}
    return {
        "state": "running",
        "containerId": res.container_id,
        "url": res.url or _url_for(res.container_id),
        "reused": False,
    }
