# Chatterbox TTS serverless worker.
# Weights are NOT baked in — they come from the network volume at runtime
# (MODEL_PATH=/runpod-volume/chatterbox), so this image stays small.
FROM runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404

WORKDIR /app

# chatterbox-tts pulls its own deps; torch/torchaudio are already in the base.
RUN pip install --no-cache-dir runpod chatterbox-tts

COPY handler.py /app/handler.py

# Serverless workers just run the handler; no Jupyter/SSH.
CMD ["python", "-u", "handler.py"]
