/* Smoke test for app/js/voice.js (and its Clarify wiring) under jsdom with a mocked fetch.
   Run: cd test && npm install && npm test
   Covers: sidecar unreachable → graceful degradation; /health ok → buttons enabled; a mocked mic round-trip
   through /stt; WAV encoding; dry-run Clarify path (scripted text, no sidecar call); voice cost line. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const APP = path.join(__dirname, '..', 'app', 'js');
const src = (f) => fs.readFileSync(path.join(APP, f), 'utf8');
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, blob: async () => new Blob([JSON.stringify(body)]) });

function boot(fetchImpl, files) {
  const vc = new VirtualConsole(); // swallow jsdom "not implemented" noise
  const dom = new JSDOM('<!doctype html><html><body><div class="clarify"><p class="cl-head"></p></div></body></html>', { runScripts: 'outside-only', url: 'http://localhost/app/', virtualConsole: vc });
  const w = dom.window;
  const calls = [];
  w.fetch = (url, opts) => { calls.push({ url: String(url), opts: opts || {} }); return fetchImpl(String(url), opts || {}); };
  w.URL.createObjectURL = () => 'blob:mock'; w.URL.revokeObjectURL = () => {};
  w.Audio = class { constructor(s) { this.src = s; } play() { return Promise.resolve(); } pause() {} };
  (files || ['voice.js']).forEach((f) => w.eval(src(f)));
  return { w, calls };
}
const down = () => Promise.reject(new TypeError('Failed to fetch'));
const up = (url) => (url.endsWith('/health') ? jsonRes(200, { ok: true, stt: 'faster-whisper-base', tts: 'piper-lessac-medium' }) : jsonRes(404, { error: 'not found' }));

test('sidecar unreachable: health false, buttons say start the sidecar, nothing throws', async () => {
  const { w } = boot(down);
  const V = w.Voice;
  assert.equal(await V.health(), false);
  assert.equal(V.ready(), false);
  assert.match(V.dot(), /data-ok="0"/);
  assert.match(V.dot(), /start the sidecar/);
  assert.match(V.mic(), / disabled/);
  assert.doesNotMatch(V.mic({ dry: true }), / disabled/); // dry-run keeps the button live
  assert.match(V.speaker('t1'), / disabled/);
  let got;
  assert.equal(await V.toggle((text, err) => { got = { text, err }; }), false);
  assert.equal(got.text, null); assert.match(got.err, /sidecar/);
  let spk;
  assert.equal(await V.speak('hello', 't1', (err) => { spk = err; }), false);
  assert.match(spk, /sidecar/);
  assert.equal(V.state().state, 'idle');
});

test('health ok: ready, dot green, mic and speaker enabled; no mic API degrades to a message', async () => {
  const { w } = boot(up);
  const V = w.Voice;
  let events = [];
  V.onChange((what) => events.push(what));
  assert.equal(await V.health(), true);
  assert.deepEqual(events, ['health']);
  assert.match(V.dot(), /data-ok="1"/);
  assert.match(V.dot(), /voice ready/);
  assert.doesNotMatch(V.mic(), / disabled/);
  assert.match(V.mic({ disabled: true }), / disabled/); // caller busy
  assert.doesNotMatch(V.speaker('t1'), / disabled/);
  let got;
  assert.equal(await V.toggle((text, err) => { got = { text, err }; }), false); // jsdom has no getUserMedia / MediaRecorder
  assert.match(got.err, /microphone|record/i);
  assert.equal(V.state().state, 'idle');
  await V.health(); // unchanged: no second event
  assert.deepEqual(events, ['health']);
});

test('mocked mic round-trip: toggle starts, toggle stops, /stt text comes back through the callback', async () => {
  const fetchImpl = (url, opts) => {
    if (url.endsWith('/health')) return up(url);
    if (url.endsWith('/stt')) { assert.equal(opts.method, 'POST'); assert.ok(opts.body && opts.body.size > 100); return jsonRes(200, { text: '  Twelve sprints, two PIs. ' }); }
    return jsonRes(404, {});
  };
  const { w, calls } = boot(fetchImpl);
  const V = w.Voice;
  let recorders = [];
  w.MediaRecorder = class {
    constructor(stream) { this.stream = stream; this.state = 'inactive'; this.mimeType = 'audio/webm'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable({ data: new w.Blob([new Uint8Array(400)], { type: 'audio/webm' }) }); this.onstop(); }
  };
  const track = { stop() { track.stopped = true; } };
  w.navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [track] }) };
  await V.health();
  const states = [];
  V.onChange((what, s) => { if (what === 'state') states.push(s.state); });
  const done = new Promise((res) => { V._cb = res; });
  assert.equal(await V.toggle((text, err) => V._cb({ text, err })), true);
  assert.equal(V.state().state, 'rec');
  assert.match(V.mic(), /class="cl-mic rec"/);
  assert.match(V.micState(), /Listening/);
  assert.equal(await V.toggle(), false); // second press stops
  const r = await done;
  assert.equal(r.err, null);
  assert.equal(r.text, 'Twelve sprints, two PIs.');
  assert.deepEqual(states, ['rec', 'stt', 'idle']);
  assert.equal(track.stopped, true);
  assert.ok(calls.some((c) => c.url === V.BASE + '/stt'));
});

test('tts: ok plays and marks the message; 503 reports the sidecar error and clears state', async () => {
  let mode = 'ok';
  const fetchImpl = (url) => {
    if (url.endsWith('/health')) return up(url);
    if (url.endsWith('/tts')) return mode === 'ok' ? { ok: true, status: 200, blob: async () => new Blob([new Uint8Array(64)], { type: 'audio/wav' }), json: async () => ({}) } : jsonRes(503, { error: 'text-to-speech unavailable: run download_models.py' });
    return jsonRes(404, {});
  };
  const { w } = boot(fetchImpl);
  const V = w.Voice;
  await V.health();
  let err = 'unset';
  assert.equal(await V.speak('Hello there', 'say1', (e) => { err = e; }), true);
  assert.equal(err, null);
  assert.equal(V.state().speaking, 'say1');
  assert.match(V.speaker('say1'), /class="cl-speak on"/);
  assert.equal(await V.speak('Hello there', 'say1'), false); // same message again = stop
  assert.equal(V.state().speaking, null);
  mode = 'fail';
  assert.equal(await V.speak('x', 'say2', (e) => { err = e; }), false);
  assert.match(err, /download_models/);
  assert.equal(V.state().state, 'idle');
});

test('encodeWav: 16-bit mono 16 kHz with a RIFF header, downsampled from 48 kHz', async () => {
  const { w } = boot(down);
  const blob = w.Voice.encodeWav(new Float32Array(4800), 48000); // 0.1 s at 48 kHz → 1600 samples at 16 kHz
  assert.equal(blob.type, 'audio/wav');
  assert.equal(blob.size, 44 + 1600 * 2);
  const buf = await new Promise((res, rej) => { const r = new w.FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(blob); }); // jsdom Blob has no arrayBuffer()
  const dv = new DataView(buf);
  assert.equal(String.fromCharCode(...new Uint8Array(buf.slice(0, 4))), 'RIFF');
  assert.equal(dv.getUint16(22, true), 1);      // mono
  assert.equal(dv.getUint32(24, true), 16000);  // sample rate
  assert.equal(dv.getUint16(34, true), 16);     // bits per sample
});

test('Clarify dry-run: mic inserts scripted text with a note, no sidecar call; voice turns show the local cost line', async () => {
  const { w, calls } = boot(down, ['sample-data.js', 'openai.js', 'state.js', 'voice.js', 'clarify.js']);
  const ST = w.State, CL = w.Clarify;
  const S = ST.load();
  S.clarify = ST.normClarify({ status: 'open', questions: [{ id: 'Q1', lens: 'timeline', text: 'How long do you have?', default: '12 sprints', options: ['6 sprints'], status: 'open' }], turns: [{ id: 'a1', kind: 'ask', qid: 'Q1', at: 1 }, { id: 's1', kind: 'say', text: 'Hello.', at: 1, cost: { pt: 10, ct: 5, usd: 0.0001, dry: false, voice: true } }], cursor: 'Q1' });
  const toasts = [];
  CL.init({ getS: () => S, ui: { busy: false }, render() {}, touch() {}, toast: (m) => toasts.push(m), confirmBox: async () => true, guarded: async () => false, go() {}, genStories() {}, esc: (v) => String(v == null ? '' : v), mi: (v) => String(v), ic: () => '', fmtUsd: (n) => '$' + n.toFixed(2), plural: (n, o) => n + ' ' + o, errBox: () => '', apiHost: () => 'api.openai.com', openDoc() {}, openRules() {} });
  w.OpenAI.configure({ dryRun: true });
  const html = CL.render();
  assert.match(html, /class="cl-vdot"/);
  assert.match(html, /data-a="cl-mic"/);
  assert.match(html, /data-a="cl-speak" data-k="s1"/);
  assert.match(html, /local voice · \$0\.00/);
  assert.doesNotMatch(html, /data-a="cl-mic"[^>]* disabled/); // dry-run keeps the mic live without a sidecar
  CL.actions['cl-mic']();
  assert.equal(S.clarify.composer, '12 sprints');
  assert.match(CL.render(), /Voice unavailable in dry-run/);
  CL.actions['cl-speak']({ dataset: { k: 's1' } });
  assert.match(toasts.pop(), /dry-run/);
  assert.equal(calls.filter((c) => c.url.indexOf('/stt') !== -1 || c.url.indexOf('/tts') !== -1).length, 0);
  // Live mode with the sidecar down: the mic press is a hint, never an error in the conversation.
  w.OpenAI.configure({ dryRun: false });
  CL.actions['cl-mic']();
  assert.match(toasts.pop(), /sidecar/);
  assert.equal(S.clarify.composer, '12 sprints');
});

test('Clarify: arriving starts the review, and the analyst opens by playing back what it understood before the first question', async () => {
  const { w } = boot(down, ['sample-data.js', 'openai.js', 'state.js', 'voice.js', 'clarify.js']);
  const ST = w.State, CL = w.Clarify;
  const S = ST.load();
  S.docs.prd.text = 'A PRD with enough words to read.';
  S.clarify = ST.clarifyFresh();
  let done; const reviewed = new Promise((r) => { done = r; });
  CL.init({ getS: () => S, ui: { busy: false }, render() {}, touch() {}, toast() {}, confirmBox: async () => true,
    guarded: async (op, input, title, apply) => { const r = await w.OpenAI.clarifyReview(input); apply(r.data, r.usage); done(); return true; },
    go() {}, genStories() {}, esc: (v) => String(v == null ? '' : v), mi: (v) => String(v), ic: () => '', fmtUsd: (n) => '$' + n.toFixed(2), plural: (n, o) => n + ' ' + o, errBox: () => '', apiHost: () => 'api.openai.com', openDoc() {}, openRules() {} });
  w.OpenAI.configure({ dryRun: true });
  CL.onEnter();
  await reviewed; await new Promise((r) => setTimeout(r, 1700)); // begin() lets the reading animation finish
  const [first, second] = S.clarify.turns;
  assert.equal(first.kind, 'say');
  assert.match(first.text, /^So, if I’ve got this right/);
  assert.equal(second.kind, 'ask');
  assert.equal(second.qid, 'Q1');
  assert.doesNotMatch(CL.render(), /class="cl-brief/); // the play-back lives in the conversation, not above it
  w.Voice.watch(false); w.close(); // onEnter started the /health poll
});
