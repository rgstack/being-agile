/* OpenAI adapter — BYOK, token budgets, usage metering, dry-run + live JSON-mode path.
   Dry-run (default): bundled sample output, zero network. Live (dryRun off): liveCall() POSTs one
   chat-completions request (response_format json_object, output capped by BUDGETS) to cfg.endpoint
   (api.openai.com by default, or a corporate proxy that injects auth — then the key is optional),
   parses the JSON reply and records the REAL usage from the response into metering.
   liveCall is the only network code in the app. The API key lives only in this closure and is
   never logged or committed. */
(function () {
  'use strict';

  // Estimates only — USD per 1M tokens. Phase 2 should refresh these from the vendor price page.
  const PRICING = {
    'gpt-4o-mini': { in: 0.15, out: 0.60 },
    'gpt-4o':      { in: 2.50, out: 10.00 },
    'o3-mini':     { in: 1.10, out: 4.40 },
  };
  const MODELS = Object.keys(PRICING);

  // Hard per-operation caps (tokens).
  const BUDGETS = {
    stories: { in: 6000, out: 4000 },
    plan:    { in: 4000, out: 3000 },
    cases:   { in: 6000, out: 4000 },
  };

  const PROMPTS = {
    stories: 'You are a senior product analyst. Given the PRD, design doc, API spec and supporting docs, produce substantial Jira stories as JSON: [{id, title, description, acceptance_criteria[7-8 items], subtasks[6 items], priority, labels}]. Cover every requirement. No prose outside the JSON.\n\nWrite every story against these rules:\n- INVEST: each story is Independent (buildable and testable on its own), Negotiable (detail open to conversation, not fixed like a contract), Valuable (a user or the business notices when it ships), Estimable (sizable without guessing), Small (fits comfortably inside one iteration), Testable (a clear pass/fail check proves it done).\n- Definition of Ready: the description states who wants what and why (As a... I want... so that...); acceptance criteria are written one per line and each is verifiable; the requirement(s) it covers are linked in labels as REQ-nnn; dependencies and open questions are named; priority is set.\n- Description follows As a / I want / So that. Acceptance criteria: 7-8 items, each a single verifiable check, demonstrated rather than asserted.',
    plan: 'Given the stories, produce a test plan as JSON: {objectives, scope_in, scope_out, approach, entry_criteria[], exit_criteria[], risks[]}.',
    cases: 'Given the test plan and stories, produce test cases as JSON: [{id, requirement_ref, title, steps[], expected, priority}]. Cover all requirements. No prose outside the JSON.\n\nWrite every case against these rules:\n- One objective per case; the title says what it proves.\n- Preconditions stated: role, data, environment and configuration are named, not assumed.\n- Steps are clear and numbered; each step is a single action someone else could repeat exactly.\n- Expected result is unambiguous: specific values, codes and messages, so any two reviewers reach the same pass or fail.\n- Every case carries the REQ-nnn it proves in requirement_ref, so each requirement ends with a verdict.',
  };

  const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
  let cfg = { apiKey: '', model: 'gpt-4o-mini', dryRun: true, endpoint: DEFAULT_ENDPOINT };
  const calls = [];
  const listeners = [];

  class BudgetError extends Error {}

  function configure(o) {
    o = o || {};
    if (typeof o.apiKey === 'string') cfg.apiKey = o.apiKey;
    if (o.model && PRICING[o.model]) cfg.model = o.model;
    if (typeof o.dryRun === 'boolean') cfg.dryRun = o.dryRun;
    if (typeof o.endpoint === 'string') cfg.endpoint = o.endpoint || DEFAULT_ENDPOINT;
  }
  const getConfig = () => ({ model: cfg.model, dryRun: cfg.dryRun, hasKey: !!cfg.apiKey, endpoint: cfg.endpoint, isCustom: cfg.endpoint !== DEFAULT_ENDPOINT }); // never exposes the key
  const hostOf = (u) => { try { return new URL(u).hostname; } catch (e) { return u; } };

  const estTokens = (v) => Math.ceil((typeof v === 'string' ? v : JSON.stringify(v) || '').length / 4);
  const usd = (model, pt, ct) => {
    const p = PRICING[model] || PRICING['gpt-4o-mini'];
    return (pt * p.in + ct * p.out) / 1e6;
  };

  // Flatten the docs object ({prd, design, api, extras[]}) to the text the prompt would carry.
  function docsText(docs) {
    const parts = [];
    [['PRD', 'prd'], ['DESIGN DOC', 'design'], ['API SPEC', 'api']].forEach(([label, k]) => {
      if (docs && docs[k] && docs[k].text) parts.push('# ' + label + '\n' + docs[k].text);
    });
    ((docs && docs.extras) || []).forEach((d, i) => { if (d.text) parts.push('# SUPPORTING DOC ' + (i + 1) + (d.name ? ' (' + d.name + ')' : '') + '\n' + d.text); });
    return parts.join('\n\n');
  }
  function inputFor(op, input) {
    if (op === 'stories') return docsText(input);
    return JSON.stringify(input);
  }
  function simulated(op) {
    const S = window.SAMPLE;
    return op === 'stories' ? S.stories : op === 'plan' ? S.plan : S.cases;
  }

  function estimateCall(op, input) {
    const b = BUDGETS[op];
    if (!b) throw new Error('Unknown operation: ' + op);
    const inTok = estTokens(PROMPTS[op]) + estTokens(inputFor(op, input));
    const outTok = Math.min(b.out, estTokens(simulated(op)));
    return {
      operation: op, model: cfg.model, tokens: inTok + outTok, inputTokens: inTok, outputTokens: outTok,
      usd: usd(cfg.model, inTok, outTok), capIn: b.in, capOut: b.out, overCap: inTok > b.in,
      endpoint: cfg.endpoint, endpointHost: hostOf(cfg.endpoint),
    };
  }

  function checkBudget(op, est) {
    if (!est.overCap) return null;
    const msg = 'Estimated input (~' + est.inputTokens.toLocaleString() + ' tokens) exceeds the ' + op +
      ' budget of ' + est.capIn.toLocaleString() + ' input tokens. Trim or condense the inputs.';
    if (cfg.dryRun) return msg + ' (Dry-run: continuing because nothing is sent; a live call would abort here.)';
    throw new BudgetError(msg);
  }

  // LIVE: one JSON-mode chat completion. Returns {data, pt, ct} with real usage from the API.
  async function liveCall(op, input) {
    if (!cfg.apiKey && cfg.endpoint === DEFAULT_ENDPOINT) throw new Error('No API key. Enter your OpenAI API key in Settings (gear icon).');
    const body = {
      model: cfg.model,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: PROMPTS[op] }, { role: 'user', content: inputFor(op, input) }],
    };
    body[cfg.model.indexOf('o3') === 0 ? 'max_completion_tokens' : 'max_tokens'] = BUDGETS[op].out;
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey; // custom proxy without a key injects auth itself
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 120000);
    let res;
    try {
      res = await fetch(cfg.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('Request timed out after 120s.');
      throw new Error('Network error: ' + ((e && e.message) || e));
    } finally { clearTimeout(timer); }
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = (j && j.error && j.error.message) || ''; } catch (e) { /* no JSON body */ }
      if (res.status === 401) throw new Error('401 Unauthorized — check your API key in Settings.');
      if (res.status === 403) throw new Error('403 Forbidden — ' + (detail || 'your key may lack access to this model or project.'));
      if (res.status === 429) throw new Error('429 Rate limited — wait a moment and retry.');
      throw new Error('API error ' + res.status + ': ' + (detail || res.statusText || 'unknown'));
    }
    let json, data;
    try {
      json = await res.json();
      data = JSON.parse(json.choices[0].message.content);
    } catch (e) { throw new Error('Model did not return valid JSON. Retry or use dry-run.'); }
    const u = json.usage || {};
    return { data, pt: u.prompt_tokens || 0, ct: u.completion_tokens || 0 };
  }

  async function run(op, input) {
    const est = estimateCall(op, input);
    const warning = checkBudget(op, est);
    let data, pt, ct;
    if (cfg.dryRun) {
      // DRY-RUN: bundled sample output, zero network.
      await new Promise((r) => setTimeout(r, 450));
      data = JSON.parse(JSON.stringify(simulated(op)));
      pt = est.inputTokens; ct = est.outputTokens;
    } else {
      ({ data, pt, ct } = await liveCall(op, input));
    }
    const rec = { operation: op, model: cfg.model, prompt_tokens: pt, completion_tokens: ct, est_usd: usd(cfg.model, pt, ct), at: Date.now(), dry_run: cfg.dryRun };
    calls.push(rec);
    listeners.forEach((f) => f(getUsage()));
    return { data, usage: { prompt_tokens: pt, completion_tokens: ct, model: cfg.model }, warning };
  }

  const generateStories = (docs) => run('stories', docs);
  const generateTestPlan = (stories) => run('plan', stories);
  const generateTestCases = (plan, stories) => run('cases', { plan, stories });

  // Canned per-item "AI assist" (dry-run only; no network).
  async function assist(kind, prompt) {
    await new Promise((r) => setTimeout(r, 250));
    const p = (prompt || '').trim();
    return 'Dry-run suggestion' + (p ? ' for "' + p.slice(0, 60) + '"' : '') + ': make the ' + kind +
      ' observable and testable — name the actor, the trigger and the exact system response, and add one negative case. (Canned note; no AI call was made.)';
  }

  function getUsage() {
    const total = calls.reduce((t, c) => ({
      prompt_tokens: t.prompt_tokens + c.prompt_tokens,
      completion_tokens: t.completion_tokens + c.completion_tokens,
      est_usd: t.est_usd + c.est_usd,
    }), { prompt_tokens: 0, completion_tokens: 0, est_usd: 0 });
    return { calls: calls.slice(), total };
  }
  const loadUsage = (saved) => { calls.length = 0; (saved || []).forEach((c) => calls.push(c)); };
  const onUsage = (f) => listeners.push(f);

  window.OpenAI = { DEFAULT_ENDPOINT, PRICING, MODELS, BUDGETS, PROMPTS, BudgetError, configure, getConfig, estimateCall, generateStories, generateTestPlan, generateTestCases, assist, getUsage, loadUsage, onUsage };
})();
