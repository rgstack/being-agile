# PLAN — Clarify: the conversation between your documents and your stories

*Implementation plan and design proposal. Plan only: no code in this change.*
*Branch `clarify-conversational-intake`. Written 2026-10-11 against v22.*

---

## 0. What Clarify is, in one paragraph

Today the flow is **Start → Stories**: you load a PRD, design doc and API spec, press
Generate, and stories appear. Clarify is a new stage between those two. The AI reads
every document through a **delivery lens** (timeline, stakeholders, value stream,
business area), writes down what it could place and what it could not, and then asks
you, one question at a time, like an analyst sitting across the table. Nothing it asks
ever blocks you: **Generate stories** is live from the first second, and whatever is
still open becomes a stated assumption carried inside the stories. Every story that
comes out fits one two-week sprint and carries story points.

New flow: **Start → Clarify → Stories → Test plan → Test cases → Run → Report**.

---

## 1. What the repo looks like today (findings that shape the plan)

| Area | Finding | Consequence for Clarify |
|---|---|---|
| Modules | Vanilla JS, no build. Each file is an IIFE exposing one global (`State`, `OpenAI`, `Rules`, `Markdown`, `CSV`, `PinLock`); `screens.js` owns all rendering and event delegation (`data-a` click, `data-i` input, `data-c` change). | Clarify ships as a new IIFE `clarify.js` exposing `window.Clarify`, registered into `screens.js` the same way the others are. |
| Stages | `State.STEPS` is a positional array; `S.step` is an index persisted in localStorage; `unlocked(i)` gates navigation; `screens.js` has ~15 literal index checks (`S.step === 1 && curStory()`, `S.step >= 1 && S.step <= 3`, `go(5)`, etc.). | Inserting a stage at index 1 shifts every later index. We add a named `STEP` map and replace every literal (full list in §5.4), plus a one-time migration of persisted `step`. |
| Start page | Uploads are behind `UPLOADS_ENABLED = false`; testers paste text or press **Load NPPES sample**. The primary button is **Generate stories**. | Start's primary button becomes **Continue to Clarify**. Generate moves to the Clarify screen (and stays always-enabled there). |
| AI calls | `OpenAI.run(op)` wraps one JSON-mode chat completion per operation with per-op budgets, a cost-estimate confirm modal (`guarded()`), real-usage metering, and a dry-run path that returns `SAMPLE` data after a 450 ms delay. `postChat` is the only network code. | Two new ops: `clarify-review` (one call, reads docs) and `clarify-turn` (one call per message). Dry-run gets a scripted conversation so the demo works offline. |
| Rules sheet | `rules.js` is a single Markdown string rendered into the right-hand `#sheet` from the top-bar **Rules** button. The stories prompt restates these rules in prose. | Add sections 7 and 8 (delivery lens, story sizing) and mirror them into the prompts. |
| Design system | "Colour is evidence": green only for proven, red only for failed, everything else ink on paper. Hairline rules, hanging marginal numerals (`.md-num`), a five-shape mark vocabulary (`.mark[data-v]`), `rise`/`swap`/`think` keyframes, light and dark tokens, print styles. Fonts are system stacks on purpose ("zero network"). An unused `.pts` chip style already exists. | The ledger reuses the marks literally: an empty circle is an open question, a half circle is an unconfirmed reading, a full green circle is a fact you confirmed. Fonts are self-hosted so zero-network stays true. |
| Story model | `normStory` has no size field. CSV export has no points column. | Add `points` and `assumptions[]`; export **Story Points**. |

---

## 2. Design proposal

### 2.1 The direction: *Editorial dossier*

One aesthetic, executed precisely: **the analyst's dossier**. Think of a long-form
magazine interview laid out by a careful typesetter, bound to a ruled ledger in the
margin. Not a chat app. No bubbles, no avatars, no gradient blobs, no "AI sparkle".

Why this direction fits:

- Clarify is literally an interview. Interviews in print have a known grammar: a
  numbered question set large in a display face, the answer set smaller in a text face,
  a running head telling you where you are. Readers already know how to read it.
- The existing app is "ink on paper" with marginalia. The dossier extends that language
  instead of bolting a chat widget onto it.
- The **ledger** gives the conversation a visible purpose. Every exchange moves a mark.
  That is the wow: you watch the AI read, then watch the ledger fill, then watch your
  answers turn circles green.

### 2.2 Typography

Two variable families, both SIL Open Font License, **self-hosted** under `app/fonts/`
(no CDN, so the app still runs from `file://` and behind a corporate proxy). Fallbacks
keep the current stacks.

| Role | Face | Why | Where |
|---|---|---|---|
| Display | **Fraunces** (variable: `wght` 100–900, `opsz` 9–144, `SOFT`, `WONK`) | A soft, slightly wonky old-style serif with a real optical-size axis. At `opsz 144 / WONK 1` it is unmistakable; at `opsz 11` it is a sober text serif. One file covers both. | Page titles, the active question, ledger values, rendered Markdown prose (replaces the Iowan Old Style stack token-for-token). |
| Body | **Instrument Sans** (variable `wght` 400–700) | A refined grotesque with narrow, even rhythm and distinctive `a`/`g`/`t`; reads as crafted, not default. Not Inter, not Arial. | All UI: kickers, labels, buttons, answers, the composer, chips. |
| Mono | existing system mono stack | Unchanged. | File names, IDs. |

Decision: swap the **existing tokens** `--serif` and `--sans` app-wide so every screen
inherits the pairing with no per-screen CSS. Trade-off: about 240 KB of woff2 loaded
once, and the whole app's voice changes. If that is unwanted, the fallback is one line:
scope the new families under `.clarify { --serif: …; --sans: … }` and the rest of the
app keeps system fonts. Recommendation: app-wide. A dossier with Fraunces headlines and
Instrument Sans body next to a system-font Stories page would look like two products.

Font loading: `@font-face` with `font-display: swap`, `unicode-range` Latin subset,
`<link rel="preload" as="font">` for both files in `index.html`. Variation settings via
`font-variation-settings` on the specific selectors (not globally), e.g. the active
question uses `"opsz" 72, "SOFT" 40, "WONK" 1` at weight 450.

Type scale on the Clarify screen (desktop):

| Element | Face | Size / leading / tracking | Notes |
|---|---|---|---|
| Running head ("CLARIFY · 3 DOCUMENTS · Q3 OF ~6") | Instrument Sans 600 | 11.5 px / 1 / +.09em, uppercase | `--ink-3` |
| Brief paragraph ("I read three documents…") | Fraunces 400, opsz 24 | 20 px / 1.35 / −.008em | max 58ch |
| Active question numeral (margin) | Fraunces 300, opsz 144 | 48 px / 1 | `--ink-3` at 55% opacity, hangs left of the text column like `.md-num` |
| Active question | Fraunces 450, opsz 72, SOFT 40, WONK 1 | clamp(24px, 2.4cqi + 12px, 34px) / 1.15 / −.015em | `text-wrap: balance`, max 26em |
| Question "why" line | Instrument Sans 400 | 14 px / 1.45 | `--ink-2`, prefixed by a 1.5 px rule 18 px wide |
| Settled Q (answered/skipped) | Fraunces 400, opsz 14 | 16.5 px / 1.4 | compact, numeral shrinks to 13 px tabular |
| Your answer | Instrument Sans 400 | 15.5 px / 1.5 | 2 px left rule in `--ink`, 16 px padding |
| Ledger lens name | Instrument Sans 600 | 11.5 px uppercase +.08em | |
| Ledger value | Fraunces 450, opsz 20 | 19 px / 1.25 | `text-wrap: pretty` |
| Ledger source line | Instrument Sans 400 | 12.5 px | `--ink-3`; citations are buttons that open the doc sheet |
| Composer input | Instrument Sans 400 | 16 px / 1.45 | grows to 6 lines |

### 2.3 Layout

Two columns inside `.page.full`, on an 8 px baseline, gutters 56 px (matches `.page`).

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ CLARIFY · 3 DOCUMENTS · 12,410 WORDS · Q3 OF ~6                                │
│                                                                                │
│ I read the PRD, the design doc and the API spec.          THE DELIVERY LEDGER  │
│ I could place the value stream and most of the            ────────────────────│
│ stakeholders. Two things I can't find anywhere, and       ◐ TIMELINE            │
│ one I'd like you to confirm.                                 2 PIs · 12 sprints │
│                                                              assumed from P0/P1 │
│ ─────────────────────────────────────────────                Confirm · Edit     │
│  1  Who owns the enrollment outcome?  ✓ answered          ────────────────────│
│     YOU  Priya's team, Provider Data Mgmt.                ● STAKEHOLDERS        │
│                                                              Dana, Marcus,      │
│  2  Is Phase 1 one PI?   skipped                             Priya, Lee, Sam    │
│                                                              + Sponsor: you said │
│                                                              PRD › Users  ·Edit │
│                                                           ────────────────────│
│         Which value stream does                           ○ VALUE STREAM        │
│  3      provider verification sit in:                        —                  │
│         Provider Network Operations,                         open · Q3          │
│         or Credentialing?                                 ────────────────────│
│     ── The PRD names both as owners.                      ◐ BUSINESS AREA       │
│        Stories get tagged with it.                           Provider Data Mgmt │
│                                                              inferred · Confirm │
│     [Provider Network Ops] [Credentialing] [Other…]       ────────────────────│
│     Skip for now                                          Open  2 · Assumed 2   │
│                                                           Confirmed 1 of 4      │
│ ┌──────────────────────────────────────────────┐                               │
│ │ VALUE STREAM ▸ Answer, or tell me something   │          ┌──────────────────┐ │
│ │ I missed…                              ⏎ Send │          │ Generate stories │ │
│ └──────────────────────────────────────────────┘          └──────────────────┘ │
│ Don't include sensitive information — this goes to api.openai.com   2 open     │
│                                                           questions become     │
│                                                           stated assumptions.  │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **Left, the transcript** (`minmax(0, 1fr)`, max 66ch of question text): running head,
  brief, then turns in order. Settled questions collapse to a compact Q/A pair; only the
  **current** question is at display size. The composer is sticky at the bottom of the
  column (`position: sticky; bottom: 0`, paper background, hairline top rule, 24 px of
  fade above it).
- **Right, the ledger** (`clamp(280px, 30%, 360px)`, `position: sticky; top: 24px`):
  four lens rows, a tally line, and the primary action. It is the thing that persists
  while the transcript scrolls.
- Below 1100 px the ledger drops under the brief as a 2×2 grid; below 700 px it
  becomes a single row of four marks with lens names that expands on tap, and the
  composer pins to the viewport bottom.

### 2.4 The marks: colour is evidence, applied to the ledger

| Lens status | Mark | Meaning |
|---|---|---|
| `open` | empty circle | Not in the documents; not answered yet |
| `assumed` | empty circle + small-caps "assumed" | The AI guessed to keep moving; stories will state this assumption |
| `found` | half circle (`partial`) | The AI found it in a document; you have not confirmed it |
| `confirmed` | full green circle (`proven`) | You confirmed it or told us directly |

Green appears **only** on `confirmed`. That is the same rule the rest of the app lives
by, and it gives every row a human act to complete (press **Confirm**, or answer).

### 2.5 Motion (all under `prefers-reduced-motion` guard, which the app already has)

1. **Reading** (while `clarify-review` is in flight): the three documents render as
   thin vertical spines (2 px wide, height proportional to word count, max 160 px) with
   a 1.5 px `--ink` line descending each spine over 1.6 s, staggered 180 ms; the three
   `think` marks from `.ai-busy` pulse beside the running head. Caption under the
   spines: "Reading the PRD…", then "design doc…", then "API spec…", cycling with the
   stagger. In dry-run this plays the same 1.6 s so the demo looks right.
2. **The brief arrives**: brief paragraph `rise` 500 ms; the four ledger rows `rise`
   at 80 ms stagger with their marks `markin`; the tally fades in last.
3. **First question**: numeral scales in (`pop`, 350 ms) then the question text
   `rise`s 60 ms later.
4. **You answer**: your answer `rise`s under the question; the question collapses to its
   settled form (height transition via `grid-template-rows: 1fr → 0fr` on the display
   block, 320 ms, with the compact block fading in at 180 ms); the affected ledger mark
   gets the existing `bump` and, on confirmation, its colour transition (already 350 ms
   on `.mark`). The next question rises in.
5. **Waiting for the AI**: the three `think` marks under the last turn, nothing else. No
   typing indicator dots, no skeleton bars.

Because `render()` rebuilds the view with `innerHTML`, only the **newest** turn gets an
entry animation. `ui.clarifyAnim` holds the id of the element to animate; everything
else renders static. This avoids the whole transcript re-animating on each keystroke.

### 2.6 Details that make it feel finished

- Hanging numerals align to the same left edge as `.md-num` in the doc viewer, so the
  transcript and the documents share a margin grammar.
- The composer's lens prefix ("VALUE STREAM ▸") is a real button: it cycles the
  question's lens label as a reminder, and clicking it scrolls the ledger row into view
  and flashes it (`flash` keyframe, already defined).
- Quick-pick chips come only from the AI's `options[]` (document-derived choices) and
  always end with **Other…** which focuses the composer. Picking a chip sends
  immediately.
- **Skip for now** sets the question to `skipped`, moves the lens to `assumed` if the AI
  supplied a default, and poses the next question with no AI call (saves a round trip
  and keeps "never block" literal).
- Every ledger citation ("PRD › Users") opens the existing document sheet at that
  document (reusing `openDocSheet`). No new viewer.
- The running head counts "Q3 of ~6": the tilde is deliberate; the AI's question list is
  an estimate and can grow or shrink.
- Per-turn cost appears as a 12 px `--ink-3` line under each AI turn in live mode
  ("~$0.0009 · 2,910 tokens"), mirroring the top-bar meter. In dry-run it says "dry-run".
- Empty state before review: the ledger shows four empty rows with em-dashes, and the
  single primary button **Begin review** (with the same cost estimate the other
  generate buttons show). Nothing else.
- Stale state: if any document's text changes after the review (hash mismatch), a
  one-line note under the running head: "Documents changed since this review.
  **Re-review** · Keep going." Stories can still be generated.
- Print: the ledger prints as a boxed header on the report, under the summary line.
  (Deferred to a follow-up; noted in §8.)

---

## 3. The rules: exact additions to the Rules sheet

Appended to `Rules.markdown` in `app/js/rules.js` after section 6. Section 4's
Definition of Ready gets one line changed. The stories prompt mirrors sections 7 and 8.

```markdown
## 7. Delivery lens: how Clarify reads your documents

Before stories are drafted, every document is read through a delivery and
implementation lens. The AI places what it can, asks about what it cannot, and
writes the rest down as assumptions. These are the four things it is looking for.

| Lens | Question it answers | Units and conventions |
|---|---|---|
| **Timeline** | How long is this, and in what units? | Sprints are **2 weeks**. A **Program Increment (PI) is about one quarter**: 6 sprints (5 for delivery plus 1 for innovation and planning). State the timeline as *sprints → PIs → quarters*, e.g. "12 sprints ≈ 2 PIs ≈ 2 quarters". |
| **Stakeholders** | Who are they, and what does each one need from this? | Name the sponsor, the product owner, the user groups, and anyone who signs off. A role without a name is still a stakeholder; a name without a role is a question. |
| **Value stream** | Which value stream does this work belong to? | The end-to-end flow that creates value for a customer (for example *Provider onboarding* or *Claims adjudication*). One primary value stream per body of work. |
| **Business area** | Which business area on the delivery side owns it? | The delivery organisation that will build and run it. One primary area; secondary areas are noted, not asked about. |

**Out of scope for now:** the offshore versus onsite team mix. It is a cost lens, not a
delivery lens, and Clarify does not ask about it.

### 7.1 Questions never block

- Clarify asks only about what the documents do not answer, one question at a time,
  with the reason it is asking.
- You can answer, skip, or leave at any point. **Generate stories** is always
  available.
- Whatever is still open when stories are generated becomes a **stated assumption**
  inside the affected stories ("Assumes: Phase 1 is one PI"), never a silent guess.
- A reading the AI took from a document is shown as *found* (half mark) until you
  confirm it. Only a fact you confirmed is shown green.

## 8. Story sizing rules

1. **One sprint, no carry-forward.** Every story is completable, tested and done inside
   a single 2-week sprint by one team. If it cannot be, it is split before it is
   written, not after.
2. **Every story gets story points.** Fibonacci scale: 1, 2, 3, 5, 8. **8 is the
   ceiling**; anything the team would size above 8 does not fit a sprint and must be
   split. The points carry a one-line sizing rationale.
3. **Points reflect effort, uncertainty and risk**, not hours. An open assumption adds
   uncertainty and should show up in the size.
4. **Timeline is derived, not declared.** Total points over the team's sprint capacity
   gives sprints; sprints over 6 gives PIs; PIs are quarters. When capacity is unknown,
   the stories say so and the estimate is marked as an assumption.
```

Section 4 (Definition of Ready), replace the line

```
- [ ] Priority is set and the team has sized it.
```
with
```
- [ ] Priority is set and **story points** are on it (1, 2, 3, 5, 8; it fits one sprint).
```

Section 3 (INVEST) row **S** gets one clarification: "Does it fit comfortably inside
**one 2-week sprint**?"

---

## 4. Data flow and conversation state

### 4.1 State shape (`S.clarify`, persisted with the rest of `S`)

```js
S.clarify = {
  v: 1,
  status: 'idle',          // 'idle' | 'reading' | 'open' | 'done'
  docsHash: '',            // djb2 of all doc texts at review time; mismatch => stale note
  brief: null,             // { summary: string, words: number, docs: [{ id, name, words }] }
  digest: '',              // AI-written delivery digest of the docs (<= ~1,500 words); carried in every turn instead of full docs
  ledger: {
    timeline:     { status: 'open', value: null, source: '', cites: [] },
    //   value: { sprints: 12, pis: 2, quarters: 2, note: 'P0 in PI 1, P1 in PI 2' }
    stakeholders: { status: 'open', value: [],   source: '', cites: [] },
    //   value: [{ name: 'Priya', role: 'Data Steward', needs: 'batch verification' }]
    valueStream:  { status: 'open', value: '',   source: '', cites: [] },
    businessArea: { status: 'open', value: '',   source: '', cites: [] },
  },
  //   status: 'open' | 'assumed' | 'found' | 'confirmed'
  //   source: 'PRD › Users' | 'you' | 'assumed'   cites: [{ doc: 'prd', heading: 'Users' }]
  questions: [
    // { id: 'Q1', lens: 'timeline', text, why, options: [], status: 'open'|'answered'|'skipped', answer: '' }
  ],
  turns: [
    // { id: 't1', role: 'ai'|'you', text, qid: 'Q1', at: 1760000000000, cost: { pt, ct, usd } | null }
  ],
  cursor: null,            // id of the question currently posed, or null when the AI has nothing more to ask
  composer: '',            // draft text, persisted so a reload keeps it
  assumptions: [],         // derived at generate time; kept so the Stories page can show "carried assumptions"
};
```

Per-lens status transitions:

```
open ──(AI finds it in a doc)──▶ found ──(you Confirm)──▶ confirmed
open ──(AI guesses a default)─▶ assumed ──(you answer)──▶ confirmed
open ──(you answer)──────────────────────────────────────▶ confirmed
confirmed ──(you Edit)─▶ confirmed (source: 'you')
```

Question lifecycle: `open → answered | skipped`. Skipping never calls the AI.

### 4.2 Calls

**`OpenAI.clarifyReview(docs)`** (op `clarify-review`, one call, JSON mode)

- Input: `docsText(docs)` (same flattening stories use) plus the delivery rules.
- Output:
  ```json
  { "brief": "I read three documents…",
    "digest": "…delivery-lens summary of the docs, ≤1500 words…",
    "ledger": { "timeline": {"status":"assumed","value":{…},"source":"…","cites":[…]}, … },
    "questions": [ {"id":"Q1","lens":"timeline","text":"…","why":"…","options":["…"]} ] }
  ```
- Budget: in 50,000 / out 8,000. Goes through the existing `guarded()` confirm modal.
  The modal text adds one line: "Each reply you send afterwards is one further call
  (~3,000 tokens each, no further prompts)."

**`OpenAI.clarifyTurn(ctx)`** (op `clarify-turn`, one call per message, JSON mode)

- Input: `{ digest, ledger, questions, turns: last 12, cursor, user: text }`. The full
  documents are **not** resent; the digest stands in for them. This keeps a turn at
  roughly 3K tokens in / 400 out on gpt-4o-mini.
- Output:
  ```json
  { "reply": "Got it — Provider Network Operations.",
    "ledger_updates": { "valueStream": { "status": "confirmed", "value": "Provider Network Operations", "source": "you" } },
    "question_updates": [ { "id": "Q3", "status": "answered", "answer": "Provider Network Operations" } ],
    "ask": { "id": "Q4", "lens": "businessArea", "text": "…", "why": "…", "options": [] } ,
    "done": false }
  ```
  `ask` may introduce a question not in the original list (follow-ups). `done: true`
  means the AI has nothing more to ask; the composer stays open for free text.
- Budget: in 20,000 / out 2,000. No confirm modal per turn (see §6, decision 3).

**`OpenAI.generateStories(docs, clarify)`** (existing op `stories`, extended)

- `inputFor('stories')` becomes `docsText(docs) + '\n\n# DELIVERY LEDGER\n' + JSON(ledger
  + open questions)`.
- Prompt gains sections 7 and 8 verbatim (compressed) and the output schema gains:
  - per story: `points` (1|2|3|5|8), `size_rationale`, `assumptions[]`, `sprint`
    (suggested 1-based sprint index, optional)
  - top level: `delivery: { sprints, pis, quarters, basis, assumptions[] }`
- `extractArray` keeps working (stories array is still under `stories`); a new
  `extractDelivery(data)` pulls the `delivery` object, which lands in `S.delivery`.

### 4.3 Dry-run script

`SAMPLE.clarify` in `sample-data.js` carries a complete offline conversation for the
NPPES sample:

- `review`: a brief, a digest, a ledger (timeline *assumed* 2 PIs from P0/P1 phasing;
  stakeholders *found* from "Users"; value stream *open*; business area *assumed*), and
  five questions with options.
- `script`: keyed by question id. The dry-run turn (a) records whatever you typed as
  the answer and confirms the lens with `source: 'you'` (so the ledger genuinely
  reflects your words), (b) replies with the canned acknowledgement, (c) poses the next
  scripted question. Free text that is not an answer gets a canned "Noted — I'll carry
  that into the stories" and re-poses the current question.
- `stories`: the existing sample stories gain `points` and `assumptions`, and a
  `delivery` block.

### 4.4 Sequence

```
Start ──Continue──▶ Clarify(idle) ──Begin review──▶ guarded() confirm
   ──▶ status 'reading' (spines animate) ──▶ clarifyReview ──▶ brief + ledger + Q1 (status 'open')
   ──▶ [ answer | chip | skip | free text ]* ──▶ clarifyTurn / local skip ──▶ ledger + next Q
   ──▶ Generate stories (any time) ──▶ guarded() ──▶ generateStories(docs, clarify)
   ──▶ S.stories (+points, +assumptions), S.delivery, clarify.status 'done' ──▶ Stories page
```

Re-opening Clarify after stories exist is allowed (the stage stays unlocked); the
composer still works, and a **Regenerate stories** button appears beside Generate with
the usual "this replaces the saved stories" confirm.

---

## 5. File-by-file changes

### 5.1 New files

| File | Purpose |
|---|---|
| `app/js/clarify.js` | The Clarify screen: `render()`, the ledger / transcript / composer renderers, the reading animation, the action, input and change handlers, and the dry-run script runner. Exposes `window.Clarify = { render, actions, inputs, changes, meta, onEnter }`. ~450 lines. |
| `app/fonts/Fraunces[SOFT,WONK,opsz,wght].woff2` | Display + prose face (variable, Latin subset). |
| `app/fonts/InstrumentSans[wdth,wght].woff2` | Body face (variable, Latin subset). |
| `app/fonts/OFL-Fraunces.txt`, `app/fonts/OFL-InstrumentSans.txt` | Licences, vendored next to the files. |
| `PLAN-clarify.md` | This document. |

### 5.2 `app/js/state.js`

- `STEPS` → `['Start', 'Clarify', 'Stories', 'Test plan', 'Test cases', 'Run', 'Report']`.
- New `STEP = { start: 0, clarify: 1, stories: 2, plan: 3, cases: 4, run: 5, report: 6 }`
  exported on `State`; `screens.js` uses it instead of literals.
- `fresh()` adds `clarify: clarifyFresh()` and `delivery: null`.
- `load()` migration: persisted state without `clarify` (v22 and earlier) gets
  `clarify = clarifyFresh()` and, if `step >= 1`, `step += 1`. Guarded by a new
  `S.v = 2` marker so it runs once.
- `normStory` adds `points: Number.isFinite(+s.points) ? +s.points : null`,
  `size_rationale: s.size_rationale || ''`, `assumptions: (s.assumptions || []).map(planItemText)`,
  `sprint: s.sprint || null`.
- `unlocked(i)`:
  - `clarify`: any document has text.
  - `stories`: unchanged (`S.stories.length > 0`).
  - later stages unchanged.
- `reset()` clears `clarify` and `delivery`.
- New helpers: `clarifyFresh()`, `docsHash(docs)` (djb2 over the four texts),
  `ledgerTally(ledger)` → `{ open, assumed, found, confirmed }`,
  `openAssumptions(clarify)` → the assumption strings stories will carry.

### 5.3 `app/js/openai.js`

- `BUDGETS` adds `'clarify-review': { in: 50000, out: 8000 }` and
  `'clarify-turn': { in: 20000, out: 2000 }`.
- `PROMPTS` adds `'clarify-review'` and `'clarify-turn'` (system prompts carrying
  sections 7–8, the "never block" rule, the explicit "do not ask about offshore/onsite",
  and the JSON shapes in §4.2). `PROMPTS.stories` is extended with sizing rules and the
  new fields.
- `inputFor(op, input)`: `'clarify-review'` → `docsText(input)`; `'clarify-turn'` →
  `JSON.stringify(input)`; `'stories'` → docs text + ledger block.
- `simulated(op)`: returns `SAMPLE.clarify.review` for the review; for a turn, returns
  the scripted response computed by `Clarify.dryTurn(ctx)` (the script runner lives in
  `clarify.js`; openai.js only calls it so the dry-run stays zero-network and canned).
- New exports `clarifyReview(docs)` and `clarifyTurn(ctx)` built on `run()`; a new
  `extractClarify(op, data)` normaliser (accepts a wrapped object the same defensive way
  `extractPlan` does; fills missing lens rows with `open`).
- `generateStories(docs, clarify)` signature change; `extractDelivery(data)`.
- Usage records for the new ops flow into the existing meter and Settings table with
  operation names `clarify-review` and `clarify-turn`.

### 5.4 `app/js/screens.js`

- Load order: `clarify.js` is included before `screens.js`; `const CL = window.Clarify`.
- `SCREENS` → `[renderStart, CL.render, renderStories, renderPlan, renderCases, renderRun, renderReport]`.
- `NEXT` → keyed by `STEP`: start→clarify ("Continue to Clarify"), clarify→stories,
  stories→plan, plan→cases, cases→run, run→report.
- Literal step fixes (each becomes a `STEP.*` comparison):
  `nextInner` (`S.step === 0`, `S.step >= 1 && S.step <= 3`), `touch` (`S.step === 1`),
  `paintSheet` (`S.step !== 1`, `S.step !== 0`), `render` (`.page.full` for cases/run,
  plus clarify), the Ctrl/Cmd+S guard, `A.trace` (`go(5)`, `S.step === 5`,
  `ST.unlocked(5)`), `A['gen-stories']` (`S.step = 1` → `STEP.stories`), and
  `renderChrome`'s `meta[]` array (gains a Clarify line: "No review yet" / "Reading…" /
  "2 of 4 confirmed · 1 open").
- Start page: `nextInner` for `STEP.start` renders **Continue to Clarify** (enabled when
  any doc has text) instead of **Generate stories**. The "How this works" line becomes
  "AI reads → asks → drafts → you edit → you save."
- `A['gen-stories']` moves its trigger to the Clarify screen, passes `S.clarify`, stores
  `S.delivery`, sets `S.clarify.status = 'done'`, and goes to `STEP.stories`.
- Handlers: `Object.assign(A, CL.actions)`, `Object.assign(I_, CL.inputs)`,
  `Object.assign(C, CL.changes)`. Clarify action names are prefixed `cl-` to avoid
  collisions (`cl-begin`, `cl-send`, `cl-chip`, `cl-skip`, `cl-confirm`, `cl-edit`,
  `cl-edit-save`, `cl-edit-cancel`, `cl-cite`, `cl-rereview`, `cl-retry`, `cl-gen`).
- Keyboard: in the composer, Enter sends and Shift+Enter inserts a newline (added to the
  existing `stage` keydown handler).
- Story card: a `.pts` chip after the priority ("3 pts"); null points render "— pts" in
  `--ink-3` so a missing size is visible, not hidden.
- Story sheet: a **Points** select (1, 2, 3, 5, 8, —) in the `dl.fields` next to
  Priority; a **Sizing** one-line field; an **Assumptions** section (one per line,
  Preview/Write via `rt()`), placed after Acceptance criteria.
- Stories page header: when `S.delivery` exists, one line under the lede: "Sized at 46
  points ≈ 8 sprints ≈ 2 PIs ≈ 2 quarters, assuming 6 points per sprint. 2 assumptions
  carried." with a link that opens the Rules sheet at section 8.
- `A['load-sample']` and `A['rm-extra']`/doc input: when the docs hash no longer matches
  `S.clarify.docsHash`, nothing is reset; the Clarify screen shows the stale note.
- Reset demo: also clears `S.clarify`, `S.delivery`, `ui.clarifyAnim`.

### 5.5 `app/js/rules.js`

Append sections 7 and 8, edit the DoR line and the INVEST **S** row exactly as in §3.

### 5.6 `app/js/sample-data.js`

Add `SAMPLE.clarify = { review, script }` and `SAMPLE.delivery`; add `points`,
`size_rationale`, `assumptions` to each of the 8 sample stories (all ≤ 8; US-008 batch
verification is the natural 8).

### 5.7 `app/js/csv.js`

`storiesToCsv`: add **Story Points** after Priority (Jira's importer maps it to the
Story Points field by header name) and a **Description** suffix block
"Assumptions:\n- …" when assumptions exist, so Jira carries them.

### 5.8 `app/css/main.css`

- Top: two `@font-face` rules; `--serif` and `--sans` tokens updated with the new
  families first; `--display-settings` custom property for the Fraunces axes.
- New section "1b. Clarify" (~220 lines): `.clarify` grid, `.cl-head`, `.cl-brief`,
  `.cl-spines` + `@keyframes read`, `.turn`, `.turn.ask` (display question with hanging
  numeral), `.turn.settled`, `.turn.you`, `.cl-chips`, `.cl-composer` (sticky), `.ledger`,
  `.lens`, `.lens .mark`, `.lens-src button`, `.cl-tally`, `.cl-cta`, `.cl-stale`,
  container queries at 1100 px and 700 px, print rules.
- `.pts` already exists; one rule adds the muted `.pts.none` variant.

### 5.9 `app/index.html`

- `<link rel="preload" as="font" type="font/woff2" crossorigin>` × 2.
- `<script src="js/clarify.js?v=23">` before `screens.js`.
- Bump every `?v=22` to `?v=23`.

### 5.10 `README.md`

Flow line and bullet for Clarify.

---

## 6. Decisions taken (and the alternative not chosen)

1. **Clarify is a real stage in the rail**, not a mode of Start. It has its own
   persisted state, its own unlock rule and its own sidebar line. Cost: the step-index
   refactor in §5.4. Benefit: the flow reads honestly, and the rail's "review gate"
   semantics still hold (Stories unlocks when stories exist; Clarify never gates it).
2. **One review call, then one call per message, carrying a digest instead of the
   documents.** The alternative, resending full documents each turn, would cost
   ~10× per turn on real PRDs and hit the 50K input cap on long bundles.
3. **No confirm modal per message.** A cost modal on every sentence would kill the
   conversation. Instead: the one-time modal before the review states the per-turn
   cost, each AI turn shows its real cost, and the top-bar meter keeps counting. This is
   the same transparency as today, moved from "before" to "beside".
4. **Skip is local.** No AI call; the next question comes from the list the review
   already produced. If the list is exhausted, the AI is asked once with
   `user: "(skipped)"` so it can decide whether to add a follow-up or finish.
5. **Found ≠ confirmed.** Only a human act turns a mark green. The app's premise is
   proof not promises; the ledger should not promise.
6. **Fonts app-wide, self-hosted.** Reasons in §2.2. The one-line scoped fallback is
   documented there if Rajan prefers to keep the rest of the app on system fonts.
7. **Offshore/onsite is not asked**, per rule 5. It is listed in the Rules sheet as out
   of scope so a reader knows why the AI never raises it.
8. **Assumptions live inside stories** (`assumptions[]`, exported to Jira), not only in
   a side panel, because that is where a developer will meet them.

---

## 7. Build order and verification

Four commits, each shippable.

| # | Commit | Verify (dry-run unless noted) |
|---|---|---|
| A | **Stage + state + rules + fonts.** `STEP` map, migration, Clarify stage rendering an idle ledger with **Begin review** disabled-stub, rules sections 7–8, fonts vendored and tokens swapped. | Fresh load and a v22 localStorage blob both land on the right stage; every existing screen still renders; Rules sheet shows 8 sections; fonts load from `file://` with no network requests in DevTools. |
| B | **Review + conversation.** `clarify-review` / `clarify-turn` ops, dry-run script, transcript, composer, chips, skip, confirm/edit, stale note, animations. | Walk the scripted NPPES conversation end to end; skip two questions; confirm a found row; edit a value; reload mid-conversation (state and composer draft survive); switch theme; resize to 700 px. Then **live on gpt-4o-mini** with the condensed sample: review returns a valid ledger; three turns; meter and Settings usage table show the new ops. |
| C | **Stories integration.** Ledger-aware stories prompt, `points` / `assumptions` / `delivery`, card chip, sheet fields, Stories header line, CSV column, sample data. | Generate from Clarify with two open questions: every story has points ≤ 8, open questions appear as assumptions on the stories they affect, the Stories header shows the derived timeline, CSV opens in a sheet with a Story Points column. Regenerate path replaces stories with the usual confirm. |
| D | **Polish.** Reduced-motion check, print of ledger, keyboard pass, screen-reader pass (`role="log"`, labelled marks, focus order composer → chips → skip), empty/error/retry states. | Tab through the whole screen without a mouse; VoiceOver reads marks as "open / found / confirmed"; a forced 429 shows Retry and keeps the typed text. |

Live testing follows the existing habit (commit messages say "live-tested on 4o-mini").
Budget for the whole live pass on the condensed sample: under $0.05.

---

## 8. Out of scope for this feature (noted so they are not forgotten)

- Offshore/onsite mix (rule 5): not asked, not modelled.
- Re-enabling file uploads (`UPLOADS_ENABLED`): unrelated; the Clarify stage works with
  pasted text and the sample exactly as Start does today.
- Printing the ledger on the report page: small, do it in D if time allows, otherwise
  next.
- Velocity as a settings field (points per sprint): the AI asks it as part of the
  timeline lens; a persistent setting can come later.
- Multiple value streams per body of work: one primary only, by rule.

---

## 9. Open questions for Rajan (none block the build)

1. App-wide font swap (recommended) or Clarify-only scope? Default if unanswered:
   app-wide.
2. PI = 6 sprints (5 + 1 IP) is the convention written into the rules. If CareFirst's
   PIs run 5 sprints, that is one number in `rules.js` and one in the prompt.
3. Should **Continue to Clarify** auto-start the review (one fewer click) or stop at the
   idle ledger with **Begin review** (one fewer surprise call)? Default: stop at idle,
   because every other AI call in the app is an explicit act.
