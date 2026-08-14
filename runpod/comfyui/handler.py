"""RunPod entrypoint for the ComfyUI worker.

This REPLACES the handler that ships in `runpod/worker-comfyui`. The stock one
is preserved in the image as `/upstream_handler.py` and every piece of plumbing
is imported from it — server health checks, the upload endpoint, queueing, the
history fetch, `/view`, websocket reconnection. None of that is reimplemented
here, so a base-image bump keeps working.

What IS reimplemented is the job body, for one reason: the stock handler reads
`node_output["images"]` and logs everything else as "unhandled output keys"
before dropping it. CreateGent runs arbitrary graphs, and a `SaveAudio` node
returning nothing while the job reports success is not a failure mode we can
live with. See `comfy_worker/contract.py` for the full argument and the shape.

The websocket wait loop below is adapted from the stock handler rather than
imported, because upstream keeps it inline inside `handler()` with the
image-only collection it exists to feed.
"""

import json
import os
import tempfile
import traceback
import uuid

import requests
import runpod
import websocket
from runpod.serverless.utils import rp_upload

# The stock handler, kept alongside ours by the Dockerfile. If a future base
# image moves it, this import and the `cp` in the Dockerfile are the two lines
# to change.
import upstream_handler as upstream

from comfy_worker import build_result, collect_outputs, normalize_input

COMFY_HOST = upstream.COMFY_HOST


def _fetch(filename, subfolder, folder):
    """Pull one produced file out of ComfyUI. Any type — /view is content-blind."""
    return upstream.get_image_data(filename, subfolder, folder)


def _make_uploader(job_id):
    """Object-storage uploader, or None when the worker has no bucket configured.

    Without this every artifact comes back base64 in the job output, which is
    fine for one short mp4 and hopeless for a graph that emits video plus a
    separate audio track.
    """
    if not os.environ.get("BUCKET_ENDPOINT_URL"):
        return None

    def upload(filename, data):
        suffix = os.path.splitext(filename)[1] or ".bin"
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
                temp_file.write(data)
                temp_path = temp_file.name
            # Named `upload_image`, but it is extension-driven and type-blind.
            return rp_upload.upload_image(job_id, temp_path)
        finally:
            if temp_path and os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except OSError as err:
                    print("creategent-comfyui - could not remove %s: %s" % (temp_path, err))

    return upload


# How many consecutive websocket read timeouts before we stop trusting the
# socket and ask ComfyUI directly whether the job is done. The socket timeout is
# 10s, so this is roughly a minute of silence.
#
# Upstream waits on the websocket alone, which turns a single missed `executing`
# frame into a job that hangs until the caller's timeout fires — 25 minutes, for
# a video that finished in three. A prompt id present in /history means the
# prompt is finished, so this is a cheap, authoritative second opinion.
_HISTORY_FALLBACK_AFTER_TIMEOUTS = 6


def _wait_for_execution(ws, ws_url, prompt_id, errors):
    """Block until the prompt finishes or errors.

    Returns `(completed, ws)` — the socket comes back because a reconnect
    replaces it, and the caller owns closing it.

    Adapted from the stock handler's inline loop; the reconnection helper is
    still upstream's.
    """
    idle_timeouts = 0

    while True:
        try:
            out = ws.recv()
            if not isinstance(out, str):
                continue

            idle_timeouts = 0
            message = json.loads(out)
            msg_type = message.get("type")

            if msg_type == "status":
                remaining = (
                    message.get("data", {})
                    .get("status", {})
                    .get("exec_info", {})
                    .get("queue_remaining", "N/A")
                )
                print("creategent-comfyui - %s item(s) remaining in queue" % remaining)
            elif msg_type == "executing":
                data = message.get("data", {})
                if data.get("node") is None and data.get("prompt_id") == prompt_id:
                    print("creategent-comfyui - execution finished for %s" % prompt_id)
                    return True, ws
            elif msg_type == "execution_error":
                data = message.get("data", {})
                if data.get("prompt_id") == prompt_id:
                    detail = "Node Type: %s, Node ID: %s, Message: %s" % (
                        data.get("node_type"),
                        data.get("node_id"),
                        data.get("exception_message"),
                    )
                    print("creategent-comfyui - execution error: %s" % detail)
                    errors.append("Workflow execution error: %s" % detail)
                    return False, ws

        except websocket.WebSocketTimeoutException:
            # Long sampling passes are silent for minutes; this is not a stall.
            idle_timeouts += 1
            if idle_timeouts >= _HISTORY_FALLBACK_AFTER_TIMEOUTS:
                idle_timeouts = 0
                try:
                    if prompt_id in upstream.get_history(prompt_id):
                        print(
                            "creategent-comfyui - %s is in history; the completion "
                            "frame was missed" % prompt_id
                        )
                        return True, ws
                except Exception as err:  # noqa: BLE001 - a probe must not fail the job
                    print("creategent-comfyui - history probe failed: %s" % err)
            continue
        except websocket.WebSocketConnectionClosedException as closed_err:
            ws = upstream._attempt_websocket_reconnect(
                ws_url,
                upstream.WEBSOCKET_RECONNECT_ATTEMPTS,
                upstream.WEBSOCKET_RECONNECT_DELAY_S,
                closed_err,
            )
            print("creategent-comfyui - resumed listening after reconnect")
            continue
        except json.JSONDecodeError:
            print("creategent-comfyui - ignoring invalid JSON websocket frame")


def handler(job):
    """Run one ComfyUI graph and return every file it produced."""
    if upstream.is_network_volume_debug_enabled():
        upstream.run_network_volume_diagnostics()

    job_input = job["input"]
    job_id = job["id"]

    validated, error_message = normalize_input(job_input)
    if error_message:
        return {"error": error_message}

    workflow = validated["workflow"]
    input_files = validated["files"]

    if not upstream.check_server(
        "http://%s/" % COMFY_HOST,
        upstream.COMFY_API_AVAILABLE_MAX_RETRIES,
        upstream.COMFY_API_AVAILABLE_INTERVAL_MS,
    ):
        return {"error": "ComfyUI server (%s) not reachable after multiple retries." % COMFY_HOST}

    if input_files:
        # `/upload/image` writes raw bytes under the filename it is given and
        # never inspects them, so this uploads audio and video just as happily.
        upload_result = upstream.upload_images(
            [{"name": f["name"], "image": f["data"]} for f in input_files]
        )
        if upload_result["status"] == "error":
            return {
                "error": "Failed to upload one or more input files",
                "details": upload_result["details"],
            }

    ws = None
    client_id = str(uuid.uuid4())
    errors = []

    try:
        ws_url = "ws://%s/ws?clientId=%s" % (COMFY_HOST, client_id)
        ws = websocket.WebSocket()
        ws.connect(ws_url, timeout=10)

        try:
            queued = upstream.queue_workflow(
                workflow,
                client_id,
                comfy_org_api_key=validated.get("comfy_org_api_key"),
            )
            prompt_id = queued.get("prompt_id")
            if not prompt_id:
                raise ValueError("Missing 'prompt_id' in queue response: %s" % queued)
            print("creategent-comfyui - queued workflow %s" % prompt_id)
        except requests.RequestException as err:
            raise ValueError("Error queuing workflow: %s" % err)

        completed, ws = _wait_for_execution(ws, ws_url, prompt_id, errors)

        # History is fetched even after an execution error: a graph that failed
        # at the last node may still have written the artifact we care about.
        history = upstream.get_history(prompt_id)
        if prompt_id not in history:
            msg = "Prompt ID %s not found in history after execution." % prompt_id
            if not errors:
                return {"error": msg}
            errors.append(msg)
            return {"error": "Job processing failed, prompt ID not found in history.", "details": errors}

        outputs = history.get(prompt_id, {}).get("outputs", {})
        if not outputs and not errors:
            errors.append("No outputs found in history for prompt %s." % prompt_id)

        files, values, collect_errors = collect_outputs(
            outputs, _fetch, _make_uploader(job_id)
        )
        errors.extend(collect_errors)

        if not completed and not errors:
            errors.append("Workflow monitoring ended without a completion signal.")

        print(
            "creategent-comfyui - collected %d file(s) and %d value(s)"
            % (len(files), len(values))
        )
        return build_result(files, values, errors)

    except websocket.WebSocketException as err:
        print(traceback.format_exc())
        return {"error": "WebSocket communication error: %s" % err}
    except requests.RequestException as err:
        print(traceback.format_exc())
        return {"error": "HTTP communication error with ComfyUI: %s" % err}
    except ValueError as err:
        print(traceback.format_exc())
        return {"error": str(err)}
    except Exception as err:  # noqa: BLE001 - the worker must answer, always
        print(traceback.format_exc())
        return {"error": "An unexpected error occurred: %s" % err}
    finally:
        if ws and ws.connected:
            ws.close()


if __name__ == "__main__":
    print("creategent-comfyui - starting handler...")
    runpod.serverless.start({"handler": handler})
