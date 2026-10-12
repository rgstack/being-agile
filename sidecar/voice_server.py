#!/usr/bin/env python3
"""Being Agile voice sidecar: local speech-to-text (faster-whisper) and text-to-speech (Kokoro, Piper fallback).

Runs on 127.0.0.1:8099 only. The browser app POSTs audio here and gets text back, or POSTs text
and gets WAV back; nothing leaves the machine. The LLM turn itself never passes through here.

  GET  /health                        -> {"ok": true, "stt": "faster-whisper-base", "tts": "kokoro", "voices": ["af_heart", ..., "lessac", ...]}
  POST /stt  (audio body)             -> {"text": "..."}      WAV preferred; anything PyAV decodes is accepted
  POST /tts  {"text":..., "voice":..} -> audio/wav bytes      voice defaults to Kokoro af_heart (Piper lessac if Kokoro is absent)

Kokoro (82M, Apache 2.0) sounds far more natural than Piper and still runs on the CPU; it needs
Python 3.10+ and kokoro-onnx. A Piper voice name ("lessac", "amy", ...) still selects Piper.

Models are read from sidecar/models/ (run download_models.py once). Missing models or packages
give a clear JSON error instead of a crash, so the app can keep working in text mode.
"""
import io
import json
import os
import re
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = "127.0.0.1", int(os.environ.get("VOICE_PORT", "8099"))
HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "models")
STT_DIR = os.path.join(MODELS, "faster-whisper-base")
TTS_VOICES = {
    "lessac":  "en_US-lessac-medium",
    "amy":     "en_US-amy-medium",
    "kristin": "en_US-kristin-medium",
    "ryan":    "en_US-ryan-medium",
}
KOKORO_MODEL = os.path.join(MODELS, "kokoro-v1.0.onnx")  # fp32: on x86 CPUs it is faster than the int8 file
KOKORO_VOICES = os.path.join(MODELS, "voices-v1.0.bin")
KOKORO_DEFAULT = os.environ.get("VOICE_DEFAULT", "af_heart")
KOKORO_SPEED = float(os.environ.get("VOICE_SPEED", "1.0"))
LANG = os.environ.get("VOICE_LANG", "en")
HINT = "run: python3 sidecar/download_models.py"
INSTALL = "run: python3 -m pip install -r sidecar/requirements.txt"

STT = {"model": None, "err": None}
TTS = {"cache": {}, "err": None, "available": []}  # cache: name -> PiperVoice; available: Piper names with model files present
KOKORO = {"model": None, "voices": [], "err": None, "lock": threading.Lock()}


def load_models():
    try:
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            raise ImportError("faster-whisper is not installed — " + INSTALL)
        if not os.path.isdir(STT_DIR):
            raise FileNotFoundError("STT model not found at " + STT_DIR + " — " + HINT)
        STT["model"] = WhisperModel(STT_DIR, device="cpu", compute_type="int8")
    except Exception as e:  # ImportError or missing files: keep serving, report on use
        STT["err"] = "%s: %s" % (type(e).__name__, e)
    try:
        try:
            from kokoro_onnx import Kokoro
        except ImportError:
            raise ImportError("kokoro-onnx is not installed (needs Python 3.10+) — " + INSTALL)
        if not (os.path.isfile(KOKORO_MODEL) and os.path.isfile(KOKORO_VOICES)):
            raise FileNotFoundError("Kokoro model files not found in " + MODELS + " — " + HINT)
        KOKORO["model"] = Kokoro(KOKORO_MODEL, KOKORO_VOICES)
        KOKORO["voices"] = sorted(v for v in KOKORO["model"].get_voices() if v[:2] in ("af", "am", "bf", "bm"))  # English voices
    except Exception as e:  # Piper still serves
        KOKORO["err"] = "%s: %s" % (type(e).__name__, e)
    try:
        try:
            from piper import PiperVoice  # noqa: F401 — just verify import
        except ImportError:
            raise ImportError("piper-tts is not installed — " + INSTALL)
        for short, base in TTS_VOICES.items():
            onnx = os.path.join(MODELS, base + ".onnx")
            if os.path.isfile(onnx) and os.path.isfile(onnx + ".json"):
                TTS["available"].append(short)
        if not TTS["available"] and not KOKORO["model"]:
            raise FileNotFoundError("No TTS voice files found in " + MODELS + " — " + HINT)
    except Exception as e:
        TTS["err"] = "%s: %s" % (type(e).__name__, e)


def get_voice(name):
    """Return a loaded PiperVoice for `name`, lazy-loading and caching. Falls back to lessac or first available."""
    from piper import PiperVoice
    if name not in TTS["available"]:
        name = "lessac" if "lessac" in TTS["available"] else TTS["available"][0]
    if name in TTS["cache"]:
        return TTS["cache"][name]
    onnx = os.path.join(MODELS, TTS_VOICES[name] + ".onnx")
    v = PiperVoice.load(onnx)
    TTS["cache"][name] = v
    return v


def transcribe(audio_bytes):
    segments, _info = STT["model"].transcribe(io.BytesIO(audio_bytes), language=LANG or None, beam_size=1, vad_filter=True)
    return " ".join(s.text.strip() for s in segments).strip()


# Spoken-English clean-up shared by both engines: ranges, acronyms the model would read as words, symbols.
SAY = [
    (re.compile(r"(\d)\s*[–—-]\s*(\d)"), r"\1 to \2"),
    (re.compile(r"\bPIs\b"), "P.I.s"), (re.compile(r"\bPI\b"), "P.I."),
    (re.compile(r"\bNPIs\b"), "N.P.I.s"), (re.compile(r"\bNPI\b"), "N.P.I."),
    (re.compile(r"\bAPI\b"), "A.P.I."), (re.compile(r"\bPRD\b"), "P.R.D."), (re.compile(r"\bSSO\b"), "S.S.O."),
    (re.compile(r"\bREQ-0*(\d+)\b"), r"requirement \1"),
    (re.compile(r"\s*&\s*"), " and "), (re.compile(r"\s*[•·]\s*"), ", "), (re.compile(r"[*_#`]+"), ""),
]


def speakable(text):
    for rx, sub in SAY:
        text = rx.sub(sub, text)
    return re.sub(r"\s+", " ", text).strip()


def synthesize_kokoro(text, voice):
    import numpy as np
    with KOKORO["lock"]:  # one synthesis at a time: they share the CPU anyway
        samples, sr = KOKORO["model"].create(text, voice=voice, speed=KOKORO_SPEED, lang="en-gb" if voice[:1] == "b" else "en-us")
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
    return buf.getvalue()


def tts(text, name):
    """Kokoro unless a Piper voice is asked for by name (or Kokoro is unavailable)."""
    text = speakable(text)
    if KOKORO["model"] and name not in TTS["available"]:
        voice = name if name in KOKORO["voices"] else (KOKORO_DEFAULT if KOKORO_DEFAULT in KOKORO["voices"] else KOKORO["voices"][0])
        return synthesize_kokoro(text, voice)
    return synthesize(text, get_voice(name))


def tts_ready():
    return bool(KOKORO["model"] or TTS["available"])


def synthesize(text, voice):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        if hasattr(voice, "synthesize_wav"):   # piper-tts >= 1.3
            voice.synthesize_wav(text, w)
        else:                                   # piper-tts 1.2
            voice.synthesize(text, w)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")  # file:// pages send Origin: null
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")  # Chrome PNA: an https page may call localhost

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n > 0 else b""

    def do_OPTIONS(self):  # CORS preflight
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0] != "/health":
            return self._json(404, {"error": "not found"})
        ok = STT["model"] is not None and tts_ready()
        engine = "kokoro" if KOKORO["model"] else "piper" if TTS["available"] else None
        out = {"ok": ok, "stt": "faster-whisper-base" if STT["model"] else None, "tts": engine, "voices": KOKORO["voices"] + TTS["available"]}
        if not ok:
            out["error"] = "; ".join(e for e in (STT["err"], TTS["err"]) if e)
        self._json(200, out)

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            if path == "/stt":
                if STT["model"] is None:
                    return self._json(503, {"error": "speech-to-text unavailable: " + (STT["err"] or HINT)})
                audio = self._body()
                if len(audio) < 100:
                    return self._json(400, {"error": "empty audio"})
                return self._json(200, {"text": transcribe(audio)})
            if path == "/tts":
                if not tts_ready():
                    return self._json(503, {"error": "text-to-speech unavailable: " + (TTS["err"] or HINT)})
                try:
                    body = json.loads(self._body().decode("utf-8") or "{}")
                except ValueError:
                    return self._json(400, {"error": "body must be JSON {\"text\": ...}"})
                text = str(body.get("text") or "").strip()
                voice_name = str(body.get("voice") or "").strip()
                if not text:
                    return self._json(400, {"error": "empty text"})
                wav = tts(text[:4000], voice_name)
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(wav)))
                self.end_headers()
                self.wfile.write(wav)
                return
            return self._json(404, {"error": "not found"})
        except Exception as e:
            return self._json(500, {"error": "%s: %s" % (type(e).__name__, e)})

    def log_message(self, fmt, *args):  # one quiet line per request, no client details
        sys.stderr.write("%s %s\n" % (self.command, self.path))


if __name__ == "__main__":
    print("Loading models from", MODELS, "...", flush=True)
    load_models()
    print("  STT: %s" % ("ready" if STT["model"] else "UNAVAILABLE — " + STT["err"]), flush=True)
    print("  TTS: %s" % ("Kokoro (default %s)" % KOKORO_DEFAULT if KOKORO["model"] else "Kokoro unavailable — " + str(KOKORO["err"])), flush=True)
    print("       %s" % ("Piper fallback: " + ", ".join(TTS["available"]) if TTS["available"] else "Piper unavailable — " + str(TTS["err"])), flush=True)
    print("Voice sidecar on http://%s:%d  (Ctrl+C to stop)" % (HOST, PORT), flush=True)
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
