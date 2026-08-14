"""A minimal HTTP client for a ComfyUI process running in the same container.

Why this is not used by the RunPod entrypoint
---------------------------------------------
`runpod/worker-comfyui` already ships an equivalent, and parts of it are tied to
that image: `check_server` reads the PID file `start.sh` writes, so it can tell
"ComfyUI is slow to boot" from "ComfyUI crashed". There is no such file on Beam.
So the *plumbing* is host-specific by nature and each entrypoint uses the one
that fits, while the part that actually has to agree — what a job accepts and
what it returns, in `contract.py` — is shared.

This client polls `/history` rather than listening on the websocket. It is a few
lines instead of a reconnect state machine, and for jobs measured in minutes the
poll interval is free.
"""

import json
import time
import urllib.parse
import uuid

import requests


class ComfyError(RuntimeError):
    """ComfyUI refused the graph or failed while running it."""


def wait_for_server(base_url, timeout_s=600, poll_s=1.0):
    """Block until ComfyUI answers, or raise.

    Generous by default: on a cold container this waits out a full ComfyUI boot,
    which with a mounted model volume is not fast.
    """
    deadline = time.time() + timeout_s
    last_err = None

    while time.time() < deadline:
        try:
            res = requests.get("%s/system_stats" % base_url, timeout=5)
            if res.ok:
                return True
        except requests.RequestException as err:
            last_err = err
        time.sleep(poll_s)

    raise ComfyError("ComfyUI did not become reachable at %s (%s)" % (base_url, last_err))


def upload_file(base_url, name, b64_data):
    """Upload one input file into ComfyUI's `input/` directory.

    The endpoint is called `/upload/image` and the multipart field is called
    `image`, but ComfyUI writes the raw bytes under the filename it is given and
    never inspects them — so this is how audio, video and masks get in too. The
    extension is what decides how the graph's loader reads the file.
    """
    import base64

    payload = b64_data.split(",", 1)[1] if "," in b64_data else b64_data
    blob = base64.b64decode(payload)

    res = requests.post(
        "%s/upload/image" % base_url,
        files={
            "image": (name, blob, "application/octet-stream"),
            "overwrite": (None, "true"),
        },
        timeout=120,
    )
    res.raise_for_status()
    return res.json()


def queue_prompt(base_url, workflow, client_id=None, comfy_org_api_key=None):
    """Submit the graph. Returns its prompt id."""
    body = {"prompt": workflow, "client_id": client_id or str(uuid.uuid4())}

    headers = {"Content-Type": "application/json"}
    if comfy_org_api_key:
        headers["Authorization"] = "Bearer %s" % comfy_org_api_key

    res = requests.post(
        "%s/prompt" % base_url, data=json.dumps(body), headers=headers, timeout=60
    )

    if res.status_code >= 400:
        # ComfyUI reports a rejected graph as a structured 400 — node id, the
        # offending input, and why. Surfacing it beats "HTTP 400".
        try:
            detail = json.dumps(res.json(), indent=2)
        except ValueError:
            detail = res.text
        raise ComfyError("ComfyUI rejected the workflow (%s):\n%s" % (res.status_code, detail))

    prompt_id = res.json().get("prompt_id")
    if not prompt_id:
        raise ComfyError("ComfyUI accepted the workflow but returned no prompt_id")
    return prompt_id


def wait_for_prompt(base_url, prompt_id, timeout_s=1800, poll_s=2.0):
    """Poll until the prompt appears in history. Returns `(outputs, errors)`.

    A prompt id shows up in `/history` only once it is finished, which makes
    presence the completion signal. Errors are read from the history entry's
    status messages, so a graph that died halfway still reports why — and any
    file it managed to write is still in `outputs` for the caller to collect.
    """
    deadline = time.time() + timeout_s

    while time.time() < deadline:
        try:
            res = requests.get("%s/history/%s" % (base_url, prompt_id), timeout=30)
            res.raise_for_status()
            history = res.json()
        except requests.RequestException:
            # A dropped poll is not a failed job; the next one will tell us.
            time.sleep(poll_s)
            continue

        entry = history.get(prompt_id)
        if entry is not None:
            return entry.get("outputs", {}), _status_errors(entry)

        time.sleep(poll_s)

    raise ComfyError(
        "ComfyUI did not finish prompt %s within %ds" % (prompt_id, timeout_s)
    )


def _status_errors(entry):
    """Pull human-readable failures out of a history entry's status block."""
    status = entry.get("status") or {}
    if status.get("status_str") == "success":
        return []

    errors = []
    for message in status.get("messages") or []:
        # Each message is [event_name, payload].
        if not isinstance(message, (list, tuple)) or len(message) != 2:
            continue
        event, payload = message
        if event == "execution_error" and isinstance(payload, dict):
            errors.append(
                "Workflow execution error — Node Type: %s, Node ID: %s, Message: %s"
                % (
                    payload.get("node_type"),
                    payload.get("node_id"),
                    payload.get("exception_message"),
                )
            )
        elif event == "execution_interrupted":
            errors.append("Workflow execution was interrupted")

    if not errors and status.get("status_str"):
        errors.append("Workflow finished with status '%s'" % status["status_str"])
    return errors


def make_fetcher(base_url, timeout_s=120):
    """Build the `fetch(filename, subfolder, folder)` that `collect_outputs` needs."""

    def fetch(filename, subfolder, folder):
        query = urllib.parse.urlencode(
            {"filename": filename, "subfolder": subfolder, "type": folder}
        )
        try:
            res = requests.get("%s/view?%s" % (base_url, query), timeout=timeout_s)
            res.raise_for_status()
            return res.content
        except requests.RequestException as err:
            print("comfy-worker - could not fetch %s: %s" % (filename, err))
            return None

    return fetch
