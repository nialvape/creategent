# Wan image-to-video serverless worker.
# Weights come from the network volume (MODEL_PATH=/runpod-volume/Wan2.2-I2V).
FROM runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404

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

COPY handler.py /app/handler.py

CMD ["python", "-u", "handler.py"]
