# RunPod serverless workers

These are the GPU handlers behind CreateGent's self-hosted models. The app
(`src/providers/runpod.ts`) calls each endpoint with a small JSON `input` and
expects a small JSON `output`. The weights are NOT in these images — they load
from the network volume (`fs37zsln52`) at runtime, so the images stay tiny.

| Folder         | Endpoint                  | Endpoint ID      | GPU        | input → output |
|----------------|---------------------------|------------------|------------|----------------|
| `chatterbox/`  | creategent-chatterbox-tts | `09bw6q1blhayzg` | RTX 5090   | `{text, reference_audio_b64?, language_id?}` → `{audio_b64, sample_rate}` |
| `wan/`         | creategent-wan26-i2v      | `0urbbihiwowt7f` | H100 80GB  | `{prompt, image_url, width, height, duration}` → `{video_b64}` |
| musetalk       | creategent-musetalk-avatar| `ebkllrlml5kij3` | RTX 4090   | (not built yet — talking-head lip-sync, for later) |

## 1. Build & push each image

Build on linux/amd64 (RunPod is amd64). From `runpod/`:

```bash
# Docker Hub example — replace YOURUSER
docker buildx build --platform linux/amd64 -t YOURUSER/creategent-chatterbox:latest chatterbox --push
docker buildx build --platform linux/amd64 -t YOURUSER/creategent-wan:latest        wan        --push
```

If the repo is **private**, register the pull credentials with RunPod first
(Console → Settings → Container Registry Auth, or ask me to run
`create-container-registry-auth`).

## 2. Point each endpoint at its image

The endpoints currently use **pod-style templates** (Jupyter + SSH, no handler) —
that's why jobs queue forever with no worker. Convert each to a serverless worker:

**RunPod Console** → Serverless → **New Endpoint** → "Import Git Repository" →
pick `nialvape/creategent`, then:
- **Branch** = `master`
- **Dockerfile Path** = `runpod/chatterbox/Dockerfile` (or `runpod/wan/Dockerfile`)
  — RunPod's GitHub builder uses the **repo root** as the build context (there is
  no separate build-context field), which is why the Dockerfiles `COPY` from
  repo-root-relative paths.
- Next → **GPU** (RTX 5090 for chatterbox, H100 for wan), **env vars**
  (`MODEL_PATH`, `HF_HOME`), workers min 0.
- After it's created, open the endpoint settings to attach the **Network Volume**
  (`fs37zsln52`) and bump **Container Disk** (~15–20 GB) if those weren't offered
  during creation.

## 3. Smoke-test the endpoint

In the Console's **Requests** tab, or ask me to fire a `runsync` test:

```jsonc
// chatterbox
{ "input": { "text": "Hey guys, welcome back to my channel." } }
// wan
{ "input": { "prompt": "slow push-in, gym lighting", "image_url": "https://.../frame.jpg",
             "width": 720, "height": 1280, "duration": 5 } }
```

First call is a cold start (loads weights from the volume) — give it a minute.

## 4. Use from the app

Wiring is already done — nothing else to change:

1. Put your RunPod API key in `.env.local`: `RUNPOD_API_KEY=rpa_...`
   (endpoint IDs default to the ones above; override with `RUNPOD_WAN_ENDPOINT_ID`
   / `RUNPOD_CHATTERBOX_ENDPOINT_ID` if they ever change).
2. `runpod/wan-2.6-i2v` and `runpod/chatterbox` are the **default** video/audio
   models, so a normal generation already routes to your GPUs.
3. **Off-voice cloning:** drop a public URL to a voice sample in
   **Project → Settings → Voice Clone Reference**. Every voiceover in that project
   is then synthesized in that voice.

## The ComfyUI worker (`comfyui/`) speaks a different contract

The other workers take a small purpose-built JSON body. The ComfyUI one takes an
entire API-format graph plus its input files, so one image can run any workflow:

```jsonc
// input
{ "workflow": { /* API-format graph */ },
  "files": [{ "name": "voice.wav", "data": "<base64>" }] }

// output
{ "files": [{ "node_id": "12", "key": "audio", "filename": "voice.flac",
              "mime": "audio/flac", "encoding": "base64", "size": 812345,
              "data": "<base64 or URL>" }],
  "values": [{ "node_id": "14", "key": "text", "value": ["..."] }],
  "images": [ /* the same files, in the legacy shape */ ],
  "errors": ["..."] }
```

That contract is implemented once, in `comfy_worker/` at the repo root, and is
shared with the Beam backend so the two cannot drift. `runpod/comfyui/handler.py`
is a thin RunPod entrypoint over it — the stock `worker-comfyui` handler is kept
in the image as `/upstream_handler.py` and everything except the job body is
imported from it.

**Why we override the stock handler at all:** it reads `node_output["images"]`
and logs every other key as "unhandled output keys" before dropping it. LTX-2.5
only works on it by luck, because `SaveVideo` reports its mp4 through
`PreviewVideo`, which writes under `images`. A graph with a `SaveAudio` node
returns success with nothing in it. Inputs were never the problem: ComfyUI's
`/upload/image` writes raw bytes under the filename it is given and never looks
at them, so audio and video always rode that channel fine.

**Both sides are compatible in both directions.** The worker accepts `images` as
an alias for `files`; the app (`src/lib/comfy/transport.ts`) reads `files` when
present and falls back to `images`. So the image and the app can be redeployed
independently. What the app sends is declared per endpoint by `contract` in
`src/providers/runpod.ts`, and only one key is ever sent — putting the same
base64 under both would double the payload against RunPod's 10 MiB body limit.

> **After rebuilding the endpoint from `runpod/comfyui/Dockerfile`,** flip that
> endpoint's `contract` to `'generic'` (or set `RUNPOD_COMFYUI_CONTRACT=generic`).
> Until then the worker is still the stock one and non-image outputs are
> discarded on the GPU, whatever the app asks for.
>
> RunPod's GitHub builder may keep serving the previous image after a push —
> terminate the stale worker in the Console to force the new one.

## Heads-up: Spanish voiceovers

Base Chatterbox is English-only. For Spanish (and the gym-girl idea is in Spanish),
download the **multilingual** Chatterbox checkpoint to the volume and set
`CHATTERBOX_MULTILINGUAL=1` on the endpoint. The handler then accepts a
`language_id` (e.g. `"es"`). The app doesn't send `language_id` yet — ping me and
I'll wire `plan.contentLanguages` through to the TTS call.
