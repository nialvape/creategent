"""The job contract: what a ComfyUI worker accepts, and what it gives back.

Why this file exists at all
---------------------------
The stock `runpod/worker-comfyui` handler is image-shaped in both directions,
and only one of those halves is a real limit:

*Input* is generic by accident. The handler base64-decodes each entry of
`images` and POSTs it to ComfyUI's `/upload/image` with a hardcoded
`image/png` content type — but ComfyUI's `image_upload` ignores the MIME
entirely, takes `image.filename` and writes the raw bytes into its `input/`
directory. An `.mp3` or `.mp4` sent through that array lands correctly and
`LoadAudio`/`LoadVideo` find it, because their combo lists are rebuilt from the
input directory when the prompt is validated. So the name is a misnomer, not a
constraint.

*Output* is genuinely broken for anything but images. The stock handler reads
`node_output["images"]` and logs every other key as "unhandled output keys"
before dropping it. LTX-2.5 only works there by luck: `SaveVideo` reports its
mp4 through `PreviewVideo`, which writes under `images`. A `SaveAudio` node
emits under `audio`, and the job returns success with nothing in it.

Since CreateGent runs arbitrary graphs — lip-sync, s2v, audio-only passes — the
contract has to be symmetric: any file in, every produced file out.

The shape
---------
Input::

    {
      "workflow": { ... ComfyUI API-format graph ... },
      "files":  [{"name": "voice.wav", "data": "<base64>"}],   # any type
      "images": [{"name": "frame.png", "image": "<base64>"}],  # legacy alias
      "comfy_org_api_key": "..."                               # optional
    }

`files` and `images` are merged, in that order. Both are accepted forever:
`images` is what an older deployed worker understands, so the app can send both
and work against either side of a rebuild.

Output::

    {
      "files": [
        {
          "node_id": "9",
          "key": "audio",        # the node output key it came from
          "filename": "out.flac",
          "subfolder": "",
          "folder": "output",    # ComfyUI's own type: output | temp | input
          "mime": "audio/flac",
          "encoding": "base64",  # or "url" when an uploader is configured
          "size": 123456,        # bytes of the decoded file
          "data": "<base64 or URL>"
        }
      ],
      "values": [{"node_id": "12", "key": "text", "value": ["..."]}],
      "images": [{"filename": ..., "type": "base64", "data": ...}],  # legacy
      "errors": ["..."]
    }

`values` catches non-file outputs (a node that returns text, numbers, a
caption) so they are reported instead of silently dropped, which was the
original sin being fixed here.
"""

import base64
import mimetypes
import os

# mimetypes' table varies by platform and Python build; these are the ones a
# media graph actually emits, pinned so the app can trust `mime` for routing.
_MIME_OVERRIDES = {
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".wav": "audio/wav",
    ".webm": "video/webm",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".json": "application/json",
    ".txt": "text/plain",
}

DEFAULT_MIME = "application/octet-stream"

# ComfyUI writes previews into its `temp` directory and the real artifact into
# `output`. Returning both doubles the payload for a duplicate, which is why the
# stock handler skips temp — kept, for the same reason.
_SKIPPED_FOLDERS = ("temp",)


def mime_for(filename):
    """Best-effort MIME type for a produced file, never None."""
    ext = os.path.splitext(filename or "")[1].lower()
    if ext in _MIME_OVERRIDES:
        return _MIME_OVERRIDES[ext]
    guessed, _ = mimetypes.guess_type(filename or "")
    return guessed or DEFAULT_MIME


def normalize_input(job_input):
    """Validate and flatten a job input.

    Returns `(data, error)` where `data` is
    `{"workflow", "files", "comfy_org_api_key"}` and `files` is a list of
    `{"name", "data"}` ready to upload. Mirrors the stock handler's tolerance
    for a JSON string instead of an object.
    """
    if job_input is None:
        return None, "Please provide input"

    if isinstance(job_input, str):
        import json

        try:
            job_input = json.loads(job_input)
        except json.JSONDecodeError:
            return None, "Invalid JSON format in input"

    if not isinstance(job_input, dict):
        return None, "Input must be a JSON object"

    workflow = job_input.get("workflow")
    if workflow is None:
        return None, "Missing 'workflow' parameter"

    files = []

    raw_files = job_input.get("files")
    if raw_files is not None:
        if not isinstance(raw_files, list):
            return None, "'files' must be a list of objects with 'name' and 'data' keys"
        for entry in raw_files:
            if not isinstance(entry, dict) or "name" not in entry or "data" not in entry:
                return (
                    None,
                    "'files' must be a list of objects with 'name' and 'data' keys",
                )
            files.append({"name": entry["name"], "data": entry["data"]})

    # Legacy alias. Same channel, different key names — see the module docstring.
    raw_images = job_input.get("images")
    if raw_images is not None:
        if not isinstance(raw_images, list):
            return None, "'images' must be a list of objects with 'name' and 'image' keys"
        for entry in raw_images:
            if not isinstance(entry, dict) or "name" not in entry or "image" not in entry:
                return (
                    None,
                    "'images' must be a list of objects with 'name' and 'image' keys",
                )
            files.append({"name": entry["name"], "data": entry["image"]})

    return {
        "workflow": workflow,
        "files": files,
        "comfy_org_api_key": job_input.get("comfy_org_api_key"),
    }, None


def _is_file_entry(entry):
    """True for an output entry that names a file on disk."""
    return isinstance(entry, dict) and bool(entry.get("filename"))


def collect_outputs(outputs, fetch, uploader=None):
    """Turn ComfyUI's history `outputs` into the flat file list of the contract.

    `outputs` is `history[prompt_id]["outputs"]`: `{node_id: {key: [entry...]}}`.

    `fetch(filename, subfolder, folder) -> bytes | None` pulls one file (the
    `/view` endpoint, for both hosts).

    `uploader(filename, data) -> url | None` is optional. When present, files go
    to object storage and only the URL is returned — the escape hatch for
    payloads too large to inline, which is every multi-file audio+video job.
    A failed upload falls back to base64 rather than losing the artifact.

    Returns `(files, values, errors)`.
    """
    files = []
    values = []
    errors = []

    for node_id, node_output in (outputs or {}).items():
        if not isinstance(node_output, dict):
            continue

        for key, entries in node_output.items():
            # Some nodes report a bare value rather than a list of files.
            if not isinstance(entries, list):
                values.append({"node_id": node_id, "key": key, "value": entries})
                continue

            if entries and not any(_is_file_entry(e) for e in entries):
                values.append({"node_id": node_id, "key": key, "value": entries})
                continue

            for entry in entries:
                if not _is_file_entry(entry):
                    # A mixed list: keep the odd one out instead of dropping it.
                    if entry is not None:
                        values.append({"node_id": node_id, "key": key, "value": entry})
                    continue

                filename = entry.get("filename")
                subfolder = entry.get("subfolder", "") or ""
                folder = entry.get("type") or "output"

                if folder in _SKIPPED_FOLDERS:
                    continue

                data = fetch(filename, subfolder, folder)
                if not data:
                    errors.append(
                        "Failed to fetch %s (node %s, key %s) from /view"
                        % (filename, node_id, key)
                    )
                    continue

                record = {
                    "node_id": node_id,
                    "key": key,
                    "filename": filename,
                    "subfolder": subfolder,
                    "folder": folder,
                    "mime": mime_for(filename),
                    "size": len(data),
                }

                url = None
                if uploader is not None:
                    try:
                        url = uploader(filename, data)
                    except Exception as err:  # noqa: BLE001 - never lose the file
                        errors.append("Upload of %s failed (%s); inlining instead" % (filename, err))
                        url = None

                if url:
                    record["encoding"] = "url"
                    record["data"] = url
                else:
                    record["encoding"] = "base64"
                    record["data"] = base64.b64encode(data).decode("utf-8")

                files.append(record)

    return files, values, errors


def legacy_images(files):
    """Project the file list back onto the stock worker's `images` shape.

    The deployed app reads `output.images[]` and looks for an `.mp4`. Keeping
    that key populated means a rebuilt worker stays compatible with an app that
    has not been redeployed yet, and vice versa.
    """
    return [
        {
            "filename": f["filename"],
            "type": "s3_url" if f["encoding"] == "url" else "base64",
            "data": f["data"],
        }
        for f in files
    ]


def build_result(files, values, errors):
    """Assemble the final job output, including the failure cases.

    A job with no files and no errors is a real outcome (a graph whose only
    output is text), so it is reported as success rather than as the stock
    handler's `success_no_images`.
    """
    if not files and errors:
        return {"error": "Job processing failed", "details": errors}

    result = {"files": files, "images": legacy_images(files)}
    if values:
        result["values"] = values
    if errors:
        result["errors"] = errors
    return result
