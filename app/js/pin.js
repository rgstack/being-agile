/* PinLock: optional app PIN gate. Offline, zero network. Only "salt:sha256(salt+pin)" is stored; the PIN is never saved or logged. */
(function () {
  'use strict';
  const KEY = 'being-agile-pin';
  const MIN = 4, MAX = 16;
  let unlocked = false;       // never persisted: a reload always re-locks
  let fails = 0, waitUntil = 0; // in-memory brute-force pacing only
  let entry = '', booted = false, onUnlock = null, timer = null;

  const store = (fn) => { try { return fn(window.localStorage); } catch (e) { return null; } };
  const stored = () => store((s) => s.getItem(KEY));

  // ---------- SHA-256 (compact pure-JS fallback) ----------
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  function utf8(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) c = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(++i) - 0xdc00);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  function sha256Js(str) {
    const b = utf8(str), bits = b.length * 8;
    b.push(0x80);
    while (b.length % 64 !== 56) b.push(0);
    b.push(0, 0, 0, 0, (bits >>> 24) & 255, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255);
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Array(64);
    const rr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < b.length; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = (b[o + 4 * i] << 24) | (b[o + 4 * i + 1] << 16) | (b[o + 4 * i + 2] << 8) | b[o + 4 * i + 3];
      for (let i = 16; i < 64; i++) {
        const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, bb, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      const v = [a, bb, c, d, e, f, g, h];
      for (let i = 0; i < 8; i++) H[i] = (H[i] + v[i]) | 0;
    }
    return H.map((x) => ('00000000' + (x >>> 0).toString(16)).slice(-8)).join('');
  }
  const hex = (bytes) => Array.prototype.map.call(bytes, (x) => ('0' + x.toString(16)).slice(-2)).join('');
  async function sha256(str) {
    try {
      if (window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
        return hex(new Uint8Array(await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))));
      }
    } catch (e) { /* fall through to pure JS */ }
    return sha256Js(str);
  }
  function newSalt() {
    const a = new Uint8Array(16);
    window.crypto.getRandomValues(a);
    return hex(a);
  }

  // ---------- core ----------
  const isSet = () => !!stored();
  const validFormat = (p) => typeof p === 'string' && /^[0-9]+$/.test(p) && p.length >= MIN && p.length <= MAX;
  function blockedMs() { return Math.max(0, waitUntil - Date.now()); }
  function noteResult(ok) {
    if (ok) { fails = 0; waitUntil = 0; return; }
    fails++;
    if (fails >= 5) waitUntil = Date.now() + Math.min(10000, 2000 * (fails - 4));
  }
  async function verify(pin) {
    const rec = stored();
    if (!rec || typeof pin !== 'string' || blockedMs() > 0) return false;
    const i = rec.indexOf(':');
    if (i < 1) return false;
    const ok = (await sha256(rec.slice(0, i) + pin)) === rec.slice(i + 1);
    noteResult(ok);
    return ok;
  }
  async function setPin(pin) {
    if (!validFormat(pin)) throw new Error('PIN must be ' + MIN + '–' + MAX + ' digits (numbers only).');
    const salt = newSalt();
    const rec = salt + ':' + (await sha256(salt + pin));
    if (store((s) => { s.setItem(KEY, rec); return true; }) !== true) throw new Error('Could not save the PIN in this browser.');
    unlocked = true; // the person who just set it is in
  }
  function removePin() { store((s) => s.removeItem(KEY)); unlocked = true; hideLock(); }

  // ---------- overlay ----------
  const $ = (id) => document.getElementById(id);
  const wait = (fn) => { clearTimeout(timer); timer = setTimeout(fn, blockedMs() + 20); };

  function showLock() {
    const el = $('lock');
    if (!el) return;
    entry = '';
    el.innerHTML =
      '<div class="lock-card" role="dialog" aria-modal="true" aria-label="Unlock Being Agile">' +
      '<div class="brand"><span class="marks" aria-hidden="true"><i class="mark"></i><i class="mark" data-v="partial"></i><i class="mark" data-v="proven"></i></span>Being Agile</div>' +
      '<p class="lead">Enter your app PIN to unlock</p>' +
      '<div id="pin-dots" class="pin-dots" aria-hidden="true"></div>' +
      '<div class="pin-pad">' +
      '1 2 3 4 5 6 7 8 9'.split(' ').map((d) => '<button type="button" class="pin-key" data-k="' + d + '">' + d + '</button>').join('') +
      '<button type="button" class="pin-key" data-k="C" aria-label="Clear">C</button>' +
      '<button type="button" class="pin-key" data-k="0">0</button>' +
      '<button type="button" class="pin-key" data-k="B" aria-label="Backspace">⌫</button>' +
      '</div>' +
      '<button type="button" id="pin-go" class="btn">Unlock</button>' +
      '<p id="pin-err" class="pin-err" role="alert"></p></div>';
    el.hidden = false;
    paint();
    const pad = el.querySelector('.pin-pad');
    pad.onclick = (e) => { const b = e.target.closest('[data-k]'); if (b) key(b.dataset.k); };
    $('pin-go').onclick = attempt;
    if (blockedMs() > 0) tick();
  }
  function hideLock() { const el = $('lock'); if (el) { el.hidden = true; el.innerHTML = ''; } entry = ''; clearTimeout(timer); }
  const isLockShown = () => { const el = $('lock'); return !!el && !el.hidden; };
  function paint() {
    const d = $('pin-dots');
    if (!d) return;
    const n = Math.max(MIN, entry.length);
    let h = '';
    for (let i = 0; i < n; i++) h += '<span class="' + (i < entry.length ? 'on' : '') + '"></span>';
    d.innerHTML = h;
  }
  function setErr(msg) { const e = $('pin-err'); if (e) e.textContent = msg || ''; }
  function setDisabled(off) {
    const el = $('lock');
    if (el) Array.prototype.forEach.call(el.querySelectorAll('button'), (b) => { b.disabled = off; });
  }
  function tick() {
    const ms = blockedMs();
    if (ms > 0) { setDisabled(true); setErr('Too many tries — wait ' + Math.ceil(ms / 1000) + ' s'); timer = setTimeout(tick, 250); }
    else { setDisabled(false); setErr(''); }
  }
  function key(k) {
    if (blockedMs() > 0) return;
    if (k === 'C') entry = '';
    else if (k === 'B') entry = entry.slice(0, -1);
    else if (entry.length < MAX) entry += k;
    setErr('');
    paint();
  }
  async function attempt() {
    if (blockedMs() > 0 || !entry) return;
    const pin = entry;
    entry = '';
    paint();
    const ok = await verify(pin);
    if (ok) {
      unlocked = true;
      hideLock();
      const cb = onUnlock; onUnlock = null;
      if (cb) cb();
    } else if (blockedMs() > 0) tick();
    else setErr('That PIN didn’t match. Try again.');
  }
  document.addEventListener('keydown', (e) => {
    if (!isLockShown()) return;
    if (/^[0-9]$/.test(e.key)) { key(e.key); e.preventDefault(); }
    else if (e.key === 'Backspace') { key('B'); e.preventDefault(); }
    else if (e.key === 'Enter') { attempt(); e.preventDefault(); }
    else if (e.key === 'Escape') { key('C'); e.preventDefault(); }
  });

  function boot(done) {
    if (!booted) booted = true;
    if (!isSet()) { unlocked = true; done(); return; }
    unlocked = false;
    onUnlock = done;
    showLock();
  }
  function lockNow() {
    if (!isSet()) return;
    unlocked = false;
    const d = $('drawer'); if (d) d.hidden = true;
    showLock();
  }

  // ---------- settings drawer section ----------
  function renderSettings() {
    const host = $('pin-settings');
    if (!host) return;
    const f = (id, label) => '<label class="fld">' + label + '<input id="' + id + '" class="in" type="password" inputmode="numeric" autocomplete="off" spellcheck="false"></label>';
    const msg = '<p id="pin-msg" class="pin-msg" role="status"></p>';
    const hint = '<p class="hint">Forgot the PIN? Clear this site’s browser storage to remove it (your saved demo data goes with it).</p>';
    if (!isSet()) {
      host.innerHTML =
        '<p class="pin-status">No PIN set — anyone with this link can open the app.</p>' +
        f('pin-new', 'New PIN') + f('pin-new2', 'Confirm PIN') +
        '<button type="button" id="pin-set" class="btn">Set PIN</button>' + msg +
        '<p class="hint">4 or more digits. Only a SHA-256 hash is stored on this device; the PIN itself is never saved or logged.</p>' + hint;
    } else {
      host.innerHTML =
        '<p class="pin-status">App PIN is set.</p>' +
        '<button type="button" id="pin-lock" class="btn btn-q">Lock now</button>' +
        '<div class="pin-form"><h4>Change PIN</h4>' + f('pin-cur', 'Current PIN') + f('pin-new', 'New PIN') + f('pin-new2', 'Confirm new PIN') +
        '<button type="button" id="pin-change" class="btn">Change PIN</button></div>' +
        '<div class="pin-form"><h4>Remove PIN</h4>' + f('pin-cur-rm', 'Current PIN') +
        '<button type="button" id="pin-remove" class="btn btn-q">Remove PIN</button></div>' + msg +
        '<p class="hint">Only a SHA-256 hash is stored on this device; the PIN itself is never saved or logged.</p>' + hint;
    }
    const val = (id) => ($(id) ? $(id).value : '');
    const clear = () => ['pin-cur', 'pin-cur-rm', 'pin-new', 'pin-new2'].forEach((id) => { if ($(id)) $(id).value = ''; });
    const say = (t, ok) => { const m = $('pin-msg'); if (m) { m.textContent = t; m.className = 'pin-msg ' + (ok ? 'ok' : 'err'); } };
    const bind = (id, fn) => { const b = $(id); if (b) b.onclick = async () => {
      try { await fn(); } catch (e) { say(e.message || 'Something went wrong.'); }
      clear();
    }; };
    const checkCurrent = async (pin) => {
      if (blockedMs() > 0) throw new Error('Too many tries — wait ' + Math.ceil(blockedMs() / 1000) + ' s');
      if (!(await verify(pin))) throw new Error(blockedMs() > 0 ? 'Too many tries — wait ' + Math.ceil(blockedMs() / 1000) + ' s' : 'Current PIN is incorrect.');
    };
    const pair = () => {
      const a = val('pin-new'), b = val('pin-new2');
      if (!validFormat(a)) throw new Error('PIN must be ' + MIN + '–' + MAX + ' digits (numbers only).');
      if (a !== b) throw new Error('The two new PINs don’t match.');
      return a;
    };
    bind('pin-set', async () => { const p = pair(); await setPin(p); renderSettings(); say('PIN set.', true); });
    bind('pin-change', async () => { const cur = val('pin-cur'), p = pair(); await checkCurrent(cur); await setPin(p); renderSettings(); say('PIN changed.', true); });
    bind('pin-remove', async () => { await checkCurrent(val('pin-cur-rm')); removePin(); renderSettings(); say('PIN removed.', true); });
    const lk = $('pin-lock'); if (lk) lk.onclick = lockNow;
  }

  window.PinLock = { isSet, verify, setPin, removePin, boot, lockNow, renderSettings, _sha256Js: sha256Js };
})();
