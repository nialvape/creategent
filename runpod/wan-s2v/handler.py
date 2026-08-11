"""
RunPod serverless handler — Wan2.2-S2V-14B (Speech-to-Video / talking avatar).

This is the AUDIO-DRIVEN sibling of the wan/ i2v worker. It animates a portrait
so the lips/expression follow a speech clip — the real lip-sync avatar model.

Contract (must match generateAvatarVideo in src/providers/runpod.ts):
  input:  { "image_url": str, "audio_b64": str (wav/mp3),
            "prompt"?: str, "size"?: str, "num_clip"?: int, "seed"?: int }
  output: { "video_b64": str (mp4) }

Weights live on the network volume (CKPT_DIR = /runpod-volume/Wan2.2-S2V-14B),
downloaded once (see runpod/README.md). The model is built ONCE at cold start and
kept warm across invocations on the same worker — reloading 44GB per call would
make serverless unusable.

Inference uses Wan's OWN repo (cloned into the image at /app/Wan2.2), not diffusers:
there is no diffusers S2V pipeline, so we drive `wan.WanS2V` directly. The API here
mirrors the s2v-14B branch of the repo's generate.py.
"""

import base64
import os
import tempfile
import urllib.request

import runpod
import wan
from wan.configs import WAN_CONFIGS, MAX_AREA_CONFIGS
from wan.utils.utils import save_video

CKPT_DIR = os.environ.get("CKPT_DIR", "/runpod-volume/Wan2.2-S2V-14B")
TASK = "s2v-14B"
# Default render area. Aspect ratio follows the input image; this only sets the
# pixel budget. "1024*704" is the size used in the official single-GPU example.
DEFAULT_SIZE = os.environ.get("WAN_S2V_SIZE", "1024*704")
# offload_model + convert_model_dtype keep the 14B model within an 80GB card
# (this is what the official single-GPU command uses). Set WAN_S2V_T5_CPU=1 to
# also push the umT5-XXL text encoder to CPU if you hit OOM on a tighter card.
T5_CPU = os.environ.get("WAN_S2V_T5_CPU", "0") == "1"

cfg = WAN_CONFIGS[TASK]
MODEL = wan.WanS2V(
    config=cfg,
    checkpoint_dir=CKPT_DIR,
    device_id=0,
    rank=0,
    t5_fsdp=False,
    dit_fsdp=False,
    use_sp=False,
    t5_cpu=T5_CPU,
    convert_model_dtype=True,
)
print(f"[wan-s2v] model ready from {CKPT_DIR} (t5_cpu={T5_CPU})")


def _download_to_temp(url: str, suffix: str) -> str:
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    tmp.close()
    urllib.request.urlretrieve(url, tmp.name)
    return tmp.name


def _b64_to_temp(b64: str, suffix: str) -> str:
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    tmp.write(base64.b64decode(b64))
    tmp.flush()
    tmp.close()
    return tmp.name


def handler(event):
    inp = event.get("input", {}) or {}
    image_url = inp.get("image_url")
    audio_b64 = inp.get("audio_b64")
    if not image_url:
        return {"error": "missing 'image_url'"}
    if not audio_b64:
        return {"error": "missing 'audio_b64'"}

    prompt = inp.get("prompt", "")
    size = inp.get("size", DEFAULT_SIZE)
    if size not in MAX_AREA_CONFIGS:
        return {"error": f"unsupported size '{size}'; expected one of {list(MAX_AREA_CONFIGS)}"}

    image_path = _download_to_temp(image_url, ".jpg")
    audio_path = _b64_to_temp(audio_b64, ".wav")
    out = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
    out.close()

    try:
        video = MODEL.generate(
            input_prompt=prompt,
            ref_image_path=image_path,
            audio_path=audio_path,
            # num_repeat drives length: each "clip" is ~infer_frames long. The
            # audio length ultimately bounds how many clips are rendered.
            num_repeat=int(inp["num_clip"]) if inp.get("num_clip") else None,
            pose_video=None,
            max_area=MAX_AREA_CONFIGS[size],
            sampling_steps=int(inp.get("sampling_steps", 40)),
            guide_scale=float(inp.get("guide_scale", 4.5)),
            seed=int(inp.get("seed", -1)),
            offload_model=True,
        )
        save_video(
            tensor=video[None],
            save_file=out.name,
            fps=cfg.sample_fps,
            normalize=True,
            value_range=(-1, 1),
        )
        with open(out.name, "rb") as f:
            video_b64 = base64.b64encode(f.read()).decode("utf-8")
    finally:
        for p in (image_path, audio_path, out.name):
            try:
                os.unlink(p)
            except OSError:
                pass

    return {"video_b64": video_b64}


runpod.serverless.start({"handler": handler})
