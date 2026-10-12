#!/usr/bin/env python3
"""Fetch the voice models into sidecar/models/ (one-time, ~150 MB + ~350 MB + ~65 MB).

  faster-whisper base  -> models/faster-whisper-base/   (Systran/faster-whisper-base on Hugging Face)
  Kokoro v1.0          -> models/kokoro-v1.0.onnx + voices-v1.0.bin   (thewh1teagle/kokoro-onnx releases)
  Piper en_US-lessac-medium -> models/en_US-lessac-medium.onnx + .onnx.json (rhasspy/piper-voices; fallback)

Needs the packages in requirements.txt (huggingface_hub comes with faster-whisper). Re-running skips
files that already exist. This is the only step that reaches the network; the server never does.
"""
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "models")
STT_REPO, STT_DIR = "Systran/faster-whisper-base", os.path.join(MODELS, "faster-whisper-base")
PIPER_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/"
PIPER_FILES = ["en_US-lessac-medium.onnx", "en_US-lessac-medium.onnx.json"]
KOKORO_BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
KOKORO_FILES = ["kokoro-v1.0.onnx", "voices-v1.0.bin"]


def fetch(url, dest):
    if os.path.isfile(dest) and os.path.getsize(dest) > 0:
        print("  have", os.path.basename(dest))
        return
    print("  get ", url)
    tmp = dest + ".part"
    with urllib.request.urlopen(url) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, dest)


def main():
    os.makedirs(MODELS, exist_ok=True)
    print("Speech-to-text:", STT_REPO)
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        sys.exit("huggingface_hub missing — pip install -r sidecar/requirements.txt first")
    snapshot_download(STT_REPO, local_dir=STT_DIR, allow_patterns=["*.bin", "*.json", "*.txt", "*.model"])
    print("  ->", STT_DIR)
    print("Text-to-speech: Kokoro v1.0")
    for name in KOKORO_FILES:
        fetch(KOKORO_BASE + name, os.path.join(MODELS, name))
    print("Text-to-speech fallback: Piper en_US-lessac-medium")
    for name in PIPER_FILES:
        fetch(PIPER_BASE + name, os.path.join(MODELS, name))
    print("Done. Start the sidecar with: python3 sidecar/voice_server.py")


if __name__ == "__main__":
    main()
