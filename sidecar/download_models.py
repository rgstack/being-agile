#!/usr/bin/env python3
"""Fetch the two voice models into sidecar/models/ (one-time, ~150 MB + ~65 MB).

  faster-whisper base  -> models/faster-whisper-base/   (Systran/faster-whisper-base on Hugging Face)
  Piper en_US-lessac-medium -> models/en_US-lessac-medium.onnx + .onnx.json (rhasspy/piper-voices)

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
    print("Text-to-speech: Piper en_US-lessac-medium")
    for name in PIPER_FILES:
        fetch(PIPER_BASE + name, os.path.join(MODELS, name))
    print("Done. Start the sidecar with: python3 sidecar/voice_server.py")


if __name__ == "__main__":
    main()
