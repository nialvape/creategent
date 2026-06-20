# Wan image-to-video serverless worker.
# Weights come from the network volume (MODEL_PATH=/runpod-volume/Wan2.2-I2V).
#
# Base: torch 2.6.0 + CUDA 12.4 — CUDA 12.4 (not 12.8) so the container starts
# on hosts with older NVIDIA drivers.
FROM pytorch/pytorch:2.6.0-cuda12.4-cudnn9-devel

WORKDIR /app

# diffusers must be recent enough to include WanImageToVideoPipeline.
RUN pip install --no-cache-dir \
    runpod \
    "diffusers>=0.34.0" \
    transformers \
    accelerate \
    ftfy \
    imageio \
    imageio-ffmpeg

# RunPod's GitHub builder uses the REPO ROOT as the build context, so this path
# is repo-root-relative (not relative to this Dockerfile's folder).
COPY runpod/wan/handler.py /app/handler.py

CMD ["python", "-u", "handler.py"]
