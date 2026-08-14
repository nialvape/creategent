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
# Base tag note: this worker MUST use the -cuda12.8.1 variant, which is the
# opposite of the rule chatterbox/wan follow. The default 5.8.6-base ships CUDA
# 12.6.3 (NVIDIA_REQUIRE_CUDA=cuda>=12.6), and Blackwell (sm_120) needs 12.8+,
# so the RTX PRO 6000 this endpoint targets cannot initialize on it.
#
# chatterbox/wan avoid a 12.8 base because it fails at container start on
# older-driver hosts ("nvidia-container-cli: unsatisfied condition: cuda>=12.8").
# That failure mode cannot reach this worker: the endpoint is pinned to the
# BLACKWELL_96 pool, and every Blackwell host has a driver new enough for 12.8.
FROM runpod/worker-comfyui:5.8.6-base-cuda12.8.1

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

# Our handler replaces the stock one, which only ever returns a node's `images`
# output and drops audio, video and text with a log line. Keep the original
# alongside it: everything except the job body is imported from it, so this is a
# thin override rather than a fork. `/start.sh` runs `/handler.py`, so the swap
# needs no change to the entrypoint.
RUN cp /handler.py /upstream_handler.py
COPY comfy_worker /comfy_worker
COPY runpod/comfyui/handler.py /handler.py
