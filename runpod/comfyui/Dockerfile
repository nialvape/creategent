# ComfyUI serverless worker — MiniMax H3 (quantized) video+audio.
#
# Why ComfyUI and not diffusers like runpod/wan:
#   The official MiniMaxAI/MiniMax-H3 diffusers repo is ~135 GB for the FL2VA
#   branch alone, and transformer + qwen3vl-32b text encoder together exceed the
#   80 GB of an H100 (MiniMax's own README deploys it across 4 GPUs). The int8 /
#   nvfp4 builds are ComfyUI single-file format and are the only variants that
#   fit one GPU.
#
# Why we rebuild ComfyUI instead of using the stock worker:
#   runpod/worker-comfyui's newest tag (5.8.6) is from 2026-06-17; H3 shipped in
#   2026-08, so the pinned ComfyUI predates the H3 nodes. We inherit the worker's
#   handler (it already speaks the workflow-JSON contract) and pull ComfyUI to
#   master on top.
#
# Base tag note: deliberately NOT the -cuda12.8.1 variant. A CUDA 12.8 base is
# what broke the earlier chatterbox/wan workers at container start
# ("nvidia-container-cli: unsatisfied condition: cuda>=12.8" on older-driver
# hosts). Keep the default base unless the whole fleet is verified on 12.8.
FROM runpod/worker-comfyui:5.8.6-base

# COMFYUI_PATH is where the base image keeps its ComfyUI checkout. If a future
# base tag moves it, this is the one line to change.
ENV COMFYUI_PATH=/comfyui

# Pull ComfyUI to master so the H3 model/sampler nodes exist, then reinstall its
# requirements in case the bump added any.
RUN cd "$COMFYUI_PATH" \
    && git fetch --depth=1 origin master \
    && git reset --hard FETCH_HEAD \
    && pip install --no-cache-dir -r requirements.txt

# Weights are NOT baked in — they come from the network volume at runtime.
# extra_model_paths.yaml points ComfyUI at the volume so the image stays small
# and the same weights can back several endpoints.
COPY runpod/comfyui/extra_model_paths.yaml /comfyui/extra_model_paths.yaml
