/* Central state store + localStorage persistence.
   Committed data (S.stories/plan/cases) only changes via "Save all"; in-progress edits live in S.draft.
   The API key is NEVER part of state and never reaches localStorage. */
(function () {
  'use strict';
  const KEY = 'being-agile-state-v1';
  const STEPS = ['Start', 'Stories', 'Test plan', 'Test cases', 'Run', 'Report'];
  const clone = (o) => JSON.parse(JSON.stringify(o));

  const fresh = () => ({
    step: 0,
    docs: { prd: { name: '', text: '' }, design: { name: '', text: '' }, api: { name: '', text: '' }, extras: [] },
    stories: [], plan: null, cases: [],
    results: {},            // caseId -> {status: PASS|FAIL|BLOCKED, note, sample?}
    sampleResults: false,
    sel: null,              // selected story id
    model: 'gpt-4o-mini',
    dryRun: true,
    usage: [],
  });

  let S = fresh();
  S.draft = { stories: null, plan: null, cases: null };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) S = Object.assign(fresh(), JSON.parse(raw));
    } catch (e) { S = fresh(); }
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
  function normStory(s) {
    return {
      id: s.id, title: s.title || '', description: s.description || '',
      acceptance_criteria: (s.acceptance_criteria || []).slice(),
      subtasks: (s.subtasks || []).map((t) => (typeof t === 'string' ? { text: t, done: false } : { text: t.text, done: !!t.done })),
      priority: s.priority || 'P2', labels: (s.labels || []).slice(),
      status: STATUS_MAP[String(s.status || '').toLowerCase()] || s.status || 'To Do',
      assignee: s.assignee || '',
    };
  }
  const normCase = (c) => ({
    id: c.id, requirement_ref: c.requirement_ref || c.requirement || '', title: c.title || '',
    steps: (c.steps || []).slice(), expected: c.expected || '', priority: c.priority || 'P1',
  });

  const unlocked = (i) => i === 0 || (i === 1 && S.stories.length > 0) || (i === 2 && S.stories.length > 0) ||
    (i === 3 && !!S.plan) || ((i === 4 || i === 5) && S.cases.length > 0);

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
    STEPS, clone, load, save, reset, normStory, normCase, unlocked, verdict, setSampleResults,
    get: () => S,
  };
})();
