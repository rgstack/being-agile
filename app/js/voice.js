/* Voice (mic-only): press the mic in the Clarify composer, speak, press stop.
   The recording is transcribed with Whisper through the app's own OpenAI adapter
   (window.OpenAI.transcribe) and the text lands in the composer as editable text,
   exactly as if typed — the user reviews and sends it. The AI never speaks back;
   there is no auto-listen loop and no sidecar. Dry-run is decided by the caller
   (clarify.js), which inserts scripted text instead of recording. */
(function () {
  'use strict';
  const MAX_REC_MS = 90000; // a forgotten mic stops itself
  // state: idle | rec | stt (transcribing)
  const V = { state: 'idle', stream: null, rec: null, chunks: [], recTimer: null, t0: 0, cb: null, quiet: false, listeners: [] };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const emit = (what) => V.listeners.forEach((f) => { try { f(what, snapshot()); } catch (e) { /* a listener must never break capture */ } });
  const snapshot = () => ({ state: V.state });
  const setState = (s) => { if (V.state !== s) { V.state = s; emit('state'); } };
  const AI = () => window.OpenAI;

  const supported = () => typeof navigator !== 'undefined' &&
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
    typeof MediaRecorder !== 'undefined';

  function release() {
    if (V.stream) { try { V.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ } }
    clearTimeout(V.recTimer); V.recTimer = null;
    V.stream = null; V.rec = null; V.chunks = []; V.cb = null; V.quiet = false;
  }
  // stop(true) is the silent path (reset): the pending callback never fires.
  function stop(silent) {
    if (silent) V.quiet = true;
    clearTimeout(V.recTimer); V.recTimer = null;
    if (V.rec && V.rec.state !== 'inactive') { try { V.rec.stop(); } catch (e) { release(); setState('idle'); } }
  }
  // Toggle capture. First press starts recording, second press stops and transcribes;
  // cb(text, err) fires once per completed recording. Returns a promise that resolves
  // to true when a recording started, false when it stopped or could not start.
  async function toggle(cb) {
    cb = cb || function () {};
    if (V.state === 'rec') { stop(false); return false; }
    if (V.state !== 'idle') return false;
    if (!supported()) { cb(null, 'This browser cannot record audio here. Type your reply instead.'); return false; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { cb(null, e && e.name === 'NotAllowedError' ? 'Microphone access was denied. Allow the mic for this page and try again.' : 'No microphone available: ' + ((e && e.message) || e)); return false; }
    let rec;
    try { rec = new MediaRecorder(stream); }
    catch (e) { try { stream.getTracks().forEach((t) => t.stop()); } catch (e2) { /* ignore */ } cb(null, 'Recording is not supported in this browser.'); return false; }
    V.stream = stream; V.rec = rec; V.chunks = []; V.cb = cb; V.quiet = false; V.t0 = Date.now();
    rec.ondataavailable = (e) => { if (e.data && e.data.size) V.chunks.push(e.data); };
    rec.onerror = () => { const f = V.quiet ? null : V.cb; release(); setState('idle'); if (f) f(null, 'Recording failed.'); };
    rec.onstop = async () => {
      const f = V.quiet ? null : V.cb;
      const blob = new Blob(V.chunks, { type: (rec.mimeType) || 'audio/webm' });
      const secs = Math.max(1, Math.round((Date.now() - V.t0) / 1000));
      release(); setState('stt');
      if (!f) { setState('idle'); return; }
      try {
        if (blob.size < 100) throw new Error('Nothing was recorded. Hold the mic closer and try again.');
        const A = AI();
        if (!A || typeof A.transcribe !== 'function') throw new Error('Transcription is unavailable in this build.');
        const text = await A.transcribe(blob, secs);
        setState('idle');
        f(text || '', text ? null : 'I did not catch any words. Try again.');
      } catch (e) { setState('idle'); f(null, (e && e.message) || String(e)); }
    };
    try { rec.start(); } catch (e) { release(); cb(null, 'Recording could not start.'); return false; }
    V.recTimer = setTimeout(() => stop(false), MAX_REC_MS);
    setState('rec');
    return true;
  }

  // ---------- markup (icons in the app's 16px line style) ----------
  const SVG = (p) => '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">' + p + '</svg>';
  const MIC = SVG('<rect x="5.6" y="1.8" width="4.8" height="8" rx="2.4"/><path d="M3.4 7.6a4.6 4.6 0 0 0 9.2 0M8 12.2v2.2M5.6 14.4h4.8"/>');
  const SQUARE = SVG('<rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor"/>');
  // o: { disabled, dry } — dry-run keeps the button live (the caller scripts the result) even where recording is unsupported.
  const mic = (o) => {
    o = o || {};
    const rec = V.state === 'rec', busy = V.state === 'stt';
    const off = !!o.disabled || busy || (!o.dry && !supported());
    const title = rec ? 'Stop and transcribe' : busy ? 'Transcribing…' : 'Speak instead of typing';
    return '<button type="button" class="cl-mic' + (rec ? ' rec' : '') + (busy ? ' busy' : '') + '" data-a="cl-mic" aria-pressed="' + rec + '" aria-label="' + esc(title) + '" title="' + esc(title) + '"' + (off ? ' disabled' : '') + '>' + (rec ? SQUARE : MIC) + '</button>';
  };
  const micState = () => (V.state === 'rec' ? '<p class="cl-vstate rec" role="status"><i aria-hidden="true"></i>Listening… press the square to stop.</p>' : V.state === 'stt' ? '<p class="cl-vstate" role="status"><i aria-hidden="true"></i>Transcribing…</p>' : '');
  const onChange = (f) => { V.listeners.push(f); };
  const reset = () => { stop(true); release(); setState('idle'); };

  window.Voice = { supported, toggle, stop, mic, micState, onChange, reset, state: snapshot };
})();
