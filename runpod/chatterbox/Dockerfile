# Chatterbox TTS serverless worker.
# Weights are NOT baked in — they come from the network volume at runtime
# (MODEL_PATH=/runpod-volume/chatterbox), so this image stays small.
#
# Base: torch 2.6.0 + CUDA 12.4. chatterbox-tts pins torch==2.6.0, so this base
# matches it exactly (no torch reinstall). CUDA 12.4 (not 12.8) so the container
# starts on hosts with older NVIDIA drivers.
FROM pytorch/pytorch:2.6.0-cuda12.4-cudnn9-devel

WORKDIR /app

# torch/torchaudio 2.6.0 are already in the base; this just adds the SDK + TTS.
RUN pip install --no-cache-dir runpod chatterbox-tts

# RunPod's GitHub builder uses the REPO ROOT as the build context, so this path
# is repo-root-relative (not relative to this Dockerfile's folder).
COPY runpod/chatterbox/handler.py /app/handler.py

# Serverless workers just run the handler; no Jupyter/SSH.
CMD ["python", "-u", "handler.py"]
