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

  // Per-operation caps (tokens). Raised for testing Oct 6 2026: input guard at
  // 50K so large PRD/spec bundles go through; output at 16K = the max the
  // GPT-4o family accepts (the API rejects max_tokens above the model's limit,
  // so output cannot be uncapped the way input can).
  const BUDGETS = {
    stories: { in: 50000, out: 16000 },
    plan:    { in: 50000, out: 16000 },
    cases:   { in: 50000, out: 16000 },
    assist:  { in: 50000, out: 16000 },
  };

  const PROMPTS = {
    stories: 'You are a senior product analyst. Given the PRD, design doc, API spec and supporting docs, produce substantial Jira stories as a JSON object: {"stories": [{id, title, description, acceptance_criteria[7-8 items], subtasks[6 items], priority, labels}]}. Cover every requirement. No prose outside the JSON.\n\nWrite every story against these rules:\n- INVEST: each story is Independent (buildable and testable on its own), Negotiable (detail open to conversation, not fixed like a contract), Valuable (a user or the business notices when it ships), Estimable (sizable without guessing), Small (fits comfortably inside one iteration), Testable (a clear pass/fail check proves it done).\n- Definition of Ready: the description states who wants what and why (As a... I want... so that...); acceptance criteria are written one per line and each is verifiable; the requirement(s) it covers are linked in labels as REQ-nnn; dependencies and open questions are named; priority is set.\n- Description follows As a / I want / So that. Acceptance criteria: 7-8 items, each a single verifiable check, demonstrated rather than asserted.',
    plan: 'Given the stories, produce a test plan as JSON: {objectives, scope_in, scope_out, approach, entry_criteria[], exit_criteria[], risks[]}.',
    cases: 'Given the test plan and stories, produce test cases as a JSON object: {"test_cases": [{id, requirement_ref, title, steps[], expected, priority}]}. Cover all requirements. No prose outside the JSON.\n\nWrite every case against these rules:\n- One objective per case; the title says what it proves.\n- Preconditions stated: role, data, environment and configuration are named, not assumed.\n- Steps are clear and numbered; each step is a single action someone else could repeat exactly.\n- Expected result is unambiguous: specific values, codes and messages, so any two reviewers reach the same pass or fail.\n- Every case carries the REQ-nnn it proves in requirement_ref, so each requirement ends with a verdict.',
    assist: 'You are a senior product analyst and test strategist. The user is drafting a Jira story, a test plan, or a test case and asks for help improving one item. You receive the item kind, its current text, and their request. Reply in concise markdown with specific, actionable suggestions grounded in the item\'s actual content. Judge it against INVEST (for stories), the Definition of Ready, and the test-case quality rules (one objective, stated preconditions, repeatable numbered steps, unambiguous expected result, REQ-nnn traceability) wherever they apply. If the request asks for a rewrite or an improved version, include it in a fenced code block after the suggestions. Be concrete — quote the weak lines and show the fix.',
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
  // Defensive: browser/autofill managers may fill #set-key without firing input events.
  // At call time, fall back to the field's live value so a visibly-filled key is never ignored.
  const domKey = () => { try { const el = document.getElementById('set-key'); return (el && el.value ? el.value : '').trim(); } catch (e) { return ''; } };
  const effKey = () => cfg.apiKey || domKey();
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

  // Shared POST: the only network code in the app. Returns the parsed JSON body.
  async function postChat(body) {
    const headers = { 'Content-Type': 'application/json' };
    const k = effKey(); if (k) headers.Authorization = 'Bearer ' + k; // custom proxy without a key injects auth itself
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
    return res.json();
  }

  // LIVE: one JSON-mode chat completion. Returns {data, pt, ct} with real usage from the API.
  async function liveCall(op, input) {
    if (!effKey() && cfg.endpoint === DEFAULT_ENDPOINT) throw new Error('No API key. Enter your OpenAI API key in Settings (gear icon).');
    const body = {
      model: cfg.model,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: PROMPTS[op] }, { role: 'user', content: inputFor(op, input) }],
    };
    body[cfg.model.indexOf('o3') === 0 ? 'max_completion_tokens' : 'max_tokens'] = BUDGETS[op].out;
    const json = await postChat(body);
    let data;
    try {
      data = JSON.parse(json.choices[0].message.content);
    } catch (e) { throw new Error('Model did not return valid JSON. Retry or use dry-run.'); }
    const u = json.usage || {};
    return { data, pt: u.prompt_tokens || 0, ct: u.completion_tokens || 0 };
  }

  // json_object mode forces the model to return a JSON object, so the prompts above
  // ask for {"stories":[...]} / {"test_cases":[...]}. Normalize defensively anyway:
  // accept a bare array (dry-run samples) or any single-key object holding the array.
  function extractArray(op, data) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      const KEYS = { stories: ['stories', 'user_stories', 'jira_stories'], cases: ['test_cases', 'cases', 'tests'] };
      for (const k of (KEYS[op] || [])) if (Array.isArray(data[k])) return data[k];
      const vals = Object.values(data);
      if (vals.length === 1 && Array.isArray(vals[0])) return vals[0];
    }
    throw new Error('Model returned an unexpected shape for ' + op + ' (expected a JSON array). Retry — or switch to dry-run.');
  }

  // The plan prompt asks for a bare object, which matches json_object mode — but the
  // model may still wrap it ({"plan": {...}}). Unwrap the same defensive way.
  function extractPlan(data) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (data.objectives || data.scope_in || data.scope) return data;
      const vals = Object.values(data);
      if (vals.length === 1 && vals[0] && typeof vals[0] === 'object' && !Array.isArray(vals[0])) return vals[0];
    }
    return data;
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
    if (op === 'stories' || op === 'cases') data = extractArray(op, data);
    if (op === 'plan') data = extractPlan(data);
    const rec = { operation: op, model: cfg.model, prompt_tokens: pt, completion_tokens: ct, est_usd: usd(cfg.model, pt, ct), at: Date.now(), dry_run: cfg.dryRun };
    calls.push(rec);
    listeners.forEach((f) => f(getUsage()));
    return { data, usage: { prompt_tokens: pt, completion_tokens: ct, model: cfg.model }, warning };
  }

  const generateStories = (docs) => run('stories', docs);
  const generateTestPlan = (stories) => run('plan', stories);
  const generateTestCases = (plan, stories) => run('cases', { plan, stories });

  // AI assist: canned in dry-run; a real model call otherwise (plain-text reply, metered).
  function assistUserText(kind, prompt, context) {
    return 'ITEM KIND: ' + kind + '\n\nCURRENT TEXT:\n' + ((context || '').trim() || '(empty — nothing written yet)') +
      '\n\nREQUEST: ' + ((prompt || '').trim() || 'Suggest concrete improvements.');
  }
  async function liveAssist(kind, prompt, context) {
    if (!effKey() && cfg.endpoint === DEFAULT_ENDPOINT) throw new Error('No API key. Enter your OpenAI API key in Settings (gear icon), or keep dry-run on for a canned suggestion.');
    const user = assistUserText(kind, prompt, context);
    const inTok = estTokens(PROMPTS.assist) + estTokens(user);
    if (inTok > BUDGETS.assist.in) throw new BudgetError('Assist input (~' + inTok.toLocaleString() + ' tokens) is over the assist budget of ' + BUDGETS.assist.in.toLocaleString() + ' tokens. Shorten the request or the item text.');
    const body = {
      model: cfg.model,
      messages: [{ role: 'system', content: PROMPTS.assist }, { role: 'user', content: user }],
    };
    body[cfg.model.indexOf('o3') === 0 ? 'max_completion_tokens' : 'max_tokens'] = BUDGETS.assist.out;
    const json = await postChat(body);
    const text = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (!text) throw new Error('Model returned an empty response. Retry.');
    const u = json.usage || {};
    return { text, pt: u.prompt_tokens || 0, ct: u.completion_tokens || 0 };
  }
  async function assist(kind, prompt, context) {
    const p = (prompt || '').trim();
    if (cfg.dryRun) {
      await new Promise((r) => setTimeout(r, 250));
      return 'Dry-run suggestion' + (p ? ' for "' + p.slice(0, 60) + '"' : '') + ': make the ' + kind +
        ' observable and testable — name the actor, the trigger and the exact system response, and add one negative case. (Canned note; turn off dry-run to get a real suggestion.)';
    }
    const { text, pt, ct } = await liveAssist(kind, p, context);
    const rec = { operation: 'assist', model: cfg.model, prompt_tokens: pt, completion_tokens: ct, est_usd: usd(cfg.model, pt, ct), at: Date.now(), dry_run: false };
    calls.push(rec);
    listeners.forEach((f) => f(getUsage()));
    return text;
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
