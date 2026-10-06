/* Six screens: rendering + interactions. Event delegation on #app via data-a (click), data-i (input), data-c (change). */
(function () {
  'use strict';
  const AI = window.OpenAI, ST = window.State, CSV = window.CSV;
  let S = ST.load();
  const app = document.getElementById('app');
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tok = (t) => Math.ceil((t || '').length / 4);
  const fmtUsd = (n) => '$' + (n < 0.01 ? n.toFixed(4) : n.toFixed(2));
  const rows = (s, min) => Math.max(min || 2, Math.min(14, String(s).split('\n').length + 1));
  const ui = { busy: false, error: '', assist: {}, focus: null };

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
  const dirty = (k) => !!S.draft[k] && JSON.stringify(S.draft[k]) !== JSON.stringify(S[k]);
  const anyDirty = () => ['stories', 'plan', 'cases'].some((k) => S.draft[k] && JSON.stringify(S.draft[k]) !== JSON.stringify(S[k]));

  async function guarded(op, input, title, apply) {
    const est = AI.estimateCall(op, input), cfg = AI.getConfig();
    const ok = await confirmBox(title,
      '<p>This will use <b>~' + est.tokens.toLocaleString() + ' tokens</b>, est. <b>' + fmtUsd(est.usd) + '</b> (' + esc(est.model) + ').</p>' +
      '<p class="hint">Input ~' + est.inputTokens.toLocaleString() + ' (cap ' + est.capIn.toLocaleString() + ') · output ~' + est.outputTokens.toLocaleString() + ' (cap ' + est.capOut.toLocaleString() + ')</p>' +
      (cfg.dryRun ? '<p class="hint">Dry-run: simulated response, nothing is sent and nothing is spent.</p>' : '') +
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

  // ---------- header / drawer ----------
  function renderChrome() {
    document.getElementById('steps').innerHTML = ST.STEPS.map((n, i) =>
      '<button data-step="' + i + '" class="' + (S.step === i ? 'on' : '') + '"' + (ST.unlocked(i) ? '' : ' disabled title="Complete the previous step first"') + '><b>' + (i + 1) + '</b>' + n + '</button>').join('');
    const u = AI.getUsage().total;
    document.getElementById('meter').textContent = (u.prompt_tokens + u.completion_tokens).toLocaleString() + ' tok · ~' + fmtUsd(u.est_usd) + (AI.getConfig().dryRun ? ' · dry-run' : ' · live');
    const calls = AI.getUsage().calls;
    document.getElementById('usage').innerHTML = calls.length
      ? '<table class="u-tbl"><tr><th>Call</th><th>Model</th><th>In</th><th>Out</th><th>$</th></tr>' + calls.map((c) =>
        '<tr><td>' + c.operation + '</td><td>' + c.model + '</td><td>' + c.prompt_tokens.toLocaleString() + '</td><td>' + c.completion_tokens.toLocaleString() + '</td><td>' + fmtUsd(c.est_usd) + '</td></tr>').join('') +
      '<tr><th>Total</th><th></th><th>' + u.prompt_tokens.toLocaleString() + '</th><th>' + u.completion_tokens.toLocaleString() + '</th><th>' + fmtUsd(u.est_usd) + '</th></tr></table>'
      : '<p class="hint">No calls yet.</p>';
  }

  // ---------- 1. Start ----------
  function docCard(key, label, d, extraIdx) {
    const id = extraIdx == null ? key : 'x' + extraIdx;
    return '<div class="card doc" data-doc="' + id + '"><h3>' + label +
      (d.text ? '<button class="sm" data-a="view-doc" data-k="' + id + '" data-label="' + esc(label) + '">View</button>' : '') +
      (extraIdx != null ? '<button class="sm" data-a="rm-extra" data-k="' + extraIdx + '">Remove</button>' : '') + '</h3>' +
      '<div class="drop" data-drop="' + id + '">Drop a .md / .txt file here or <label style="color:var(--accent);cursor:pointer;text-decoration:underline">browse<input type="file" accept=".md,.txt,text/*" data-c="file" data-k="' + id + '"></label>' +
      (d.name ? '<br><b style="color:var(--ink)">' + esc(d.name) + '</b>' : '') + '</div>' +
      '<textarea data-i="doc" data-k="' + id + '" placeholder="…or paste text here" spellcheck="false">' + esc(d.text) + '</textarea>' +
      '<div class="meta"><span data-count="' + id + '">' + d.text.length.toLocaleString() + ' chars · ~' + tok(d.text).toLocaleString() + ' tokens</span></div></div>';
  }
  const docRef = (id) => (id[0] === 'x' ? S.docs.extras[+id.slice(1)] : S.docs[id]);
  function openDocView(d, label) {
    const m = document.getElementById('doc-view'), box = m.firstElementChild, text = d.text || '';
    box.innerHTML = '<div class="docview-head"><div><h3>' + esc(d.name || label) + '</h3><span class="meta">' + text.length.toLocaleString() + ' chars · ~' + tok(text).toLocaleString() + ' tokens</span></div>' +
      '<button class="sm" data-close>Close</button></div><div class="docview-body">' + esc(text) + '</div>';
    box.querySelector('[data-close]').onclick = () => { m.hidden = true; };
    m.onclick = (e) => { if (e.target === m) m.hidden = true; };
    m.hidden = false;
  }
  document.addEventListener('keydown', (e) => {
    const m = document.getElementById('doc-view');
    if (e.key === 'Escape' && m && !m.hidden) m.hidden = true;
  });
  function renderStart() {
    const d = S.docs, has = [d.prd, d.design, d.api].concat(d.extras).some((x) => x.text.trim());
    const dry = AI.getConfig().dryRun;
    return '<h1>Start</h1><p class="lead">' + (dry
      ? 'Add the PRD, design doc and API spec (plus any supporting docs). Nothing leaves your browser in Phase 1 — generation is simulated (dry-run).'
      : 'Add the PRD, design doc and API spec (plus any supporting docs). <b>Live mode:</b> calls OpenAI with your key. Sample docs are condensed to control cost — full text in dry-run.') + '</p>' +
      '<div class="grid3">' + docCard('prd', 'PRD', d.prd) + docCard('design', 'Design doc', d.design) + docCard('api', 'API spec', d.api) +
      d.extras.map((x, i) => docCard('x', 'Supporting doc ' + (i + 1), x, i)).join('') + '</div>' +
      '<div class="bar"><button class="ghost" data-a="add-extra">+ Add another document</button><button class="ghost" data-a="load-sample">Load NPPES sample</button><span class="grow"></span>' +
      '<button class="primary" data-a="gen-stories"' + (has && !ui.busy ? '' : ' disabled') + '>' + (ui.busy ? 'Generating…' : 'Generate stories →') + '</button></div>' +
      (ui.error ? '<div class="err">' + esc(ui.error) + '</div>' : '');
  }

  // ---------- 2. Stories ----------
  const PRIOS = ['P0', 'P1', 'P2', 'P3'], STATUSES = ['To Do', 'In Progress', 'Done'];
  const prioCls = (p) => (p === 'P0' ? 'p0' : p === 'P1' ? 'p1' : '');
  const curStory = () => (S.draft.stories || []).find((s) => s.id === S.sel);
  function assistBox(sec) {
    const a = ui.assist[sec] || {};
    return '<div class="assist" ' + (a.open ? '' : 'hidden') + '><div class="li"><input data-i="assist-prompt" data-k="' + sec + '" placeholder="Ask AI to improve this…" value="' + esc(a.prompt || '') + '"><button class="sm" data-a="assist" data-k="' + sec + '">Ask</button></div>' +
      (a.out ? '<div class="out">' + esc(a.out) + '</div>' : '') + '</div>';
  }
  const aiLink = (sec) => '<button class="sm" data-a="assist-toggle" data-k="' + sec + '">✨ AI assist</button>';
  function renderPanel() {
    const s = curStory();
    if (!s) return '<div class="card empty">Select a story.</div>';
    return '<div class="card panel"><div class="mono" style="color:var(--faint)">' + esc(s.id) + '</div>' +
      '<label class="fld">Title<input data-i="s-title" value="' + esc(s.title) + '"></label>' +
      '<div class="fields"><label class="fld">Status<select data-c="s-status">' + STATUSES.map((x) => '<option' + (x === s.status ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></label>' +
      '<label class="fld">Priority<select data-c="s-priority">' + PRIOS.map((x) => '<option' + (x === s.priority ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></label>' +
      '<label class="fld">Assignee<input data-i="s-assignee" value="' + esc(s.assignee) + '" placeholder="Unassigned"></label>' +
      '<label class="fld">Labels (comma-separated)<input data-i="s-labels" value="' + esc(s.labels.join(', ')) + '"></label></div>' +
      '<h3>Description ' + aiLink('description') + '</h3>' + assistBox('description') +
      '<textarea data-i="s-desc" rows="' + rows(s.description, 6) + '" placeholder="Markdown-ish description">' + esc(s.description) + '</textarea>' +
      '<h3>Acceptance criteria (' + s.acceptance_criteria.length + ') ' + aiLink('acceptance criteria') + '</h3>' + assistBox('acceptance criteria') +
      s.acceptance_criteria.map((a, i) => '<div class="li"><textarea data-i="s-ac" data-k="' + i + '" rows="' + rows(a, 2) + '">' + esc(a) + '</textarea>' +
        '<button class="sm" data-a="ac-up" data-k="' + i + '" title="Move up"' + (i ? '' : ' disabled') + '>↑</button><button class="sm" data-a="ac-down" data-k="' + i + '" title="Move down"' + (i < s.acceptance_criteria.length - 1 ? '' : ' disabled') + '>↓</button><button class="sm" data-a="ac-rm" data-k="' + i + '" title="Remove">✕</button></div>').join('') +
      '<button class="sm" data-a="ac-add">+ criterion</button>' +
      '<h3>Subtasks (' + s.subtasks.filter((t) => t.done).length + '/' + s.subtasks.length + ') <span>' + aiLink('subtasks') + ' <button class="sm" data-a="st-add">+ subtask</button></span></h3>' + assistBox('subtasks') +
      s.subtasks.map((t, i) => '<div class="li"><input type="checkbox" data-c="st-done" data-k="' + i + '"' + (t.done ? ' checked' : '') + '><input class="' + (t.done ? 'done' : '') + '" data-i="st-text" data-k="' + i + '" value="' + esc(t.text) + '"><button class="sm" data-a="st-rm" data-k="' + i + '" title="Remove">✕</button></div>').join('') + '</div>';
  }
  function renderStories() {
    const L = S.draft.stories || [];
    return '<h1>Stories</h1><p class="lead">Review and revise before anything goes to Jira. Edits stay in a draft until you press <b>Save all</b>.</p>' +
      '<div class="bar"><button class="primary" data-a="save-all">Save all</button><button class="ghost" data-a="csv-stories">Export CSV</button>' +
      (dirty('stories') ? '<span class="dirty">● unsaved changes</span>' : '') + '<span class="grow"></span><button class="ghost" data-a="to-plan">Test plan →</button></div>' +
      '<div class="split"><div class="list">' + L.map((s) => '<button class="story ' + (s.id === S.sel ? 'on' : '') + '" data-a="sel" data-k="' + esc(s.id) + '"><div class="row1"><span class="mono">' + esc(s.id) + '</span><span class="badge ' + prioCls(s.priority) + '">' + esc(s.priority) + '</span><span class="pill ' + s.status.split(' ')[0] + '">' + esc(s.status) + '</span></div>' +
        '<div class="t">' + esc(s.title) + '</div><div class="chips">' + s.labels.map((l) => '<span class="chip">' + esc(l) + '</span>').join('') + '<span class="chip">☑ ' + s.subtasks.filter((t) => t.done).length + '/' + s.subtasks.length + '</span></div></button>').join('') + '</div>' +
      renderPanel() + '</div>';
  }

  // ---------- 3. Test plan ----------
  const PLAN_LABELS = { objectives: 'Objectives', scope_in: 'Scope — in', scope_out: 'Scope — out', approach: 'Approach', entry_criteria: 'Entry criteria', exit_criteria: 'Exit criteria', risks: 'Risks' };
  function renderPlan() {
    const p = S.draft.plan;
    const head = '<h1>Test plan</h1><p class="lead">Generated from the saved stories. Edit any block; list sections take one item per line.</p>';
    const gen = '<button class="' + (p ? 'ghost' : 'primary') + '" data-a="gen-plan"' + (ui.busy ? ' disabled' : '') + '>' + (ui.busy ? 'Generating…' : (p ? 'Regenerate' : 'Generate test plan →')) + '</button>';
    if (!p) return head + '<div class="card empty">' + gen + '</div>' + (ui.error ? '<div class="err">' + esc(ui.error) + '</div>' : '');
    return head + '<div class="bar"><button class="primary" data-a="save-all">Save</button><button class="ghost" data-a="csv-plan">Export CSV</button>' + gen +
      (dirty('plan') ? '<span class="dirty">● unsaved changes</span>' : '') + '<span class="grow"></span><button class="ghost" data-a="to-cases">Test cases →</button></div>' +
      (ui.error ? '<div class="err">' + esc(ui.error) + '</div>' : '') +
      Object.keys(PLAN_LABELS).map((k) => { const v = Array.isArray(p[k]) ? p[k].join('\n') : (p[k] || ''); return '<div class="card plan-block"><h3>' + PLAN_LABELS[k] + (Array.isArray(p[k]) ? ' <span class="hint">one per line</span>' : '') + '</h3><textarea data-i="plan" data-k="' + k + '" rows="' + rows(v, 3) + '">' + esc(v) + '</textarea></div>'; }).join('');
  }

  // ---------- 4. Test cases ----------
  function renderCases() {
    const C = S.draft.cases;
    const head = '<h1>Test cases</h1><p class="lead">Traceable to requirements. Edit inline; steps take one per line.</p>';
    const gen = '<button class="' + (C ? 'ghost' : 'primary') + '" data-a="gen-cases"' + (ui.busy ? ' disabled' : '') + '>' + (ui.busy ? 'Generating…' : (C ? 'Regenerate' : 'Generate test cases →')) + '</button>';
    if (!C) return head + '<div class="card empty">' + gen + '</div>' + (ui.error ? '<div class="err">' + esc(ui.error) + '</div>' : '');
    return head + '<div class="bar"><button class="primary" data-a="save-all">Save</button><button class="ghost" data-a="csv-cases">Export CSV</button><button class="ghost" data-a="case-add">+ Add case</button>' + gen +
      (dirty('cases') ? '<span class="dirty">● unsaved changes</span>' : '') + '<span class="grow"></span><button class="ghost" data-a="to-run">Run →</button></div>' +
      (ui.error ? '<div class="err">' + esc(ui.error) + '</div>' : '') +
      '<table class="tbl"><thead><tr><th style="width:84px">ID</th><th style="width:90px">Req ref</th><th>Title</th><th>Steps</th><th>Expected result</th><th style="width:70px">Priority</th><th></th></tr></thead><tbody>' +
      C.map((c, i) => '<tr><td><input data-i="case" data-f="id" data-k="' + i + '" value="' + esc(c.id) + '"></td><td><input data-i="case" data-f="requirement_ref" data-k="' + i + '" value="' + esc(c.requirement_ref) + '"></td>' +
        '<td><textarea data-i="case" data-f="title" data-k="' + i + '" rows="' + rows(c.title, 3) + '">' + esc(c.title) + '</textarea></td>' +
        '<td><textarea data-i="case" data-f="steps" data-k="' + i + '" rows="' + rows(c.steps.join('\n'), 3) + '">' + esc(c.steps.join('\n')) + '</textarea></td>' +
        '<td><textarea data-i="case" data-f="expected" data-k="' + i + '" rows="' + rows(c.expected, 4) + '">' + esc(c.expected) + '</textarea></td>' +
        '<td><select data-c="case-prio" data-k="' + i + '">' + PRIOS.map((x) => '<option' + (x === c.priority ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></td>' +
        '<td><button class="sm" data-a="case-rm" data-k="' + i + '" title="Remove">✕</button></td></tr>').join('') + '</tbody></table>';
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
    return '<h1>Run</h1><p class="lead">Mark each test case as you execute it. Phase 1 is manual; automation comes later.</p>' +
      (anyDirty() ? '<div class="note">You have unsaved edits; this screen uses the last saved version.</div>' : '') + sampleBanner() +
      '<div class="bar"><label class="chk" style="margin:0"><input type="checkbox" data-c="sample"' + (S.sampleResults ? ' checked' : '') + '> Fill sample results <span class="sample-tag">DEMO</span> <span class="hint">(11 PASS / 2 FAIL / 2 BLOCKED with notes)</span></label><span class="grow"></span><button class="ghost" data-a="clear-results">Clear all results</button><button class="primary" data-a="to-report">Report →</button></div>' +
      '<div class="sum">' + ['PASS', 'FAIL', 'BLOCKED', 'NOT RUN'].map((k) => '<div class="stat"><b>' + c[k] + '</b><span>' + k + '</span></div>').join('') + '</div>' +
      '<div class="progress">' + ['PASS', 'FAIL', 'BLOCKED'].map((k) => '<i class="i-' + k + '" style="width:' + (100 * c[k] / n) + '%"></i>').join('') + '</div>' +
      '<div class="card" style="padding:0">' + S.cases.map((t) => {
        const r = S.results[t.id] || {};
        return '<div class="run"><span class="mono">' + esc(t.id) + '</span><span class="chip">' + esc(t.requirement_ref) + '</span><span>' + esc(t.title) + (r.sample ? ' <span class="sample-tag">SAMPLE</span>' : '') + '</span>' +
          '<div class="seg">' + ['PASS', 'FAIL', 'BLOCKED'].map((k) => '<button class="' + k + (r.status === k ? ' on' : '') + '" data-a="mark" data-k="' + esc(t.id) + '" data-v="' + k + '">' + k + '</button>').join('') + '</div>' +
          '<input class="note-in" data-i="note" data-k="' + esc(t.id) + '" placeholder="Evidence / notes" value="' + esc(r.note || '') + '"' + (r.status ? '' : ' disabled') + '></div>';
      }).join('') + '</div>';
  }

  // ---------- 6. Report ----------
  function reportModel() {
    const reqs = {};
    const add = (r) => (reqs[r] = reqs[r] || { id: r, stories: [], cases: [] });
    S.stories.forEach((s) => s.labels.filter((l) => /^REQ-/.test(l)).forEach((l) => add(l).stories.push(s)));
    S.cases.forEach((c) => String(c.requirement_ref).split(/[,\s]+/).filter(Boolean).forEach((r) => add(r).cases.push(c)));
    return Object.values(reqs).sort((a, b) => a.id.localeCompare(b.id)).map((r) => Object.assign(r, { verdict: ST.verdict(r.cases) }));
  }
  function renderReport() {
    const M = reportModel(), tally = {};
    M.forEach((r) => (tally[r.verdict] = (tally[r.verdict] || 0) + 1));
    return '<h1>Report</h1><p class="lead">Proof per requirement, rendered from saved stories, cases and run results.</p>' + sampleBanner() +
      '<div class="bar"><button class="primary" data-a="copy-summary">Copy summary</button><span class="hint">' + ['PROVEN', 'PARTIAL', 'FAILED', 'NOT RUN'].map((v) => (tally[v] || 0) + ' ' + v).join(' · ') + '</span></div>' +
      M.map((r) => '<div class="card req"><header><b class="mono">' + esc(r.id) + '</b><span class="v ' + r.verdict.replace(' ', '') + '">' + r.verdict + '</span><span>' + esc(r.stories.map((s) => s.id + ' ' + s.title).join(' · ') || 'No linked story') + '</span></header>' +
        '<ul>' + (r.cases.length ? r.cases.map((c) => { const x = S.results[c.id]; return '<li><span class="mono">' + esc(c.id) + '</span><span class="v ' + (x ? x.status : 'NOTRUN') + '" style="font-size:11.5px">' + (x ? x.status : 'NOT RUN') + '</span><span>' + esc(c.title) + (x && x.sample ? ' <span class="sample-tag">SAMPLE</span>' : '') + '</span>' + (x && x.note ? '<span class="ev">Evidence: ' + esc(x.note) + '</span>' : '') + '</li>'; }).join('') : '<li class="ev">No test cases linked to this requirement.</li>') + '</ul></div>').join('');
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
    app.innerHTML = SCREENS[S.step]();
    window.scrollTo(0, y);
    if (ui.focus) { const el = app.querySelector(ui.focus); if (el) el.focus(); ui.focus = null; }
    else if (keep) { const el = app.querySelector('[data-i="' + keep.i + '"]' + (keep.k != null ? '[data-k="' + keep.k + '"]' : '') + (keep.f ? '[data-f="' + keep.f + '"]' : '')); if (el) el.focus(); }
  }
  function go(i) { if (!ST.unlocked(i)) return; S.step = i; ST.save(); ui.error = ''; render(); window.scrollTo(0, 0); }

  // ---------- commit ----------
  function cleanDraft() {
    const D = S.draft;
    if (D.plan) ['scope_in', 'scope_out', 'entry_criteria', 'exit_criteria', 'risks'].forEach((k) => { D.plan[k] = (D.plan[k] || []).filter((x) => x.trim()); });
    if (D.stories) D.stories.forEach((s) => { s.acceptance_criteria = s.acceptance_criteria.filter((x) => x.trim()); s.subtasks = s.subtasks.filter((t) => t.text.trim()); });
    if (D.cases) D.cases.forEach((c) => { c.steps = c.steps.filter((x) => x.trim()); });
  }
  function saveAll() {
    cleanDraft();
    ['stories', 'plan', 'cases'].forEach((k) => { if (S.draft[k]) S[k] = ST.clone(S.draft[k]); });
    ST.save(); toast('Saved'); render();
  }

  // ---------- actions ----------
  const A = {
    'view-doc': (el) => openDocView(docRef(el.dataset.k), el.dataset.label),
    'add-extra': () => { S.docs.extras.push({ name: '', text: '' }); ST.save(); render(); },
    'rm-extra': (el) => { S.docs.extras.splice(+el.dataset.k, 1); ST.save(); render(); },
    'load-sample': () => {
      const live = !AI.getConfig().dryRun;
      const d = live ? window.SAMPLE.docsCondensed : window.SAMPLE.docs, sfx = live ? '-condensed' : '';
      S.docs.prd = { name: 'prd' + sfx + '.md (NPPES sample)', text: d.prd }; S.docs.design = { name: 'design' + sfx + '.md (NPPES sample)', text: d['design']  }; S.docs.api = { name: 'api-spec' + sfx + '.md (NPPES sample)', text: d['api-spec'] };
      ST.save(); render(); toast('NPPES sample loaded');
    },
    'gen-stories': () => guarded('stories', S.docs, 'Generate stories', (data) => {
      S.stories = data.map(ST.normStory); S.draft.stories = ST.clone(S.stories);
      S.plan = null; S.draft.plan = null; S.cases = []; S.draft.cases = null; S.results = {}; S.sampleResults = false;
      S.sel = S.stories[0] && S.stories[0].id; S.step = 1;
    }),
    'gen-plan': () => { if (anyDirty() && !confirm('Unsaved edits will not be used. Continue with last saved stories?')) return; return guarded('plan', S.stories, 'Generate test plan', (data) => { S.plan = data; S.draft.plan = ST.clone(data); S.cases = []; S.draft.cases = null; S.results = {}; S.sampleResults = false; }); },
    'gen-cases': () => guarded('cases', { plan: S.plan, stories: S.stories }, 'Generate test cases', (data) => { S.cases = data.map(ST.normCase); S.draft.cases = ST.clone(S.cases); S.results = {}; S.sampleResults = false; }),
    'save-all': saveAll,
    'csv-stories': () => { cleanDraft(); toast('Downloaded ' + CSV.download('stories', CSV.storiesToCsv(S.draft.stories))); },
    'csv-plan': () => { cleanDraft(); toast('Downloaded ' + CSV.download('test-plan', CSV.planToCsv(S.draft.plan))); },
    'csv-cases': () => { cleanDraft(); toast('Downloaded ' + CSV.download('test-cases', CSV.casesToCsv(S.draft.cases))); },
    'to-plan': () => go(2), 'to-cases': () => go(3), 'to-run': () => go(4), 'to-report': () => go(5),
    sel: (el) => { S.sel = el.dataset.k; ST.save(); render(); },
    'ac-add': () => { curStory().acceptance_criteria.push(''); ui.focus = '[data-i="s-ac"][data-k="' + (curStory().acceptance_criteria.length - 1) + '"]'; render(); },
    'ac-rm': (el) => { curStory().acceptance_criteria.splice(+el.dataset.k, 1); render(); },
    'ac-up': (el) => swap(curStory().acceptance_criteria, +el.dataset.k, -1),
    'ac-down': (el) => swap(curStory().acceptance_criteria, +el.dataset.k, 1),
    'st-add': () => { curStory().subtasks.push({ text: '', done: false }); ui.focus = '[data-i="st-text"][data-k="' + (curStory().subtasks.length - 1) + '"]'; render(); },
    'st-rm': (el) => { curStory().subtasks.splice(+el.dataset.k, 1); render(); },
    'assist-toggle': (el) => { const a = (ui.assist[el.dataset.k] = ui.assist[el.dataset.k] || {}); a.open = !a.open; ui.focus = '[data-i="assist-prompt"][data-k="' + el.dataset.k + '"]'; render(); },
    assist: async (el) => { const a = ui.assist[el.dataset.k]; a.out = 'Thinking…'; render(); a.out = await AI.assist(el.dataset.k, a.prompt); render(); },
    'case-add': () => { S.draft.cases.push({ id: 'TC-' + String(S.draft.cases.length + 1).padStart(3, '0'), requirement_ref: '', title: '', steps: [], expected: '', priority: 'P1' }); render(); },
    'case-rm': (el) => { S.draft.cases.splice(+el.dataset.k, 1); render(); },
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
  function swap(arr, i, d) { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; render(); }

  // ---------- inputs (no re-render; keeps focus) ----------
  let saveT;
  const I = {
    doc: (el) => { const d = docRef(el.dataset.k); d.text = el.value; const c = app.querySelector('[data-count="' + el.dataset.k + '"]'); c.textContent = el.value.length.toLocaleString() + ' chars · ~' + tok(el.value).toLocaleString() + ' tokens'; clearTimeout(saveT); saveT = setTimeout(() => { ST.save(); const b = app.querySelector('[data-a="gen-stories"]'); if (b) b.disabled = ui.busy || ![S.docs.prd, S.docs.design, S.docs.api].concat(S.docs.extras).some((x) => x.text.trim()); }, 300); },
    's-title': (el) => { curStory().title = el.value; },
    's-assignee': (el) => { curStory().assignee = el.value; },
    's-labels': (el) => { curStory().labels = el.value.split(',').map((x) => x.trim()).filter(Boolean); },
    's-desc': (el) => { curStory().description = el.value; },
    's-ac': (el) => { curStory().acceptance_criteria[+el.dataset.k] = el.value; },
    'st-text': (el) => { curStory().subtasks[+el.dataset.k].text = el.value; },
    'assist-prompt': (el) => { (ui.assist[el.dataset.k] = ui.assist[el.dataset.k] || {}).prompt = el.value; },
    plan: (el) => { const k = el.dataset.k; S.draft.plan[k] = Array.isArray(S.draft.plan[k]) ? el.value.split('\n') : el.value; },
    case: (el) => { const c = S.draft.cases[+el.dataset.k], f = el.dataset.f; c[f] = f === 'steps' ? el.value.split('\n') : el.value; },
    note: (el) => { const r = S.results[el.dataset.k]; if (r) { r.note = el.value; delete r.sample; clearTimeout(saveT); saveT = setTimeout(ST.save, 300); } },
  };
  const C = {
    's-status': (el) => { curStory().status = el.value; render(); },
    's-priority': (el) => { curStory().priority = el.value; render(); },
    'st-done': (el) => { curStory().subtasks[+el.dataset.k].done = el.checked; render(); },
    'case-prio': (el) => { S.draft.cases[+el.dataset.k].priority = el.value; },
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
  app.addEventListener('input', (e) => { const el = e.target.closest('[data-i]'); if (el && I[el.dataset.i]) I[el.dataset.i](el); });
  app.addEventListener('change', (e) => { const el = e.target.closest('[data-c]'); if (el && C[el.dataset.c]) C[el.dataset.c](el); });
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
  modelEl.onchange = () => { S.model = modelEl.value; AI.configure({ model: S.model }); ST.save(); render(); };
  const KEYSTORE = 'being-agile-session-key'; // sessionStorage only, opt-in; never localStorage
  const sess = (fn) => { try { return fn(sessionStorage); } catch (e) { return null; } };
  keyEl.oninput = () => { AI.configure({ apiKey: keyEl.value }); if (keepEl.checked) sess((s) => s.setItem(KEYSTORE, keyEl.value)); };
  keepEl.onchange = () => { sess((s) => (keepEl.checked ? s.setItem(KEYSTORE, keyEl.value) : s.removeItem(KEYSTORE))); };
  document.getElementById('btn-reset').onclick = async () => {
    if (!(await confirmBox('Reset demo?', '<p>This clears all saved documents, stories, plan, cases and results from this browser.</p>', 'Reset'))) return;
    S = ST.reset(); AI.loadUsage([]); ui.assist = {}; ui.error = ''; render(); toast('Demo reset');
  };

  // ---------- init ----------
  AI.configure({ model: S.model, dryRun: S.dryRun !== false });
  dryEl.checked = S.dryRun !== false;
  AI.loadUsage(S.usage);
  modelEl.value = S.model;
  const sk = sess((s) => s.getItem(KEYSTORE));
  if (sk) { keyEl.value = sk; keepEl.checked = true; AI.configure({ apiKey: sk }); }
  const start = () => { if (!S.sel && S.stories[0]) S.sel = S.stories[0].id; render(); };
  if (window.PinLock) window.PinLock.boot(start); else start();
})();
