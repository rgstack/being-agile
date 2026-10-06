/* Six screens: rendering + interactions. Event delegation on .app / #stage via data-a (click), data-i (input), data-c (change).
   Shell: sidebar (stages + proof tracker) + top bar + #view + right-hand #sheet (document viewer, story detail).
   Read-only text goes through Markdown (marked -> DOMPurify, mermaid fences painted as diagrams); editing stays raw text in Write tabs. */
(function () {
  'use strict';
  // Feature flag: file uploads (Browse buttons + drag-and-drop + "Add another document").
  // false = uploads disabled; testers use "Load NPPES sample". Set true to re-enable.
  const UPLOADS_ENABLED = false;
  const AI = window.OpenAI, ST = window.State, CSV = window.CSV, MD = window.Markdown, RL = window.Rules;
  let S = ST.load();
  const $ = (id) => document.getElementById(id);
  const shell = document.querySelector('.app'), stage = $('stage'), view = $('view'), sheetEl = $('sheet');
  const app = stage; // query root for everything rendered into the view or the sheet
  const esc = MD.esc;
  const mi = (t) => MD.inline(t);
  const fmtUsd = (n) => '$' + (n < 0.01 ? n.toFixed(4) : n.toFixed(2));
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const rows = (s, min) => Math.max(min || 2, Math.min(14, String(s).split('\n').length + 1));
  // write: field path -> true when the Write tab is chosen (Preview is the default); subEdit: "storyId|index" of the subtask being edited
  // sheet: null | 'story' | 'doc' | 'rules'; open/runOpen: expanded report rows / run rows; trace: requirement being traced
  const ui = { busy: false, error: '', assist: {}, focus: null, paste: {}, write: {}, subEdit: null, docOpener: null, sheet: null, docId: null, docLabel: '', trace: null, open: new Set(), runOpen: new Set(), rfilter: 'all', pfilter: 'all', justSaved: false, scrollTo: null, enter: false, vm: {} };

  // ---------- icons (the design's 16px line set) ----------
  const I = {
    x: '<path d="M4 4l8 8M12 4l-8 8"/>', check: '<path d="M3.2 8.4l3.2 3.2 6.4-7.2"/>', plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
    up: '<path d="M8 12.5v-9M4.2 7.2L8 3.4l3.8 3.8"/>', down: '<path d="M8 3.5v9M4.2 8.8L8 12.6l3.8-3.8"/>',
    caret: '<path d="M4.2 6.2L8 10l3.8-3.8"/>', right: '<path d="M6 3.8L10.2 8 6 12.2"/>',
    story: '<path d="M4.2 2.2h7.6a.8.8 0 0 1 .8.8v10.8L8 10.9l-4.6 2.9V3a.8.8 0 0 1 .8-.8z"/>',
    pencil: '<path d="M10.8 2.8l2.4 2.4-7.4 7.4-3.1.7.7-3.1z"/>',
    sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.6v1.5M8 12.9v1.5M1.6 8h1.5M12.9 8h1.5M3.5 3.5l1 1M11.5 11.5l1 1M12.5 3.5l-1 1M4.5 11.5l-1 1"/>',
    moon: '<path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z"/>',
    print: '<path d="M4.5 5.8V2.5h7v3.3M4.5 11.2H3a1 1 0 0 1-1-1V6.8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v3.4a1 1 0 0 1-1 1h-1.5"/><path d="M4.5 9.2h7v4.3h-7z"/>',
    Highest: '<path d="M4 8.2l4-3.6 4 3.6M4 12l4-3.6 4 3.6"/>', High: '<path d="M4 10l4-3.8 4 3.8"/>', Medium: '<path d="M4 6.2h8M4 9.8h8"/>', Low: '<path d="M4 6l4 3.8L12 6"/>',
  };
  const ic = (n, cls) => '<svg class="ic ' + (cls || '') + '" viewBox="0 0 16 16" aria-hidden="true">' + I[n] + '</svg>';
  const initials = (n) => n.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  // ---------- requirements (the 13 in the bundled NPPES PRD) ----------
  const REQS = [['REQ-001', 'Direct NPI lookup with check-digit validation'], ['REQ-002', 'Individual provider search (NPI-1)'], ['REQ-003', 'Organization search (NPI-2)'],
    ['REQ-004', 'Search filters and minimum-criteria guard'], ['REQ-005', 'Paginated results with honest counts'], ['REQ-006', 'Provider detail view'],
    ['REQ-007', 'Verification against the enrollment record'], ['REQ-008', 'Batch verification'], ['REQ-009', 'Error handling and messaging'],
    ['REQ-010', 'Caching with visible freshness'], ['REQ-011', 'Upstream protection and resilience'], ['REQ-012', 'Audit trail and evidence snapshots'], ['REQ-013', 'Access control and data handling']];
  const REQ_NAME = Object.fromEntries(REQS);
  const VKEY = { PROVEN: 'proven', PARTIAL: 'partial', FAILED: 'failed', 'NOT RUN': 'notrun' };
  const VLABEL = { proven: 'Proven', partial: 'Partial', failed: 'Failed', notrun: 'Not run' };
  const RKEY = { PASS: 'pass', FAIL: 'fail', BLOCKED: 'blocked' };
  const RLABEL = { pass: 'Pass', fail: 'Fail', blocked: 'Blocked', notrun: 'Not run' };
  const resKey = (id) => { const r = S.results[id]; return r ? RKEY[r.status] : 'notrun'; };
  const vText = (v, label) => '<span class="verdict" data-v="' + v + '"><span class="t">' + label + '</span></span>';

  // ---------- shared UI ----------
  let toastT;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600);
  }
  function confirmBox(title, bodyHtml, ok) {
    return new Promise((res) => {
      const m = $('modal'), box = m.firstElementChild;
      box.innerHTML = '<h2>' + esc(title) + '</h2><div style="margin:12px 0 18px">' + bodyHtml + '</div><div class="mbar"><button class="btn btn-q" data-r="0">Cancel</button><button class="btn" data-r="1">' + esc(ok || 'Confirm') + '</button></div>';
      m.hidden = false;
      box.onclick = (e) => { const r = e.target.closest('[data-r]'); if (r) { m.hidden = true; res(r.dataset.r === '1'); } };
      box.querySelector('[data-r="1"]').focus();
    });
  }
  const KINDS = [['stories', 'Stories'], ['plan', 'Test plan'], ['cases', 'Test cases']];
  const dirty = (k) => !!S.draft[k] && JSON.stringify(S.draft[k]) !== JSON.stringify(S[k]);
  const dirtyKinds = () => KINDS.filter(([k]) => dirty(k));
  const anyDirty = () => dirtyKinds().length > 0;

  async function guarded(op, input, title, apply) {
    const est = AI.estimateCall(op, input), cfg = AI.getConfig();
    const ok = await confirmBox(title,
      '<p>This will use <b>~' + est.tokens.toLocaleString() + ' tokens</b>, est. <b>' + fmtUsd(est.usd) + '</b> (' + esc(est.model) + ').</p>' +
      '<p class="hint">Input ~' + est.inputTokens.toLocaleString() + ' (cap ' + est.capIn.toLocaleString() + ') · output ~' + est.outputTokens.toLocaleString() + ' (cap ' + est.capOut.toLocaleString() + ')</p>' +
      (cfg.dryRun ? '<p class="hint">Dry-run: simulated response, nothing is sent and nothing is spent.</p>' : '<p>Live call target: <b>' + esc(est.endpointHost) + '</b></p>') +
      (est.overCap ? '<p class="note">Input is over the budget cap. ' + (cfg.dryRun ? 'A live call would abort; dry-run continues.' : 'This call will be aborted.') + '</p>' : ''), 'Confirm');
    if (!ok) return;
    ui.busy = true; ui.error = ''; render();
    try {
      const r = await (op === 'stories' ? AI.generateStories(input) : op === 'plan' ? AI.generateTestPlan(input) : AI.generateTestCases(input.plan, input.stories));
      apply(r.data);
      S.usage = AI.getUsage().calls; ST.save();
      toast('Generated (' + (r.usage.prompt_tokens + r.usage.completion_tokens).toLocaleString() + ' tokens' + (cfg.dryRun ? ' est., dry-run' : ' live') + ')');
    } catch (e) { ui.error = e.message || String(e); }
    ui.busy = false; render();
  }

  // ---------- requirement model (shared by coverage strip + report + proof tracker) ----------
  function reqModel(stories, cases) {
    const reqs = {}, add = (r) => (reqs[r] = reqs[r] || { id: r, stories: [], cases: [] });
    const reqsOf = (labels) => labels.filter((l) => /^REQ-/i.test(l));
    stories.forEach((s) => reqsOf(s.labels).forEach((l) => add(l.toUpperCase()).stories.push(s)));
    cases.forEach((c) => String(c.requirement_ref).split(/[,\s]+/).filter(Boolean).forEach((r) => add(r.toUpperCase()).cases.push(c)));
    return Object.values(reqs).sort((a, b) => a.id.localeCompare(b.id)).map((r) => Object.assign(r, { verdict: ST.verdict(r.cases) }));
  }
  // every bundled requirement appears even when nothing links to it yet (NOT RUN)
  function reportModel() {
    const by = {};
    reqModel(S.stories, S.cases).forEach((r) => (by[r.id] = r));
    REQS.forEach(([id]) => { if (!by[id]) by[id] = { id, stories: [], cases: [], verdict: 'NOT RUN' }; });
    return Object.values(by).sort((a, b) => a.id.localeCompare(b.id));
  }
  const reqName = (r) => REQ_NAME[r.id] || r.id;
  const reqNameHtml = (r) => (REQ_NAME[r.id] ? esc(REQ_NAME[r.id]) : r.stories[0] ? mi(r.stories[0].title) : esc(r.id));
  const reqChip = (id) => '<span class="req" title="' + esc(REQ_NAME[id] || id) + '"><i class="mark" data-v="' + (ui.vm[id.toUpperCase()] || 'notrun') + '"></i>' + esc(id) + '</span>';
  const reqChips = (ids) => ids.map(reqChip).join('');

  // ---------- chrome: sidebar stages, proof tracker, top bar ----------
  const nav = $('steps');
  nav.innerHTML = '<span class="pip" aria-hidden="true"></span>' + ST.STEPS.map((n, i) =>
    '<button class="stage-link" data-step="' + i + '"><span class="n">' + (i + 1) + '</span><span class="l">' + n + '</span><span class="m"></span></button>').join('');
  let reqKey = '';
  function buildReqUI(ids) {
    const key = ids.join(',');
    if (key === reqKey) return;
    reqKey = key;
    const btn = (id, k, cls) => '<button data-a="trace" data-k="' + id + '" aria-pressed="false" title="' + esc(id + (REQ_NAME[id] ? ' · ' + REQ_NAME[id] : '')) + '" aria-label="' + esc(id + (REQ_NAME[id] ? ', ' + REQ_NAME[id] : '')) + '"><i class="mark" data-reqmark="' + id + '" style="--k:' + k + '"></i></button>';
    $('proof').innerHTML = '<div class="proof-h"><span>Proof so far</span><span>' + ids.length + ' requirements</span></div><div class="proof-row" role="group" aria-label="Requirements">' + ids.map((id, k) => btn(id, k)).join('') + '</div><div class="proof-c" id="proofc"></div>';
    $('top-marks').innerHTML = ids.map((id, k) => btn(id, k)).join('');
  }
  function marks() {
    document.querySelectorAll('[data-reqmark]').forEach((m) => {
      const v = ui.vm[m.dataset.reqmark] || 'notrun';
      if (m.dataset.v && m.dataset.v !== v) { m.classList.remove('bump'); void m.offsetWidth; m.classList.add('bump'); }
      m.dataset.v = v;
    });
    document.querySelectorAll('.proof-row button, .top-marks button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === ui.trace)));
  }
  function chromeSave() {
    const n = dirtyKinds().length, st = $('savestate'), b = $('saveall');
    st.className = 'save-state' + (n ? ' dirty' : ui.justSaved ? ' done' : '');
    st.textContent = n ? 'Unsaved changes' : ui.justSaved ? 'Saved just now' : 'All changes saved';
    b.disabled = !n;
    b.innerHTML = n ? 'Save all<span class="count">' + n + '</span>' : 'Save all';
    b.title = n ? 'Unsaved: ' + dirtyKinds().map((k) => k[1]).join(', ') : 'Nothing to save';
  }
  function renderChrome() {
    const model = reportModel(), tally = { proven: 0, partial: 0, failed: 0, notrun: 0 };
    ui.vm = {};
    model.forEach((r) => { ui.vm[r.id] = VKEY[r.verdict]; tally[VKEY[r.verdict]]++; });
    const c = counts(), nCases = S.cases.length;
    const planN = S.plan ? Object.keys(PLAN_LABELS).filter((k) => (Array.isArray(S.plan[k]) ? S.plan[k].length : String(S.plan[k] || '').trim())).length : 0;
    const d = S.docs, nDocs = [d.prd, d.design, d.api].concat(d.extras).filter((x) => x.text.trim()).length;
    const meta = [nDocs ? plural(nDocs, 'document') : 'No documents yet', S.stories.length ? plural(S.stories.length, 'story', 'stories') : 'No stories yet', S.plan ? plural(planN, 'section') : 'No plan yet',
      nCases ? plural(nCases, 'case') : 'No cases yet', nCases ? (nCases - c['NOT RUN']) + ' of ' + nCases + ' run' : 'Nothing to run', tally.proven + ' of ' + model.length + ' proven'];
    nav.style.setProperty('--i', S.step);
    nav.querySelectorAll('.stage-link').forEach((b, i) => {
      if (i === S.step) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      const ok = ST.unlocked(i);
      b.disabled = !ok; b.title = ok ? '' : 'Review gate: complete the previous stage first';
      b.querySelector('.m').textContent = meta[i];
    });
    const act = nav.querySelectorAll('.stage-link')[S.step];
    if (act && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = act.offsetLeft - (nav.clientWidth - act.offsetWidth) / 2;
    buildReqUI(model.map((r) => r.id));
    marks();
    $('proofc').textContent = ['proven', 'partial', 'failed', 'notrun'].filter((k) => tally[k]).map((k) => tally[k] + ' ' + VLABEL[k].toLowerCase()).join(', ');
    const r = ui.trace && model.find((x) => x.id === ui.trace);
    $('traceslot').innerHTML = r ? '<button class="trace" data-a="trace-clear" aria-label="Stop tracing ' + esc(r.id) + '"><i class="mark" data-reqmark="' + esc(r.id) + '" data-v="' + VKEY[r.verdict] + '"></i><b>Tracing ' + esc(r.id) + '</b><span class="tn">' + esc(reqName(r)) + '</span><span class="x">' + ic('x') + '</span></button>' : '';
    chromeSave();
    const u = AI.getUsage().total;
    $('meter').textContent = (u.prompt_tokens + u.completion_tokens).toLocaleString() + ' tok · ~' + fmtUsd(u.est_usd) + (AI.getConfig().dryRun ? ' · dry-run' : ' · live');
    const calls = AI.getUsage().calls;
    $('usage').innerHTML = calls.length
      ? '<table class="u-tbl"><tr><th>Call</th><th>Model</th><th>In</th><th>Out</th><th>$</th></tr>' + calls.map((x) =>
        '<tr><td>' + x.operation + '</td><td>' + x.model + '</td><td>' + x.prompt_tokens.toLocaleString() + '</td><td>' + x.completion_tokens.toLocaleString() + '</td><td>' + fmtUsd(x.est_usd) + '</td></tr>').join('') +
      '<tr><th>Total</th><th></th><th>' + u.prompt_tokens.toLocaleString() + '</th><th>' + u.completion_tokens.toLocaleString() + '</th><th>' + fmtUsd(u.est_usd) + '</th></tr></table>'
      : '<p class="hint">No calls yet.</p>';
  }

  // ---------- page furniture ----------
  const head = (title, lede, tools) => '<h1 class="title">' + title + '</h1><p class="lede">' + lede + '</p>' + (tools ? '<div class="bar">' + tools + '</div>' : '');
  const apiHost = () => { try { return new URL(AI.getConfig().endpoint).hostname; } catch (e) { return AI.getConfig().endpoint; } };
  const errBox = () => (ui.error ? '<div class="err" role="alert">' + esc(ui.error) + '</div>' : '');
  const NEXT = { 0: ['stories', 1], 1: ['the test plan', 2], 2: ['test cases', 3], 3: ['the run', 4], 4: ['the report', 5] };
  const nextBtn = (step) => { const nx = NEXT[step]; return nx ? '<button class="btn' + (step === 0 ? ' btn-q' : '') + '" data-a="go" data-k="' + nx[1] + '"' + (ST.unlocked(nx[1]) ? '' : ' disabled title="Review gate: save the previous stage first"') + '>Continue to ' + nx[0] + '</button>' : ''; };
  // next-step row at the foot of every screen; on Stories / Test plan / Test cases it carries the unsaved-changes hint
  function nextInner() {
    const ks = dirtyKinds(), mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
    let h = '';
    if (S.step === 0) {
      const d = S.docs, has = [d.prd, d.design, d.api].concat(d.extras).some((x) => x.text.trim());
      h = '<button class="btn" data-a="gen-stories"' + (has && !ui.busy ? '' : ' disabled') + '>' + (ui.busy ? 'Generating…' : 'Generate stories') + '</button>' + (S.stories.length ? nextBtn(0) : '');
    } else h = nextBtn(S.step);
    if (S.step >= 1 && S.step <= 3 && ks.length) h += '<span class="hint">Unsaved changes in ' + ks.map((k) => k[1]).join(', ') + '. Run and Report use the last saved version. <span class="kbd">' + (mac ? '⌘' : 'Ctrl') + '</span><span class="kbd">S</span> saves.</span>';
    return h;
  }
  const nextRow = () => '<div class="next" id="next">' + nextInner() + '</div>';
  const csvBtn = (a) => '<button class="btn btn-q btn-s" data-a="' + a + '">Export CSV</button>';
  const genBtn = (exists, act, first) => '<button class="btn' + (exists ? ' btn-q btn-s' : '') + '" data-a="' + act + '"' + (ui.busy ? ' disabled' : '') + '>' + (ui.busy ? 'Generating…' : (exists ? 'Regenerate' : first)) + '</button>';
  const tabs = (act, cur, items) => '<div class="tabs" role="tablist">' + items.map(([v, l, c]) => '<button class="tab" role="tab" aria-selected="' + (v === cur) + '" data-a="' + act + '" data-k="' + v + '">' + l + (c === undefined ? '' : '<span class="c">' + c + '</span>') + '</button>').join('') + '</div>';

  // ---------- markdown Write / Preview tabs ----------
  // fmt: 'ac' = one item per line -> checklist; 'steps' = one per line -> numbered list; '' = plain markdown
  const numbered = (t) => t.split('\n').map((l) => l.trim().replace(/^\d+[.)]\s+/, '')).filter(Boolean).map((l, i) => (i + 1) + '. ' + l).join('\n');
  const previewHtml = (v, fmt) => (fmt === 'ac' ? MD.render(v, { list: true }) : MD.render(fmt === 'steps' ? numbered(v) : v));
  function rt(path, value, fmt, min) {
    const w = !!ui.write[path], p = esc(path), tab = (t, label, on) => '<button type="button" role="tab" data-a="rt-tab" data-k="' + p + '" data-t="' + t + '" aria-selected="' + on + '">' + label + '</button>';
    return '<div class="rt" data-fmt="' + (fmt || '') + '"><div class="rt-tabs" role="tablist">' + tab('preview', 'Preview', !w) + tab('write', 'Write', w) + '</div>' +
      '<div class="rt-write" role="tabpanel"' + (w ? '' : ' hidden') + '><textarea data-i="rt" data-k="' + p + '" rows="' + rows(value, min || 3) + '" spellcheck="false" placeholder="Markdown supported">' + esc(value) + '</textarea></div>' +
      '<div class="rt-prev md prose" role="tabpanel"' + (w ? ' hidden' : '') + '></div></div>';
  }
  function grow(t) { t.style.height = 'auto'; t.style.height = (t.scrollHeight + 2) + 'px'; }
  const paintPrev = (box) => { const v = box.querySelector('.rt-prev'); if (v && !v.hidden) v.innerHTML = previewHtml(box.querySelector('textarea').value, box.dataset.fmt); };
  // fill every visible Preview pane under root from its textarea, size visible textareas, then paint diagrams
  function hydrate(root) {
    root.querySelectorAll('.rt').forEach(paintPrev);
    root.querySelectorAll('.rt-write:not([hidden]) textarea, textarea.story-title, textarea.run-in').forEach(grow);
    MD.paintMermaid(root);
  }
  function setRT(path, v) {
    const p = path.split('|');
    if (p[0] === 's') { const s = (S.draft.stories || []).find((x) => x.id === p[1]); if (!s) return; if (p[2] === 'desc') s.description = v; else s.acceptance_criteria = v.split('\n'); }
    else if (p[0] === 'plan') { const k = p[1]; S.draft.plan[k] = Array.isArray(S.draft.plan[k]) ? v.split('\n') : v; }
    else if (p[0] === 'case') { const c = S.draft.cases[+p[1]]; if (!c) return; if (p[2] === 'steps') c.steps = v.split('\n'); else c.expected = v; }
  }
  const clearCaseTabs = () => Object.keys(ui.write).forEach((k) => { if (k.indexOf('case|') === 0) delete ui.write[k]; });

  // ---------- the sheet (right-hand detail panel) ----------
  function closeSheet() {
    if (!ui.sheet) return;
    const was = ui.sheet, opener = ui.docOpener;
    ui.sheet = null; ui.docOpener = null; ui.subEdit = null;
    stage.classList.remove('open'); delete stage.dataset.sheet;
    if (was === 'doc') { const o = opener && view.querySelector('button[data-a="open-doc"][data-k="' + opener + '"]'); if (o) o.focus(); }
    else { const o = view.querySelector('.card[data-k="' + (S.sel || '') + '"]'); if (o) o.focus(); }
    view.querySelectorAll('.doc.on').forEach((r) => r.classList.remove('on'));
    view.querySelectorAll('.card[aria-current="true"]').forEach((r) => r.setAttribute('aria-current', 'false'));
  }
  function sheetDoc(d, label) {
    return '<div class="sheet-head"><span class="sheet-kicker">' + esc(label) + '</span><span class="sheet-file">' + esc(d.name || label) + '</span><span class="sp"></span>' +
      '<button class="icon-btn" data-a="sheet-close" aria-label="Close">' + ic('x') + '</button><span class="sheet-prog" aria-hidden="true"></span></div>' +
      '<div class="sheet-body"><article class="md doc-md sheet-swap">' + MD.render(d.text || '') + '</article></div>';
  }
  function openDocSheet(d, label, id) {
    ui.sheet = 'doc'; ui.docId = id; ui.docLabel = label; ui.docOpener = id; ui.subEdit = null;
    sheetEl.innerHTML = sheetDoc(d, label); sheetEl.setAttribute('aria-label', label);
    stage.dataset.sheet = 'doc'; stage.classList.add('open');
    MD.paintMermaid(sheetEl);
    view.querySelectorAll('.doc').forEach((r) => r.classList.toggle('on', r.dataset.doc === id));
    sheetEl.querySelector('[data-a="sheet-close"]').focus();
  }
  // ---------- Rules & Philosophy (read-only reference; generation prompts follow these rules) ----------
  function sheetRules() {
    return '<div class="sheet-head"><span class="sheet-kicker">' + esc(RL.title) + '</span><span class="sp"></span>' +
      '<button class="icon-btn" data-a="sheet-close" aria-label="Close rules">' + ic('x') + '</button><span class="sheet-prog" aria-hidden="true"></span></div>' +
      '<div class="sheet-body"><article class="md doc-md sheet-swap">' + MD.render(RL.markdown) + '</article></div>';
  }
  function openRulesSheet() {
    ui.sheet = 'rules'; ui.subEdit = null;
    sheetEl.innerHTML = sheetRules(); sheetEl.setAttribute('aria-label', RL.title);
    stage.dataset.sheet = 'rules'; stage.classList.add('open');
    MD.paintMermaid(sheetEl);
    sheetEl.querySelector('[data-a="sheet-close"]').focus();
  }
  function paintSheet(keepTop) {
    if (ui.sheet === 'story' && (S.step !== 1 || !curStory())) ui.sheet = null;
    if (ui.sheet === 'doc' && S.step !== 0) ui.sheet = null;
    if (ui.sheet === 'story') {
      sheetEl.innerHTML = sheetStory(curStory()); sheetEl.setAttribute('aria-label', 'Story detail');
      stage.dataset.sheet = 'story'; stage.classList.add('open');
      const b = sheetEl.querySelector('.sheet-body'); if (b && keepTop) b.scrollTop = keepTop;
      hydrate(sheetEl);
    } else if (ui.sheet !== 'doc' && ui.sheet !== 'rules') { stage.classList.remove('open'); delete stage.dataset.sheet; }
  }
  sheetEl.addEventListener('scroll', (e) => {
    const b = e.target; if (!b.classList || !b.classList.contains('sheet-body')) return;
    const p = sheetEl.querySelector('.sheet-prog'); if (p) p.style.setProperty('--p', b.scrollTop / Math.max(1, b.scrollHeight - b.clientHeight));
  }, true);

  // ---------- 1. Start ----------
  const docId = (key, extraIdx) => (extraIdx == null ? key : 'x' + extraIdx);
  function docRow(key, label, d, extraIdx) {
    const id = docId(key, extraIdx), has = !!d.text.trim();
    const browse = UPLOADS_ENABLED ? '<label class="link browse">' + (has ? 'Replace' : 'Browse') + '<input type="file" class="vh" accept=".md,.txt,text/*" data-c="file" data-k="' + id + '"></label>' : '';
    return '<li class="doc' + (has ? '' : ' empty') + (ui.paste[id] ? ' has-paste' : '') + (ui.sheet === 'doc' && ui.docId === id ? ' on' : '') + '" data-doc="' + id + '"' + (UPLOADS_ENABLED ? ' data-drop="' + id + '"' : '') + (has ? ' data-a="open-doc" data-k="' + id + '" data-label="' + esc(label) + '"' : '') + '>' +
      '<span class="doc-label">' + esc(label) + '</span>' +
      (has ? '<span class="doc-file" title="' + esc(d.name || label) + '">' + esc(d.name || label) + '</span>' : '<span class="doc-file doc-empty">No document</span>') +
      '<span class="doc-act">' +
      (has ? '<button class="btn btn-q btn-s" data-a="open-doc" data-k="' + id + '" data-label="' + esc(label) + '" aria-label="View ' + esc(label) + '">View</button>' + browse
        : browse + '<button class="link" data-a="toggle-paste" data-k="' + id + '">Paste</button>') +
      (extraIdx != null ? '<button class="link" data-a="rm-extra" data-k="' + extraIdx + '">Remove</button>' : '') + '</span>' +
      (ui.paste[id] ? '<div class="doc-paste"><textarea class="in" data-i="doc" data-k="' + id + '" placeholder="Paste text here" spellcheck="false" rows="6">' + esc(d.text) + '</textarea></div>' : '') + '</li>';
  }
  const docRef = (id) => (id[0] === 'x' ? S.docs.extras[+id.slice(1)] : S.docs[id]);
  function renderStart() {
    const d = S.docs, dry = AI.getConfig().dryRun;
    return head('Start with your source documents', dry
      ? 'Add the PRD, design doc and API spec (plus any supporting docs). Nothing leaves your browser in Phase 1 — generation is simulated (dry-run).'
      : 'Add the PRD, design doc and API spec (plus any supporting docs). <b>Live mode:</b> calls OpenAI with your key. Sample docs are condensed to control cost — full text in dry-run.') +
      '<ul class="docs">' + docRow('prd', 'PRD', d.prd) + docRow('design', 'Design doc', d.design) + docRow('api', 'API spec', d.api) + '</ul>' +
      (d.extras.length ? '<h2 class="group">Supporting documents</h2><ul class="docs">' + d.extras.map((x, i) => docRow('x', 'Supporting doc ' + (i + 1), x, i)).join('') + '</ul>' : '') +
      '<div class="bar" style="margin-top:14px">' + (UPLOADS_ENABLED ? '<button class="add-doc" data-a="add-extra" style="margin-top:0">' + ic('plus') + 'Add another document</button><span class="sp"></span>' : '') + '<button class="btn btn-q btn-s" data-a="load-sample">Load NPPES sample</button></div>' +
      errBox() + nextRow() +
      '<p class="how"><b>How this works.</b> AI drafts → you edit → you save. ' + (UPLOADS_ENABLED ? 'Drop a file on any row, browse for one, or paste text.' : 'Load the NPPES sample below, or paste text into any row.') + '</p>' +
      '<p class="ext-note"><b>NOTE:</b> <b>External service:</b> Being Agile runs outside your organization\u2019s infrastructure \u2014 files and content you load here are not inside your company systems. When you generate or use AI assist, document text may be sent to <b>' + esc(apiHost()) + '</b>. Don\u2019t upload sensitive information or anything you are not authorized to share.</p>';
  }

  // ---------- 2. Stories ----------
  const PRIOS = ['P0', 'P1', 'P2', 'P3'], STATUSES = ['To Do', 'In Progress', 'Done'];
  const PRIO_ICON = { P0: 'Highest', P1: 'High', P2: 'Medium', P3: 'Low' };
  const prio = (p) => '<span class="prio">' + (PRIO_ICON[p] ? ic(PRIO_ICON[p]) : '') + esc(p) + '</span>';
  const statusChip = (s) => '<span class="status" data-s="' + esc(s) + '"><i></i>' + esc(s) + '</span>';
  const curStory = () => (S.draft.stories || []).find((s) => s.id === S.sel);
  const reqsOf = (labels) => labels.filter((l) => /^REQ-/i.test(l));
  const storyEdited = (s) => { const v = S.stories.find((x) => x.id === s.id); return !v || JSON.stringify(v) !== JSON.stringify(s); };
  const catKind = (l) => (/^phase-/i.test(l) ? 'phase' : /^REQ-/i.test(l) ? 'req' : 'area');
  function catsHtml(labels) {
    if (!labels.length) return '<span class="hint">No labels</span>';
    const order = { phase: 0, area: 1, req: 2 };
    return labels.slice().sort((a, b) => order[catKind(a)] - order[catKind(b)]).map((l) => (catKind(l) === 'req' ? reqChip(l.toUpperCase()) : '<span class="label">' + esc(l) + '</span>')).join('');
  }
  // Apply is offered on every assist box: the AI returns only the improved item,
  // so one click replaces the field(s) with it. Structured targets (subtasks,
  // plan sections, case fields) are parsed back from the AI's text.
  const APPLYABLE = { 'description': 1, 'acceptance criteria': 1, 'subtasks': 1, 'test plan': 1 };
  const canApply = (sec) => APPLYABLE[sec] || sec.indexOf('case ') === 0;
  // Prefer the fenced code block (the AI's rewrite) over the full reply.
  function applyText(md) { const m = /```(?:[a-zA-Z0-9_-]*\n)?([\s\S]*?)```/.exec(md || ''); return (m ? m[1] : (md || '')).trim(); }
  // Parse the AI's improved test plan back into fields via its ## section headers.
  function parsePlanApply(text) {
    const KEYS = [
      ['objectives', ['objectives']],
      ['scope_in', ['scopein', 'inscope']],
      ['scope_out', ['scopeout', 'outofscope']],
      ['approach', ['approach']],
      ['entry_criteria', ['entrycriteria']],
      ['exit_criteria', ['exitcriteria']],
      ['risks', ['risks']],
    ];
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const secs = {}; let cur = null;
    text.split('\n').forEach((raw) => {
      const hm = /^##\s+(.+?)\s*$/.exec(raw);
      if (hm) {
        const h = norm(hm[1]); cur = null;
        KEYS.forEach(([key, words]) => { if (!cur && words.some((w) => h.indexOf(w) !== -1)) cur = key; });
        if (cur && !secs[cur]) secs[cur] = [];
      } else if (cur) secs[cur].push(raw);
    });
    const out = {};
    Object.keys(secs).forEach((k) => { const t = secs[k].join('\n').trim(); if (t) out[k] = t; });
    return out;
  }
  // Parse the AI's improved test case back into fields (Title/Requirement/
  // Priority/Steps/Expected result). Only non-empty fields are applied.
  function parseCaseApply(text) {
    const out = { steps: [], expected: [] };
    let section = null;
    text.split('\n').forEach((raw) => {
      const l = raw.trim(), m = /^([A-Za-z ]+):\s*(.*)$/.exec(l), k = m ? m[1].trim().toLowerCase() : null;
      if (k === 'title') { out.title = m[2].trim(); section = null; return; }
      if (k === 'requirement' || k === 'requirement ref') { out.requirement_ref = m[2].trim(); section = null; return; }
      if (k === 'priority') { out.priority = m[2].trim().toUpperCase(); section = null; return; }
      if (k === 'steps' || k === 'step') { section = 'steps'; if (m[2].trim()) out.steps.push(m[2].trim()); return; }
      if (k === 'expected result' || k === 'expected') { section = 'expected'; if (m[2].trim()) out.expected.push(m[2].trim()); return; }
      if (section === 'steps' && l) out.steps.push(l.replace(/^\d+[.)]\s+/, ''));
      else if (section === 'expected' && l) out.expected.push(l);
    });
    out.expected = out.expected.join('\n');
    return out;
  }
  function assistBox(sec) {
    const a = ui.assist[sec] || {};
    return '<div class="assist" ' + (a.open ? '' : 'hidden') + '><div class="ai-box"><span class="ai-tag">AI</span><input data-i="assist-prompt" data-k="' + sec + '" placeholder="Ask AI to improve this…" aria-label="Ask AI to improve ' + displayKind(sec) + '" value="' + esc(a.prompt || '') + '"><button class="ai-go" data-a="assist" data-k="' + sec + '">Ask</button></div>' +
      '<div class="ai-hint">Don\u2019t include sensitive information in your request \u2014 it goes to the AI service.</div>' +
      (a.out ? '<div class="ai-prop"><div class="body md">' + MD.render(a.out) + '</div>' + (a.ok && canApply(sec) ? '<button class="btn btn-s" data-a="assist-apply" data-k="' + sec + '" title="Replace with the AI response">Apply</button>' : '') + '</div>' : '') + '</div>';
  }
  const aiLink = (sec) => '<button class="ai-link" data-a="assist-toggle" data-k="' + sec + '" aria-expanded="' + !!(ui.assist[sec] || {}).open + '">AI assist</button>';
  // 'case 0' -> 'case 1' for anything the user reads; keys stay zero-indexed.
  function displayKind(k) {
    const m = /^case (\d+)$/.exec(k || '');
    return m ? 'case ' + (+m[1] + 1) : k;
  }
  function assistContext(k) {
    if (k === 'test plan') {
      const p = S.draft.plan; if (!p) return '';
      return Object.keys(PLAN_LABELS).map((key) => '## ' + PLAN_LABELS[key] + '\n' + (Array.isArray(p[key]) ? p[key].join('\n') : (p[key] || ''))).join('\n\n');
    }
    if (k.indexOf('case ') === 0) {
      const c = (S.draft.cases || [])[+k.slice(5)]; if (!c) return '';
      return 'ID: ' + c.id + '\nRequirement: ' + c.requirement_ref + '\nPriority: ' + c.priority + '\nTitle: ' + c.title +
        '\nSteps:\n' + c.steps.join('\n') + '\nExpected result:\n' + c.expected;
    }
    const s = curStory(); if (!s) return '';
    if (k === 'description') return s.description;
    if (k === 'acceptance criteria') return s.acceptance_criteria.join('\n');
    if (k === 'subtasks') return s.subtasks.map((t) => (t.done ? '[x] ' : '[ ] ') + t.text).join('\n');
    return '';
  }
  function subRow(t, i, sid) {
    if (ui.subEdit === sid + '|' + i) {
      return '<li class="edit"><input type="text" class="in" data-i="st-edit" data-k="' + i + '" value="' + esc(t.text) + '" aria-label="Edit subtask" placeholder="Subtask, markdown allowed"><button class="btn btn-s" data-a="st-save" data-k="' + i + '">Save</button><button class="btn btn-q btn-s" data-a="st-cancel" data-k="' + i + '">Cancel</button></li>';
    }
    return '<li class="' + (t.done ? 'done' : '') + '"><button class="check" role="checkbox" aria-checked="' + !!t.done + '" data-a="st-done" data-k="' + i + '" aria-label="Done">' + ic('check') + '</button>' +
      '<div class="sub-t">' + (t.text.trim() ? mi(t.text) : '<span class="hint">Empty subtask</span>') + '</div>' +
      '<span class="sub-acts"><button class="row-x" data-a="st-pencil" data-k="' + i + '" aria-label="Edit subtask" title="Edit">' + ic('pencil') + '</button><button class="row-x" data-a="st-rm" data-k="' + i + '" aria-label="Remove subtask" title="Remove">' + ic('x') + '</button></span></li>';
  }
  function footStory(s) {
    return '<span class="prov">' + (storyEdited(s) ? 'Edited. Not saved yet: Run and Report use the saved version.' : '<span class="ok-t">Saved</span> · this is the version Run and Report use') + '</span>';
  }
  function sheetStory(s) {
    const sp = 's|' + s.id + '|', nDone = s.subtasks.filter((t) => t.done).length;
    return '<div class="sheet-head"><span class="card-k"><span class="key">' + ic('story') + esc(s.id) + '</span></span><span class="sp"></span>' +
      '<button class="icon-btn" data-a="story-step" data-k="-1" aria-label="Previous story">' + ic('up') + '</button><button class="icon-btn" data-a="story-step" data-k="1" aria-label="Next story">' + ic('down') + '</button>' +
      '<button class="icon-btn" data-a="sheet-close" aria-label="Close">' + ic('x') + '</button></div>' +
      '<div class="sheet-body"><div class="story sheet-swap">' +
      '<textarea class="story-title ed-in" rows="1" spellcheck="false" data-i="s-title" aria-label="Summary">' + esc(s.title) + '</textarea>' +
      '<dl class="fields"><div><dt>Status</dt><dd><select class="in" data-c="s-status" aria-label="Status">' + STATUSES.map((x) => '<option' + (x === s.status ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></dd></div>' +
      '<div><dt>Priority</dt><dd><select class="in" data-c="s-priority" aria-label="Priority">' + PRIOS.map((x) => '<option' + (x === s.priority ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></dd></div>' +
      '<div class="wide"><dt>Assignee</dt><dd><input type="text" class="in" data-i="s-assignee" value="' + esc(s.assignee) + '" placeholder="Unassigned" aria-label="Assignee"></dd></div>' +
      '<div class="wide"><dt>Labels</dt><dd><input type="text" class="in" data-i="s-labels" value="' + esc(s.labels.join(', ')) + '" placeholder="comma-separated" aria-label="Labels"><div class="cats" id="cats" aria-label="Category">' + catsHtml(s.labels) + '</div></dd></div></dl>' +
      '<section class="sec"><div class="lbl-row"><h3>Description</h3>' + aiLink('description') + '</div>' + assistBox('description') + rt(sp + 'desc', s.description, '', 5) + '</section>' +
      '<section class="sec"><div class="lbl-row"><h3>Acceptance criteria<span class="n">one per line</span></h3>' + aiLink('acceptance criteria') + '</div>' + assistBox('acceptance criteria') + rt(sp + 'ac', s.acceptance_criteria.join('\n'), 'ac', 4) + '</section>' +
      '<section class="sec"><div class="lbl-row"><h3>Subtasks<span class="n">' + nDone + ' of ' + s.subtasks.length + ' done</span></h3>' + aiLink('subtasks') + '</div>' + assistBox('subtasks') +
      '<ul class="subs">' + s.subtasks.map((t, i) => subRow(t, i, s.id)).join('') + '</ul>' +
      '<button class="add-row" data-a="st-add">' + ic('plus') + 'Add a subtask</button></section></div></div>' +
      '<div class="sheet-foot" id="storyfoot">' + footStory(s) + '</div>';
  }
  function descText(s) {
    const tmp = document.createElement('div'); tmp.innerHTML = MD.render(s.description || '');
    const p = tmp.querySelector('p'); return ((p || tmp).textContent || '').trim();
  }
  function cardInner(s) {
    const nAc = s.acceptance_criteria.filter((x) => x.trim()).length, nDone = s.subtasks.filter((t) => t.done).length, ed = storyEdited(s);
    return '<span class="card-k"><span class="key">' + ic('story') + esc(s.id) + '</span>' + statusChip(s.status) + '</span>' +
      (ed ? '<span class="card-r"><i class="dot"></i>Edited</span>' : '<span class="card-r ok">' + ic('check') + 'Saved</span>') +
      '<span class="card-t">' + mi(s.title) + '</span><span class="card-x">' + esc(descText(s)) + '</span>' +
      '<span class="card-m">' + reqChips(reqsOf(s.labels).map((l) => l.toUpperCase())) + '<span class="sp"></span><span class="hint">' + nAc + ' criteri' + (nAc === 1 ? 'on' : 'a') + ' · ' + nDone + '/' + s.subtasks.length + ' subtask' + (s.subtasks.length === 1 ? '' : 's') + '</span>' + prio(s.priority) +
      (s.assignee ? '<span class="avatar" title="' + esc(s.assignee) + '">' + esc(initials(s.assignee)) + '</span>' : '<span class="avatar none" title="Unassigned"></span>') + '</span>';
  }
  const storyCard = (s) => '<li><button class="card" data-a="sel" data-k="' + esc(s.id) + '" aria-current="' + (ui.sheet === 'story' && s.id === S.sel) + '">' + cardInner(s) + '</button></li>';
  function renderStories() {
    const L = S.draft.stories || [];
    return head(plural(L.length, 'story', 'stories') + ', drafted for review', 'Drafted from your documents. Open a story to review it in the detail panel; descriptions and criteria show formatted — use the Write tab to edit. Edits stay in a draft until you <b>Save all</b>.', csvBtn('csv-stories')) +
      '<ol class="cards" id="cards">' + L.map(storyCard).join('') + '</ol>' + nextRow();
  }

  // ---------- 3. Test plan ----------
  const PLAN_LABELS = { objectives: 'Objectives', scope_in: 'Scope — in', scope_out: 'Scope — out', approach: 'Approach', entry_criteria: 'Entry criteria', exit_criteria: 'Exit criteria', risks: 'Risks' };
  function planBlock(p, k) {
    const isList = Array.isArray(p[k]), v = isList ? p[k].join('\n') : (p[k] || '');
    return rt('plan|' + k, v, isList ? 'ac' : '', 3) + (isList ? '<p class="hint" style="margin-top:6px">One per line</p>' : '');
  }
  function renderPlan() {
    const lede = 'A strategy-level plan derived from the saved stories: scope, approach, criteria and risks. List sections take one item per line.';
    if (!S.draft.plan) return head('Test plan', lede) + '<div class="empty-card"><p>No plan yet — generate one from the saved stories.</p>' + genBtn(false, 'gen-plan', 'Generate test plan') + '</div>' + errBox();
    const p = S.draft.plan = ST.normPlan(S.draft.plan); // heal plans saved before normalization existed
    const sec = (title, body) => '<section class="plan-sec"><h2>' + title + '</h2><div>' + body + '</div></section>';
    return head('Test plan', lede, aiLink('test plan') + csvBtn('csv-plan') + genBtn(true, 'gen-plan')) + assistBox('test plan') + errBox() +
      '<div class="plan">' + sec('Objectives', planBlock(p, 'objectives')) +
      sec('Scope', '<div class="plan-two"><div><h3>In scope</h3>' + planBlock(p, 'scope_in') + '</div><div><h3>Out of scope</h3>' + planBlock(p, 'scope_out') + '</div></div>') +
      sec('Approach', planBlock(p, 'approach')) + sec('Entry criteria', planBlock(p, 'entry_criteria')) + sec('Exit criteria', planBlock(p, 'exit_criteria')) + sec('Risks', planBlock(p, 'risks')) + '</div>' + nextRow();
  }

  // ---------- 4. Test cases ----------
  const VCLS = { PROVEN: 'pass', PARTIAL: 'blocked', FAILED: 'fail', 'NOT RUN': 'notrun' };
  // traceability: requirements -> stories -> cases -> verdict, drawn in ink; green only for proven/pass, red only for fail
  function covMermaid(M) {
    const safe = (s) => String(s).replace(/[^A-Za-z0-9._ -]/g, ''), nid = {}, nodes = [], edges = new Set(), lines = ['flowchart LR',
      '    classDef req fill:#f1f3f1,stroke:#454f4b,color:#111816', '    classDef story fill:#fff,stroke:#cbd1cc,color:#454f4b',
      '    classDef pass fill:#e6f2ec,stroke:#0b7a57,color:#0a6347', '    classDef fail fill:#fbebe9,stroke:#b3261e,color:#9d2019',
      '    classDef blocked fill:#f1f3f1,stroke:#454f4b,color:#454f4b,stroke-dasharray:4 3', '    classDef notrun fill:#fff,stroke:#cbd1cc,color:#69736e'];
    const node = (kind, id, label, cls, shape) => {
      const key = kind + id; if (nid[key]) return nid[key];
      const n = nid[key] = kind + Object.keys(nid).length;
      nodes.push('    ' + n + (shape === 'v' ? '(["' : '["') + safe(label) + (shape === 'v' ? '"])' : '"]') + ':::' + cls); return n;
    };
    const caseCls = (c) => { const r = S.results[c.id]; return r ? VCLS[{ PASS: 'PROVEN', FAIL: 'FAILED', BLOCKED: 'PARTIAL' }[r.status]] : 'notrun'; };
    const cross = M.reduce((n, r) => n + r.stories.length * r.cases.length, 0) <= 80;
    M.forEach((r) => {
      const R = node('R', r.id, r.id, 'req'), V = node('V', r.id, r.verdict, VCLS[r.verdict], 'v');
      const S_ = r.stories.map((s) => node('S', s.id, s.id, 'story')), C_ = r.cases.map((c) => node('C', c.id, c.id, caseCls(c)));
      S_.forEach((s) => edges.add(R + ' --> ' + s));
      if (cross) S_.forEach((s) => C_.forEach((c) => edges.add(s + ' --> ' + c)));
      else if (C_.length) C_.forEach((c) => edges.add((S_.length ? S_[0] : R) + ' --> ' + c));
      if (!S_.length) C_.forEach((c) => edges.add(R + ' --> ' + c));
      C_.forEach((c) => edges.add(c + ' --> ' + V));
      if (!C_.length) (S_.length ? S_ : [R]).forEach((x) => edges.add(x + ' --> ' + V));
    });
    return '```mermaid\n' + lines.concat(nodes, Array.from(edges).map((e) => '    ' + e)).join('\n') + '\n```';
  }
  function covHtml(C) {
    const M = reqModel(S.draft.stories || [], C), covered = M.filter((r) => r.cases.length).length, tally = {};
    M.forEach((r) => (tally[r.verdict] = (tally[r.verdict] || 0) + 1));
    return '<section class="cov" aria-label="Requirement coverage"><div class="cov-n">' + plural(C.length, 'test case') + ' · ' + covered + ' of ' + M.length + ' requirements covered</div>' +
      '<div class="counts cov-v">' + ['PROVEN', 'PARTIAL', 'FAILED', 'NOT RUN'].map((v) => '<span><i class="mark" data-v="' + VKEY[v] + '"></i><b>' + (tally[v] || 0) + '</b>' + v.toLowerCase() + '</span>').join('') + '</div>' +
      '<div class="cov-map">' + (M.length ? MD.render(covMermaid(M)) : '<span class="hint">Link cases to requirements (e.g. REQ-001) to see the traceability map.</span>') + '</div></section>';
  }
  function testCard(c, i) {
    const refs = String(c.requirement_ref).split(/[,\s]+/).filter(Boolean).map((r) => r.toUpperCase()), cp = 'case|' + i + '|', akey = 'case ' + i;
    return '<div class="cblock" data-card="' + i + '"><div class="cblock-h"><span class="cid">' + esc(c.id) + '</span>' + reqChips(refs) + '<span class="sp"></span>' + aiLink(akey) + prio(c.priority) +
      '<button class="row-x" data-a="case-rm" data-k="' + i + '" aria-label="Remove case ' + esc(c.id) + '" title="Remove">' + ic('x') + '</button></div>' + assistBox(akey) +
      '<div class="cfields"><div><label class="lbl">ID</label><input type="text" class="in" data-i="case" data-f="id" data-k="' + i + '" value="' + esc(c.id) + '" aria-label="ID"></div>' +
      '<div><label class="lbl">Requirement</label><input type="text" class="in" data-i="case" data-f="requirement_ref" data-k="' + i + '" value="' + esc(c.requirement_ref) + '" aria-label="Requirement ref"></div>' +
      '<div><label class="lbl">Priority</label><select class="in" data-c="case-prio" data-k="' + i + '" aria-label="Priority">' + PRIOS.map((x) => '<option' + (x === c.priority ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div></div>' +
      '<label class="lbl">Title</label><input type="text" class="in case-title" data-i="case" data-f="title" data-k="' + i + '" value="' + esc(c.title) + '" aria-label="Title">' +
      '<div class="ctwo"><div><label class="lbl">Steps · numbered, one per line</label>' + rt(cp + 'steps', c.steps.join('\n'), 'steps', 3) + '</div>' +
      '<div><label class="lbl">Expected result</label>' + rt(cp + 'expected', c.expected, '', 3) + '</div></div></div>';
  }
  function renderCases() {
    const C = S.draft.cases;
    const lede = 'Traceable to requirements. Steps and expected results show formatted — use the Write tab to edit.';
    if (!C) return head('Test cases', lede) + '<div class="empty-card"><p>No cases yet — generate them from the saved plan and stories.</p>' + genBtn(false, 'gen-cases', 'Generate test cases') + '</div>' + errBox();
    return head(plural(C.length, 'test case'), 'Each case is tagged with the requirement it proves. ' + lede, csvBtn('csv-cases') + '<button class="btn btn-q btn-s" data-a="case-add">' + ic('plus') + 'Add a case</button>' + genBtn(true, 'gen-cases')) + errBox() +
      covHtml(C) + '<div class="casebox">' + C.map(testCard).join('') + '</div>' + nextRow();
  }

  // ---------- 5. Run ----------
  const hasSample = () => Object.values(S.results).some((r) => r.sample);
  const sampleBanner = () => hasSample() ? '<div class="note"><span class="sample-tag">Sample data</span><span>Results below include demo values, not real test execution.</span></div>' : '';
  function counts() {
    const c = { PASS: 0, FAIL: 0, BLOCKED: 0, 'NOT RUN': 0 };
    S.cases.forEach((x) => { const r = S.results[x.id]; c[r ? r.status : 'NOT RUN']++; });
    return c;
  }
  function runRow(t) {
    const r = S.results[t.id] || {}, open = ui.runOpen.has(t.id);
    return '<li class="run' + (open ? ' open' : '') + '" data-id="' + esc(t.id) + '"><button class="run-tog" data-a="run-tog" data-k="' + esc(t.id) + '" aria-expanded="' + open + '" aria-label="Steps for ' + esc(t.id) + '">' + ic('right') + '</button><span class="run-id">' + esc(t.id) + '</span>' +
      '<div class="run-main"><div class="run-t"><span class="tt">' + mi(t.title) + '</span>' + reqChips(String(t.requirement_ref).split(/[,\s]+/).filter(Boolean).map((x) => x.toUpperCase())) + (r.sample ? '<span class="sample-tag">Sample</span>' : '') + '</div>' +
      '<div class="run-more"><div><div class="run-spec"><div><h4>Steps</h4><ol class="steps">' + t.steps.map((x) => '<li>' + mi(x.replace(/^\d+[.)]\s+/, '')) + '</li>').join('') + '</ol></div><div><h4>Expected result</h4><p>' + mi(t.expected) + '</p></div></div></div></div>' +
      '<textarea class="run-in" rows="1" data-i="note" data-k="' + esc(t.id) + '" aria-label="Evidence / notes for ' + esc(t.id) + '" placeholder="Evidence / notes" spellcheck="false"' + (r.status ? '' : ' disabled') + '>' + esc(r.note || '') + '</textarea></div>' +
      '<div class="seg" role="radiogroup" aria-label="Result for ' + esc(t.id) + '">' + ['PASS', 'FAIL', 'BLOCKED'].map((k) => '<button role="radio" aria-checked="' + (r.status === k) + '" data-a="mark" data-k="' + esc(t.id) + '" data-v="' + k.toLowerCase() + '">' + RLABEL[k.toLowerCase()] + '</button>').join('') + '</div></li>';
  }
  function renderRun() {
    const c = counts(), t = { pass: c.PASS, fail: c.FAIL, blocked: c.BLOCKED, none: c['NOT RUN'] };
    const list = S.cases.filter((x) => { const s = (S.results[x.id] || {}).status; return ui.rfilter === 'all' || (ui.rfilter === 'todo' ? !s : s === 'FAIL' || s === 'BLOCKED'); });
    return head('Run', 'Mark each test case as you execute it. Phase 1 is manual; automation comes later. Your notes become the evidence in the report.', '<button class="btn btn-q btn-s" data-a="clear-results">Clear all results</button>') +
      (anyDirty() ? '<div class="note">You have unsaved edits; this screen uses the last saved version.</div>' : '') + sampleBanner() +
      '<label class="sampleline"><input type="checkbox" data-c="sample"' + (S.sampleResults ? ' checked' : '') + '> <span><b>Fill sample results</b> <span class="sample-tag">Demo</span> — a labeled 11 PASS / 2 FAIL / 2 BLOCKED mix with notes. Nothing really executes.</span></label>' +
      '<div class="run-sum"><div class="meter" role="img" aria-label="Results so far">' + ['pass', 'fail', 'blocked', 'none'].map((k) => '<i data-v="' + k + '" style="--n:' + t[k] + '"></i>').join('') + '</div>' +
      '<div class="counts">' + [['pass', 'passed', 'pass'], ['fail', 'failed', 'fail'], ['blocked', 'blocked', 'blocked'], ['none', 'not run', 'notrun']].map(([k, l, m]) => '<span><i class="mark" data-v="' + m + '"></i><b>' + t[k] + '</b>' + l + '</span>').join('') + '</div></div>' +
      '<div class="bar tight">' + tabs('rfilter', ui.rfilter, [['all', 'All', S.cases.length], ['todo', 'Still to run', t.none], ['attn', 'Failed or blocked', t.fail + t.blocked]]) + '</div>' +
      '<ol class="runs">' + (list.map(runRow).join('') || '<li class="empty" style="border:0">Nothing in this view.</li>') + '</ol>' + nextRow();
  }

  // ---------- 6. Report ----------
  const passLine = (r) => (r.cases.length ? r.cases.filter((c) => (S.results[c.id] || {}).status === 'PASS').length + ' of ' + r.cases.length + ' passed' : 'No cases');
  function evidence(c) {
    const x = S.results[c.id], k = resKey(c.id);
    return '<li class="ev"><i class="mark" data-v="' + k + '"></i><span class="ev-id">' + esc(c.id) + '</span><div><div class="ev-t"><span>' + mi(c.title) + (x && x.sample ? ' <span class="sample-tag">Sample</span>' : '') + '</span>' + vText(k, RLABEL[k]) + '</div>' +
      '<p class="ev-n">' + (x && x.note ? mi(x.note) : x ? 'No note was recorded.' : 'Not run yet.') + '</p></div></li>';
  }
  function reportRow(r) {
    const v = VKEY[r.verdict], open = ui.open.has(r.id);
    return '<li class="rr' + (open ? ' open' : '') + (ui.trace === r.id ? ' rel' : '') + '" id="rr-' + esc(r.id) + '"><button class="rr-h" data-a="rr-tog" data-k="' + esc(r.id) + '" aria-expanded="' + open + '">' +
      '<i class="mark" data-v="' + v + '"></i><span class="rr-id">' + esc(r.id) + '</span><span class="rr-t">' + reqNameHtml(r) + '</span>' + vText(v, VLABEL[v]) + '<span class="rr-c">' + passLine(r) + '</span>' + ic('right', 'caret') + '</button>' +
      '<div class="rr-b"><div><div class="rr-in"><p class="rr-src">' + (r.stories.length ? r.stories.map((s) => '<span>Story ' + esc(s.id) + ' · ' + mi(s.title) + '</span>').join('') : '<span>No linked story</span>') + '</p>' +
      '<ol>' + (r.cases.length ? r.cases.map(evidence).join('') : '<li class="ev"><span></span><span></span><p class="ev-n">No test case covers this requirement yet.</p></li>') + '</ol></div></div></div></li>';
  }
  function renderReport() {
    const M = reportModel(), n = M.length, tally = { proven: 0, partial: 0, failed: 0, notrun: 0 };
    M.forEach((r) => tally[VKEY[r.verdict]]++);
    const list = ui.pfilter === 'all' ? M : M.filter((r) => r.verdict !== 'PROVEN');
    const title = tally.proven === n ? 'All ' + n + ' requirements proven' : tally.proven === 0 ? 'No requirements proven yet' : tally.proven + ' of ' + n + ' requirements proven';
    return head(title, 'Proof per requirement, rendered from saved stories, cases and run results. A requirement is proven when every test case that covers it has passed.') + sampleBanner() +
      '<div class="hero" style="--cols:' + n + '" role="group" aria-label="Verdict for each requirement">' + M.map((r, k) => '<button data-a="rr-jump" data-k="' + esc(r.id) + '" title="' + esc(r.id + ' · ' + reqName(r)) + '" aria-label="' + esc(r.id + ', ' + reqName(r) + ', ' + VLABEL[VKEY[r.verdict]]) + '"><i class="mark" data-v="' + VKEY[r.verdict] + '" style="--k:' + k + '"></i><span class="n">' + esc(r.id.replace(/^REQ-0*/, '')) + '</span></button>').join('') + '</div>' +
      '<div class="counts" style="margin-bottom:40px">' + ['proven', 'partial', 'failed', 'notrun'].map((k) => '<span><i class="mark" data-v="' + k + '"></i><b>' + tally[k] + '</b>' + VLABEL[k].toLowerCase() + '</span>').join('') + '</div>' +
      '<div class="rep-bar">' + tabs('pfilter', ui.pfilter, [['all', 'All', n], ['open', 'Not yet proven', n - tally.proven]]) + '<span class="sp"></span>' +
      '<button class="btn btn-q btn-s" data-a="rr-all">' + (list.length && list.every((r) => ui.open.has(r.id)) ? 'Collapse all' : 'Expand all') + '</button>' +
      '<button class="btn btn-q btn-s" data-a="copy-summary">Copy summary</button><button class="btn btn-q btn-s" data-a="print">' + ic('print') + 'Print or save as PDF</button></div>' +
      '<ol class="rep" id="rep">' + (list.map(reportRow).join('') || '<li class="empty" style="border:0">Every requirement is proven.</li>') + '</ol>';
  }
  function summaryText() {
    const M = reqModel(S.stories, S.cases), c = counts();
    return 'Being Agile proof summary' + (hasSample() ? ' (INCLUDES SAMPLE DATA)' : '') + '\nCases: ' + c.PASS + ' PASS, ' + c.FAIL + ' FAIL, ' + c.BLOCKED + ' BLOCKED, ' + c['NOT RUN'] + ' NOT RUN\n\n' +
      M.map((r) => r.id + ': ' + r.verdict + ' — ' + (r.stories.map((s) => s.title).join('; ') || 'no story') + '\n' +
        r.cases.map((x) => '  ' + x.id + ' ' + ((S.results[x.id] || {}).status || 'NOT RUN') + ((S.results[x.id] || {}).note ? ' — ' + S.results[x.id].note : '')).join('\n')).join('\n');
  }

  // ---------- render ----------
  const SCREENS = [renderStart, renderStories, renderPlan, renderCases, renderRun, renderReport];
  function render() {
    if (!ST.unlocked(S.step)) S.step = 0;
    renderChrome();
    const y = view.scrollTop, ae = document.activeElement, keep = ae && ae.dataset && ae.dataset.i && stage.contains(ae) ? { i: ae.dataset.i, k: ae.dataset.k, f: ae.dataset.f } : null;
    const sb = sheetEl.querySelector('.sheet-body'), sbTop = sb ? sb.scrollTop : 0;
    view.innerHTML = '<div class="page' + (S.step === 3 || S.step === 4 ? ' full' : '') + (ui.enter ? ' enter' : '') + '">' + SCREENS[S.step]() + '</div>';
    ui.enter = false;
    view.scrollTop = y;
    hydrate(view);
    paintSheet(sbTop);
    if (ui.scrollTo) { const t = view.querySelector(ui.scrollTo); if (t) t.scrollIntoView({ block: 'start' }); ui.scrollTo = null; }
    if (ui.focus) { const el = app.querySelector(ui.focus); if (el) el.focus(); ui.focus = null; }
    else if (keep) { const el = app.querySelector('[data-i="' + keep.i + '"]' + (keep.k != null ? '[data-k="' + keep.k + '"]' : '') + (keep.f ? '[data-f="' + keep.f + '"]' : '')); if (el) el.focus(); }
  }
  // cheap live refresh while typing (no re-render): save state, next-row hint, the open story's card + footer
  function touch() {
    chromeSave();
    const nx = $('next'); if (nx) nx.innerHTML = nextInner();
    const s = S.step === 1 && curStory();
    if (s) {
      const c = view.querySelector('.card[data-k="' + (window.CSS && CSS.escape ? CSS.escape(s.id) : s.id) + '"]'); if (c) c.innerHTML = cardInner(s);
      const f = $('storyfoot'); if (f) f.innerHTML = footStory(s);
    }
  }
  function go(i) {
    if (!ST.unlocked(i)) return;
    S.step = i; ST.save(); ui.error = ''; ui.subEdit = null; ui.sheet = null; ui.enter = true;
    stage.classList.remove('open'); delete stage.dataset.sheet;
    render(); if (!ui.scrollTo) view.scrollTop = 0;
  }

  // ---------- commit ----------
  const safeTrim = (x) => String(x == null ? '' : (typeof x === 'object' ? (x.text || x.item || '') : x)).trim();
  function cleanDraft() {
    const D = S.draft;
    if (D.plan) ['scope_in', 'scope_out', 'entry_criteria', 'exit_criteria', 'risks'].forEach((k) => { D.plan[k] = (D.plan[k] || []).filter((x) => safeTrim(x)); });
    if (D.stories) D.stories.forEach((s) => { s.acceptance_criteria = (s.acceptance_criteria || []).filter((x) => safeTrim(x)); s.subtasks = (s.subtasks || []).filter((t) => safeTrim(t && t.text)); });
    if (D.cases) D.cases.forEach((c) => { c.steps = (c.steps || []).filter((x) => safeTrim(x)); });
  }
  let savedT;
  function saveAll() {
    try {
      // Normalize first: the model sometimes returns objects inside list fields;
      // cleanDraft's trim would throw on those and abort the save.
      if (S.draft.stories) S.draft.stories = S.draft.stories.map(ST.normStory);
      if (S.draft.plan) S.draft.plan = ST.normPlan(S.draft.plan);
      if (S.draft.cases) S.draft.cases = S.draft.cases.map(ST.normCase);
      cleanDraft();
    } catch (e) { toast('Save failed: ' + (e && e.message || e)); return; }
    ui.subEdit = null;
    ['stories', 'plan', 'cases'].forEach((k) => { if (S.draft[k]) S[k] = ST.clone(S.draft[k]); });
    ST.save(); toast('Saved'); ui.justSaved = true; render();
    clearTimeout(savedT); savedT = setTimeout(() => { ui.justSaved = false; chromeSave(); }, 2600);
  }
  function setTheme(dark) {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try { localStorage.setItem('being-agile-theme', dark ? 'dark' : 'light'); } catch (e) { /* ignore */ }
    const b = $('btn-theme'); b.innerHTML = ic(dark ? 'sun' : 'moon'); b.setAttribute('aria-label', dark ? 'Switch to the light theme' : 'Switch to the dark theme');
  }

  // ---------- actions ----------
  // Story-section assist boxes are keyed by section, not by story — clear them on
  // story switch so one story's AI output never lingers on another story.
  const clearStoryAssist = () => { delete ui.assist['description']; delete ui.assist['acceptance criteria']; delete ui.assist['subtasks']; };
  const A = {
    'open-doc': (el) => openDocSheet(docRef(el.dataset.k), el.dataset.label, el.dataset.k),
    'sheet-close': closeSheet,
    'open-rules': () => { if (ui.sheet === 'rules') closeSheet(); else openRulesSheet(); },
    theme: () => setTheme(document.documentElement.dataset.theme !== 'dark'),
    trace: (el) => {
      const id = el.dataset.k;
      if (!ST.unlocked(5)) { toast('The report unlocks once test cases exist'); return; }
      if (ui.trace === id && S.step === 5) { ui.trace = null; render(); return; }
      ui.trace = id; ui.open.add(id); ui.scrollTo = '#rr-' + id;
      if (S.step !== 5) go(5); else render();
    },
    'trace-clear': () => { ui.trace = null; render(); },
    'toggle-paste': (el) => { ui.paste[el.dataset.k] = !ui.paste[el.dataset.k]; ui.focus = '[data-i="doc"][data-k="' + el.dataset.k + '"]'; render(); },
    'add-extra': () => { S.docs.extras.push({ name: '', text: '' }); ST.save(); render(); },
    'rm-extra': (el) => { S.docs.extras.splice(+el.dataset.k, 1); ST.save(); closeSheet(); render(); },
    'load-sample': () => {
      const live = !AI.getConfig().dryRun;
      const d = live ? window.SAMPLE.docsCondensed : window.SAMPLE.docs, sfx = live ? '-condensed' : '';
      S.docs.prd = { name: 'prd' + sfx + '.md (NPPES sample)', text: d.prd }; S.docs.design = { name: 'design' + sfx + '.md (NPPES sample)', text: d['design']  }; S.docs.api = { name: 'api-spec' + sfx + '.md (NPPES sample)', text: d['api-spec'] };
      ST.save(); closeSheet(); render(); toast('NPPES sample loaded');
    },
    'gen-stories': () => guarded('stories', S.docs, 'Generate stories', (data) => {
      S.stories = data.map(ST.normStory); S.draft.stories = ST.clone(S.stories);
      S.plan = null; S.draft.plan = null; S.cases = []; S.draft.cases = null; S.results = {}; S.sampleResults = false; ui.write = {}; ui.subEdit = null; ui.sheet = null;
      S.sel = S.stories[0] && S.stories[0].id; S.step = 1; ui.enter = true;
    }),
    'gen-plan': () => { if (anyDirty() && !confirm('Unsaved edits will not be used. Continue with last saved stories?')) return; return guarded('plan', S.stories, 'Generate test plan', (data) => { S.plan = ST.normPlan(data); S.draft.plan = ST.clone(S.plan); S.cases = []; S.draft.cases = null; S.results = {}; S.sampleResults = false; Object.keys(ui.write).forEach((k) => { if (k.indexOf('plan|') === 0) delete ui.write[k]; }); clearCaseTabs(); }); },
    'gen-cases': () => guarded('cases', { plan: S.plan, stories: S.stories }, 'Generate test cases', (data) => { S.cases = data.map(ST.normCase); S.draft.cases = ST.clone(S.cases); S.results = {}; S.sampleResults = false; clearCaseTabs(); }),
    'save-all': saveAll,
    'csv-stories': () => { cleanDraft(); toast('Downloaded ' + CSV.download('stories', CSV.storiesToCsv(S.draft.stories))); },
    'csv-plan': () => { cleanDraft(); toast('Downloaded ' + CSV.download('test-plan', CSV.planToCsv(S.draft.plan))); },
    'csv-cases': () => { cleanDraft(); toast('Downloaded ' + CSV.download('test-cases', CSV.casesToCsv(S.draft.cases))); },
    go: (el) => go(+el.dataset.k),
    sel: (el) => { S.sel = el.dataset.k; ui.sheet = 'story'; ui.subEdit = null; clearStoryAssist(); ST.save(); ui.focus = '.card[data-k="' + el.dataset.k + '"]'; render(); },
    'story-step': (el) => {
      const L = S.draft.stories || [], i = L.findIndex((s) => s.id === S.sel), n = L[i + +el.dataset.k];
      if (n) { S.sel = n.id; ui.subEdit = null; clearStoryAssist(); ST.save(); render(); const c = view.querySelector('.card[aria-current="true"]'); if (c) c.scrollIntoView({ block: 'nearest' }); }
    },
    'rt-tab': (el) => {
      const box = el.closest('.rt'), w = el.dataset.t === 'write';
      ui.write[el.dataset.k] = w;
      box.querySelectorAll('[role="tab"]').forEach((b) => b.setAttribute('aria-selected', String((b.dataset.t === 'write') === w)));
      box.querySelector('.rt-write').hidden = !w; box.querySelector('.rt-prev').hidden = w;
      if (w) { const t = box.querySelector('textarea'); grow(t); t.focus(); } else { paintPrev(box); MD.paintMermaid(box); }
    },
    'st-add': () => { const s = curStory(); s.subtasks.push({ text: '', done: false }); ui.subEdit = s.id + '|' + (s.subtasks.length - 1); ui.focus = '[data-i="st-edit"]'; render(); },
    'st-pencil': (el) => { ui.subEdit = curStory().id + '|' + el.dataset.k; ui.focus = '[data-i="st-edit"]'; render(); },
    'st-done': (el) => { const t = curStory().subtasks[+el.dataset.k]; t.done = !t.done; render(); touch(); },
    'st-save': (el) => {
      const s = curStory(), i = +el.dataset.k, inp = app.querySelector('[data-i="st-edit"][data-k="' + i + '"]');
      if (inp) s.subtasks[i].text = inp.value;
      if (!s.subtasks[i].text.trim()) s.subtasks.splice(i, 1);
      ui.subEdit = null; render(); touch();
    },
    'st-cancel': (el) => { const s = curStory(), i = +el.dataset.k; if (!s.subtasks[i].text.trim()) s.subtasks.splice(i, 1); ui.subEdit = null; render(); },
    'st-rm': (el) => { curStory().subtasks.splice(+el.dataset.k, 1); ui.subEdit = null; render(); touch(); },
    'assist-toggle': (el) => { const a = (ui.assist[el.dataset.k] = ui.assist[el.dataset.k] || {}); a.open = !a.open; ui.focus = '[data-i="assist-prompt"][data-k="' + el.dataset.k + '"]'; render(); },
    assist: async (el) => {
      const k = el.dataset.k, a = ui.assist[k];
      a.out = 'Thinking…'; a.ok = false; render();
      try { a.out = await AI.assist(displayKind(k), a.prompt, assistContext(k)); a.ok = true; }
      catch (e) { a.out = '**Assist failed:** ' + ((e && e.message) || e); a.ok = false; }
      render();
    },
    'assist-apply': (el) => {
      const k = el.dataset.k, a = ui.assist[k] || {};
      if (!a.ok || !a.out) return;
      const text = applyText(a.out);
      let n = 0;
      if (k === 'description' || k === 'acceptance criteria') {
        const s = curStory(); if (!s) return;
        const path = 's|' + s.id + '|' + (k === 'description' ? 'desc' : 'ac');
        setRT(path, text); ui.write[path] = true; n = 1; // keep the Write tab open on the applied text
      } else if (k === 'subtasks') {
        const s = curStory(); if (!s) return;
        const lines = text.split('\n').map((l) => l.trim().replace(/^([-*•]|\d+[.)])\s+/, '')).filter(Boolean);
        if (!lines.length) { toast('Nothing to apply'); return; }
        const doneBy = {};
        s.subtasks.forEach((t) => { doneBy[t.text.trim().toLowerCase()] = t.done; });
        s.subtasks = lines.map((t) => ({ text: t, done: !!doneBy[t.toLowerCase()] }));
        n = lines.length;
      } else if (k === 'test plan') {
        const p = S.draft.plan; if (!p) return;
        const secs = parsePlanApply(text), keys = Object.keys(secs);
        if (!keys.length) { toast("Couldn't match the AI response to plan sections — nothing applied"); return; }
        keys.forEach((key) => { setRT('plan|' + key, secs[key]); ui.write['plan|' + key] = true; n++; });
      } else if (k.indexOf('case ') === 0) {
        const i = +k.slice(5), c = (S.draft.cases || [])[i]; if (!c) return;
        const pc = parseCaseApply(text);
        if (pc.title) { c.title = pc.title; n++; }
        if (pc.requirement_ref) { c.requirement_ref = pc.requirement_ref; n++; }
        if (pc.priority && PRIOS.indexOf(pc.priority) !== -1) { c.priority = pc.priority; n++; }
        if (pc.steps.length) { c.steps = pc.steps; ui.write['case|' + i + '|steps'] = true; n++; }
        if (pc.expected) { c.expected = pc.expected; ui.write['case|' + i + '|expected'] = true; n++; }
        if (!n) { toast("Couldn't parse the AI response — nothing applied"); return; }
      } else return;
      delete ui.assist[k]; // response goes away, prompt cleared, box closed — fresh state
      touch(); render(); toast('Applied AI suggestion — review it, then Save all');
    },
    'case-add': () => { S.draft.cases.push({ id: 'TC-' + String(S.draft.cases.length + 1).padStart(3, '0'), requirement_ref: '', title: '', steps: [], expected: '', priority: 'P1' }); ui.focus = '[data-i="case"][data-f="title"][data-k="' + (S.draft.cases.length - 1) + '"]'; render(); },
    'case-rm': (el) => { S.draft.cases.splice(+el.dataset.k, 1); clearCaseTabs(); render(); },
    mark: (el) => {
      const id = el.dataset.k, v = el.dataset.v.toUpperCase(), cur = S.results[id];
      if (cur && cur.status === v) delete S.results[id]; else S.results[id] = { status: v, note: cur && !cur.sample ? cur.note : '' };
      ST.save(); render();
    },
    'run-tog': (el) => {
      const id = el.dataset.k, row = el.closest('.run'), on = !ui.runOpen.has(id);
      if (on) ui.runOpen.add(id); else ui.runOpen.delete(id);
      row.classList.toggle('open', on); el.setAttribute('aria-expanded', String(on));
    },
    rfilter: (el) => { ui.rfilter = el.dataset.k; render(); },
    pfilter: (el) => { ui.pfilter = el.dataset.k; render(); },
    'rr-tog': (el) => { const id = el.dataset.k; if (ui.open.has(id)) ui.open.delete(id); else ui.open.add(id); render(); },
    'rr-jump': (el) => { ui.open.add(el.dataset.k); ui.scrollTo = '#rr-' + el.dataset.k; if (ui.pfilter === 'open' && ui.vm[el.dataset.k] === 'proven') ui.pfilter = 'all'; render(); },
    'rr-all': () => {
      const list = reportModel().filter((r) => ui.pfilter === 'all' || r.verdict !== 'PROVEN');
      if (list.every((r) => ui.open.has(r.id))) list.forEach((r) => ui.open.delete(r.id)); else list.forEach((r) => ui.open.add(r.id));
      render();
    },
    print: () => window.print(),
    'clear-results': () => { S.results = {}; S.sampleResults = false; ST.save(); render(); },
    'copy-summary': async () => {
      const t = summaryText();
      try { await navigator.clipboard.writeText(t); } catch (e) { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
      toast('Summary copied');
    },
  };

  // ---------- inputs (no re-render; keeps focus) ----------
  let saveT;
  const I_ = {
    doc: (el) => {
      const d = docRef(el.dataset.k), was = !!d.text.trim();
      d.text = el.value;
      if (was !== !!d.text.trim()) { ST.save(); render(); return; } // row flips empty<->loaded: View button appears/disappears
      clearTimeout(saveT); saveT = setTimeout(() => { ST.save(); const b = app.querySelector('[data-a="gen-stories"]'); if (b) b.disabled = ui.busy || ![S.docs.prd, S.docs.design, S.docs.api].concat(S.docs.extras).some((x) => x.text.trim()); }, 300);
    },
    rt: (el) => { setRT(el.dataset.k, el.value); grow(el); },
    's-title': (el) => { curStory().title = el.value.replace(/\n/g, ' '); grow(el); },
    's-assignee': (el) => { curStory().assignee = el.value; },
    's-labels': (el) => { const s = curStory(); s.labels = el.value.split(',').map((x) => x.trim()).filter(Boolean); const c = $('cats'); if (c) c.innerHTML = catsHtml(s.labels); },
    'assist-prompt': (el) => { (ui.assist[el.dataset.k] = ui.assist[el.dataset.k] || {}).prompt = el.value; },
    case: (el) => { const c = S.draft.cases[+el.dataset.k]; c[el.dataset.f] = el.value; },
    note: (el) => { grow(el); const r = S.results[el.dataset.k]; if (r) { r.note = el.value; delete r.sample; clearTimeout(saveT); saveT = setTimeout(ST.save, 300); } },
  };
  const C = {
    's-status': (el) => { curStory().status = el.value; render(); },
    's-priority': (el) => { curStory().priority = el.value; render(); },
    'case-prio': (el) => { S.draft.cases[+el.dataset.k].priority = el.value; render(); },
    sample: (el) => { ST.setSampleResults(el.checked); ST.save(); render(); },
    file: (el) => { const f = el.files[0]; el.value = ''; readFile(f, el.dataset.k); },
  };
  function readFile(f, id) {
    if (!f) return;
    const r = new FileReader();
    r.onload = async () => {
      const text = String(r.result);
      const host = apiHost();
      const size = f.size >= 1048576 ? (f.size / 1048576).toFixed(1) + ' MB' : f.size >= 1024 ? Math.round(f.size / 1024) + ' KB' : (f.size || 0) + ' bytes';
      const ok = await confirmBox('Upload "' + f.name + '"?',
        '<p>You are about to load <b>' + esc(f.name) + '</b> (' + size + ') into Being Agile.</p>' +
        '<p><b>Check first:</b> make sure this file contains no sensitive information — passwords, API keys, personal or customer data — and that you are authorized to upload it.</p>' +
        '<p class="note"><b>Where it goes:</b> when you generate or use AI assist, your documents are sent to <b>' + esc(host) + '</b> — outside your network.</p>',
        'Upload file');
      if (!ok) return;
      const d = docRef(id); d.name = f.name; d.text = text; ST.save();
      if (ui.sheet === 'doc' && ui.docId === id) closeSheet();
      render(); toast('Uploaded ' + f.name);
    };
    r.readAsText(f);
  }

  shell.addEventListener('click', (e) => {
    const el = e.target.closest('[data-a]');
    if (!el || !A[el.dataset.a] || el.disabled) return;
    if (el.classList.contains('doc') && e.target.closest('.doc-act, .doc-paste')) return; // row opens the viewer; its own controls do not
    A[el.dataset.a](el);
  });
  stage.addEventListener('input', (e) => { const el = e.target.closest('[data-i]'); if (el && I_[el.dataset.i]) { I_[el.dataset.i](el); touch(); } });
  stage.addEventListener('change', (e) => { const el = e.target.closest('[data-c]'); if (el && C[el.dataset.c]) { C[el.dataset.c](el); touch(); } });
  stage.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t.matches('[data-i="st-edit"]') && (e.key === 'Enter' || e.key === 'Escape')) { e.preventDefault(); const b = app.querySelector('[data-a="' + (e.key === 'Enter' ? 'st-save' : 'st-cancel') + '"]'); if (b) b.click(); }
    else if (t.matches('[data-i="s-title"]') && e.key === 'Enter') e.preventDefault();
    else if (t.matches('[data-i="assist-prompt"]') && e.key === 'Enter') { e.preventDefault(); const b = app.querySelector('[data-a="assist"][data-k="' + t.dataset.k + '"]'); if (b) b.click(); }
  });
  document.addEventListener('keydown', (e) => {
    const modal = $('modal'), dr = $('drawer');
    if (e.key === 'Escape') {
      if (!modal.hidden) { const c = modal.querySelector('[data-r="0"]'); if (c) c.click(); }
      else if (!dr.hidden) { dr.hidden = true; $('btn-gear').setAttribute('aria-expanded', 'false'); }
      else if (ui.sheet && !e.target.closest('input, textarea, select')) closeSheet();
    } else if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey) && S.step >= 1 && S.step <= 3 && $('lock').hidden) { e.preventDefault(); if (anyDirty()) saveAll(); }
  });
  ['dragover', 'dragleave', 'drop'].forEach((ev) => view.addEventListener(ev, (e) => {
    if (!UPLOADS_ENABLED) return;
    const z = e.target.closest('[data-drop]'); if (!z) return;
    e.preventDefault(); z.classList.toggle('over', ev === 'dragover');
    if (ev === 'drop') readFile(e.dataTransfer.files[0], z.dataset.drop);
  }));
  nav.addEventListener('click', (e) => { const b = e.target.closest('[data-step]'); if (b) go(+b.dataset.step); });

  // ---------- settings drawer ----------
  const drawer = $('drawer'), keyEl = $('set-key'), modelEl = $('set-model');
  modelEl.innerHTML = AI.MODELS.map((m) => '<option>' + m + '</option>').join('');
  $('btn-gear').onclick = () => { drawer.hidden = !drawer.hidden; $('btn-gear').setAttribute('aria-expanded', String(!drawer.hidden)); if (!drawer.hidden && window.PinLock) window.PinLock.renderSettings(); };
  $('btn-drawer-close').onclick = () => { drawer.hidden = true; $('btn-gear').setAttribute('aria-expanded', 'false'); };
  const dryEl = $('set-dry');
  dryEl.onchange = () => { S.dryRun = dryEl.checked; AI.configure({ dryRun: S.dryRun }); ST.save(); render(); };
  const endEl = $('set-endpoint'), endErr = $('set-endpoint-err');
  endEl.oninput = () => {
    const v = endEl.value.trim(), ok = !v || /^https:\/\//i.test(v);
    endErr.hidden = ok; endErr.textContent = ok ? '' : 'Endpoint must start with https:// (leave empty for the OpenAI default). Not saved.';
    if (!ok) return;
    S.endpoint = v; AI.configure({ endpoint: v || AI.DEFAULT_ENDPOINT }); ST.save();
  };
  modelEl.onchange = () => { S.model = modelEl.value; AI.configure({ model: S.model }); ST.save(); render(); };
  const KEYSTORE = 'being-agile-api-key'; // localStorage, per Rajan's call Oct 6 2026: his key, his risk; clear via field or Reset demo
  const store = (fn) => { try { return fn(localStorage); } catch (e) { return null; } };
  const syncKey = () => { const v = keyEl.value.trim(); AI.configure({ apiKey: v }); store((s) => (v ? s.setItem(KEYSTORE, v) : s.removeItem(KEYSTORE))); };
  keyEl.addEventListener('input', syncKey);
  keyEl.addEventListener('change', syncKey); // change fires for autofill/password-manager fills that skip input events
  $('btn-reset').onclick = async () => {
    if (!(await confirmBox('Reset demo?', '<p>This clears all saved documents, stories, plan, cases and results from this browser.</p>', 'Reset'))) return;
    S = ST.reset(); AI.loadUsage([]); ui.assist = {}; ui.paste = {}; ui.write = {}; ui.subEdit = null; ui.error = ''; ui.trace = null; ui.open = new Set(); ui.runOpen = new Set(); closeSheet(); drawer.hidden = true; $('btn-gear').setAttribute('aria-expanded', 'false'); store((s) => s.removeItem(KEYSTORE)); keyEl.value = ''; AI.configure({ apiKey: '' }); render(); toast('Demo reset');
  };

  // ---------- build version stamp (bottom-left), auto-read from the ?v= cache-buster ----------
  (() => { const el = $('appver'); if (!el) return; let v = ''; try { const sc = document.querySelector('script[src*="js/screens.js"]'); const m = sc && /[?&]v=([\w.-]+)/.exec(sc.src); if (m) v = m[1]; } catch (e) {} el.textContent = v ? 'v' + v : ''; })();

  // ---------- init ----------
  setTheme(document.documentElement.dataset.theme === 'dark');
  AI.configure({ model: S.model, dryRun: S.dryRun !== false, endpoint: S.endpoint || AI.DEFAULT_ENDPOINT });
  endEl.value = S.endpoint || '';
  dryEl.checked = S.dryRun !== false;
  AI.loadUsage(S.usage);
  modelEl.value = S.model;
  const sk = store((s) => s.getItem(KEYSTORE));
  if (sk) { keyEl.value = sk; AI.configure({ apiKey: sk }); }
  const start = () => { if (!S.sel && S.stories[0]) S.sel = S.stories[0].id; ui.enter = true; render(); document.body.classList.add('boot'); };
  if (window.PinLock) window.PinLock.boot(start); else start();
})();
