/* OpenAI adapter — BYOK, token budgets, usage metering, dry-run + live JSON-mode path.
   Dry-run (default): bundled sample output, zero network. Live (dryRun off): liveCall() POSTs one
   chat-completions request (response_format json_object, output capped by BUDGETS) to cfg.endpoint
   (api.openai.com by default, or a corporate proxy that injects auth — then the key is optional),
   parses the JSON reply and records the REAL usage from the response into metering.
   liveCall is the only network code in the app. The API key lives only in this closure and is
   never logged or committed.
   Operations: stories, plan, cases, assist, and the two Clarify ops — clarify-review (one call that
   reads the documents) and clarify-turn (one call per message, carrying a digest instead of the docs). */
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
    'clarify-review': { in: 50000, out: 8000 },
    'clarify-turn':   { in: 20000, out: 2000 },
  };

  // Rules sheet sections 7 and 8, compressed for the prompts (rules.js is the readable version).
  const RULES_DELIVERY = 'DELIVERY LENS (rules 7): Sprints are 2 weeks. A Program Increment (PI) is about one quarter: 6 sprints (5 for delivery plus 1 for innovation and planning). State every timeline as sprints -> PIs -> quarters, e.g. "12 sprints ≈ 2 PIs ≈ 2 quarters". Four lenses, exactly these keys: timeline (how long, in those units), stakeholders (sponsor, product owner, user groups, anyone who signs off: name, role, what they need; a role without a name is still a stakeholder, a name without a role is a question), valueStream (the ONE end-to-end flow that creates customer value, e.g. "Provider onboarding"), businessArea (the ONE delivery organisation that will build and run it). Never ask about the offshore versus onsite team mix: it is a cost lens, out of scope.';
  const RULES_SIZING = 'STORY SIZING (rules 8): (1) One sprint, no carry-forward: every story is completable, tested and done inside a single 2-week sprint by one team; if it cannot be, split it before writing it. (2) Every story gets story points on the Fibonacci scale 1, 2, 3, 5, 8; 8 is the ceiling, anything larger must be split; each story carries a one-line size_rationale. (3) Points reflect effort, uncertainty and risk, not hours; an open assumption adds uncertainty and shows up in the size. (4) Timeline is derived, not declared: total points over points per sprint gives sprints; sprints over 6 gives PIs; PIs are quarters. When capacity is unknown, say so and mark the timeline as an assumption.';

  const PROMPTS = {
    stories: 'You are a senior product analyst. Given the PRD, design doc, API spec, supporting docs and the DELIVERY LEDGER at the end of the input, produce substantial Jira stories as a JSON object: {"stories": [{id, title, description, acceptance_criteria[7-8 items], subtasks[6 items], priority, labels, points, size_rationale, assumptions[], sprint}], "delivery": {"sprints": n, "pis": n, "quarters": n, "points_per_sprint": n or null, "basis": "one sentence on how the timeline was derived", "assumptions": ["..."]}}. Cover every requirement. No prose outside the JSON.\n\nWrite every story against these rules:\n- INVEST: each story is Independent (buildable and testable on its own), Negotiable (detail open to conversation, not fixed like a contract), Valuable (a user or the business notices when it ships), Estimable (sizable without guessing), Small (fits comfortably inside one 2-week sprint), Testable (a clear pass/fail check proves it done).\n- Definition of Ready: the description states who wants what and why (As a... I want... so that...); acceptance criteria are written one per line and each is verifiable; the requirement(s) it covers are linked in labels as REQ-nnn; dependencies and open questions are named; priority is set and story points are on it.\n- Description follows As a / I want / So that. Acceptance criteria: 7-8 items, each a single verifiable check, demonstrated rather than asserted.\n- DELIVERY LEDGER: the ledger lists what the analyst confirmed (authoritative, overrides the documents), found, assumed, and what is still open. Add the value stream and the business area as kebab-case labels on every story. Any assumed or open item a story depends on goes into that story\'s assumptions[] as a stated assumption (e.g. "Assumes: Phase 1 is one PI"), never a silent guess. Carry every open question that affects scope into the assumptions of the stories it touches, and list all of them in delivery.assumptions.\n- ' + RULES_SIZING + ' sprint is the suggested 1-based sprint index, optional.',
    plan: 'Given the stories, produce a test plan as JSON: {objectives, scope_in, scope_out, approach, entry_criteria[], exit_criteria[], risks[]}. The list fields are arrays of plain strings — no nested objects.',
    cases: 'Given the test plan and stories, produce test cases as a JSON object: {"test_cases": [{id, requirement_ref, title, steps[], expected, priority}]}. Cover all requirements. No prose outside the JSON.\n\nWrite every case against these rules:\n- One objective per case; the title says what it proves.\n- Preconditions stated: role, data, environment and configuration are named, not assumed.\n- Steps are clear and numbered; each step is a single action someone else could repeat exactly.\n- Expected result is unambiguous: specific values, codes and messages, so any two reviewers reach the same pass or fail.\n- Every case carries the REQ-nnn it proves in requirement_ref, so each requirement ends with a verdict.',
    assist: 'You are a senior product analyst and test strategist. The user is drafting a Jira story, a test plan, or a test case and asks for help improving one item. You receive the item kind, its current text, and their request. Return ONLY the improved version of the item — no suggestions, no explanations, no commentary, no notes about what you changed. Match the item\'s format: prose stays prose, one-per-line lists stay one-per-line. Judge it against INVEST (for stories), the Definition of Ready, and the test-case quality rules (one objective, stated preconditions, repeatable numbered steps, unambiguous expected result, REQ-nnn traceability) wherever they apply.',
    'clarify-review': 'You are a senior delivery analyst reading a PRD, a design doc, an API spec and any supporting documents before stories are written. Read them through the delivery lens, fill the ledger with what you can place, and prepare the questions you would ask the product owner, one at a time, like an analyst across the table.\n\n' + RULES_DELIVERY + '\n\nLEDGER STATUS per lens: "found" = stated in a document (cite the document and heading); "assumed" = not stated, you took a sensible default to keep moving and said so in source; "open" = not stated and no sensible default. Never use "confirmed": only the user confirms.\n\nQUESTIONS: ask only about what the documents do not answer. 3 to 6 questions, most important first. Each has exactly one lens, one plain sentence of text, one sentence of why (what in the documents makes you ask, and what depends on the answer), up to 4 options drawn from the documents when real choices exist (otherwise an empty list), and a default (your best guess the stories would assume if the user skips, or "" if none). Questions never block; the user may skip any of them. Write each question text the way you would say it to a colleague across the table: conversational, contractions, plain words, no jargon such as lens or ledger.\n\nOPENING: the first thing you say out loud, like a friend who has just read everything they sent you. 3 to 5 short spoken sentences, first person, talking to \"you\". Start by playing back in your own words what they are asking you to help build (e.g. \"So if I’ve got this right, you’re building…\"), mention one or two things you picked up that will shape the work, be honest about what is still fuzzy, and end by saying you have a few follow-up questions (say roughly how many) before you draft stories. Warm, natural and specific to these documents; contractions; no lists, no markdown, no requirement ids, no words like lens, ledger or digest. Do not ask the first question itself: it is shown right after.\n\nBRIEF: 2 to 4 first-person sentences: what you read, what you could place, what you could not and will ask about. DIGEST: a delivery-lens digest of the documents, at most 1500 words, that can stand in for them in later turns: scope by requirement id, phases and durations, named people and roles, systems, dates, constraints, non-goals.\n\nReturn ONLY this JSON object, with exactly these keys:\n{"opening": "...", "brief": "...", "digest": "...", "ledger": {"timeline": {"status": "found|assumed|open", "value": {"sprints": n or null, "pis": n or null, "quarters": n or null, "note": "..."}, "source": "PRD › Rollout and phasing", "cites": [{"doc": "prd|design|api", "heading": "..."}]}, "stakeholders": {"status": "...", "value": [{"name": "...", "role": "...", "needs": "..."}], "source": "...", "cites": [...]}, "valueStream": {"status": "...", "value": "...", "source": "...", "cites": [...]}, "businessArea": {"status": "...", "value": "...", "source": "...", "cites": [...]}}, "questions": [{"id": "Q1", "lens": "timeline|stakeholders|valueStream|businessArea", "text": "...", "why": "...", "options": ["..."], "default": "..."}]}\nNo prose outside the JSON.',
    'clarify-turn': 'You are continuing a short interview about delivery details, one question at a time. You receive one JSON object: digest (stands in for the documents), ledger (the four lenses as they stand), questions (each with status open, answered or skipped), turns (the recent transcript), cursor (id of the question currently posed, or null), and user (what the user just said).\n\n' + RULES_DELIVERY + '\n\nRULES: The user\'s words are authoritative over the documents. If the user answers the cursor question, record it: question_updates marks it answered with their answer, and ledger_updates sets that lens to status "confirmed", source "you", with the value expressed in the ledger\'s shape for that lens (timeline as sprints/pis/quarters/note, stakeholders as the full updated list of {name, role, needs}, the other two as a short string). If the user states or corrects a fact about any other lens, update it the same way. If the user asks something or comments without answering, reply briefly from the digest and pose the current question again as ask. If user is exactly "(skipped)", the user skipped the cursor question: do not re-ask it; add at most one genuinely needed follow-up, otherwise finish. Then pose the next open question in ask (the next open one from questions, or a new follow-up with a new id). When nothing is left to ask, set ask to null and done to true; the user may keep talking.\n\nTONE: talk like a thoughtful colleague, not a form. React to what the user actually said with a short, genuine acknowledgement (never a bare \"Noted\" or \"Understood\"), say in plain words what it means for the stories when that helps, and if you are posing another question, end with a natural bridge into it (e.g. \"That helps. One more thing I’m wondering about…\") without repeating the question’s text, which is shown right after your reply. When you finish, say so warmly and tell them they can generate the stories whenever they’re ready. Write the ask text conversationally too. 1 to 3 short spoken sentences, contractions, no markdown, no lists, no words like lens, ledger, digest or Q3, no requirement ids unless the user used them. Never ask about offshore versus onsite.\n\nReturn ONLY this JSON object: {"reply": "...", "ledger_updates": {"timeline|stakeholders|valueStream|businessArea": {"status": "confirmed|found|assumed|open", "value": ..., "source": "you"}}, "question_updates": [{"id": "Q3", "status": "answered|skipped", "answer": "..."}], "ask": {"id": "Q4", "lens": "...", "text": "...", "why": "...", "options": ["..."], "default": ""} or null, "done": false}',
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
  // The delivery ledger as the stories prompt sees it: what is confirmed, found, assumed and still open.
  function ledgerBlock(c) {
    const ST = window.State;
    if (!c || !c.ledger) return '{}';
    const ledger = {};
    (ST ? ST.LENSES : Object.keys(c.ledger)).forEach((k) => { const l = c.ledger[k] || {}; ledger[k] = { status: l.status || 'open', value: ST ? ST.lensText(k, l.value) : l.value, source: l.source || '' }; });
    const qs = (c.questions || []);
    return JSON.stringify({
      ledger,
      answered: qs.filter((q) => q.status === 'answered').map((q) => ({ lens: q.lens, question: q.text, answer: q.answer })),
      open_questions: qs.filter((q) => q.status !== 'answered').map((q) => ({ lens: q.lens, question: q.text, skipped: q.status === 'skipped', default: q.default || '' })),
    }, null, 1);
  }
  function inputFor(op, input) {
    if (op === 'stories') {
      const docs = input && input.docs ? input.docs : input;
      return docsText(docs) + (input && input.clarify ? '\n\n# DELIVERY LEDGER\n' + ledgerBlock(input.clarify) : '');
    }
    if (op === 'clarify-review') return docsText(input);
    return JSON.stringify(input);
  }
  // Dry-run output: bundled samples; the Clarify turn is scripted by clarify.js so the demo conversation stays zero-network.
  function simulated(op, input) {
    const S = window.SAMPLE;
    if (op === 'stories') return { stories: S.stories, delivery: S.delivery || null };
    if (op === 'plan') return S.plan;
    if (op === 'cases') return S.cases;
    if (op === 'clarify-review') return (S.clarify && S.clarify.review) || { brief: '', digest: '', ledger: {}, questions: [] };
    if (op === 'clarify-turn') return window.Clarify && window.Clarify.dryTurn ? window.Clarify.dryTurn(input) : { reply: '', ledger_updates: {}, question_updates: [], ask: null, done: true };
    return {};
  }

  function estimateCall(op, input) {
    const b = BUDGETS[op];
    if (!b) throw new Error('Unknown operation: ' + op);
    const inTok = estTokens(PROMPTS[op]) + estTokens(inputFor(op, input));
    const outTok = Math.min(b.out, estTokens(simulated(op, input)));
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
      const vals = Object.values(data).filter(Array.isArray);
      if (vals.length === 1) return vals[0];
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
  // The stories call also returns a derived timeline; absent or malformed => null (the UI then says so).
  function extractDelivery(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const d = data.delivery || data.timeline || null;
    return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
  }
  const unwrap = (data, keys) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    if (keys.some((k) => k in data)) return data;
    const vals = Object.values(data);
    return vals.length === 1 && vals[0] && typeof vals[0] === 'object' && !Array.isArray(vals[0]) ? vals[0] : data;
  };
  // Clarify review: brief + digest + a ledger with all four lenses (missing rows become open) + normalized questions.
  // Only a human confirms, so a "confirmed" status from the model is downgraded to "found".
  function extractClarify(data) {
    const ST = window.State, d = unwrap(data, ['ledger', 'questions', 'brief']);
    const ledger = {};
    ST.LENSES.forEach((k) => { const l = ST.normLens(k, d.ledger && d.ledger[k]); if (l.status === 'confirmed') l.status = 'found'; ledger[k] = l; });
    const questions = (Array.isArray(d.questions) ? d.questions : []).map(ST.normQuestion).filter(Boolean);
    const seen = {}; questions.forEach((q, i) => { if (seen[q.id]) q.id = 'Q' + (i + 1) + 'b'; seen[q.id] = true; });
    if (!questions.length && !Object.values(ledger).some((l) => l.status !== 'open')) throw new Error('The review came back empty (no ledger, no questions). Retry — or switch to dry-run.');
    return { opening: ST.planItemText(d.opening || d.intro || ''), brief: ST.planItemText(d.brief || d.summary || ''), digest: typeof d.digest === 'string' ? d.digest : ST.planItemText(d.digest || ''), ledger, questions };
  }
  // Clarify turn: reply + partial ledger updates + question updates + the next question (or null when done).
  function extractTurn(data) {
    const ST = window.State, d = unwrap(data, ['reply', 'ask', 'ledger_updates', 'done']);
    const ledger_updates = {};
    const lu = d.ledger_updates && typeof d.ledger_updates === 'object' ? d.ledger_updates : {};
    ST.LENSES.forEach((k) => { if (lu[k] && typeof lu[k] === 'object') { const l = ST.normLens(k, lu[k]); if (!Array.isArray(lu[k].cites)) delete l.cites; ledger_updates[k] = l; } });
    const question_updates = (Array.isArray(d.question_updates) ? d.question_updates : []).filter((u) => u && u.id).map((u) => ({ id: String(u.id), status: u.status === 'skipped' ? 'skipped' : 'answered', answer: ST.planItemText(u.answer || '') }));
    const ask = d.ask && typeof d.ask === 'object' ? ST.normQuestion(d.ask, 98) : null;
    return { reply: ST.planItemText(d.reply || d.message || ''), ledger_updates, question_updates, ask, done: !!d.done || !ask };
  }

  async function run(op, input) {
    const est = estimateCall(op, input);
    const warning = checkBudget(op, est);
    let data, pt, ct;
    if (cfg.dryRun) {
      // DRY-RUN: bundled sample output, zero network.
      await new Promise((r) => setTimeout(r, 450));
      data = JSON.parse(JSON.stringify(simulated(op, input)));
      pt = est.inputTokens; ct = est.outputTokens;
    } else {
      ({ data, pt, ct } = await liveCall(op, input));
    }
    if (op === 'stories') data = { stories: extractArray(op, data), delivery: extractDelivery(data) };
    if (op === 'cases') data = extractArray(op, data);
    if (op === 'plan') data = extractPlan(data);
    if (op === 'clarify-review') data = extractClarify(data);
    if (op === 'clarify-turn') data = extractTurn(data);
    const rec = { operation: op, model: cfg.model, prompt_tokens: pt, completion_tokens: ct, est_usd: usd(cfg.model, pt, ct), at: Date.now(), dry_run: cfg.dryRun };
    calls.push(rec);
    listeners.forEach((f) => f(getUsage()));
    return { data, usage: { prompt_tokens: pt, completion_tokens: ct, model: cfg.model, usd: rec.est_usd }, warning };
  }

  // Stories read the documents plus the delivery ledger (clarify may be null: Generate is never gated on a review).
  const generateStories = (docs, clarify) => run('stories', { docs, clarify: clarify || null });
  const generateTestPlan = (stories) => run('plan', stories);
  const generateTestCases = (plan, stories) => run('cases', { plan, stories });
  const clarifyReview = (docs) => run('clarify-review', docs);
  const clarifyTurn = (ctx) => run('clarify-turn', ctx);

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
      return 'Dry-run (canned): the improved ' + kind + ' would appear here' + (p ? ' for "' + p.slice(0, 60) + '"' : '') + ' — turn off dry-run for the real rewrite.';
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

  window.OpenAI = { DEFAULT_ENDPOINT, PRICING, MODELS, BUDGETS, PROMPTS, BudgetError, configure, getConfig, estimateCall, generateStories, generateTestPlan, generateTestCases, clarifyReview, clarifyTurn, assist, getUsage, loadUsage, onUsage };
})();
