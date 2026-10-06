# Technical Design — Provider Lookup & NPI Verification

| | |
|---|---|
| **Status** | Draft v2 (post-critique) |
| **Owner** | Tech Lead, Provider Data Platform |
| **Implements** | REQ-001 … REQ-013 (`prd.md`) |
| **Upstream** | CMS NPPES NPI Registry API v2.1 (`api-spec.md` Part A) |

## 1. Context and design drivers

1. **The upstream is public, unauthenticated, unmetered on paper, and unsupported (no SLA).** It must be treated as a shared, fragile dependency. Every design choice that touches it favors fewer calls and graceful degradation.
2. **The upstream's contract has sharp edges** discovered by live probing: validation errors come back as HTTP 200 + `Errors[]`; check digits aren't validated; `result_count` is page-size, not a total; `limit` silently clamps at 200; `Cache-Control: no-store` precludes intermediary caching.
3. **The output is evidence.** Verification results must be reproducible and defensible months later in an audit, so we snapshot upstream payloads rather than re-deriving them.
4. **Small team, internal tool, modest load** (peak tens of concurrent users, hundreds of lookups/hour, batches of ≤ 500). Prefer boring, operable technology over scale-first architecture.

## 2. Architecture overview

```
 ┌────────────┐   HTTPS/OIDC    ┌───────────────────────────────────────────────┐
 │  Browser   │ ──────────────▶ │  Provider Lookup Service (stateless, N≥2)     │
 │  SPA (UI)  │ ◀────────────── │                                               │
 └────────────┘                 │  API layer ─▶ AuthZ ─▶ Input validation       │
                                │       │                                       │
                                │       ▼                                       │
                                │  Lookup/Search/Verification services          │
                                │       │                │                      │
                                │       ▼                ▼                      │
                                │  Cache (Redis)   Evidence/Audit writers       │
                                │       │                │                      │
                                │       ▼                ▼                      │
                                │  NPPES Client     Postgres (audit, snapshots, │
                                │  (limiter,         batches)                   │
                                │   single-flight,  Job queue (Postgres-backed) │
                                │   retry, breaker)       ▲                     │
                                └───────┬─────────────────┼─────────────────────┘
                                        │ HTTPS GET       │
                                        ▼            Batch worker(s)
                            npiregistry.cms.hhs.gov/api/   (low-priority lane)
```

### Technology choices (proposed; adjustable to org standards)

| Concern | Choice | Why |
|---|---|---|
| Service | TypeScript/Node 22 (Fastify) *or* org-standard JVM service | Team skills; strong JSON handling; either is fine — the design is stack-neutral |
| UI | React SPA, served by the same service | Single deployable; SSO handled server-side |
| Cache | Redis | TTLs, atomic ops for token bucket and single-flight locks, shared across replicas |
| Persistence | PostgreSQL | Audit log, snapshots, batches; transactional; 7-year retention via partitioning |
| Jobs | Postgres-backed queue (`SKIP LOCKED`) | Avoids a new broker for ≤ 500-row batches |
| Auth | OIDC with corporate IdP; server-side session | No tokens in browser storage |
| Observability | OpenTelemetry → existing stack; Prometheus metrics | Org standard |

## 3. Components

### 3.1 API layer
Fastify routes per `api-spec.md` Part B. Responsibilities: authentication, role enforcement (REQ-013), request-ID assignment, schema validation, uniform error envelope, per-user rate limit (60 req/min interactive) to protect the proxy from a single runaway tab or script.

### 3.2 Input validator (`npi.ts`, `searchCriteria.ts`)
Pure, dependency-free functions, shared with the UI via a small package so client and server cannot drift (REQ-001, REQ-002, REQ-004).

* `normalizeNpi(s)`: strip whitespace/hyphens; reject non-digits.
* `isValidNpi(s)`: 10 digits + Luhn over `"80840" + s`. Returns a discriminated result (`FORMAT` | `CHECK_DIGIT` | `OK`).
* `validateSearch(criteria)`: ≥ 1 criterion besides `state`; wildcard needs ≥ 2 leading chars; postal code 5 or 9 digits; page depth ≤ 1000; `pageSize ∈ {10,25,50,100,200}`.

The server re-validates everything; the UI's checks are conveniences.

### 3.3 NPPES client (`nppesClient.ts`)
The only code that talks to the upstream. Pipeline per call:

1. **Build request** — always `version=2.1`; whitelist parameters (drops anything unknown); percent-encode; set `User-Agent` with contact mailbox; timeout 8 s connect+read.
2. **Single-flight** — key = canonical query string; identical concurrent requests share one promise (in-process) and a short Redis lock (`SET NX PX 10000`) across replicas, with followers polling cache.
3. **Rate limit & concurrency** — Redis token bucket (5 rps, burst 5) and a counting semaphore (4). Interactive requests have priority lane; batch work yields. Waiting longer than 3 s for interactive → fail fast with 503 `UPSTREAM_BUSY` rather than queueing indefinitely.
4. **Circuit breaker** — see §6.
5. **Retry** — transport errors and 502/503/504 only, 3 attempts with jittered backoff.
6. **Parse** — JSON parse; if body has `Errors` → throw `NppesValidationError(errors[])` (**never retried, never cached**); if body lacks both `results` and `Errors` → `NppesProtocolError` (502).
7. **Return** raw payload + timing; mapping to our domain model happens in the mapper.

### 3.4 Mapper (`providerMapper.ts`)
Converts the raw NPPES provider object to our normalized model (api-spec B.1) and applies the field-handling rules (A.3): ZIP+4 formatting, `"--"` → empty, string epochs, primary taxonomy selection (exactly one `primary:true`, else `anomaly` flag), LOCATION vs MAILING split (first of each purpose), status mapping (`A` → ACTIVE; anything else → DEACTIVATED/UNKNOWN with raw value preserved), unknown-field tolerance. Raw payload is retained alongside for snapshots.

### 3.5 Verification engine (`verify.ts`)
Pure function `verify(provider | null, expected) → VerificationResult` — no I/O, so exhaustively unit-testable.

* **Name:** normalize both sides (Unicode NFKD, strip diacritics, uppercase, strip punctuation except internal hyphen/apostrophe collapsed, collapse whitespace; remove generational suffixes into a separate field). Match if first+last equal the primary name **or** any `other_names` entry; report `matchedOn: primary|other_name`. Middle names compared only if provided, with initial-vs-full tolerance.
* **Credential:** normalized token-set comparison (`M.D.` = `MD`).
* **Taxonomy:** expected code compared to all taxonomies; `matchedOn: primary|secondary`; a secondary-only match is MATCH with a note (policy decision in PRD: not a mismatch, but displayed).
* **Location:** state equality required; ZIP compared at 5 digits (or 9 when expected is 9); compared to LOCATION address, never MAILING (a MAILING-only match is `MISMATCH` with `note: MAILING_ONLY`).
* **Verdict:** per api-spec B.3. Deactivated or not-found short-circuit to FAILED.

Open design caveat: NPPES may not return deactivated NPIs in the API at all, in which case a deactivated provider presents as "not found". The engine therefore treats not-found and status≠`A` both as FAILED, and the not-found copy mentions possible deactivation (to be confirmed against a known deactivated NPI in Phase 1; tracked as a risk, test-plan R-06).

### 3.6 Audit & evidence writers
* **Audit writer** appends to `audit_log` (Postgres) in the same request lifecycle, via an outbox-style insert **before** returning a response for verification/export actions (fail-closed: if the audit insert fails, the action fails). For high-volume search/lookup reads, the write is synchronous but lightweight; if the DB is unavailable, reads fail-closed too — we prefer unavailability to unaudited access.
* **Evidence writer** stores `{snapshot_id, npi, raw_payload (jsonb), payload_sha256, expected (jsonb), result (jsonb), retrieved_at, user_id}`. Insert-only table; a DB role without UPDATE/DELETE; sha256 allows later tamper-evidence checks.

### 3.7 Batch worker (Phase 2)
Postgres-backed queue; one row per batch, one per item. Worker claims items with `FOR UPDATE SKIP LOCKED`, processes through the same NPPES client (so limits apply globally), writes result rows; supports cancel (checked between items) and crash recovery (items `RUNNING` beyond a lease are re-queued). Batch lane has a lower token-bucket share (max 3 rps) so interactive users are not starved. 500 rows at 3 rps ≈ 3 minutes cold; much faster with cache hits.

### 3.8 UI
React SPA with a typed API client generated from the OpenAPI document. Components: `OmniSearch`, `AdvancedFilters`, `ResultsTable`, `ProviderDetail`, `VerifyPanel` (left: expected; right: NPPES; center: per-field badges), `BatchUploader`, `AuditExplorer`, `Provenance` strip. State via URL (shareable search links containing no PHI — only public search criteria). WCAG 2.1 AA test gates in CI (axe).

## 4. Data flow

### 4.1 NPI lookup (cache miss)
1. UI → `GET /providers/1063837144`.
2. API: authn/z → validator (`OK`) → audit "LOOKUP_REQUESTED".
3. Lookup service: Redis `GET npi:v1:1063837144` → miss.
4. NPPES client: single-flight → limiter → `GET …/api/?version=2.1&number=1063837144`.
5. Response has `results[0]` → mapper → normalized provider.
6. Redis `SETEX` 24 h (raw + normalized, `retrievedAt`).
7. Audit "LOOKUP_COMPLETED {npi, cache: MISS}" → 200 with provenance.

Variants: **zero results** → cache negative sentinel 15 min → 404 `NPI_NOT_FOUND`. **`Errors` body** → map → 400, no cache. **Transport failure** → retry → breaker → serve stale if present (cache: STALE, banner) else 503.

### 4.2 Search
Canonicalize criteria (lowercase, trim, sorted keys, defaults filled) → key `search:v1:<sha256(canonical)>` → TTL 1 h. Stores only the page of summaries plus per-record raw payloads are *not* separately cached from search (a lookup is authoritative for detail). Because NPPES returns full provider objects in search results, the service opportunistically warms `npi:v1:*` entries **only if absent**, tagged `source: search` with a 1 h TTL, so a click-through avoids another call without extending staleness beyond the search TTL.

### 4.3 Verification
1. `POST /verifications` → authz (Verifier).
2. **Cache bypass**: fresh upstream fetch (verification is evidence; it must reflect NPPES *now*). Result also refreshes the 24 h lookup cache.
3. `verify()` pure compute.
4. Transaction: insert snapshot + audit row. Commit, then respond 201.
5. Failure of NPPES (transport) → 503; **no snapshot** is written for a failed attempt but an audit row records `VERIFY_ERROR`.

### 4.4 Batch
Upload → parse and validate every row locally (Luhn, required columns) → reject bad rows with row numbers → enqueue valid rows → workers verify with cache **allowed** for items (batch tolerates ≤ 24 h staleness; this is a documented difference and the CSV output carries `retrieved_at`) → progress polling → CSV. Individual item snapshots are stored (evidence) so the batch is auditable per-NPI.

## 5. Caching strategy

| Cache | Key | TTL | Notes |
|---|---|---|---|
| NPI record | `npi:v1:{npi}` | 24 h | Provider records change slowly; NPPES itself updates asynchronously. |
| Negative | `npi:v1:{npi}:404` | 15 min | Short: a newly issued NPI should appear quickly. |
| Search page | `search:v1:{hash}` | 1 h | Includes `page`, `pageSize`. |
| Typeahead taxonomy list | `taxonomy:v1` | 7 d | Seeded from NUCC code set; refreshed weekly. |
| Errors | — | never | `Errors[]` and transport failures are not cached. |

Design points:
* **Versioned keys** (`v1`) so a mapper change invalidates by bumping the version, no flush needed.
* **Stale-while-error:** entries are stored with a soft TTL (above) and a hard TTL of 7 days. When upstream fails and the soft TTL has expired, a stale entry is served with `cache: STALE` and a visible warning. Verification **never** uses stale data.
* **Stampede protection:** single-flight (§3.3) plus ±10% TTL jitter.
* **Forced refresh** (`refresh=true`): bypass read, write-through on success; audited; limited to Verifiers; counts against per-user rate limit.
* **Provenance:** `retrievedAt` is stored with the entry and returned to the UI on every read, plus NPPES `last_updated` — freshness is never hidden.
* **No caching in browsers** for provider data (`Cache-Control: private, no-store`) to keep the audit story clean.

## 6. Error handling

### 6.1 Taxonomy

| Class | Examples | Retry? | Cached? | HTTP out | User sees |
|---|---|---|---|---|---|
| Local validation | not 10 digits, Luhn fail, state-only, short wildcard | no | no | 400 | Field-level message (no upstream call made) |
| Upstream validation | `Errors[]` codes 03/05/06/07 | no | no | 400 | Mapped message; indicates our validator missed a rule → increments `nppes_validation_escape` metric |
| Upstream contract/config | `Errors` 17 | no | no | 500 | "Service misconfigured"; alert |
| Not found | `result_count: 0` | no | negative 15 min | 404 | "Valid NPI format, not found in NPPES" |
| Transient transport | timeout, reset, 502/503/504 | yes, 3× | no | 503 if exhausted | "NPPES is temporarily unavailable. Try again." |
| Protocol | 200 with neither `results` nor `Errors`; invalid JSON | once | no | 502 | Generic + request ID |
| Local limit | per-user rate exceeded | no | no | 429 | "Slow down" with countdown |

### 6.2 Critical rule: HTTP 200 is not success
The NPPES client inspects the body for `Errors` before anything else. A unit test with a recorded fixture of each observed error body guards this, and a contract test runs nightly against the live API to detect changes in codes or shapes (§9).

### 6.3 Circuit breaker
Closed → Open after 5 consecutive transport failures or > 50% failures in a 30 s window with ≥ 10 requests. While Open: serve stale where permitted, otherwise immediate 503 with `retryable: true` and `Retry-After: 30`. Half-open: one probe every 30 s; two successes close. State in Redis so replicas agree. Breaker state surfaces in the UI as a top-of-page banner.

### 6.4 Idempotency & partial failure
All upstream calls are GETs and safe to retry. Batch items are independent; failure of one never fails the batch; `ERROR` items can be re-run individually.

### 6.5 Fail-closed vs fail-open
* Audit write fails → request fails (fail-closed).
* Redis unavailable → bypass cache, call NPPES directly under an in-process limiter (degraded, lower caps); alert.
* Postgres unavailable → read endpoints fail (cannot audit).

## 7. Security and privacy

* OIDC SSO; RBAC enforced in middleware and re-checked in services; admin role separate.
* NPPES data is public but access patterns are not; searches are audit-logged. Logs hold request IDs and NPIs, never free-text names beyond the audit table.
* Sole-proprietor addresses may be residential; UI warns; exports carry the same notice.
* CSV exports escape formula-leading characters. Uploads: size/row limits, strict parsing, no server-side evaluation.
* Egress allow-list limited to `npiregistry.cms.hhs.gov`; TLS verification on; no HTTP.
* Secrets: none required for NPPES; DB/Redis credentials from the secrets manager.
* Dependency scanning and SAST in CI; threat model review before pilot.

## 8. Operations

* **Metrics:** `nppes_requests_total{outcome}`, `nppes_latency_seconds`, `cache_hits_total{type}`, `limiter_wait_seconds`, `breaker_state`, `audit_write_failures_total`, `verification_verdict_total{verdict}`, `nppes_validation_escape_total`.
* **Alerts:** breaker open > 5 min; upstream error rate > 5% for 10 min; audit write failure > 0; p95 latency SLO breach.
* **Config (no redeploy):** rate, concurrency, TTLs, feature flags, breaker thresholds.
* **Deployment:** 2+ stateless replicas, rolling deploys; DB migrations backward-compatible; Redis loss is non-fatal.
* **Runbook:** "NPPES down" (confirm via CMS status/probe; breaker handles; communicate to users; manual web UI is fallback), "IP blocked/429" (stop batch lane, reduce rate, contact CMS using the User-Agent contact).
* **Data retention:** audit and snapshots 7 years (partition by month; cold-store after 2 years); cache is ephemeral.

## 9. Testing strategy (summary; see `test-plan.md`)

* **Unit:** validator (Luhn vectors), mapper (fixtures from real responses), verification engine (property tests on normalization), limiter math.
* **Contract:** recorded fixtures for success/zero results/each observed `Errors`; plus a **nightly live contract test** (the probe in `evidence/probe.py` is its seed) that asserts the assumptions in api-spec Part A still hold and pages the team when NPPES changes.
* **Integration:** service with real Redis/Postgres and a fake NPPES server that can inject latency, 5xx, malformed bodies, and `Errors`.
* **E2E:** Playwright against the stack + fake NPPES; selected smoke tests against live NPPES gated to a low rate.
* **Non-functional:** load (limiter enforcement under concurrency), accessibility (axe + manual), security (ZAP baseline, upload fuzzing).

## 10. Alternatives considered

| Option | Why not (for now) |
|---|---|
| Call NPPES directly from browsers | Cannot rate-limit/audit/cache centrally; CORS and egress policy issues. |
| Mirror the NPPES bulk dissemination file | Large (multi-GB), monthly cadence plus weekly increments; strong for fuzzy/analytics search but heavy for v2. Revisit if API limits bite (Phase 3). |
| In-memory cache only | Replicas diverge; limiter state per-instance multiplies upstream rate. |
| Third-party NPI APIs | Adds vendor, cost, and a second source of truth; our evidentiary claim is "CMS primary source". |
| Dedicated message broker for batches | Overkill for ≤ 500-row jobs; Postgres queue suffices and is one fewer system. |

## 11. Risks and open items

1. **Deactivated NPI behavior in the API is unconfirmed** (may present as not-found). Verify with a known deactivated NPI in week 1; adjust copy and engine rules.
2. **Undocumented upstream limits.** Conservative defaults; monitor; coordinate with CMS if usage grows.
3. **Name normalization edge cases** (hyphenation, suffixes, transliteration) will cause false REVIEW verdicts; track REVIEW-disposition outcomes to tune.
4. **Search quality is whatever NPPES gives us** (no fuzzy/phonetic guarantees). Set expectations in UX and training.
5. **Audit fail-closed** raises availability coupling to Postgres; accepted trade-off, with HA database.
