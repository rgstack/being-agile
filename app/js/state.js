/* Central state store + localStorage persistence.
   Committed data (S.stories/plan/cases) only changes via "Save all"; in-progress edits live in S.draft.
   The API key is NEVER part of state and never reaches localStorage. */
(function () {
  'use strict';
  const KEY = 'being-agile-state-v1';
  const STEPS = ['Start', 'Clarify', 'Stories', 'Test plan', 'Test cases', 'Run', 'Report'];
  // Named stage indices. screens.js compares against these, never against literals,
  // so inserting a stage is one edit here plus the migration in load().
  const STEP = { start: 0, clarify: 1, stories: 2, plan: 3, cases: 4, run: 5, report: 6 };
  const VERSION = 2; // persisted-state schema: 2 = Clarify stage exists (v23+)
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ---------- Clarify: the delivery ledger ----------
  const LENSES = ['timeline', 'stakeholders', 'valueStream', 'businessArea'];
  const LENS_LABEL = { timeline: 'Timeline', stakeholders: 'Stakeholders', valueStream: 'Value stream', businessArea: 'Business area' };
  const LENS_STATUS = ['open', 'assumed', 'found', 'confirmed'];
  const SPRINTS_PER_PI = 6; // 5 delivery sprints + 1 innovation & planning sprint; one PI is about one quarter
  const lensFresh = (k) => ({ status: 'open', value: k === 'stakeholders' ? [] : k === 'timeline' ? null : '', source: '', cites: [] });
  const ledgerFresh = () => Object.fromEntries(LENSES.map((k) => [k, lensFresh(k)]));
  const clarifyFresh = () => ({
    v: 1,
    status: 'idle',          // 'idle' | 'reading' | 'open' | 'done'
    docsHash: '',            // djb2 of all doc texts at review time; mismatch => stale note
    brief: null,             // { summary, words, docs: [{ id, name, words }] }
    digest: '',              // AI-written delivery digest; carried in every turn instead of the full docs
    ledger: ledgerFresh(),
    questions: [],           // { id, lens, text, why, options[], default, status: 'open'|'answered'|'skipped', answer }
    turns: [],               // { id, kind: 'ask'|'say'|'you', text, qid, at, cost }
    cursor: null,            // id of the question currently posed; null when nothing is asked
    composer: '',            // draft text, persisted so a reload keeps it
    assumptions: [],         // derived at generate time; shown on the Stories page
  });
  // Defensive normalizer for persisted or model-supplied ledger rows.
  function normLens(k, l) {
    const f = lensFresh(k);
    if (!l || typeof l !== 'object') return f;
    const status = LENS_STATUS.indexOf(l.status) !== -1 ? l.status : 'open';
    let value = l.value;
    if (k === 'stakeholders') value = Array.isArray(value) ? value.map((p) => (typeof p === 'string' ? { name: p, role: '', needs: '' } : { name: String(p && p.name || ''), role: String(p && p.role || ''), needs: String(p && p.needs || '') })).filter((p) => p.name) : [];
    else if (k === 'timeline') value = value && typeof value === 'object' ? { sprints: num(value.sprints), pis: num(value.pis), quarters: num(value.quarters), note: String(value.note || '') } : (typeof value === 'string' && value.trim() ? parseLens('timeline', value, null) : null);
    else value = typeof value === 'string' ? value : value == null ? '' : planItemText(value);
    const cites = Array.isArray(l.cites) ? l.cites.map((c) => (typeof c === 'string' ? { doc: '', heading: c } : { doc: String(c && c.doc || ''), heading: String(c && c.heading || '') })).filter((c) => c.doc || c.heading) : [];
    return { status, value, source: String(l.source || ''), cites };
  }
  const num = (v) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : null);
  function normQuestion(q, i) {
    if (!q || typeof q !== 'object') return null;
    const text = planItemText(q.text || q.question || '');
    if (!text.trim()) return null;
    return {
      id: String(q.id || 'Q' + (i + 1)), lens: LENSES.indexOf(q.lens) !== -1 ? q.lens : 'timeline', text,
      why: planItemText(q.why || q.reason || ''), options: (Array.isArray(q.options) ? q.options : []).map(planItemText).filter(Boolean).slice(0, 5),
      default: planItemText(q.default || ''), status: q.status === 'answered' || q.status === 'skipped' ? q.status : 'open', answer: planItemText(q.answer || ''),
    };
  }
  function normClarify(c) {
    const f = clarifyFresh();
    if (!c || typeof c !== 'object') return f;
    const o = Object.assign(f, c);
    o.status = ['idle', 'reading', 'open', 'done'].indexOf(o.status) !== -1 ? o.status : 'idle';
    if (o.status === 'reading') o.status = 'idle'; // a reload mid-review: the call is gone, start over
    o.ledger = Object.fromEntries(LENSES.map((k) => [k, normLens(k, o.ledger && o.ledger[k])]));
    o.questions = (Array.isArray(o.questions) ? o.questions : []).map(normQuestion).filter(Boolean);
    o.turns = Array.isArray(o.turns) ? o.turns.filter((t) => t && typeof t === 'object') : [];
    o.assumptions = Array.isArray(o.assumptions) ? o.assumptions.map(planItemText).filter(Boolean) : [];
    if (o.cursor && !o.questions.some((q) => q.id === o.cursor)) o.cursor = null;
    o.composer = typeof o.composer === 'string' ? o.composer : '';
    o.digest = typeof o.digest === 'string' ? o.digest : '';
    return o;
  }
  // The timeline reads as sprints -> PIs -> quarters (rule 7). Fill what the other units imply.
  function timelineFill(t) {
    const o = { sprints: num(t && t.sprints), pis: num(t && t.pis), quarters: num(t && t.quarters), note: String(t && t.note || '') };
    if (o.sprints == null && o.pis != null) o.sprints = o.pis * SPRINTS_PER_PI;
    if (o.sprints == null && o.quarters != null) o.sprints = o.quarters * SPRINTS_PER_PI;
    if (o.pis == null && o.sprints != null) o.pis = Math.ceil(o.sprints / SPRINTS_PER_PI);
    if (o.quarters == null && o.pis != null) o.quarters = o.pis;
    return o;
  }
  // One line of text for a ledger value, used by the ledger, the sidebar and the stories prompt.
  function lensText(k, v) {
    if (k === 'timeline') {
      if (!v) return '';
      const t = timelineFill(v), parts = [];
      if (t.sprints != null) parts.push(t.sprints + ' sprint' + (t.sprints === 1 ? '' : 's'));
      if (t.pis != null) parts.push(t.pis + ' PI' + (t.pis === 1 ? '' : 's'));
      if (t.quarters != null) parts.push(t.quarters + ' quarter' + (t.quarters === 1 ? '' : 's'));
      return parts.join(' ≈ ') + (t.note ? (parts.length ? ' · ' : '') + t.note : '');
    }
    if (k === 'stakeholders') return (v || []).map((p) => p.name + (p.role ? ' (' + p.role + ')' : '')).join(', ');
    return v || '';
  }
  // Parse what a person typed into a ledger value. Timeline: "12 sprints", "2 PIs", "one quarter"; stakeholders: one per line or comma-separated.
  const WORDN = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
  function parseLens(k, text, prev) {
    const s = String(text || '').trim();
    if (k === 'timeline') {
      const grab = (re) => { const m = re.exec(s); return m ? (WORDN[m[1].toLowerCase()] || +m[1]) : null; };
      const sprints = grab(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s*(?:two-week\s*)?sprints?\b/i);
      const pis = grab(/\b(\d+|one|two|three|four|five|six)\s*(?:PIs?|program increments?)\b/i);
      const quarters = grab(/\b(\d+|one|two|three|four)\s*quarters?\b/i);
      const weeks = grab(/\b(\d+)\s*weeks?\b/i);
      const base = prev && typeof prev === 'object' ? prev : {};
      if (sprints == null && pis == null && quarters == null && weeks == null) return timelineFill(Object.assign({}, base, { note: s }));
      return timelineFill({ sprints: sprints != null ? sprints : weeks != null ? Math.ceil(weeks / 2) : null, pis, quarters, note: /\b(sprints?|PIs?|quarters?|weeks?)\b/i.test(s) && s.length > 24 ? s : '' });
    }
    if (k === 'stakeholders') return s.split(/\n|,|;|\band\b/).map((x) => x.trim()).filter(Boolean).map((x) => { const m = /^(.+?)\s*[(—:-]\s*(.+?)\)?$/.exec(x); return m ? { name: m[1].trim(), role: m[2].trim(), needs: '' } : { name: x, role: '', needs: '' }; });
    return s;
  }
  function ledgerTally(ledger) {
    const t = { open: 0, assumed: 0, found: 0, confirmed: 0 };
    LENSES.forEach((k) => { const st = ledger && ledger[k] && ledger[k].status; t[LENS_STATUS.indexOf(st) !== -1 ? st : 'open']++; });
    return t;
  }
  // What stories will carry as stated assumptions: every lens still assumed or open, and every question not answered.
  function openAssumptions(c) {
    const out = [];
    if (!c || !c.ledger) return out;
    LENSES.forEach((k) => {
      const l = c.ledger[k];
      if (l.status === 'assumed') out.push('Assumes ' + LENS_LABEL[k].toLowerCase() + ': ' + (lensText(k, l.value) || 'not stated'));
      else if (l.status === 'open') out.push(LENS_LABEL[k] + ' not stated in the documents; stories do not assume one.');
    });
    // a skipped question whose lens you later confirmed by hand is moot; the rest are carried as open
    (c.questions || []).forEach((q) => { if (q.status !== 'answered' && !(c.ledger[q.lens] && c.ledger[q.lens].status === 'confirmed')) out.push('Open question (' + q.id + '): ' + q.text); });
    return out;
  }
  // djb2 over the document texts: cheap, deterministic, good enough to notice an edit.
  function docsHash(docs) {
    const texts = docs ? [docs.prd, docs.design, docs.api].concat(docs.extras || []).map((d) => (d && d.text) || '') : [];
    let h = 5381;
    const s = texts.join('\u0001');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + s.length.toString(36);
  }
  const hasDocs = (docs) => [docs.prd, docs.design, docs.api].concat(docs.extras || []).some((x) => x && x.text && x.text.trim());

  const fresh = () => ({
    v: VERSION,
    step: STEP.start,
    docs: { prd: { name: '', text: '' }, design: { name: '', text: '' }, api: { name: '', text: '' }, extras: [] },
    clarify: clarifyFresh(),
    delivery: null,         // { sprints, pis, quarters, basis, assumptions[] } from the last stories generation
    stories: [], plan: null, cases: [],
    results: {},            // caseId -> {status: PASS|FAIL|BLOCKED, note, sample?}
    sampleResults: false,
    sel: null,              // selected story id
    model: 'gpt-4o-mini',
    dryRun: true,
    endpoint: '',           // '' = default OpenAI endpoint; otherwise a proxy chat-completions URL
    usage: [],
  });

  let S = fresh();
  S.draft = { stories: null, plan: null, cases: null };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        S = Object.assign(fresh(), saved);
        // One-time migration from v22 and earlier: Clarify did not exist, so every stage after Start moved up by one.
        if (!saved.v || saved.v < 2) { S.clarify = clarifyFresh(); if (S.step >= 1) S.step += 1; S.v = VERSION; }
      }
    } catch (e) { S = fresh(); }
    S.clarify = normClarify(S.clarify);
    if (S.delivery && typeof S.delivery !== 'object') S.delivery = null;
    S.draft = { stories: S.stories.length ? clone(S.stories) : null, plan: S.plan ? clone(S.plan) : null, cases: S.cases.length ? clone(S.cases) : null };
    return S;
  }
  function save() {
    const { draft, ...rest } = S;
    try { localStorage.setItem(KEY, JSON.stringify(rest)); } catch (e) { /* quota: ignore */ }
  }
  function reset() {
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    S = fresh(); S.draft = { stories: null, plan: null, cases: null };
    return S;
  }

  const STATUS_MAP = { backlog: 'To Do', 'ready-for-dev': 'To Do', todo: 'To Do', 'to do': 'To Do', 'in-progress': 'In Progress', 'in progress': 'In Progress', done: 'Done' };
  const POINTS = [1, 2, 3, 5, 8]; // Fibonacci, 8 is the ceiling (rule 8.2)
  const normPoints = (p) => { const n = +p; if (!Number.isFinite(n) || n <= 0) return null; return POINTS.reduce((best, x) => (Math.abs(x - n) < Math.abs(best - n) ? x : best), POINTS[0]); };
  function normStory(s) {
    return {
      id: s.id, title: s.title || '', description: s.description || '',
      acceptance_criteria: (s.acceptance_criteria || []).map(planItemText),
      subtasks: (s.subtasks || []).map((t) => (typeof t === 'string' ? { text: t, done: false } : { text: planItemText(t.text), done: !!t.done })),
      priority: s.priority || 'P2', labels: (s.labels || []).slice(),
      status: STATUS_MAP[String(s.status || '').toLowerCase()] || s.status || 'To Do',
      assignee: s.assignee || '',
      points: normPoints(s.points != null ? s.points : s.story_points),
      size_rationale: planItemText(s.size_rationale || s.sizing || ''),
      assumptions: (Array.isArray(s.assumptions) ? s.assumptions : typeof s.assumptions === 'string' ? s.assumptions.split('\n') : []).map(planItemText).map((t) => t.trim()).filter(Boolean),
      sprint: Number.isFinite(+s.sprint) && +s.sprint > 0 ? +s.sprint : null,
    };
  }
  const normCase = (c) => ({
    id: c.id, requirement_ref: c.requirement_ref || c.requirement || '', title: c.title || '',
    steps: (c.steps || []).map(planItemText), expected: planItemText(c.expected), priority: c.priority || 'P1',
  });
  // The model sometimes nests objects inside the plan's list fields; without
  // coercion the UI renders "[object Object]". Normalize to plain strings.
  const PLAN_TEXT_KEYS = ['objectives', 'approach'];
  const PLAN_LIST_KEYS = ['scope_in', 'scope_out', 'entry_criteria', 'exit_criteria', 'risks'];
  function planItemText(x) {
    if (typeof x === 'string') return x;
    if (x && typeof x === 'object') return x.text || x.item || x.title || x.name || x.description || x.criterion || x.step || JSON.stringify(x);
    return x == null ? '' : String(x);
  }
  function normPlan(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return p;
    const o = {};
    PLAN_TEXT_KEYS.forEach((k) => { o[k] = typeof p[k] === 'string' ? p[k] : (Array.isArray(p[k]) ? p[k].map(planItemText).join('\n') : planItemText(p[k])); });
    PLAN_LIST_KEYS.forEach((k) => { o[k] = Array.isArray(p[k]) ? p[k].map(planItemText).map((t) => t.trim()).filter(Boolean) : (typeof p[k] === 'string' ? p[k].split('\n').map((t) => t.trim()).filter(Boolean) : []); });
    return o;
  }
  // Derived timeline from the stories' points (rule 8.4). pointsPerSprint unknown => stated assumption.
  function normDelivery(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    const o = { sprints: num(d.sprints), pis: num(d.pis), quarters: num(d.quarters), points_per_sprint: num(d.points_per_sprint || d.capacity || d.velocity), basis: planItemText(d.basis || ''), assumptions: (Array.isArray(d.assumptions) ? d.assumptions : []).map(planItemText).map((t) => t.trim()).filter(Boolean) };
    const t = timelineFill(o); o.sprints = t.sprints; o.pis = t.pis; o.quarters = t.quarters;
    return o;
  }

  // Stage gates. Clarify opens as soon as any document has text; Stories still needs stories to exist (Clarify never gates it).
  const unlocked = (i) => i === STEP.start || (i === STEP.clarify && hasDocs(S.docs)) ||
    ((i === STEP.stories || i === STEP.plan) && S.stories.length > 0) ||
    (i === STEP.cases && !!S.plan) || ((i === STEP.run || i === STEP.report) && S.cases.length > 0);

  // Verdict for one requirement from its linked cases' results.
  function verdict(cases) {
    const rs = cases.map((c) => (S.results[c.id] || {}).status).filter(Boolean);
    if (!cases.length || !rs.length) return 'NOT RUN';
    if (rs.includes('FAIL')) return 'FAILED';
    if (rs.length === cases.length && rs.every((r) => r === 'PASS')) return 'PROVEN';
    return 'PARTIAL';
  }

  // Sample results: 11 PASS / 2 FAIL / 2 BLOCKED against the bundled 15 cases.
  const SAMPLE_RESULTS = {
    'TC-009': ['FAIL', 'Batch of 500 rows: formula-injection cell "=HYPERLINK(...)" was exported unescaped in the results CSV. Defect filed (Sev-2).'],
    'TC-011': ['FAIL', 'After 3 retries the UI showed "No results" on a simulated 503 instead of an upstream-unavailable message.'],
    'TC-013': ['BLOCKED', 'Needs 2-replica staging environment with shared Redis; environment not yet provisioned.'],
    'TC-014': ['BLOCKED', 'Blocked on Postgres role setup for the immutable-evidence privilege test.'],
  };
  function setSampleResults(on) {
    if (on) {
      S.cases.forEach((c, i) => {
        if (S.results[c.id] && !S.results[c.id].sample) return; // keep manual marks
        const r = SAMPLE_RESULTS[c.id];
        S.results[c.id] = { status: r ? r[0] : 'PASS', note: r ? r[1] : 'Sample: passed with evidence retained.', sample: true };
      });
    } else {
      Object.keys(S.results).forEach((k) => { if (S.results[k].sample) delete S.results[k]; });
    }
    S.sampleResults = on;
  }

  window.State = {
    STEPS, STEP, LENSES, LENS_LABEL, LENS_STATUS, SPRINTS_PER_PI, POINTS,
    clone, load, save, reset, normStory, normCase, normPlan, normDelivery, unlocked, verdict, setSampleResults, hasDocs,
    clarifyFresh, normClarify, normLens, normQuestion, lensText, parseLens, timelineFill, ledgerTally, openAssumptions, docsHash, planItemText,
    get: () => S,
  };
})();
