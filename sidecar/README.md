# Voice sidecar (local, optional)

Speech in and out for the Clarify stage, entirely on this machine. The browser app talks to
`http://127.0.0.1:8099`; nothing here touches the network after the one-time model download.
The LLM turn still goes through the app's own OpenAI adapter: voice is an alternative to typing.

```sh
python3 -m venv sidecar/.venv && source sidecar/.venv/bin/activate
python3 -m pip install -r sidecar/requirements.txt
python3 sidecar/download_models.py      # one time, ~215 MB into sidecar/models/
python3 sidecar/voice_server.py         # leave running; the Clarify header dot turns green
```

Endpoints: `GET /health`, `POST /stt` (audio body, WAV preferred), `POST /tts` (`{"text": ...}`, returns WAV).
If the sidecar is down the app keeps working in text mode; the mic and speaker buttons just say so.
