#!/usr/bin/env python3
"""Being Agile voice sidecar: local speech-to-text (faster-whisper) and text-to-speech (Piper).

Runs on 127.0.0.1:8099 only. The browser app POSTs audio here and gets text back, or POSTs text
and gets WAV back; nothing leaves the machine. The LLM turn itself never passes through here.

  GET  /health            -> {"ok": true, "stt": "faster-whisper-base", "tts": "piper-lessac-medium"}
  POST /stt  (audio body) -> {"text": "..."}      WAV preferred; anything PyAV decodes is accepted
  POST /tts  {"text":...} -> audio/wav bytes

Models are read from sidecar/models/ (run download_models.py once). Missing models or packages
give a clear JSON error instead of a crash, so the app can keep working in text mode.
"""
import io
import json
import os
import sys
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = "127.0.0.1", int(os.environ.get("VOICE_PORT", "8099"))
HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "models")
STT_DIR = os.path.join(MODELS, "faster-whisper-base")
TTS_ONNX = os.path.join(MODELS, "en_US-lessac-medium.onnx")
LANG = os.environ.get("VOICE_LANG", "en")
HINT = "run: python3 sidecar/download_models.py"

STT = {"model": None, "err": None}
TTS = {"voice": None, "err": None}


def load_models():
    try:
        from faster_whisper import WhisperModel
        if not os.path.isdir(STT_DIR):
            raise FileNotFoundError("STT model not found at " + STT_DIR + " — " + HINT)
        STT["model"] = WhisperModel(STT_DIR, device="cpu", compute_type="int8")
    except Exception as e:  # ImportError or missing files: keep serving, report on use
        STT["err"] = "%s: %s" % (type(e).__name__, e)
    try:
        from piper import PiperVoice
        if not os.path.isfile(TTS_ONNX) or not os.path.isfile(TTS_ONNX + ".json"):
            raise FileNotFoundError("TTS voice not found at " + TTS_ONNX + " — " + HINT)
        TTS["voice"] = PiperVoice.load(TTS_ONNX)
    except Exception as e:
        TTS["err"] = "%s: %s" % (type(e).__name__, e)


def transcribe(audio_bytes):
    segments, _info = STT["model"].transcribe(io.BytesIO(audio_bytes), language=LANG or None, beam_size=1, vad_filter=True)
    return " ".join(s.text.strip() for s in segments).strip()


def synthesize(text):
    buf = io.BytesIO()
    voice = TTS["voice"]
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
        ok = STT["model"] is not None and TTS["voice"] is not None
        out = {"ok": ok, "stt": "faster-whisper-base" if STT["model"] else None, "tts": "piper-lessac-medium" if TTS["voice"] else None}
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
                if TTS["voice"] is None:
                    return self._json(503, {"error": "text-to-speech unavailable: " + (TTS["err"] or HINT)})
                try:
                    text = str(json.loads(self._body().decode("utf-8") or "{}").get("text") or "").strip()
                except ValueError:
                    return self._json(400, {"error": "body must be JSON {\"text\": ...}"})
                if not text:
                    return self._json(400, {"error": "empty text"})
                wav = synthesize(text[:4000])
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
    for name, st in (("STT", STT), ("TTS", TTS)):
        print("  %s: %s" % (name, "ready" if st.get("model") or st.get("voice") else "UNAVAILABLE — " + st["err"]), flush=True)
    print("Voice sidecar on http://%s:%d  (Ctrl+C to stop)" % (HOST, PORT), flush=True)
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
