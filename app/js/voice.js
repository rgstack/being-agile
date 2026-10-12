/* Voice: speech in and out for Clarify, via a local sidecar (sidecar/voice_server.py on 127.0.0.1:8099).
   Mic → MediaRecorder → decoded to 16 kHz mono WAV → POST /stt → text, handed back to the caller to drop
   into the composer (the user edits and sends it like typed text; the LLM turn never passes through here).
   Model replies → POST /tts → WAV → played. GET /health drives the header dot. Everything degrades to the
   text flow: no sidecar, no mic, no audio support — each is a toast or a disabled button, never an error
   in the conversation. Dry-run is decided by the caller (clarify.js): this module only knows the sidecar. */
(function () {
  'use strict';
  const BASE = 'http://127.0.0.1:8099';
  const POLL_MS = 15000, HEALTH_TIMEOUT_MS = 1500, MAX_REC_MS = 90000, RATE = 16000;
  // ok: last health result; checked: at least one health call finished; info: /health body; state: idle|rec|stt|tts;
  // speaking: id of the message being read aloud; stream/rec/chunks: the live capture; audio: the playing element.
  const V = { ok: false, checked: false, info: null, state: 'idle', speaking: null, stream: null, rec: null, chunks: [], audio: null, timer: null, recTimer: null, partialTimer: null, partialBusy: false, partialText: '', gen: 0, autoStop: false, silTimer: null, silAC: null, recT0: 0, ttsEndCb: null, listeners: [] };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const emit = (what) => V.listeners.forEach((f) => { try { f(what, snapshot()); } catch (e) { /* a listener must never break capture */ } });
  const snapshot = () => ({ ok: V.ok, checked: V.checked, state: V.state, speaking: V.speaking, info: V.info, partialText: V.partialText });
  const setState = (s) => { if (V.state !== s) { V.state = s; emit('state'); } };
  const withTimeout = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
  const HINT = 'Start the voice sidecar: python3 sidecar/voice_server.py';
  const getVoice = () => { try { return localStorage.getItem('ba_voice') || ''; } catch (e) { return ''; } }; // '' = the sidecar's default (Kokoro)

  // ---------- health ----------
  async function health() {
    let ok = false, info = null;
    try {
      const r = await fetch(BASE + '/health', { method: 'GET', signal: withTimeout(HEALTH_TIMEOUT_MS) });
      info = await r.json();
      ok = !!(r.ok && info && info.ok);
    } catch (e) { ok = false; }
    const changed = ok !== V.ok || !V.checked;
    V.ok = ok; V.checked = true; V.info = info;
    if (changed) emit('health');
    return ok;
  }
  // Poll while the caller says so (Clarify is on screen); stops itself when the caller's keepAlive() says no.
  function watch(on, keepAlive) {
    clearInterval(V.timer); V.timer = null;
    if (!on) return;
    health();
    V.timer = setInterval(() => { if (keepAlive && !keepAlive()) { clearInterval(V.timer); V.timer = null; return; } health(); }, POLL_MS);
  }
  const ready = () => V.ok;
  const canRecord = () => typeof navigator !== 'undefined' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && typeof MediaRecorder !== 'undefined';

  // ---------- WAV ----------
  // Float32 samples at `rate` → 16-bit PCM mono WAV at RATE (nearest-sample downsampling: speech-adequate, dependency-free).
  function encodeWav(samples, rate) {
    rate = rate || RATE;
    let pcm = samples;
    if (rate !== RATE) {
      const n = Math.round(samples.length * RATE / rate); pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = samples[Math.min(samples.length - 1, Math.floor(i * rate / RATE))];
    }
    const buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, RATE, true); dv.setUint32(28, RATE * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
    for (let i = 0, o = 44; i < pcm.length; i++, o += 2) { const s = Math.max(-1, Math.min(1, pcm[i])); dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return new Blob([buf], { type: 'audio/wav' });
  }
  async function toWav(blob) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return blob; // the sidecar decodes webm/ogg itself
    const ctx = new AC();
    try {
      const ab = await ctx.decodeAudioData(await blob.arrayBuffer());
      const n = ab.numberOfChannels, len = ab.length, mono = new Float32Array(len);
      for (let c = 0; c < n; c++) { const d = ab.getChannelData(c); for (let i = 0; i < len; i++) mono[i] += d[i] / n; }
      return encodeWav(mono, ab.sampleRate);
    } catch (e) { return blob; } finally { try { ctx.close(); } catch (e) { /* ignore */ } }
  }

  // ---------- speech to text ----------
  async function stt(blob) {
    const r = await fetch(BASE + '/stt', { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
    let j = null; try { j = await r.json(); } catch (e) { j = null; }
    if (!r.ok || !j || typeof j.text !== 'string') throw new Error((j && j.error) || ('Sidecar replied ' + r.status));
    return j.text.trim();
  }
  function release() {
    if (V.stream) { try { V.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ } }
    clearTimeout(V.recTimer); V.recTimer = null; clearInterval(V.partialTimer); V.partialTimer = null; V.partialBusy = false; V.partialText = ''; stopSilenceWatch(); V.stream = null; V.rec = null; V.chunks = [];
  }
  // Live interim transcript: every PARTIAL_MS while recording, transcribe audio-so-far and emit('partial').
  // Fully local (same /stt endpoint); skipped while a partial is in flight so requests never pile up.
  const PARTIAL_MS = 1500;
  async function partial() {
    if (V.state !== 'rec' || V.partialBusy || !V.chunks.length) return;
    const g = V.gen; // per-recording token: a late partial must never leak into the next session
    V.partialBusy = true;
    try {
      const blob = new Blob(V.chunks.slice(), { type: (V.rec && V.rec.mimeType) || 'audio/webm' });
      if (blob.size < 500) return; // too little audio to bother
      const wav = await toWav(blob);
      if (g !== V.gen || V.state !== 'rec') return;
      const text = await stt(wav);
      if (g !== V.gen || V.state !== 'rec') return; // user stopped (or restarted) while we were transcribing
      if (text && text !== V.partialText) { V.partialText = text; emit('partial'); }
    } catch (e) { /* interim is best-effort; the final transcription still runs on stop */ }
    finally { V.partialBusy = false; }
  }
  // ---------- silence auto-stop (conversation mode only) ----------
  // Watches mic input level via AnalyserNode; after SILENCE_MS of quiet (past an initial
  // grace period so the user gets a moment to start talking), stops the recording.
  const SILENCE_MS = 2000, SILENCE_GRACE_MS = 3000;
  function startSilenceWatch(stream) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      const ac = new AC(), src = ac.createMediaStreamSource(stream), an = ac.createAnalyser();
      an.fftSize = 2048; src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      let quietSince = 0;
      V.silTimer = setInterval(() => {
        if (V.state !== 'rec') { stopSilenceWatch(); return; }
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i] - 128); if (v > peak) peak = v; }
        const now = Date.now();
        if (now - V.recT0 < SILENCE_GRACE_MS) { quietSince = 0; return; } // grace period
        if (peak < 8) { // very quiet (~-42 dBFS on 8-bit samples)
          if (!quietSince) quietSince = now;
          else if (now - quietSince >= SILENCE_MS) { stopSilenceWatch(); stop(); }
        } else quietSince = 0;
      }, 200);
      V.silAC = ac;
    } catch (e) { /* silence detection unavailable; manual stop still works */ }
  }
  function stopSilenceWatch() {
    clearInterval(V.silTimer); V.silTimer = null;
    try { if (V.silAC) V.silAC.close(); } catch (e) { /* ignore */ }
    V.silAC = null;
  }
  // Toggle capture. First press starts, second press stops and transcribes; cb(text, err) fires once per stop.
  // Returns a promise that resolves to true when a recording started, false otherwise (the error already reported through cb).
  async function toggle(cb, opts) {
    cb = cb || function () {}; opts = opts || {};
    if (V.state === 'rec') { stop(); return false; }
    if (V.state !== 'idle') return false;
    if (!V.ok) { cb(null, HINT); return false; }
    if (!canRecord()) { cb(null, 'This browser cannot record audio here (no microphone API).'); return false; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { cb(null, e && e.name === 'NotAllowedError' ? 'Microphone access was denied. Allow the mic for this page and try again.' : 'No microphone available: ' + ((e && e.message) || e)); return false; }
    let rec;
    try { rec = new MediaRecorder(stream); } catch (e) { try { stream.getTracks().forEach((t) => t.stop()); } catch (e2) { /* ignore */ } cb(null, 'Recording is not supported in this browser.'); return false; }
    V.stream = stream; V.rec = rec; V.chunks = []; V.gen++; V.autoStop = !!opts.autoStop;
    rec.ondataavailable = (e) => { if (e.data && e.data.size) V.chunks.push(e.data); };
    rec.onerror = () => { release(); setState('idle'); cb(null, 'Recording failed.'); };
    rec.onstop = async () => {
      const blob = new Blob(V.chunks, { type: rec.mimeType || 'audio/webm' });
      release(); setState('stt');
      try {
        if (blob.size < 100) throw new Error('Nothing was recorded. Hold the mic closer and try again.');
        const text = await stt(await toWav(blob));
        setState('idle');
        cb(text || '', text ? null : 'I did not catch any words. Try again.');
      } catch (e) { setState('idle'); cb(null, (e && e.message) || String(e)); }
    };
    rec.start(1000); // 1s timeslice: ondataavailable fires during recording so partials have audio
    V.recTimer = setTimeout(stop, MAX_REC_MS); // a forgotten mic stops itself
    clearInterval(V.partialTimer); V.partialTimer = setInterval(partial, PARTIAL_MS);
    V.recT0 = Date.now();
    if (V.autoStop) startSilenceWatch(stream);
    setState('rec');
    return true;
  }
  function stop() { clearInterval(V.partialTimer); V.partialTimer = null; stopSilenceWatch(); if (V.rec && V.rec.state !== 'inactive') { try { V.rec.stop(); } catch (e) { release(); setState('idle'); } } }

  // ---------- text to speech ----------
  function stopAudio() {
    V.ttsEndCb = null; // a manual stop is not a natural end; conversation mode must not auto-listen
    if (V.audio) { try { V.audio.pause(); } catch (e) { /* ignore */ } if (V.audio.src) { try { URL.revokeObjectURL(V.audio.src); } catch (e) { /* ignore */ } } V.audio = null; }
    if (V.speaking !== null || V.state === 'tts') { V.speaking = null; if (V.state === 'tts') V.state = 'idle'; emit('state'); }
  }
  // Read `text` aloud; `id` tags the message so the UI can show which one is playing. Pressing the same one again stops it.
  // cb(err) fires when playback starts (or fails to start); onEnded(ok) fires when playback naturally
  // ends (ok=true) or errors mid-play (ok=false). A manual stopAudio() never fires onEnded.
  // Sentence by sentence: the first plays as soon as it is ready while the next is synthesised, so a long
  // reply starts quickly and each sentence gets its own natural phrasing.
  const sentences = (t) => String(t || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?…][”’"')]*)\s+(?=[A-Z0-9“"‘'(])/).filter(Boolean);
  function fetchTts(text) {
    const p = Promise.resolve().then(() => fetch(BASE + '/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice: getVoice() }) }))
      .then(async (r) => { if (!r.ok) { let j = null; try { j = await r.json(); } catch (e) { j = null; } throw new Error((j && j.error) || ('Sidecar replied ' + r.status)); } return r.blob(); });
    p.catch(() => {}); // a prefetch nobody awaits (playback stopped) must not surface as unhandled
    return p;
  }
  async function speak(text, id, cb, onEnded) {
    cb = cb || function () {};
    if (V.speaking === id) { stopAudio(); return false; }
    stopAudio();
    if (!V.ok) { cb(HINT); return false; }
    V.speaking = id; V.state = 'tts'; emit('state');
    V.ttsEndCb = (typeof onEnded === 'function') ? onEnded : null;
    const parts = sentences(text);
    if (!parts.length) parts.push(String(text || ''));
    const finish = (ok) => { if (V.speaking !== id) return; const f = V.ttsEndCb; stopAudio(); if (f) { try { f(ok); } catch (e) { /* listener must never break playback */ } } };
    const playFrom = async (i, pending) => {
      const blob = await pending;
      if (V.speaking !== id) return false; // stopped while fetching
      if (typeof Audio === 'undefined') throw new Error('Audio playback is not available here.');
      const next = i + 1 < parts.length ? fetchTts(parts[i + 1]) : null;
      const a = new Audio(URL.createObjectURL(blob));
      if (V.audio && V.audio.src) { try { URL.revokeObjectURL(V.audio.src); } catch (e) { /* ignore */ } }
      V.audio = a;
      a.onended = () => { if (V.audio !== a) return; if (!next) finish(true); else playFrom(i + 1, next).catch(() => finish(false)); };
      a.onerror = () => { if (V.audio === a) finish(false); };
      await a.play();
      return true;
    };
    try {
      if (!(await playFrom(0, fetchTts(parts[0])))) return false;
      cb(null);
      return true;
    } catch (e) { stopAudio(); cb((e && e.message) || String(e)); return false; }
  }

  // ---------- markup (icons in the app's 16px line style) ----------
  const SVG = (p) => '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">' + p + '</svg>';
  const MIC = SVG('<rect x="5.6" y="1.8" width="4.8" height="8" rx="2.4"/><path d="M3.4 7.6a4.6 4.6 0 0 0 9.2 0M8 12.2v2.2M5.6 14.4h4.8"/>');
  const SQUARE = SVG('<rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor"/>');
  const SPEAKER = SVG('<path d="M2.4 6.2h2.4L8.4 3v10L4.8 9.8H2.4z"/><path d="M10.6 5.6a3.2 3.2 0 0 1 0 4.8M12.4 3.6a5.8 5.8 0 0 1 0 8.8"/>');
  const dot = () => {
    const ok = V.ok, label = !V.checked ? 'voice' : ok ? 'voice ready' : 'voice off · start the sidecar';
    const title = ok ? 'Local voice ready (' + esc((V.info && V.info.stt) || 'stt') + ', ' + esc((V.info && V.info.tts) || 'tts') + ')' : HINT;
    return '<span class="cl-vdot" data-ok="' + (ok ? '1' : '0') + '" role="status" title="' + title + '"><i aria-hidden="true"></i>' + label + '</span>';
  };
  // o: { disabled, dry } — dry keeps the button live (the caller scripts the result) even with no sidecar.
  const mic = (o) => {
    o = o || {};
    const rec = V.state === 'rec', busy = V.state === 'stt';
    const off = !!o.disabled || busy || (!o.dry && !V.ok && !rec);
    const title = rec ? 'Stop and transcribe' : busy ? 'Transcribing…' : o.dry ? 'Speak (dry-run: scripted text)' : V.ok ? 'Speak instead of typing' : HINT;
    return '<button type="button" class="cl-mic' + (rec ? ' rec' : '') + (busy ? ' busy' : '') + '" data-a="cl-mic" aria-pressed="' + rec + '" aria-label="' + esc(title) + '" title="' + esc(title) + '"' + (off ? ' disabled' : '') + '>' + (rec ? SQUARE : MIC) + '</button>';
  };
  const micState = () => (V.state === 'rec' ? '<p class="cl-vstate rec" role="status"><i aria-hidden="true"></i>Listening… press the square to stop.</p>' : V.state === 'stt' ? '<p class="cl-vstate" role="status"><i aria-hidden="true"></i>Transcribing locally…</p>' : '');
  const speaker = (id, o) => {
    o = o || {};
    const on = V.speaking === id;
    const title = on ? 'Stop reading' : o.dry ? 'Read aloud (unavailable in dry-run)' : V.ok ? 'Read this aloud' : HINT;
    return '<button type="button" class="cl-speak' + (on ? ' on' : '') + '" data-a="cl-speak" data-k="' + esc(id) + '" aria-pressed="' + on + '" aria-label="' + esc(title) + '" title="' + esc(title) + '"' + (!o.dry && !V.ok ? ' disabled' : '') + '>' + (on ? SQUARE : SPEAKER) + '</button>';
  };
  const onChange = (f) => { V.listeners.push(f); };
  const reset = () => { stop(); release(); stopAudio(); setState('idle'); };

  window.Voice = { BASE, HINT, health, watch, ready, canRecord, toggle, stop, speak, stopAudio, encodeWav, dot, mic, micState, speaker, onChange, reset, state: snapshot, get voice() { return getVoice(); } };
})();
