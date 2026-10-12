/* Smoke test for the mic-only voice.js (and openai.js transcribe) under jsdom.
   Run: cd test && npm test
   Covers: unsupported browser -> graceful degradation; a mocked mic round-trip
   (MediaRecorder -> Whisper transcribe -> text to the caller); mic denied;
   transcription failure; reset() stays silent; Whisper posts to
   /audio/transcriptions, meters usage, and maps 401 to a friendly error. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const APP = path.join(__dirname, '..', 'app', 'js');
const src = (f) => fs.readFileSync(path.join(APP, f), 'utf8');
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));

function boot(files, fetchImpl) {
  const vc = new VirtualConsole(); // swallow jsdom "not implemented" noise
  const dom = new JSDOM('<!doctype html><html><body><div class="clarify"></div></body></html>', { runScripts: 'outside-only', url: 'https://localhost/app/', virtualConsole: vc });
  const w = dom.window;
  const calls = [];
  w.fetch = (url, opts) => { calls.push({ url: String(url), opts: opts || {} }); return fetchImpl(String(url), opts || {}); };
  (files || []).forEach((f) => w.eval(src(f)));
  return { w, calls };
}
// Install a mock MediaRecorder + getUserMedia on the jsdom window. Returns the
// instances list so tests can feed audio chunks into ondataavailable.
function mockMic(w, opts) {
  opts = opts || {};
  const instances = [];
  w.MediaRecorder = class {
    constructor(stream) { this.stream = stream; this.state = 'inactive'; this.mimeType = 'audio/webm'; instances.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; if (this.onstop) this.onstop(); }
  };
  const fakeStream = { getTracks: () => [] };
  Object.defineProperty(w.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: opts.deny
        ? async () => { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; }
        : async () => fakeStream,
    },
  });
  return instances;
}

test('unsupported browser: mic disabled, toggle reports gracefully', async () => {
  const { w } = boot(['voice.js'], () => { throw new Error('no network expected'); });
  const V = w.Voice;
  assert.equal(V.supported(), false);
  assert.match(V.mic(), / disabled/);
  let got;
  assert.equal(await V.toggle((text, err) => { got = { text, err }; }), false);
  assert.equal(got.text, null);
  assert.match(got.err, /cannot record audio/);
  assert.equal(V.state().state, 'idle');
});

test('mic denied: friendly permission message', async () => {
  const { w } = boot(['voice.js'], () => { throw new Error('no network expected'); });
  mockMic(w, { deny: true });
  w.OpenAI = { transcribe: async () => 'never' };
  const V = w.Voice;
  let got;
  assert.equal(await V.toggle((text, err) => { got = { text, err }; }), false);
  assert.match(got.err, /Microphone access was denied/);
});

test('full round trip: record -> stop -> transcribe -> text to caller', async () => {
  const { w } = boot(['voice.js'], () => { throw new Error('no network expected'); });
  const inst = mockMic(w);
  const seen = [];
  w.OpenAI = { transcribe: async (blob, secs) => { seen.push({ size: blob.size, secs }); return 'the timeline is six sprints'; } };
  const V = w.Voice;
  const events = [];
  V.onChange((what) => events.push(what));
  let got;
  assert.equal(await V.toggle((text, err) => { got = { text, err }; }), true);
  assert.equal(V.state().state, 'rec');
  assert.match(V.mic(), / rec/);
  assert.match(V.micState(), /Listening/);
  inst[0].ondataavailable({ data: new w.Blob(['x'.repeat(500)]) }); // fake audio
  assert.equal(await V.toggle(() => {}), false); // second press stops
  await tick(50);
  assert.equal(V.state().state, 'idle');
  assert.equal(seen.length, 1);
  assert.ok(seen[0].size >= 500, 'transcribe receives the recorded audio');
  assert.equal(got.text, 'the timeline is six sprints');
  assert.equal(got.err, null);
  assert.deepEqual(events, ['state', 'state', 'state']); // idle->rec, rec->stt, stt->idle
});

test('transcription failure: caller gets the error, state returns to idle', async () => {
  const { w } = boot(['voice.js'], () => { throw new Error('no network expected'); });
  const inst = mockMic(w);
  w.OpenAI = { transcribe: async () => { throw new Error('429 Rate limited — wait a moment and retry.'); } };
  const V = w.Voice;
  let got;
  await V.toggle((text, err) => { got = { text, err }; });
  inst[0].ondataavailable({ data: new w.Blob(['x'.repeat(500)]) });
  await V.toggle(() => {});
  await tick(50);
  assert.equal(got.text, null);
  assert.match(got.err, /429/);
  assert.equal(V.state().state, 'idle');
});

test('reset() during recording stays silent', async () => {
  const { w } = boot(['voice.js'], () => { throw new Error('no network expected'); });
  mockMic(w);
  w.OpenAI = { transcribe: async () => 'never' };
  const V = w.Voice;
  let calls = 0;
  await V.toggle(() => { calls++; });
  assert.equal(V.state().state, 'rec');
  V.reset();
  await tick(50);
  assert.equal(calls, 0);
  assert.equal(V.state().state, 'idle');
});

test('transcribe posts to /audio/transcriptions and meters usage', async () => {
  const okRes = { ok: true, status: 200, json: async () => ({ text: '  six sprints  ' }) };
  const { w, calls } = boot(['openai.js'], async () => okRes);
  const AI = w.OpenAI;
  AI.configure({ apiKey: 'sk-test', dryRun: false });
  const text = await AI.transcribe(new w.Blob(['x'.repeat(100)]), 10);
  assert.equal(text, 'six sprints'); // trimmed
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.match(calls[0].opts.headers.Authorization, /^Bearer sk-test$/);
  assert.ok(calls[0].opts.body instanceof w.FormData);
  const total = AI.getUsage().total;
  assert.equal(total.est_usd, 0.006 * 10 / 60);
  assert.equal(AI.getUsage().calls[0].operation, 'whisper');
});

test('transcribe maps 401 to the settings hint', async () => {
  const bad = { ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) };
  const { w } = boot(['openai.js'], async () => bad);
  w.OpenAI.configure({ apiKey: 'sk-bad', dryRun: false });
  await assert.rejects(() => w.OpenAI.transcribe(new w.Blob(['x']), 5), /401 Unauthorized/);
});

test('transcribe refuses without a key', async () => {
  const { w, calls } = boot(['openai.js'], async () => { throw new Error('must not hit network'); });
  w.OpenAI.configure({ apiKey: '', dryRun: false });
  await assert.rejects(() => w.OpenAI.transcribe(new w.Blob(['x']), 5), /No API key/);
  assert.equal(calls.length, 0);
});
