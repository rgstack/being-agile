/* Six screens: rendering + interactions. Event delegation on #app via data-a (click), data-i (input), data-c (change).
   Read-only text goes through Markdown (marked -> DOMPurify, mermaid fences painted as diagrams); editing stays raw text in Write tabs. */
(function () {
  'use strict';
  const AI = window.OpenAI, ST = window.State, CSV = window.CSV, MD = window.Markdown;
  let S = ST.load();
  const app = document.getElementById('app');
  const esc = MD.esc;
  const mi = (t) => MD.inline(t);
  const fmtUsd = (n) => '$' + (n < 0.01 ? n.toFixed(4) : n.toFixed(2));
  const rows = (s, min) => Math.max(min || 2, Math.min(14, String(s).split('\n').length + 1));
  // write: field path -> true when the Write tab is chosen (Preview is the default); subEdit: "storyId|index" of the subtask being edited
  const ui = { busy: false, error: '', assist: {}, focus: null, paste: {}, write: {}, subEdit: null, docOpener: null };

  // ---------- shared UI ----------
  let toastT;
  function toast(msg) {
    const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function confirmBox(title, bodyHtml, ok) {
    return new Promise((res) => {
      const m = document.getElementById('modal'), box = m.firstElementChild;
      box.innerHTML = '<h2>' + esc(title) + '</h2><div style="margin:10px 0 16px">' + bodyHtml + '</div><div class="bar"><button class="ghost" data-r="0">Cancel</button><button class="primary" data-r="1">' + esc(ok || 'Confirm') + '</button></div>';
      m.hidden = false;
      box.onclick = (e) => { const r = e.target.closest('[data-r]'); if (r) { m.hidden = true; res(r.dataset.r === '1'); } };
      box.querySelector('.primary').focus();
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

  // ---------- chrome ----------
  function renderChrome() {
    document.getElementById('steps').innerHTML = ST.STEPS.map((n, i) =>
      '<button data-step="' + i + '" class="' + (S.step === i ? 'cur' : i < S.step ? 'done' : '') + '"' + (S.step === i ? ' aria-current="step"' : '') + (ST.unlocked(i) ? '' : ' disabled title="Complete the previous step first"') + '><span class="n">' + (i + 1) + '</span><span class="t">' + n + '</span></button>').join('');
    const u = AI.getUsage().total;
    document.getElementById('meter').textContent = (u.prompt_tokens + u.completion_tokens).toLocaleString() + ' tok · ~' + fmtUsd(u.est_usd) + (AI.getConfig().dryRun ? ' · dry-run' : ' · live');
    const calls = AI.getUsage().calls;
    document.getElementById('usage').innerHTML = calls.length
      ? '<table class="u-tbl"><tr><th>Call</th><th>Model</th><th>In</th><th>Out</th><th>$</th></tr>' + calls.map((c) =>
        '<tr><td>' + c.operation + '</td><td>' + c.model + '</td><td>' + c.prompt_tokens.toLocaleString() + '</td><td>' + c.completion_tokens.toLocaleString() + '</td><td>' + fmtUsd(c.est_usd) + '</td></tr>').join('') +
      '<tr><th>Total</th><th></th><th>' + u.prompt_tokens.toLocaleString() + '</th><th>' + u.completion_tokens.toLocaleString() + '</th><th>' + fmtUsd(u.est_usd) + '</th></tr></table>'
      : '<p class="hint">No calls yet.</p>';
  }
  const head = (title, lede, tools) => '<div class="pagehead"><div class="tx"><h1>' + title + '</h1><p class="lede">' + lede + '</p></div>' + (tools ? '<div class="ph-tools">' + tools + '</div>' : '') + '</div>';
  const errBox = () => (ui.error ? '<div class="err" role="alert">' + esc(ui.error) + '</div>' : '');
  const NEXT = { 1: ['Test plan', 2], 2: ['Test cases', 3], 3: ['Run', 4] };
  // sticky save bar (Stories / Test plan / Test cases): dirty state, Save all, next step
  function barInner() {
    const ks = dirtyKinds(), nx = NEXT[S.step], mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
    return '<div class="bar-msg ' + (ks.length ? 'warn' : 'ok') + '">' + (ks.length ? '<span class="pip"></span>Unsaved changes in ' + ks.map((k) => k[1]).join(', ') + '. Run and Report use the last saved version.' : '✓ All changes saved') + '</div>' +
      (ks.length ? '<span class="kbd" title="Save with the keyboard"><kbd>' + (mac ? '⌘' : 'Ctrl') + '</kbd> <kbd>S</kbd></span>' : '') +
      '<button class="primary" data-a="save-all"' + (ks.length ? '' : ' disabled') + '>Save all</button>' +
      (nx ? '<button class="ghost" data-a="go" data-k="' + nx[1] + '"' + (ST.unlocked(nx[1]) ? '' : ' disabled title="Save first to unlock the next step"') + '>' + nx[0] + ' →</button>' : '');
  }
  const saveBar = () => '<div class="savebar" id="bar"><div class="bar-in">' + barInner() + '</div></div>';
  const csvBtn = (a) => '<button class="ghost" data-a="' + a + '">Export CSV</button>';
  const genBtn = (exists, act, first) => '<button class="' + (exists ? 'ghost' : 'primary') + '" data-a="' + act + '"' + (ui.busy ? ' disabled' : '') + '>' + (ui.busy ? 'Generating…' : (exists ? 'Regenerate' : first)) + '</button>';

  // ---------- markdown Write / Preview tabs ----------
  // fmt: 'ac' = one item per line -> checklist; 'steps' = one per line -> numbered list; '' = plain markdown
  const numbered = (t) => t.split('\n').map((l) => l.trim().replace(/^\d+[.)]\s+/, '')).filter(Boolean).map((l, i) => (i + 1) + '. ' + l).join('\n');
  const previewHtml = (v, fmt) => (fmt === 'ac' ? MD.render(v, { list: true }) : MD.render(fmt === 'steps' ? numbered(v) : v));
  function rt(path, value, fmt, min) {
    const w = !!ui.write[path], p = esc(path), tab = (t, label, on) => '<button type="button" role="tab" data-a="rt-tab" data-k="' + p + '" data-t="' + t + '" aria-selected="' + on + '">' + label + '</button>';
    return '<div class="rt" data-fmt="' + (fmt || '') + '"><div class="rt-tabs" role="tablist">' + tab('write', 'Write', w) + tab('preview', 'Preview', !w) + '</div>' +
      '<div class="rt-write" role="tabpanel"' + (w ? '' : ' hidden') + '><textarea data-i="rt" data-k="' + p + '" rows="' + rows(value, min || 3) + '" spellcheck="false" placeholder="Markdown supported">' + esc(value) + '</textarea></div>' +
      '<div class="rt-prev doc" role="tabpanel"' + (w ? ' hidden' : '') + '></div></div>';
  }
  function grow(t) { t.style.height = 'auto'; t.style.height = (t.scrollHeight + 2) + 'px'; }
  const paintPrev = (box) => { const v = box.querySelector('.rt-prev'); if (v && !v.hidden) v.innerHTML = previewHtml(box.querySelector('textarea').value, box.dataset.fmt); };
  // fill every visible Preview pane under root from its textarea, size visible textareas, then paint diagrams
  function hydrate(root) {
    root.querySelectorAll('.rt').forEach(paintPrev);
    root.querySelectorAll('.rt-write:not([hidden]) textarea').forEach(grow);
    MD.paintMermaid(root);
  }
  function setRT(path, v) {
    const p = path.split('|');
    if (p[0] === 's') { const s = (S.draft.stories || []).find((x) => x.id === p[1]); if (!s) return; if (p[2] === 'desc') s.description = v; else s.acceptance_criteria = v.split('\n'); }
    else if (p[0] === 'plan') { const k = p[1]; S.draft.plan[k] = Array.isArray(S.draft.plan[k]) ? v.split('\n') : v; }
    else if (p[0] === 'case') { const c = S.draft.cases[+p[1]]; if (!c) return; if (p[2] === 'steps') c.steps = v.split('\n'); else c.expected = v; }
  }
  const clearCaseTabs = () => Object.keys(ui.write).forEach((k) => { if (k.indexOf('case|') === 0) delete ui.write[k]; });

  // ---------- 1. Start ----------
  const FILE_ICON = '<svg class="ficon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>';
  const docId = (key, extraIdx) => (extraIdx == null ? key : 'x' + extraIdx);
  function docRow(key, label, d, extraIdx) {
    const id = docId(key, extraIdx), has = !!d.text.trim();
    const browse = '<label class="browse">' + (has ? 'Replace' : 'Browse') + '<input type="file" accept=".md,.txt,text/*" data-c="file" data-k="' + id + '"></label>';
    return '<div class="docrow' + (has ? ' loaded' : '') + '" data-doc="' + id + '" data-drop="' + id + '"><div class="docrow-main">' + FILE_ICON + '<span class="docrow-label">' + esc(label) + '</span>' +
      (has
        ? '<span class="docrow-name" title="' + esc(d.name || label) + '">' + esc(d.name || label) + '</span><button class="sm" data-a="open-doc" data-k="' + id + '" data-label="' + esc(label) + '">View</button>' + browse
        : '<span class="docrow-empty">No document</span>' + browse + '<button class="link" data-a="toggle-paste" data-k="' + id + '">Paste</button>') +
      (extraIdx != null ? '<button class="sm" data-a="rm-extra" data-k="' + extraIdx + '">Remove</button>' : '') + '</div>' +
      (ui.paste[id] ? '<textarea data-i="doc" data-k="' + id + '" placeholder="Paste text here" spellcheck="false" rows="6">' + esc(d.text) + '</textarea>' : '') + '</div>';
  }
  const docRef = (id) => (id[0] === 'x' ? S.docs.extras[+id.slice(1)] : S.docs[id]);
  const docPanel = () => document.getElementById('doc-panel');
  function openDocPanel(d, label, opener) {
    const p = docPanel();
    p.innerHTML = '<div class="doc-panel-head"><h2>' + esc(d.name || label) + '</h2><button class="sm" data-a="close-doc">Close</button></div><div class="doc-body doc">' + MD.render(d.text || '') + '</div>';
    p.hidden = false; p.scrollTop = 0; ui.docOpener = opener || null;
    MD.paintMermaid(p);
    p.querySelector('[data-a="close-doc"]').focus();
  }
  function closeDocPanel() {
    const p = docPanel(); if (p.hidden) return;
    p.hidden = true; p.innerHTML = '';
    const o = ui.docOpener && app.querySelector('[data-a="open-doc"][data-k="' + ui.docOpener + '"]'); ui.docOpener = null;
    if (o) o.focus();
  }
  docPanel().addEventListener('click', (e) => { if (e.target.closest('[data-a="close-doc"]')) closeDocPanel(); });
  function renderStart() {
    const d = S.docs, has = [d.prd, d.design, d.api].concat(d.extras).some((x) => x.text.trim());
    const dry = AI.getConfig().dryRun;
    return head('Start with your source documents', dry
      ? 'Add the PRD, design doc and API spec (plus any supporting docs). Nothing leaves your browser in Phase 1 — generation is simulated (dry-run).'
      : 'Add the PRD, design doc and API spec (plus any supporting docs). <b>Live mode:</b> calls OpenAI with your key. Sample docs are condensed to control cost — full text in dry-run.') +
      '<div class="doclist">' + docRow('prd', 'PRD', d.prd) + docRow('design', 'Design doc', d.design) + docRow('api', 'API spec', d.api) +
      d.extras.map((x, i) => docRow('x', 'Supporting doc ' + (i + 1), x, i)).join('') + '</div>' +
      '<div class="bar"><button class="ghost" data-a="add-extra">+ Add another document</button><button class="ghost" data-a="load-sample">Load NPPES sample</button><span class="grow"></span>' +
      '<button class="primary" data-a="gen-stories"' + (has && !ui.busy ? '' : ' disabled') + '>' + (ui.busy ? 'Generating…' : 'Generate stories →') + '</button></div>' + errBox() +
      '<p class="how"><b>How this works.</b> AI drafts → you edit → you save. Drop a file on any row, browse for one, or paste text.</p>';
  }

  // ---------- 2. Stories ----------
  const PRIOS = ['P0', 'P1', 'P2', 'P3'], STATUSES = ['To Do', 'In Progress', 'Done'];
  const prioCls = (p) => (p === 'P0' ? 'p0' : p === 'P1' ? 'p1' : '');
  const curStory = () => (S.draft.stories || []).find((s) => s.id === S.sel);
  const reqsOf = (labels) => labels.filter((l) => /^REQ-/i.test(l));
  const reqTags = (r) => r.map((x) => '<span class="tag">' + esc(x) + '</span>').join('');
  const storyEdited = (s) => { const v = S.stories.find((x) => x.id === s.id); return !v || JSON.stringify(v) !== JSON.stringify(s); };
  const stateTag = (edited) => '<span class="state ' + (edited ? 'edited' : 'ok') + '">' + (edited ? 'Edited' : 'Saved') + '</span>';
  const catKind = (l) => (/^phase-/i.test(l) ? 'phase' : /^REQ-/i.test(l) ? 'req' : 'area');
  function catsHtml(labels) {
    if (!labels.length) return '<span class="cat-l">Category</span><span class="hint">No labels</span>';
    const order = { phase: 0, area: 1, req: 2 };
    return '<span class="cat-l">Category</span>' + labels.slice().sort((a, b) => order[catKind(a)] - order[catKind(b)]).map((l) => '<span class="cat ' + catKind(l) + '">' + esc(l) + '</span>').join('');
  }
  function assistBox(sec) {
    const a = ui.assist[sec] || {};
    return '<div class="assist" ' + (a.open ? '' : 'hidden') + '><div class="revise"><input data-i="assist-prompt" data-k="' + sec + '" placeholder="Ask AI to improve this…" aria-label="Ask AI to improve ' + sec + '" value="' + esc(a.prompt || '') + '"><button class="sm" data-a="assist" data-k="' + sec + '">Ask</button></div>' +
      (a.out ? '<div class="out doc">' + MD.render(a.out) + '</div>' : '') + '</div>';
  }
  const aiLink = (sec) => '<button class="sm ai" data-a="assist-toggle" data-k="' + sec + '">✨ AI assist</button>';
  function subRow(t, i, sid) {
    if (ui.subEdit === sid + '|' + i) {
      return '<div class="sub edit"><input type="text" data-i="st-edit" data-k="' + i + '" value="' + esc(t.text) + '" aria-label="Edit subtask" placeholder="Subtask, markdown allowed"><button class="sm primary" data-a="st-save" data-k="' + i + '">Save</button><button class="sm" data-a="st-cancel" data-k="' + i + '">Cancel</button></div>';
    }
    return '<div class="sub' + (t.done ? ' done' : '') + '"><input type="checkbox" data-c="st-done" data-k="' + i + '" aria-label="Done"' + (t.done ? ' checked' : '') + '>' +
      '<div class="sub-t">' + (t.text.trim() ? mi(t.text) : '<span class="hint">Empty subtask</span>') + '</div>' +
      '<button class="ib" data-a="st-pencil" data-k="' + i + '" aria-label="Edit subtask" title="Edit">✎</button><button class="ib" data-a="st-rm" data-k="' + i + '" aria-label="Remove subtask" title="Remove">×</button></div>';
  }
  function renderPanel() {
    const s = curStory();
    if (!s) return '<aside class="card panel empty">Select a story.</aside>';
    const sp = 's|' + s.id + '|', nDone = s.subtasks.filter((t) => t.done).length;
    return '<aside class="panel" aria-label="Story detail"><div class="panel-h"><span class="id">' + esc(s.id) + '</span>' + reqTags(reqsOf(s.labels)) + stateTag(storyEdited(s)) + '</div><div class="panel-b">' +
      '<div class="cats" aria-label="Category">' + catsHtml(s.labels) + '</div>' +
      '<input type="text" class="title-in" data-i="s-title" value="' + esc(s.title) + '" aria-label="Summary">' +
      '<div class="fields"><div><label class="l">Status</label><select data-c="s-status" aria-label="Status">' + STATUSES.map((x) => '<option' + (x === s.status ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div>' +
      '<div><label class="l">Priority</label><select data-c="s-priority" aria-label="Priority">' + PRIOS.map((x) => '<option' + (x === s.priority ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div>' +
      '<div><label class="l">Assignee</label><input type="text" data-i="s-assignee" value="' + esc(s.assignee) + '" placeholder="Unassigned" aria-label="Assignee"></div>' +
      '<div><label class="l">Labels</label><input type="text" data-i="s-labels" value="' + esc(s.labels.join(', ')) + '" placeholder="comma-separated" aria-label="Labels"></div></div>' +
      '<div class="lbl-row"><label class="l">Description</label>' + aiLink('description') + '</div>' + assistBox('description') + rt(sp + 'desc', s.description, '', 5) +
      '<div class="lbl-row"><label class="l">Acceptance criteria · one per line</label>' + aiLink('acceptance criteria') + '</div>' + assistBox('acceptance criteria') + rt(sp + 'ac', s.acceptance_criteria.join('\n'), 'ac', 4) +
      '<div class="lbl-row"><label class="l">Subtasks · ' + nDone + '/' + s.subtasks.length + ' done</label>' + aiLink('subtasks') + '</div>' + assistBox('subtasks') +
      s.subtasks.map((t, i) => subRow(t, i, s.id)).join('') +
      '<button class="sm addsub" data-a="st-add">+ Add subtask</button></div></aside>';
  }
  function storyCard(s) {
    const nAc = s.acceptance_criteria.filter((x) => x.trim()).length, nDone = s.subtasks.filter((t) => t.done).length, ed = storyEdited(s);
    return '<article class="card story' + (s.id === S.sel ? ' sel' : '') + (ed ? '' : ' firm') + '" role="button" tabindex="0" aria-pressed="' + (s.id === S.sel) + '" data-a="sel" data-k="' + esc(s.id) + '">' +
      '<div class="card-h"><span class="id">' + esc(s.id) + '</span>' + reqTags(reqsOf(s.labels)) + '<span class="tag">' + esc(s.status) + '</span><span class="tag prio ' + prioCls(s.priority) + '">' + esc(s.priority) + '</span>' + stateTag(ed) + '</div>' +
      '<div class="story-title">' + mi(s.title) + '</div>' +
      '<div class="meta">' + nAc + ' acceptance criteri' + (nAc === 1 ? 'on' : 'a') + ' · ' + nDone + '/' + s.subtasks.length + ' subtask' + (s.subtasks.length === 1 ? '' : 's') + (s.assignee ? ' · ' + esc(s.assignee) : '') + '</div></article>';
  }
  function renderStories() {
    const L = S.draft.stories || [];
    return head('Stories', L.length + ' stories drafted from your documents. Select one to review it in the detail panel; descriptions and criteria show formatted — use the Write tab to edit. Edits stay in a draft until you <b>Save all</b>.', csvBtn('csv-stories')) +
      '<div class="split"><div class="list">' + L.map(storyCard).join('') + '</div>' + renderPanel() + '</div>' + saveBar();
  }

  // ---------- 3. Test plan ----------
  const PLAN_LABELS = { objectives: 'Objectives', scope_in: 'Scope — in', scope_out: 'Scope — out', approach: 'Approach', entry_criteria: 'Entry criteria', exit_criteria: 'Exit criteria', risks: 'Risks' };
  function planBlock(p, k) {
    const isList = Array.isArray(p[k]), v = isList ? p[k].join('\n') : (p[k] || '');
    return '<div class="block"><label class="l">' + PLAN_LABELS[k] + (isList ? ' · one per line' : '') + '</label>' + rt('plan|' + k, v, isList ? 'ac' : '', 3) + '</div>';
  }
  function renderPlan() {
    const p = S.draft.plan;
    const lede = 'A strategy-level plan derived from the saved stories: scope, approach, criteria and risks. List sections take one item per line.';
    if (!p) return head('Test plan', lede) + '<div class="card empty"><p>No plan yet — generate one from the saved stories.</p>' + genBtn(false, 'gen-plan', 'Generate test plan →') + '</div>' + errBox();
    return head('Test plan', lede, csvBtn('csv-plan') + genBtn(true, 'gen-plan')) + errBox() +
      '<article class="card firm planbox"><div class="card-h"><span class="id">PLAN-1</span><span class="tag">strategy</span>' + stateTag(dirty('plan')) + '</div>' +
      planBlock(p, 'objectives') + '<div class="two">' + planBlock(p, 'scope_in') + planBlock(p, 'scope_out') + '</div>' +
      ['approach', 'entry_criteria', 'exit_criteria', 'risks'].map((k) => planBlock(p, k)).join('') + '</article>' + saveBar();
  }

  // ---------- requirement model (shared by coverage strip + report) ----------
  function reqModel(stories, cases) {
    const reqs = {}, add = (r) => (reqs[r] = reqs[r] || { id: r, stories: [], cases: [] });
    stories.forEach((s) => reqsOf(s.labels).forEach((l) => add(l.toUpperCase()).stories.push(s)));
    cases.forEach((c) => String(c.requirement_ref).split(/[,\s]+/).filter(Boolean).forEach((r) => add(r.toUpperCase()).cases.push(c)));
    return Object.values(reqs).sort((a, b) => a.id.localeCompare(b.id)).map((r) => Object.assign(r, { verdict: ST.verdict(r.cases) }));
  }
  const reportModel = () => reqModel(S.stories, S.cases);
  const VCLS = { PROVEN: 'pass', PARTIAL: 'blocked', FAILED: 'fail', 'NOT RUN': 'notrun' };

  // ---------- 4. Test cases ----------
  // traceability: requirements -> stories -> cases -> verdict, colored by saved run results
  function covMermaid(M) {
    const safe = (s) => String(s).replace(/[^A-Za-z0-9._ -]/g, ''), nid = {}, nodes = [], edges = new Set(), lines = ['flowchart LR',
      '    classDef req fill:#eef2ff,stroke:#6366f1,color:#1e1b4b', '    classDef story fill:#fff,stroke:#94a3b8,color:#334155',
      '    classDef pass fill:#D5F2E1,stroke:#0E6B3F,color:#0E6B3F', '    classDef fail fill:#FDD9DC,stroke:#A31D2B,color:#A31D2B',
      '    classDef blocked fill:#FFEBB8,stroke:#C98A00,color:#855000', '    classDef notrun fill:#F1EFFB,stroke:#8F8CA8,color:#5B5878'];
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
    return '<section class="cov" aria-label="Requirement coverage"><div class="cov-n">' + C.length + ' test case' + (C.length === 1 ? '' : 's') + ' · ' + covered + ' of ' + M.length + ' requirements covered</div>' +
      '<div class="cov-v">' + ['PROVEN', 'PARTIAL', 'FAILED', 'NOT RUN'].map((v) => '<span class="chip ' + VCLS[v] + '">' + (tally[v] || 0) + ' ' + v + '</span>').join('') + '</div>' +
      '<div class="cov-map">' + (M.length ? MD.render(covMermaid(M)) : '<span class="hint">Link cases to requirements (e.g. REQ-001) to see the traceability map.</span>') + '</div></section>';
  }
  function testCard(c, i) {
    const refs = String(c.requirement_ref).split(/[,\s]+/).filter(Boolean), cp = 'case|' + i + '|';
    return '<article class="card firm testcase" data-card="' + i + '"><div class="card-h"><span class="id">' + esc(c.id) + '</span>' + reqTags(refs) + '<span class="tag prio ' + prioCls(c.priority) + '">' + esc(c.priority) + '</span>' +
      '<button class="x" data-a="case-rm" data-k="' + i + '" aria-label="Remove case ' + esc(c.id) + '" title="Remove">×</button></div>' +
      '<div class="fields f4"><div><label class="l">ID</label><input type="text" data-i="case" data-f="id" data-k="' + i + '" value="' + esc(c.id) + '" aria-label="ID"></div>' +
      '<div><label class="l">Req ref</label><input type="text" data-i="case" data-f="requirement_ref" data-k="' + i + '" value="' + esc(c.requirement_ref) + '" aria-label="Requirement ref"></div>' +
      '<div class="span2"><label class="l">Priority</label><select data-c="case-prio" data-k="' + i + '" aria-label="Priority">' + PRIOS.map((x) => '<option' + (x === c.priority ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div></div>' +
      '<label class="l">Title</label><input type="text" class="title-in" data-i="case" data-f="title" data-k="' + i + '" value="' + esc(c.title) + '" aria-label="Title">' +
      '<div class="two"><div><label class="l">Steps · numbered, one per line</label>' + rt(cp + 'steps', c.steps.join('\n'), 'steps', 3) + '</div>' +
      '<div><label class="l">Expected result</label>' + rt(cp + 'expected', c.expected, '', 3) + '</div></div></article>';
  }
  function renderCases() {
    const C = S.draft.cases;
    const lede = 'Traceable to requirements. Steps and expected results show formatted — use the Write tab to edit.';
    if (!C) return head('Test cases', lede) + '<div class="card empty"><p>No cases yet — generate them from the saved plan and stories.</p>' + genBtn(false, 'gen-cases', 'Generate test cases →') + '</div>' + errBox();
    return head('Test cases', C.length + ' cases, each tagged with the requirement it proves. ' + lede, csvBtn('csv-cases') + '<button class="ghost" data-a="case-add">+ Add case</button>' + genBtn(true, 'gen-cases')) + errBox() +
      covHtml(C) + '<div class="list">' + C.map(testCard).join('') + '</div>' + saveBar();
  }

  // ---------- 5. Run ----------
  const hasSample = () => Object.values(S.results).some((r) => r.sample);
  const sampleBanner = () => hasSample() ? '<div class="note"><span class="sample-tag">SAMPLE DATA</span> Results below include demo values, not real test execution.</div>' : '';
  function counts() {
    const c = { PASS: 0, FAIL: 0, BLOCKED: 0, 'NOT RUN': 0 };
    S.cases.forEach((x) => { const r = S.results[x.id]; c[r ? r.status : 'NOT RUN']++; });
    return c;
  }
  function renderRun() {
    const c = counts(), n = S.cases.length || 1;
    return head('Run', 'Mark each test case as you execute it. Phase 1 is manual; automation comes later.', '<button class="ghost" data-a="clear-results">Clear all results</button><button class="primary" data-a="go" data-k="5">Report →</button>') +
      (anyDirty() ? '<div class="note">You have unsaved edits; this screen uses the last saved version.</div>' : '') + sampleBanner() +
      '<label class="sampleline"><input type="checkbox" data-c="sample"' + (S.sampleResults ? ' checked' : '') + '> <span><b>Fill sample results</b> <span class="sample-tag">DEMO</span> — a labeled 11 PASS / 2 FAIL / 2 BLOCKED mix with notes. Nothing really executes.</span></label>' +
      '<div class="sum">' + ['PASS', 'FAIL', 'BLOCKED', 'NOT RUN'].map((k) => '<div class="stat s-' + k.replace(' ', '') + '"><b>' + c[k] + '</b><span>' + k + '</span></div>').join('') + '</div>' +
      '<div class="progress" role="img" aria-label="Run progress">' + ['PASS', 'FAIL', 'BLOCKED'].map((k) => '<i class="i-' + k + '" style="width:' + (100 * c[k] / n) + '%"></i>').join('') + '</div>' +
      '<div class="rows">' + S.cases.map((t) => {
        const r = S.results[t.id] || {};
        return '<div class="run"><span class="id">' + esc(t.id) + '</span><span class="run-t">' + mi(t.title) + ' <span class="tag">' + esc(t.requirement_ref) + '</span>' + (r.sample ? ' <span class="sample-tag">SAMPLE</span>' : '') + '</span>' +
          '<div class="seg">' + ['PASS', 'FAIL', 'BLOCKED'].map((k) => '<button class="' + k + (r.status === k ? ' on' : '') + '" data-a="mark" data-k="' + esc(t.id) + '" data-v="' + k + '" aria-pressed="' + (r.status === k) + '">' + k + '</button>').join('') + '</div>' +
          '<input class="note-in" data-i="note" data-k="' + esc(t.id) + '" aria-label="Evidence / notes for ' + esc(t.id) + '" placeholder="Evidence / notes" value="' + esc(r.note || '') + '"' + (r.status ? '' : ' disabled') + '></div>';
      }).join('') + '</div>';
  }

  // ---------- 6. Report ----------
  function renderReport() {
    const M = reportModel(), tally = {};
    M.forEach((r) => (tally[r.verdict] = (tally[r.verdict] || 0) + 1));
    return head('Report', 'Proof per requirement, rendered from saved stories, cases and run results.', '<button class="primary" data-a="copy-summary">Copy summary</button>') + sampleBanner() +
      '<div class="sumline">' + ['PROVEN', 'PARTIAL', 'FAILED', 'NOT RUN'].map((v) => '<div class="big ' + VCLS[v] + '"><b>' + (tally[v] || 0) + '</b>' + v + '</div>').join('') + '</div>' +
      M.map((r) => '<article class="req ' + VCLS[r.verdict] + '"><header><b class="id">' + esc(r.id) + '</b><span class="v ' + r.verdict.replace(' ', '') + '">' + r.verdict + '</span><span class="by">' + (r.stories.map((s) => esc(s.id) + ' ' + mi(s.title)).join(' · ') || 'No linked story') + '</span></header>' +
        '<ul>' + (r.cases.length ? r.cases.map((c) => { const x = S.results[c.id]; return '<li><span class="id">' + esc(c.id) + '</span><span class="v ' + (x ? x.status : 'NOTRUN') + '">' + (x ? x.status : 'NOT RUN') + '</span><span>' + mi(c.title) + (x && x.sample ? ' <span class="sample-tag">SAMPLE</span>' : '') + '</span>' + (x && x.note ? '<span class="ev">Evidence: ' + mi(x.note) + '</span>' : '') + '</li>'; }).join('') : '<li class="ev">No test cases linked to this requirement.</li>') + '</ul></article>').join('');
  }
  function summaryText() {
    const M = reportModel(), c = counts();
    return 'Being Agile proof summary' + (hasSample() ? ' (INCLUDES SAMPLE DATA)' : '') + '\nCases: ' + c.PASS + ' PASS, ' + c.FAIL + ' FAIL, ' + c.BLOCKED + ' BLOCKED, ' + c['NOT RUN'] + ' NOT RUN\n\n' +
      M.map((r) => r.id + ': ' + r.verdict + ' — ' + (r.stories.map((s) => s.title).join('; ') || 'no story') + '\n' +
        r.cases.map((x) => '  ' + x.id + ' ' + ((S.results[x.id] || {}).status || 'NOT RUN') + ((S.results[x.id] || {}).note ? ' — ' + S.results[x.id].note : '')).join('\n')).join('\n');
  }

  // ---------- render ----------
  const SCREENS = [renderStart, renderStories, renderPlan, renderCases, renderRun, renderReport];
  function render() {
    if (!ST.unlocked(S.step)) S.step = 0;
    renderChrome();
    const y = window.scrollY, ae = document.activeElement, keep = ae && ae.dataset && ae.dataset.i ? { i: ae.dataset.i, k: ae.dataset.k, f: ae.dataset.f } : null;
    const pb = app.querySelector('.panel-b'), pbTop = pb ? pb.scrollTop : 0;
    app.innerHTML = '<div class="screen s' + S.step + ' fade">' + SCREENS[S.step]() + '</div>';
    window.scrollTo(0, y);
    const npb = app.querySelector('.panel-b'); if (npb) npb.scrollTop = pbTop;
    hydrate(app);
    if (ui.focus) { const el = app.querySelector(ui.focus); if (el) el.focus(); ui.focus = null; }
    else if (keep) { const el = app.querySelector('[data-i="' + keep.i + '"]' + (keep.k != null ? '[data-k="' + keep.k + '"]' : '') + (keep.f ? '[data-f="' + keep.f + '"]' : '')); if (el) el.focus(); }
  }
  // cheap live refresh while typing (no re-render): save bar + the open story's state tags
  function touch() {
    const b = document.querySelector('#bar .bar-in'); if (b) b.innerHTML = barInner();
    const s = S.step === 1 && curStory();
    if (s) {
      const ed = storyEdited(s), set = (el) => { if (el) { el.className = 'state ' + (ed ? 'edited' : 'ok'); el.textContent = ed ? 'Edited' : 'Saved'; } };
      set(app.querySelector('.panel .state')); set(app.querySelector('.story.sel .state'));
      const c = app.querySelector('.story.sel'); if (c) c.classList.toggle('firm', !ed);
    }
  }
  function go(i) { if (!ST.unlocked(i)) return; S.step = i; ST.save(); ui.error = ''; ui.subEdit = null; closeDocPanel(); render(); window.scrollTo(0, 0); }

  // ---------- commit ----------
  function cleanDraft() {
    const D = S.draft;
    if (D.plan) ['scope_in', 'scope_out', 'entry_criteria', 'exit_criteria', 'risks'].forEach((k) => { D.plan[k] = (D.plan[k] || []).filter((x) => x.trim()); });
    if (D.stories) D.stories.forEach((s) => { s.acceptance_criteria = s.acceptance_criteria.filter((x) => x.trim()); s.subtasks = s.subtasks.filter((t) => t.text.trim()); });
    if (D.cases) D.cases.forEach((c) => { c.steps = c.steps.filter((x) => x.trim()); });
  }
  function saveAll() {
    cleanDraft(); ui.subEdit = null;
    ['stories', 'plan', 'cases'].forEach((k) => { if (S.draft[k]) S[k] = ST.clone(S.draft[k]); });
    ST.save(); toast('Saved'); render();
  }

  // ---------- actions ----------
  const A = {
    'open-doc': (el) => openDocPanel(docRef(el.dataset.k), el.dataset.label, el.dataset.k),
    'close-doc': closeDocPanel,
    'toggle-paste': (el) => { ui.paste[el.dataset.k] = !ui.paste[el.dataset.k]; ui.focus = '[data-i="doc"][data-k="' + el.dataset.k + '"]'; render(); },
    'add-extra': () => { S.docs.extras.push({ name: '', text: '' }); ST.save(); render(); },
    'rm-extra': (el) => { S.docs.extras.splice(+el.dataset.k, 1); ST.save(); closeDocPanel(); render(); },
    'load-sample': () => {
      const live = !AI.getConfig().dryRun;
      const d = live ? window.SAMPLE.docsCondensed : window.SAMPLE.docs, sfx = live ? '-condensed' : '';
      S.docs.prd = { name: 'prd' + sfx + '.md (NPPES sample)', text: d.prd }; S.docs.design = { name: 'design' + sfx + '.md (NPPES sample)', text: d['design']  }; S.docs.api = { name: 'api-spec' + sfx + '.md (NPPES sample)', text: d['api-spec'] };
      ST.save(); render(); toast('NPPES sample loaded');
    },
    'gen-stories': () => guarded('stories', S.docs, 'Generate stories', (data) => {
      S.stories = data.map(ST.normStory); S.draft.stories = ST.clone(S.stories);
      S.plan = null; S.draft.plan = null; S.cases = []; S.draft.cases = null; S.results = {}; S.sampleResults = false; ui.write = {}; ui.subEdit = null;
      S.sel = S.stories[0] && S.stories[0].id; S.step = 1;
    }),
    'gen-plan': () => { if (anyDirty() && !confirm('Unsaved edits will not be used. Continue with last saved stories?')) return; return guarded('plan', S.stories, 'Generate test plan', (data) => { S.plan = data; S.draft.plan = ST.clone(data); S.cases = []; S.draft.cases = null; S.results = {}; S.sampleResults = false; Object.keys(ui.write).forEach((k) => { if (k.indexOf('plan|') === 0) delete ui.write[k]; }); clearCaseTabs(); }); },
    'gen-cases': () => guarded('cases', { plan: S.plan, stories: S.stories }, 'Generate test cases', (data) => { S.cases = data.map(ST.normCase); S.draft.cases = ST.clone(S.cases); S.results = {}; S.sampleResults = false; clearCaseTabs(); }),
    'save-all': saveAll,
    'csv-stories': () => { cleanDraft(); toast('Downloaded ' + CSV.download('stories', CSV.storiesToCsv(S.draft.stories))); },
    'csv-plan': () => { cleanDraft(); toast('Downloaded ' + CSV.download('test-plan', CSV.planToCsv(S.draft.plan))); },
    'csv-cases': () => { cleanDraft(); toast('Downloaded ' + CSV.download('test-cases', CSV.casesToCsv(S.draft.cases))); },
    go: (el) => go(+el.dataset.k),
    sel: (el) => { S.sel = el.dataset.k; ui.subEdit = null; ST.save(); render(); },
    'rt-tab': (el) => {
      const box = el.closest('.rt'), w = el.dataset.t === 'write';
      ui.write[el.dataset.k] = w;
      box.querySelectorAll('[role="tab"]').forEach((b) => b.setAttribute('aria-selected', String((b.dataset.t === 'write') === w)));
      box.querySelector('.rt-write').hidden = !w; box.querySelector('.rt-prev').hidden = w;
      if (w) { const t = box.querySelector('textarea'); grow(t); t.focus(); } else { paintPrev(box); MD.paintMermaid(box); }
    },
    'st-add': () => { const s = curStory(); s.subtasks.push({ text: '', done: false }); ui.subEdit = s.id + '|' + (s.subtasks.length - 1); ui.focus = '[data-i="st-edit"]'; render(); },
    'st-pencil': (el) => { ui.subEdit = curStory().id + '|' + el.dataset.k; ui.focus = '[data-i="st-edit"]'; render(); },
    'st-save': (el) => {
      const s = curStory(), i = +el.dataset.k, inp = app.querySelector('[data-i="st-edit"][data-k="' + i + '"]');
      if (inp) s.subtasks[i].text = inp.value;
      if (!s.subtasks[i].text.trim()) s.subtasks.splice(i, 1);
      ui.subEdit = null; render();
    },
    'st-cancel': (el) => { const s = curStory(), i = +el.dataset.k; if (!s.subtasks[i].text.trim()) s.subtasks.splice(i, 1); ui.subEdit = null; render(); },
    'st-rm': (el) => { curStory().subtasks.splice(+el.dataset.k, 1); ui.subEdit = null; render(); },
    'assist-toggle': (el) => { const a = (ui.assist[el.dataset.k] = ui.assist[el.dataset.k] || {}); a.open = !a.open; ui.focus = '[data-i="assist-prompt"][data-k="' + el.dataset.k + '"]'; render(); },
    assist: async (el) => { const a = ui.assist[el.dataset.k]; a.out = 'Thinking…'; render(); a.out = await AI.assist(el.dataset.k, a.prompt); render(); },
    'case-add': () => { S.draft.cases.push({ id: 'TC-' + String(S.draft.cases.length + 1).padStart(3, '0'), requirement_ref: '', title: '', steps: [], expected: '', priority: 'P1' }); ui.focus = '[data-i="case"][data-f="title"][data-k="' + (S.draft.cases.length - 1) + '"]'; render(); },
    'case-rm': (el) => { S.draft.cases.splice(+el.dataset.k, 1); clearCaseTabs(); render(); },
    mark: (el) => {
      const id = el.dataset.k, v = el.dataset.v, cur = S.results[id];
      if (cur && cur.status === v) delete S.results[id]; else S.results[id] = { status: v, note: cur && !cur.sample ? cur.note : '' };
      ST.save(); render();
    },
    'clear-results': () => { S.results = {}; S.sampleResults = false; ST.save(); render(); },
    'copy-summary': async () => {
      const t = summaryText();
      try { await navigator.clipboard.writeText(t); } catch (e) { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
      toast('Summary copied');
    },
  };

  // ---------- inputs (no re-render; keeps focus) ----------
  let saveT;
  const I = {
    doc: (el) => {
      const d = docRef(el.dataset.k), was = !!d.text.trim();
      d.text = el.value;
      if (was !== !!d.text.trim()) { ST.save(); render(); return; } // row flips empty<->loaded: View button appears/disappears
      clearTimeout(saveT); saveT = setTimeout(() => { ST.save(); const b = app.querySelector('[data-a="gen-stories"]'); if (b) b.disabled = ui.busy || ![S.docs.prd, S.docs.design, S.docs.api].concat(S.docs.extras).some((x) => x.text.trim()); }, 300);
    },
    rt: (el) => { setRT(el.dataset.k, el.value); grow(el); },
    's-title': (el) => { curStory().title = el.value; const t = app.querySelector('.story.sel .story-title'); if (t) t.innerHTML = mi(el.value); },
    's-assignee': (el) => { curStory().assignee = el.value; },
    's-labels': (el) => { const s = curStory(); s.labels = el.value.split(',').map((x) => x.trim()).filter(Boolean); const c = app.querySelector('.cats'); if (c) c.innerHTML = catsHtml(s.labels); },
    'assist-prompt': (el) => { (ui.assist[el.dataset.k] = ui.assist[el.dataset.k] || {}).prompt = el.value; },
    case: (el) => { const c = S.draft.cases[+el.dataset.k]; c[el.dataset.f] = el.value; },
    note: (el) => { const r = S.results[el.dataset.k]; if (r) { r.note = el.value; delete r.sample; clearTimeout(saveT); saveT = setTimeout(ST.save, 300); } },
  };
  const C = {
    's-status': (el) => { curStory().status = el.value; render(); },
    's-priority': (el) => { curStory().priority = el.value; render(); },
    'st-done': (el) => { curStory().subtasks[+el.dataset.k].done = el.checked; render(); },
    'case-prio': (el) => { S.draft.cases[+el.dataset.k].priority = el.value; render(); },
    sample: (el) => { ST.setSampleResults(el.checked); ST.save(); render(); },
    file: (el) => readFile(el.files[0], el.dataset.k),
  };
  function readFile(f, id) {
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { const d = docRef(id); d.name = f.name; d.text = String(r.result); ST.save(); render(); };
    r.readAsText(f);
  }

  app.addEventListener('click', (e) => { const el = e.target.closest('[data-a]'); if (el && A[el.dataset.a] && !el.disabled) A[el.dataset.a](el); });
  app.addEventListener('input', (e) => { const el = e.target.closest('[data-i]'); if (el && I[el.dataset.i]) { I[el.dataset.i](el); touch(); } });
  app.addEventListener('change', (e) => { const el = e.target.closest('[data-c]'); if (el && C[el.dataset.c]) { C[el.dataset.c](el); touch(); } });
  app.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t.matches('[data-i="st-edit"]') && (e.key === 'Enter' || e.key === 'Escape')) { e.preventDefault(); const b = app.querySelector('[data-a="' + (e.key === 'Enter' ? 'st-save' : 'st-cancel') + '"]'); if (b) b.click(); }
    else if (t.matches('article[data-a="sel"]') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); t.click(); }
  });
  document.addEventListener('keydown', (e) => {
    const p = docPanel();
    if (e.key === 'Escape' && p && !p.hidden) closeDocPanel();
    else if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey) && S.step >= 1 && S.step <= 3 && document.getElementById('lock').hidden) { e.preventDefault(); if (anyDirty()) saveAll(); }
  });
  ['dragover', 'dragleave', 'drop'].forEach((ev) => app.addEventListener(ev, (e) => {
    const z = e.target.closest('[data-drop]'); if (!z) return;
    e.preventDefault(); z.classList.toggle('over', ev === 'dragover');
    if (ev === 'drop') readFile(e.dataTransfer.files[0], z.dataset.drop);
  }));
  document.getElementById('steps').addEventListener('click', (e) => { const b = e.target.closest('[data-step]'); if (b) go(+b.dataset.step); });

  // ---------- settings drawer ----------
  const drawer = document.getElementById('drawer'), keyEl = document.getElementById('set-key'), keepEl = document.getElementById('set-keep'), modelEl = document.getElementById('set-model');
  modelEl.innerHTML = AI.MODELS.map((m) => '<option>' + m + '</option>').join('');
  document.getElementById('btn-gear').onclick = () => { drawer.hidden = !drawer.hidden; if (!drawer.hidden && window.PinLock) window.PinLock.renderSettings(); };
  document.getElementById('btn-drawer-close').onclick = () => { drawer.hidden = true; };
  const dryEl = document.getElementById('set-dry');
  dryEl.onchange = () => { S.dryRun = dryEl.checked; AI.configure({ dryRun: S.dryRun }); ST.save(); render(); };
  const endEl = document.getElementById('set-endpoint'), endErr = document.getElementById('set-endpoint-err');
  endEl.oninput = () => {
    const v = endEl.value.trim(), ok = !v || /^https:\/\//i.test(v);
    endErr.hidden = ok; endErr.textContent = ok ? '' : 'Endpoint must start with https:// (leave empty for the OpenAI default). Not saved.';
    if (!ok) return;
    S.endpoint = v; AI.configure({ endpoint: v || AI.DEFAULT_ENDPOINT }); ST.save();
  };
  modelEl.onchange = () => { S.model = modelEl.value; AI.configure({ model: S.model }); ST.save(); render(); };
  const KEYSTORE = 'being-agile-session-key'; // sessionStorage only, opt-in; never localStorage
  const sess = (fn) => { try { return fn(sessionStorage); } catch (e) { return null; } };
  keyEl.oninput = () => { AI.configure({ apiKey: keyEl.value }); if (keepEl.checked) sess((s) => s.setItem(KEYSTORE, keyEl.value)); };
  keepEl.onchange = () => { sess((s) => (keepEl.checked ? s.setItem(KEYSTORE, keyEl.value) : s.removeItem(KEYSTORE))); };
  document.getElementById('btn-reset').onclick = async () => {
    if (!(await confirmBox('Reset demo?', '<p>This clears all saved documents, stories, plan, cases and results from this browser.</p>', 'Reset'))) return;
    S = ST.reset(); AI.loadUsage([]); ui.assist = {}; ui.paste = {}; ui.write = {}; ui.subEdit = null; ui.error = ''; closeDocPanel(); render(); toast('Demo reset');
  };

  // ---------- init ----------
  AI.configure({ model: S.model, dryRun: S.dryRun !== false, endpoint: S.endpoint || AI.DEFAULT_ENDPOINT });
  endEl.value = S.endpoint || '';
  dryEl.checked = S.dryRun !== false;
  AI.loadUsage(S.usage);
  modelEl.value = S.model;
  const sk = sess((s) => s.getItem(KEYSTORE));
  if (sk) { keyEl.value = sk; keepEl.checked = true; AI.configure({ apiKey: sk }); }
  const start = () => { if (!S.sel && S.stories[0]) S.sel = S.stories[0].id; render(); };
  if (window.PinLock) window.PinLock.boot(start); else start();
})();
