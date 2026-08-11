# Wan2.2-S2V-14B serverless worker — audio-driven talking-avatar (speech-to-video).
# Weights are NOT baked in — they load from the network volume at runtime
# (CKPT_DIR=/runpod-volume/Wan2.2-S2V-14B). The IMAGE ships Wan's inference CODE.
#
# Base: torch 2.6.0 + CUDA 12.4 — same base as the other workers, so the CUDA
# version starts on the host driver fleet (12.4, not 12.8).
FROM pytorch/pytorch:2.6.0-cuda12.4-cudnn9-devel

WORKDIR /app

# git for cloning Wan's repo; ffmpeg for encoding the output mp4.
RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Wan's inference code (there is no pip package — the `wan` module lives in the repo).
# Pin to a commit for reproducibility if a build ever drifts.
RUN git clone --depth 1 https://github.com/Wan-Video/Wan2.2.git /app/Wan2.2

WORKDIR /app/Wan2.2

# Install Wan's deps. torch/torchaudio 2.6.0 are already in the base image.
# flash-attn is the fragile one: building it from source is slow and can OOM the
# builder, so install it with --no-build-isolation (uses the base image's torch)
# and give ninja plenty of workers. If the GitHub build keeps failing on
# flash-attn, pin a prebuilt wheel matching torch2.6/cu124/cp311 instead.
RUN pip install --no-cache-dir packaging ninja
RUN MAX_JOBS=4 pip install --no-cache-dir flash-attn --no-build-isolation || true
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install --no-cache-dir runpod

# RunPod's GitHub builder uses the REPO ROOT as build context, so this COPY path
# is repo-root-relative (not relative to this Dockerfile's folder).
COPY runpod/wan-s2v/handler.py /app/Wan2.2/handler.py

# The handler imports `wan` from the cloned repo.
ENV PYTHONPATH=/app/Wan2.2

CMD ["python", "-u", "handler.py"]
