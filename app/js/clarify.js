/* Clarify (stage 1): the conversation between your documents and your stories.
   The AI reads every document through a delivery lens (timeline, stakeholders, value stream, business area),
   fills the ledger with what it could place, then asks one question at a time. Nothing it asks blocks you:
   Generate stories is live from the first second and whatever is still open becomes a stated assumption.
   Design: an editorial dossier — a numbered interview in the display face, bound to a ruled ledger in the margin.
   Marks: empty circle = open (or assumed), half circle = found in a document, full green circle = you confirmed it.
   Shape: an IIFE like the other modules; screens.js hands it a slice of its closure via init() and merges
   actions/inputs/changes (all prefixed cl-) into its own delegation maps. Persisted state lives in S.clarify.
   Voice (voice.js, optional): the mic drops transcribed text into the composer as if typed, so it is edited and
   sent through the same turn(); replies get a speaker button. Turns that began as speech are marked voice:true. */
(function () {
  'use strict';
  const ST = window.State, AI = window.OpenAI;
  const VO = () => window.Voice || null; // absent in tests that load clarify.js alone
  const LENSES = ST.LENSES, LABEL = ST.LENS_LABEL;
  let X = null; // from screens.js: getS, ui, render, touch, toast, confirmBox, guarded, go, genStories, esc, mi, ic, fmtUsd, plural, errBox, apiHost, openDoc, openRules
  // View-only state, never persisted. anim: id of the one element that gets an entry animation on this render;
  // animAll: the brief + ledger rows rise together (review just arrived); bump: lens whose mark just changed.
  // fromVoice: the composer text began as speech (cleared when the box empties); vnote: a one-line voice notice under the composer.
  const U = { busy: false, err: '', lastText: '', lastSilent: false, lastVoice: false, anim: null, animAll: false, bump: null, edit: null, editVal: '', staleOk: false, reviewing: false, readT0: 0, capTimer: null, x: {}, fromVoice: false, vnote: '' };
  const S = () => X.getS();
  const C = () => S().clarify;
  const esc = (v) => X.esc(v);
  const tid = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const save = () => ST.save();
  const MARK = { open: 'open', assumed: 'open', found: 'partial', confirmed: 'proven' };
  const DOC_LABEL = { prd: 'PRD', design: 'Design doc', api: 'API spec' };
  const docLabel = (id) => DOC_LABEL[id] || ('Supporting doc ' + (+String(id).slice(1) + 1));
  const cur = (c) => c.questions.find((q) => q.id === c.cursor) || null;
  const qNum = (c, q) => c.questions.indexOf(q) + 1;
  const words = (t) => (String(t || '').trim() ? String(t).trim().split(/\s+/).length : 0);
  const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => x == null || x === ''));

  function docsInfo() {
    const d = S().docs;
    return [['prd', 'PRD'], ['design', 'design doc'], ['api', 'API spec']].map(([id, name]) => ({ id, name, words: words(d[id].text) }))
      .concat(d.extras.map((x, i) => ({ id: 'x' + i, name: x.name || 'supporting doc ' + (i + 1), words: words(x.text) })))
      .filter((x) => x.words > 0);
  }
  const stale = (c) => c.status !== 'idle' && c.docsHash && c.docsHash !== ST.docsHash(S().docs);
  const reading = (c) => c.status === 'reading' || (U.reviewing && X.ui.busy);

  // ---------- rendering ----------
  function headLine(c) {
    const docs = c.brief && c.brief.docs && c.brief.docs.length ? c.brief.docs : docsInfo(), n = docs.reduce((t, d) => t + d.words, 0);
    const parts = ['Clarify', X.plural(docs.length, 'document'), n.toLocaleString() + ' words'];
    if (reading(c)) parts.push('reading');
    else if (c.status !== 'idle') {
      const q = cur(c), total = c.questions.length, open = c.questions.filter((x) => x.status === 'open').length;
      if (q) parts.push('Q' + qNum(c, q) + ' of ~' + total);
      else if (total) parts.push(open ? X.plural(open, 'question') + ' open' : 'nothing more to ask');
    }
    return '<p class="cl-head">' + parts.map(esc).join(' <span aria-hidden="true">·</span> ') + '</p>';
  }
  const staleNote = (c) => (stale(c) && !U.staleOk ? '<p class="cl-stale" role="status">Documents changed since this review. <button class="link" data-a="cl-rereview">Re-review</button> <span aria-hidden="true">·</span> <button class="link" data-a="cl-keep">Keep going</button></p>' : '');
  // A turn that began as speech shows the mic price (~nothing: Whisper is a fraction of a cent, metered separately) in place of the API estimate; the usage meter still records the call.
  const costLine = (cost) => (cost ? '<span class="cl-cost">' + (cost.voice ? 'mic · ~$0.00' : cost.dry ? 'dry-run' : '~' + X.fmtUsd(cost.usd || 0) + ' · ' + ((cost.pt || 0) + (cost.ct || 0)).toLocaleString() + ' tokens') + '</span>' : '');

  function renderTop(c) {
    if (reading(c)) {
      const docs = docsInfo(), max = Math.max(1, ...docs.map((d) => d.words));
      return headLine(c) + '<div class="cl-reading" role="status"><div class="cl-spines" aria-hidden="true">' +
        docs.map((d, i) => '<i style="--h:' + Math.round(40 + 120 * d.words / max) + 'px;--d:' + (i * 180) + 'ms"></i>').join('') + '</div>' +
        '<p class="cl-cap"><span class="marks" aria-hidden="true"><i class="mark"></i><i class="mark"></i><i class="mark"></i></span><span class="cl-cap-t" data-names="' + esc(JSON.stringify(docs.map((d) => d.name))) + '">Reading the ' + esc(docs.length ? docs[0].name : 'documents') + '…</span></p></div>';
    }
    if (c.status === 'idle') {
      return headLine(c) + '<p class="cl-brief cl-intro">Before stories are drafted, I’ll read every document through a delivery lens: timeline, stakeholders, value stream and business area. I’ll place what I can, ask you about what I can’t, and write the rest down as assumptions. Nothing I ask will block you.</p>' + X.errBox();
    }
    return headLine(c) + staleNote(c) + '<p class="cl-brief' + (U.animAll ? ' anim' : '') + '">' + esc(c.brief ? c.brief.summary : '') + costLine(c.brief && c.brief.cost) + '</p>';
  }
  function chips(q) {
    const opts = (q.options || []).slice(0, 4);
    return '<div class="cl-chips" role="group" aria-label="Quick answers">' + opts.map((o) => '<button type="button" data-a="cl-chip" data-k="' + esc(o) + '">' + esc(o) + '</button>').join('') +
      '<button type="button" class="other" data-a="cl-other">Other…</button></div>' +
      '<button type="button" class="link cl-skip" data-a="cl-skip">Skip for now</button>';
  }
  function turnHtml(c, t, i) {
    const anim = U.anim === t.id ? ' anim' : '';
    if (t.kind === 'ask') {
      const q = c.questions.find((x) => x.id === t.qid); if (!q) return '';
      const n = qNum(c, q), lastAsk = c.turns.map((x) => x.kind === 'ask' && x.qid === q.id).lastIndexOf(true) === i;
      if (c.cursor === q.id && q.status === 'open' && lastAsk) {
        return '<li class="turn ask cur' + anim + '" id="' + t.id + '" data-q="' + esc(q.id) + '"><span class="cl-n" aria-hidden="true">' + n + '</span><div class="cl-q">' +
          '<p class="cl-qt"><span class="vh">Question ' + n + ', ' + esc(LABEL[q.lens]) + ': </span>' + esc(q.text) + '</p>' + (q.why ? '<p class="cl-why">' + esc(q.why) + '</p>' : '') + (U.busy ? '' : chips(q)) + '</div></li>';
      }
      const st = q.status === 'answered' ? '<span class="cl-st answered">' + X.ic('check') + 'answered</span>' : q.status === 'skipped' ? '<span class="cl-st">skipped</span>' : '<span class="cl-st">open</span>';
      return '<li class="turn ask settled' + anim + '" id="' + t.id + '"><span class="cl-n" aria-hidden="true">' + n + '</span><div class="cl-q"><p class="cl-qt"><span class="vh">Question ' + n + ': </span>' + esc(q.text) + '</p>' + st + '</div></li>';
    }
    if (t.kind === 'you') return '<li class="turn you' + anim + '" id="' + t.id + '"><span class="cl-n" aria-hidden="true"></span><div class="cl-you"><span class="cl-who">You</span><p>' + esc(t.text) + '</p></div></li>';
    return '<li class="turn say' + anim + '" id="' + t.id + '"><span class="cl-n" aria-hidden="true"></span><div class="cl-say"><p><span class="vh">Analyst: </span>' + X.mi(t.text) + '</p>' + costLine(t.cost) + '</div></li>';
  }
  function composer(c) {
    const q = cur(c), dry = AI.getConfig().dryRun, live = !dry;
    return '<div class="cl-composer"><div class="cl-box">' +
      (q ? '<button type="button" class="cl-lens" data-a="cl-lens" data-k="' + esc(q.lens) + '" title="Show this row in the ledger">' + esc(LABEL[q.lens]) + ' <span aria-hidden="true">▸</span></button>' : '') +
      '<textarea class="cl-input" data-i="cl-composer" rows="1" aria-label="Your reply" placeholder="' + (q ? 'Answer, or tell me something I missed…' : 'Tell me anything else the stories should know…') + '"' + (U.busy ? ' disabled' : '') + '>' + esc(c.composer) + '</textarea>' +
      (VO() ? VO().mic({ disabled: U.busy, dry }) : '') +
      '<button type="button" class="cl-send" data-a="cl-send"' + (U.busy ? ' disabled' : '') + '><span class="kbd" aria-hidden="true">⏎</span>Send</button></div>' +
      (VO() ? VO().micState() : '') + (U.vnote ? '<p class="cl-vnote" role="status">' + esc(U.vnote) + '</p>' : '') +
      (live ? '<p class="ai-hint">Don’t include sensitive information — this goes to ' + esc(X.apiHost()) + '. Each reply is one metered call.</p>' : '<p class="hint cl-dry">Dry-run: scripted replies, nothing is sent.</p>') + '</div>';
  }
  function renderBody(c) {
    if (c.status === 'idle' || reading(c)) return '';
    const thinking = U.busy ? '<div class="cl-think" role="status" aria-label="Waiting for the analyst"><span class="marks" aria-hidden="true"><i class="mark"></i><i class="mark"></i><i class="mark"></i></span></div>' : '';
    const err = U.err ? '<div class="err cl-err" role="alert"><span>' + esc(U.err) + '</span><button type="button" class="btn btn-q btn-s" data-a="cl-retry">Retry</button></div>' : '';
    return '<ol class="cl-turns" role="log" aria-live="polite" aria-relevant="additions">' + c.turns.map((t, i) => turnHtml(c, t, i)).join('') + '</ol>' + thinking + err + composer(c);
  }
  function lensRow(c, k, i) {
    const l = c.ledger[k], st = l.status, open = (c.status === 'idle' || reading(c)) ? 'open' : st;
    const q = c.questions.find((x) => x.lens === k && x.status === 'open');
    let value;
    if (c.status === 'idle' || reading(c) || isEmpty(l.value)) value = '<p class="lens-v none">—</p>';
    else if (k === 'stakeholders') value = '<ul class="lens-people">' + l.value.map((p) => '<li><b>' + esc(p.name) + '</b>' + (p.role ? '<span>' + esc(p.role) + '</span>' : '') + '</li>').join('') + '</ul>';
    else value = '<p class="lens-v">' + esc(ST.lensText(k, l.value)) + '</p>';
    const cites = (l.cites || []).map((x) => (x.doc ? '<button type="button" data-a="cl-cite" data-k="' + esc(x.doc) + '" data-h="' + esc(x.heading) + '">' + esc(docLabel(x.doc)) + (x.heading ? ' › ' + esc(x.heading) : '') + '</button>' : '<span>' + esc(x.heading) + '</span>')).join('');
    let src = '';
    if (c.status !== 'idle' && !reading(c)) {
      if (st === 'confirmed') src = l.source === 'you' || !l.source ? 'you said so' : esc(l.source) + ' · confirmed by you';
      else if (st === 'assumed') src = l.source && l.source !== 'assumed' ? esc(l.source) : 'assumed to keep moving';
      else if (st === 'found') src = l.source ? esc(l.source) : 'found in the documents';
      else src = q ? 'open · Q' + qNum(c, q) : 'not in the documents';
    }
    let acts = '';
    if (U.edit === k) {
      acts = '<div class="lens-edit"><textarea class="in" data-i="cl-edit" rows="' + (k === 'stakeholders' ? 4 : 2) + '" aria-label="Edit ' + esc(LABEL[k]) + '" placeholder="' + (k === 'timeline' ? 'e.g. 12 sprints, or 2 PIs' : k === 'stakeholders' ? 'One per line: Name — role' : 'Type the ' + LABEL[k].toLowerCase()) + '">' + esc(U.editVal) + '</textarea>' +
        '<div class="acts"><button type="button" class="btn btn-s" data-a="cl-edit-save">Save</button><button type="button" class="btn btn-q btn-s" data-a="cl-edit-cancel">Cancel</button></div></div>';
    } else if (c.status !== 'idle' && !reading(c)) {
      acts = '<div class="lens-acts">' + (st === 'found' || st === 'assumed' ? '<button type="button" data-a="cl-confirm" data-k="' + k + '">Confirm</button>' : '') +
        '<button type="button" data-a="cl-edit" data-k="' + k + '">' + (st === 'open' ? 'Answer' : 'Edit') + '</button></div>';
    }
    const word = { open: 'open', assumed: 'assumed', found: 'found, not yet confirmed', confirmed: 'confirmed' }[open];
    return '<li class="lens' + (U.animAll ? ' anim' : '') + (U.x[k] ? ' x' : '') + '" id="lens-' + k + '" data-lens="' + k + '" style="--k:' + i + '">' +
      '<i class="mark' + (U.bump === k ? ' bump' : '') + '" data-v="' + MARK[open] + '" role="img" aria-label="' + esc(LABEL[k] + ': ' + word) + '"></i>' +
      '<div class="lens-b"><div class="lens-n">' + esc(LABEL[k]) + (open === 'assumed' ? '<small class="lens-s">assumed</small>' : '') + '<button type="button" class="lens-tog" data-a="cl-toggle" data-k="' + k + '" aria-expanded="' + !!U.x[k] + '" aria-label="Show ' + esc(LABEL[k].toLowerCase()) + ' details">' + X.ic('caret') + '</button></div>' +
      '<div class="lens-more">' + value + (src || cites ? '<p class="lens-src">' + src + cites + '</p>' : '') + acts + '</div></div></li>';
  }
  function cta(c) {
    const s = S(), busy = X.ui.busy || U.busy, has = ST.hasDocs(s.docs), stories = s.stories.length > 0;
    if (c.status === 'idle' || reading(c)) {
      let est = '';
      try { const e = AI.estimateCall('clarify-review', s.docs); est = AI.getConfig().dryRun ? 'Dry-run: a scripted review, nothing is sent.' : '~' + e.tokens.toLocaleString() + ' tokens · est. ' + X.fmtUsd(e.usd) + ' · ' + esc(e.model); } catch (e) { est = ''; }
      return '<button class="btn" data-a="cl-begin"' + (busy || !has || reading(c) ? ' disabled' : '') + '>' + (reading(c) ? 'Reading…' : 'Begin review') + '</button>' +
        (est ? '<p class="hint">' + est + '</p>' : '') +
        (stories ? '<button class="btn btn-q" data-a="go" data-k="' + ST.STEP.stories + '">Continue to stories</button>' : '<button type="button" class="link" data-a="cl-gen"' + (busy || !has ? ' disabled' : '') + '>Generate stories without a review</button>');
    }
    const n = ST.openAssumptions(c).length;
    const note = n ? X.plural(n, 'open item') + ' become' + (n === 1 ? 's' : '') + ' stated assumptions in the stories.' : 'Everything is confirmed; the stories carry no assumptions from here.';
    if (stories) {
      return '<button class="btn" data-a="go" data-k="' + ST.STEP.stories + '">Continue to stories</button><button class="btn btn-q" data-a="cl-gen"' + (busy ? ' disabled' : '') + '>' + (X.ui.busy ? 'Generating…' : 'Regenerate stories') + '</button><p class="hint">' + note + ' Regenerating replaces the saved stories.</p>';
    }
    return '<button class="btn" data-a="cl-gen"' + (busy ? ' disabled' : '') + '>' + (X.ui.busy ? 'Generating…' : 'Generate stories') + '</button><p class="hint">' + note + '</p>';
  }
  function renderLedger(c) {
    const t = ST.ledgerTally(c.ledger), live = c.status !== 'idle' && !reading(c);
    const tally = live ? '<p class="cl-tally' + (U.animAll ? ' anim' : '') + '">Confirmed ' + t.confirmed + ' of ' + LENSES.length + [['found', 'Found'], ['assumed', 'Assumed'], ['open', 'Open']].filter(([k]) => t[k]).map(([k, l]) => ' <span aria-hidden="true">·</span> ' + l + ' ' + t[k]).join('') + '</p>' : '';
    return '<aside class="ledger" aria-label="The delivery ledger"><p class="cl-kicker">The delivery ledger</p><ul class="lenses">' + LENSES.map((k, i) => lensRow(c, k, i)).join('') + '</ul>' + tally + '<div class="cl-cta">' + cta(c) + '</div></aside>';
  }
  function render() {
    const c = C();
    const html = '<div class="clarify" data-status="' + esc(reading(c) ? 'reading' : c.status) + '"><div class="cl-top">' + renderTop(c) + '</div>' + renderLedger(c) + '<div class="cl-body">' + renderBody(c) + '</div></div>';
    if (reading(c) && !U.readT0) U.readT0 = Date.now();
    U.anim = null; U.animAll = false; U.bump = null; // entry animations run once, on the render that introduced the element
    setTimeout(afterRender, 0);
    return html;
  }
  // DOM touches that need the fresh markup: size the composer, cycle the reading caption.
  function afterRender() {
    const ta = document.querySelector('.cl-input'); if (ta) grow(ta);
    const cap = document.querySelector('.cl-cap-t');
    clearInterval(U.capTimer); U.capTimer = null;
    if (cap) {
      let names = []; try { names = JSON.parse(cap.dataset.names); } catch (e) { names = []; }
      let i = 0;
      if (names.length > 1) U.capTimer = setInterval(() => { if (!cap.isConnected) { clearInterval(U.capTimer); U.capTimer = null; return; } i = (i + 1) % names.length; cap.textContent = (i === names.length - 1 ? 'and the ' : 'then the ') + names[i] + '…'; }, 540);
    }
  }
  function grow(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 16 * 1.45 * 6 + 16) + 'px'; }
  function focusComposer() { const ta = document.querySelector('.cl-input'); if (ta && !ta.disabled) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; } }
  const meta = () => {
    const c = C();
    if (reading(c)) return 'Reading…';
    if (c.status === 'idle') return 'No review yet';
    const t = ST.ledgerTally(c.ledger), open = c.questions.filter((q) => q.status === 'open').length;
    return t.confirmed + ' of ' + LENSES.length + ' confirmed · ' + X.plural(open, 'question') + ' open';
  };

  // ---------- the conversation ----------
  function pose(c, qid) { // the current question always sits at the end of the transcript
    for (let i = c.turns.length - 1; i >= 0; i--) if (c.turns[i].kind === 'ask' && c.turns[i].qid === qid) c.turns.splice(i, 1);
    const t = { id: tid(), kind: 'ask', qid, at: Date.now() };
    c.turns.push(t); c.cursor = qid; U.anim = t.id;
    return t;
  }
  function applyReview(data, usage) {
    const s = S(), c = s.clarify, docs = docsInfo();
    c.brief = { summary: data.brief || 'I read the documents.', words: docs.reduce((t, d) => t + d.words, 0), docs, cost: usage ? { pt: usage.prompt_tokens, ct: usage.completion_tokens, usd: usage.usd, dry: AI.getConfig().dryRun } : null };
    c.digest = data.digest || ''; c.ledger = data.ledger; c.questions = data.questions; c.turns = []; c.cursor = null; c.assumptions = [];
    c.docsHash = ST.docsHash(s.docs); c.status = 'open';
    U.staleOk = false; U.animAll = true; U.err = ''; U.edit = null;
    const first = c.questions.find((q) => q.status === 'open');
    if (first) pose(c, first.id);
    else c.turns.push({ id: tid(), kind: 'say', text: 'I could place everything from the documents. Confirm the rows you agree with, or tell me what I got wrong.', at: Date.now(), cost: null });
  }
  async function begin() {
    const s = S(), c = s.clarify;
    if (U.busy || X.ui.busy) return;
    if (!ST.hasDocs(s.docs)) { X.toast('Add a document first'); return; }
    let got = null;
    U.reviewing = true; U.readT0 = 0; U.err = '';
    const ok = await X.guarded('clarify-review', s.docs, 'Begin review', (data, usage) => { got = { data, usage }; },
      '<p class="hint">Each reply you send afterwards is one further call (~3,000 tokens each, no further prompts).</p>');
    if (ok && got) {
      const wait = Math.max(0, 1600 - (Date.now() - (U.readT0 || Date.now()))); // let the reading animation finish
      if (wait) { c.status = 'reading'; X.render(); await new Promise((r) => setTimeout(r, wait)); }
      applyReview(got.data, got.usage);
    } else if (c.status === 'reading') c.status = 'idle';
    U.reviewing = false; U.readT0 = 0;
    save(); X.render();
    if (ok) focusComposer();
  }
  const turnText = (c, t) => (t.kind === 'ask' ? ((c.questions.find((q) => q.id === t.qid) || {}).text || '') : t.text || '');
  const ctxFor = (c, text) => ({
    digest: c.digest, ledger: c.ledger,
    questions: c.questions.map((q) => ({ id: q.id, lens: q.lens, text: q.text, why: q.why, options: q.options, default: q.default, status: q.status, answer: q.answer })),
    turns: c.turns.slice(-12).map((t) => ({ role: t.kind === 'you' ? 'you' : 'ai', text: turnText(c, t) })),
    cursor: c.cursor, user: text,
  });
  function settleLens(c, k, upd) {
    const prev = c.ledger[k];
    const next = { status: upd.status || prev.status, value: isEmpty(upd.value) ? prev.value : upd.value, source: upd.source || prev.source, cites: upd.cites || prev.cites };
    if (prev.status !== next.status || JSON.stringify(prev.value) !== JSON.stringify(next.value)) U.bump = k;
    c.ledger[k] = ST.normLens(k, next);
  }
  function applyTurn(c, d, usage, cursor, text, voice) {
    Object.keys(d.ledger_updates || {}).forEach((k) => settleLens(c, k, d.ledger_updates[k]));
    (d.question_updates || []).forEach((u) => { const q = c.questions.find((x) => x.id === u.id); if (q) { q.status = u.status; if (u.answer) q.answer = u.answer; } });
    // The analyst moved on without marking the posed question: the user's words were its answer.
    const cq = c.questions.find((q) => q.id === cursor);
    if (cq && cq.status === 'open' && (!d.ask || d.ask.id !== cursor) && text !== '(skipped)') { cq.status = 'answered'; cq.answer = text; }
    let last = null;
    if (d.reply) { last = { id: tid(), kind: 'say', text: d.reply, at: Date.now(), cost: usage ? { pt: usage.prompt_tokens, ct: usage.completion_tokens, usd: usage.usd, dry: AI.getConfig().dryRun, voice: !!voice } : null }; c.turns.push(last); }
    if (d.ask) {
      let q = c.questions.find((x) => x.id === d.ask.id);
      if (q && q.status !== 'open' && q.text !== d.ask.text) q = null; // the model reused an id for a new follow-up
      if (!q) { q = Object.assign({}, d.ask, { id: c.questions.some((x) => x.id === d.ask.id) ? d.ask.id + 'b' : d.ask.id, status: 'open', answer: '' }); c.questions.push(q); }
      else if (q.status !== 'open' && !(d.question_updates || []).some((u) => u.id === q.id)) q.status = 'open'; // re-asked
      last = pose(c, q.id);
    } else c.cursor = null;
    if (last) U.anim = last.id;
  }
  async function turn(text, opts) {
    opts = opts || {};
    const s = S(), c = s.clarify;
    if (U.busy || X.ui.busy || (c.status !== 'open' && c.status !== 'done')) return;
    const voice = !!opts.voice;
    U.busy = true; U.err = ''; U.lastText = text; U.lastSilent = !!opts.silent; U.lastVoice = voice; U.edit = null; U.vnote = '';
    const cursor = c.cursor;
    let you = null;
    if (!opts.silent) { you = { id: tid(), kind: 'you', text, qid: cursor, at: Date.now(), voice }; c.turns.push(you); c.composer = ''; U.fromVoice = false; U.anim = you.id; }
    save(); X.render();
    try {
      const r = await AI.clarifyTurn(ctxFor(c, text));
      applyTurn(c, r.data, r.usage, cursor, text, voice);
      s.usage = AI.getUsage().calls;
    } catch (e) {
      if (you) { const i = c.turns.indexOf(you); if (i !== -1) c.turns.splice(i, 1); c.composer = text; U.fromVoice = voice; } // keep what was typed (or said)
      U.err = (e && e.message) || String(e);
    }
    U.busy = false; save(); X.render();
    if (!U.err) focusComposer();
  }
  // Skip is local: no AI call. The lens takes the analyst's default (assumed) if it offered one; the next listed question is posed.
  // Only when the list is exhausted is the analyst asked once, with "(skipped)", so it can add a follow-up or finish.
  function skip() {
    const c = C(), q = cur(c);
    if (!q || U.busy || X.ui.busy) return;
    q.status = 'skipped';
    const l = c.ledger[q.lens];
    if (l.status === 'open' && q.default) settleLens(c, q.lens, { status: 'assumed', value: ST.parseLens(q.lens, q.default, l.value), source: 'assumed' });
    const next = c.questions.find((x) => x.status === 'open');
    if (next) { pose(c, next.id); save(); X.render(); focusComposer(); }
    else { save(); turn('(skipped)', { silent: true }); }
  }
  // A human act on the ledger (Confirm / Edit) also settles any open question about that lens, without a round trip.
  function settleQuestions(c, k, answer) {
    const open = c.questions.filter((q) => q.lens === k && q.status === 'open');
    if (!open.length) return;
    open.forEach((q) => { q.status = 'answered'; q.answer = answer; });
    if (open.some((q) => q.id === c.cursor)) {
      c.turns.push({ id: tid(), kind: 'you', text: answer, qid: c.cursor, at: Date.now() });
      const next = c.questions.find((x) => x.status === 'open');
      if (next) pose(c, next.id); else c.cursor = null;
    }
  }
  const editText = (k, l) => (k === 'stakeholders' ? (l.value || []).map((p) => p.name + (p.role ? ' — ' + p.role : '')).join('\n') : ST.lensText(k, l.value));

  // ---------- dry-run: the scripted NPPES conversation (pure; also used for estimates) ----------
  // Whatever you type is recorded as the answer and confirms the lens with source "you", so the ledger reflects your words.
  function dryTurn(ctx) {
    const SC = (window.SAMPLE && window.SAMPLE.clarify && window.SAMPLE.clarify.script) || {};
    const qs = Array.isArray(ctx && ctx.questions) ? ctx.questions : [], user = String((ctx && ctx.user) || '').trim();
    const q = qs.find((x) => x.id === ctx.cursor) || null;
    const nextOpen = (skipId) => qs.find((x) => x.status === 'open' && x.id !== skipId) || null;
    const out = { reply: '', ledger_updates: {}, question_updates: [], ask: null, done: false };
    const finish = () => { out.ask = null; out.done = true; };
    if (user === '(skipped)') { out.reply = SC.done || 'That is everything I needed to ask.'; finish(); return out; }
    if (!q) { out.reply = SC.aside || 'Noted — I’ll carry that into the stories.'; const n = nextOpen(null); if (n) out.ask = n; else finish(); return out; }
    if (/\?\s*$/.test(user) || /^(what|why|how|who|when|where|which|can you|could you|tell me|explain)\b/i.test(user)) { out.reply = SC.aside || 'Noted.'; out.ask = q; return out; }
    const sc = SC[q.id] || {}, prev = (ctx.ledger && ctx.ledger[q.lens]) || {};
    const value = q.lens === 'stakeholders' ? (Array.isArray(prev.value) ? prev.value : []).concat([{ name: user, role: sc.role || '', needs: sc.needs || '' }]) : ST.parseLens(q.lens, user, prev.value);
    out.ledger_updates[q.lens] = { status: 'confirmed', value, source: 'you' };
    out.question_updates.push({ id: q.id, status: 'answered', answer: user });
    out.reply = (sc.reply || 'Got it — {answer}.').replace('{answer}', user);
    const n = nextOpen(q.id); if (n) out.ask = n; else finish();
    return out;
  }

  // ---------- voice: speech lands in the composer, never straight into the transcript (ask, don't block) ----------
  const dryRun = () => AI.getConfig().dryRun;
  // Dry-run has no sidecar: the "transcript" is the analyst's own suggested answer, so the demo stays zero-network.
  function scriptedSpeech(c) {
    const q = cur(c);
    if (!q) return 'Nothing else from me; the stories can go ahead.';
    return q.default || (q.options || [])[0] || 'Carry that as an assumption for now.';
  }
  function dropText(c, text) {
    const prev = c.composer || '';
    c.composer = (prev.trim() ? prev.replace(/\s*$/, ' ') : '') + text;
    U.fromVoice = true;
  }
  function micPressed() {
    const c = C(), V = VO();
    if (!V || U.busy || X.ui.busy || (c.status !== 'open' && c.status !== 'done')) return;
    if (dryRun()) {
      dropText(c, scriptedSpeech(c)); U.vnote = 'Voice unavailable in dry-run: scripted text inserted. Edit it, then send.';
      save(); X.render(); focusComposer(); return;
    }
    if (!V.supported()) { X.toast('This browser cannot record audio here. Type your reply instead.'); return; }
    if (!AI.getConfig().hasKey) { X.toast('Add your OpenAI API key in Settings (gear icon) to use the mic.'); return; }
    V.toggle((text, err) => {
      if (err) X.toast(err);
      else if (text) { dropText(c, text); U.vnote = ''; save(); }
      X.render(); if (!err) focusComposer();
    });
  }
  // Mic-button and status line patch in place (no re-render, so typing is never disturbed).
  function syncVoiceDom() {
    const V = VO(); if (!V || !document.querySelector('.clarify')) return;
    const m = document.querySelector('.cl-mic'); if (m) m.outerHTML = V.mic({ disabled: U.busy, dry: dryRun() });
    const s = document.querySelector('.cl-vstate'), ns = V.micState();
    if (s) { if (ns) s.outerHTML = ns; else s.remove(); }
    else if (ns) { const box = document.querySelector('.cl-box'); if (box) box.insertAdjacentHTML('afterend', ns); }
  }
  function voiceChanged() {
    if (document.querySelector('.clarify')) syncVoiceDom();
  }

  // ---------- handlers (merged into screens.js maps; names prefixed cl-) ----------
  const actions = {
    'cl-begin': begin,
    'cl-send': () => { const c = C(), t = c.composer.trim(); if (!t) { focusComposer(); return; } turn(t, { voice: U.fromVoice }); },
    'cl-mic': micPressed,
    'cl-chip': (el) => turn(el.dataset.k),
    'cl-other': () => focusComposer(),
    'cl-skip': skip,
    'cl-retry': () => { U.err = ''; turn(U.lastText, { silent: U.lastSilent, voice: U.lastVoice }); },
    'cl-confirm': (el) => {
      const c = C(), k = el.dataset.k, l = c.ledger[k];
      settleLens(c, k, { status: 'confirmed' });
      settleQuestions(c, k, 'Confirmed: ' + ST.lensText(k, l.value));
      save(); X.render(); X.toast(LABEL[k] + ' confirmed');
    },
    'cl-edit': (el) => { const c = C(), k = el.dataset.k; U.edit = k; U.editVal = editText(k, c.ledger[k]); X.ui.focus = '[data-i="cl-edit"]'; X.render(); },
    'cl-edit-cancel': () => { U.edit = null; U.editVal = ''; X.render(); },
    'cl-edit-save': () => {
      const c = C(), k = U.edit; if (!k) return;
      const text = U.editVal.trim(), l = c.ledger[k];
      if (!text) settleLens(c, k, Object.assign(ST.normLens(k, null), { status: 'open', source: '', cites: l.cites }));
      else { settleLens(c, k, { status: 'confirmed', value: ST.parseLens(k, text, l.value), source: 'you' }); settleQuestions(c, k, text); }
      U.edit = null; U.editVal = ''; save(); X.render();
    },
    'cl-cite': (el) => {
      const id = el.dataset.k, h = (el.dataset.h || '').trim().toLowerCase();
      X.openDoc(id);
      if (h) setTimeout(() => { const el2 = Array.from(document.querySelectorAll('#sheet h1, #sheet h2, #sheet h3')).find((x) => x.textContent.trim().toLowerCase().indexOf(h) !== -1); if (el2) el2.scrollIntoView({ block: 'start' }); }, 60);
    },
    'cl-lens': (el) => { const row = document.getElementById('lens-' + el.dataset.k); if (row) { row.scrollIntoView({ block: 'nearest' }); row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); } },
    'cl-toggle': (el) => { const k = el.dataset.k; U.x[k] = !U.x[k]; const row = document.getElementById('lens-' + k); if (row) { row.classList.toggle('x', U.x[k]); el.setAttribute('aria-expanded', String(U.x[k])); } },
    'cl-rereview': () => { const s = S(); s.clarify = ST.clarifyFresh(); U.staleOk = false; U.err = ''; save(); begin(); },
    'cl-keep': () => { U.staleOk = true; X.render(); },
    'cl-gen': () => X.genStories(),
  };
  let saveT;
  const inputs = {
    'cl-composer': (el) => { C().composer = el.value; if (!el.value.trim()) U.fromVoice = false; grow(el); clearTimeout(saveT); saveT = setTimeout(save, 300); },
    'cl-edit': (el) => { U.editVal = el.value; },
  };
  const changes = {};
  const onEnter = () => {
    if (C().status === 'open' || C().status === 'done') setTimeout(focusComposer, 0);
  };
  const reset = () => { Object.assign(U, { busy: false, err: '', lastText: '', lastSilent: false, lastVoice: false, anim: null, animAll: false, bump: null, edit: null, editVal: '', staleOk: false, reviewing: false, readT0: 0, x: {}, fromVoice: false, vnote: '' }); clearInterval(U.capTimer); U.capTimer = null; if (VO()) VO().reset(); };
  const init = (ctx) => { X = ctx; if (VO()) VO().onChange(voiceChanged); };

  window.Clarify = { init, render, meta, onEnter, reset, actions, inputs, changes, dryTurn, scriptedSpeech };
})();
