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

## Heads-up: Spanish voiceovers

Base Chatterbox is English-only. For Spanish (and the gym-girl idea is in Spanish),
download the **multilingual** Chatterbox checkpoint to the volume and set
`CHATTERBOX_MULTILINGUAL=1` on the endpoint. The handler then accepts a
`language_id` (e.g. `"es"`). The app doesn't send `language_id` yet — ping me and
I'll wire `plan.contentLanguages` through to the TTS call.
