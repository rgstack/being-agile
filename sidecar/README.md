# Voice sidecar (local, optional)

Speech in and out for the Clarify stage, entirely on this machine. The browser app talks to
`http://127.0.0.1:8099`; nothing here touches the network after the one-time model download.
The LLM turn still goes through the app's own OpenAI adapter: voice is an alternative to typing.

```sh
python3.12 -m venv sidecar/.venv && source sidecar/.venv/bin/activate   # Python 3.10+ (Kokoro needs it)
python3 -m pip install -r sidecar/requirements.txt
python3 sidecar/download_models.py      # one time, ~570 MB into sidecar/models/
python3 sidecar/voice_server.py         # leave running; the Clarify header dot turns green
```

Endpoints: `GET /health`, `POST /stt` (audio body, WAV preferred), `POST /tts` (`{"text": ...}`, returns WAV).
If the sidecar is down the app keeps working in text mode; the mic and speaker buttons just say so.

Speech out uses **Kokoro** (82M, Apache 2.0) by default: natural phrasing on the CPU, about 3x faster than
real time on a desktop i5. The app sends replies one sentence at a time, so the first sentence plays while
the next is synthesised. Piper stays as the fallback, and asking for a Piper voice by name ("lessac") still
selects it. `VOICE_DEFAULT=am_michael` picks another Kokoro voice; `VOICE_SPEED=1.05` speeds it up a touch.
