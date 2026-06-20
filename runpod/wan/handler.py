"""
RunPod serverless handler — Wan image-to-video.

Contract (must match src/providers/runpod.ts):
  input:  { "prompt": str, "image_url": str, "width": int, "height": int, "duration": number }
  output: { "video_b64": str (mp4) }

Weights live on the network volume (MODEL_PATH). Loaded ONCE at cold start.

NOTE: this uses the diffusers WanImageToVideoPipeline, which expects the model
directory in *diffusers* layout. If your /runpod-volume/Wan2.2-I2V is the original
Wan repo format, either convert it to diffusers format or swap the load/inference
block for Wan's own `wan` package — keep the input/output contract identical.
"""

import base64
import os
import tempfile

import runpod
import torch
from diffusers import WanImageToVideoPipeline
from diffusers.utils import export_to_video, load_image

MODEL_PATH = os.environ.get("MODEL_PATH", "/runpod-volume/Wan2.2-I2V")
FPS = int(os.environ.get("WAN_FPS", "16"))
DEVICE = "cuda"

PIPE = WanImageToVideoPipeline.from_pretrained(MODEL_PATH, torch_dtype=torch.bfloat16)
# A14B/14B variants may not fit fully in VRAM — uncomment to offload:
# PIPE.enable_model_cpu_offload()
PIPE.to(DEVICE)
print(f"[wan] pipeline ready on {DEVICE}")


def handler(event):
    inp = event.get("input", {}) or {}
    image_url = inp.get("image_url")
    if not image_url:
        return {"error": "missing 'image_url'"}

    prompt = inp.get("prompt", "")
    width = int(inp.get("width", 720))
    height = int(inp.get("height", 1280))
    duration = float(inp.get("duration", 5))
    num_frames = int(duration * FPS) + 1

    image = load_image(image_url).resize((width, height))

    result = PIPE(
        image=image,
        prompt=prompt,
        height=height,
        width=width,
        num_frames=num_frames,
    )
    frames = result.frames[0]

    tmp = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
    tmp.close()
    try:
        export_to_video(frames, tmp.name, fps=FPS)
        with open(tmp.name, "rb") as f:
            video_b64 = base64.b64encode(f.read()).decode("utf-8")
    finally:
        os.unlink(tmp.name)

    return {"video_b64": video_b64}


runpod.serverless.start({"handler": handler})
