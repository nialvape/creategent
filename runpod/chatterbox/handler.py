"""
RunPod serverless handler — Chatterbox TTS (+ zero-shot voice cloning).

Contract (must match src/providers/runpod.ts):
  input:  { "text": str, "reference_audio_b64"?: str, "language_id"?: str }
  output: { "audio_b64": str (wav), "sample_rate": int }

The model weights live on the network volume (MODEL_PATH). The model is loaded
ONCE at cold start and kept warm across invocations on the same worker.
"""

import base64
import io
import os
import tempfile

import runpod
import torch
import torchaudio as ta

MODEL_PATH = os.environ.get("MODEL_PATH", "/runpod-volume/chatterbox")
# Set CHATTERBOX_MULTILINGUAL=1 if you downloaded the multilingual checkpoint
# (needed for Spanish and other non-English voiceovers).
MULTILINGUAL = os.environ.get("CHATTERBOX_MULTILINGUAL", "0") == "1"
DEFAULT_LANG = os.environ.get("CHATTERBOX_LANGUAGE", "en")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


def _load_model():
    if MULTILINGUAL:
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS as TTS
    else:
        from chatterbox.tts import ChatterboxTTS as TTS
    # Prefer loading the local checkpoint from the volume; fall back to the HF
    # cache (HF_HOME also points at the volume) if the dir isn't a checkpoint.
    if os.path.isdir(MODEL_PATH) and os.listdir(MODEL_PATH):
        try:
            return TTS.from_local(MODEL_PATH, device=DEVICE)
        except Exception as exc:  # noqa: BLE001
            print(f"[chatterbox] from_local failed ({exc}); trying from_pretrained")
    return TTS.from_pretrained(device=DEVICE)


MODEL = _load_model()
print(f"[chatterbox] model ready on {DEVICE} (multilingual={MULTILINGUAL}, sr={MODEL.sr})")


def handler(event):
    inp = event.get("input", {}) or {}
    text = inp.get("text")
    if not text:
        return {"error": "missing 'text'"}

    # Voice cloning: write the reference sample to a temp wav and hand its path
    # to the model. Without it, Chatterbox uses its built-in default speaker.
    audio_prompt_path = None
    ref_b64 = inp.get("reference_audio_b64")
    if ref_b64:
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.write(base64.b64decode(ref_b64))
        tmp.flush()
        tmp.close()
        audio_prompt_path = tmp.name

    kwargs = {}
    if audio_prompt_path:
        kwargs["audio_prompt_path"] = audio_prompt_path
    if MULTILINGUAL:
        kwargs["language_id"] = inp.get("language_id", DEFAULT_LANG)

    try:
        wav = MODEL.generate(text, **kwargs)  # torch tensor [1, N] @ MODEL.sr
    finally:
        if audio_prompt_path:
            os.unlink(audio_prompt_path)

    buf = io.BytesIO()
    ta.save(buf, wav.detach().cpu(), MODEL.sr, format="wav")
    return {
        "audio_b64": base64.b64encode(buf.getvalue()).decode("utf-8"),
        "sample_rate": MODEL.sr,
    }


runpod.serverless.start({"handler": handler})
