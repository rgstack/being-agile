# Product Requirements Document — Provider Lookup & NPI Verification

| | |
|---|---|
| **Owner** | Product, Provider Network Operations |
| **Status** | Draft v2 (post-critique) |
| **Last updated** | 2026-10-05 |
| **Upstream data source** | CMS NPPES NPI Registry API v2.1 — `https://npiregistry.cms.hhs.gov/api/` (public, unauthenticated) |
| **Related docs** | `design.md`, `api-spec.md`, `stories.json`, `test-plan.md`, `test-cases.json`, `proof-report.md` |

---

## 1. Problem statement

Our Enrollment & Credentialing department onboards and re-credentials thousands of practitioners and facilities every year. Every one of those files begins with an NPI, and every downstream process — claims adjudication, directory publication, delegated-credentialing audits, CMS and state network-adequacy filings — inherits whatever we recorded at intake. When the NPI or its associated attributes are wrong, the cost is paid months later and in places far from the root cause.

Today, verification is a manual, inconsistent practice:

* **Analysts open the NPPES web UI in a browser tab**, search by name, eyeball the result against the application, and paste values into the credentialing system. There is no record of *what* was checked, *when*, or *by whom*. In an NCQA or URAC audit, "primary source verification of NPI" is attested to by a checkbox, not by evidence.
* **Typos survive intake.** A single transposed digit in an NPI either points to a different real provider (a silent, dangerous mismatch) or to nothing. NPPES does *not* validate the check digit server-side — we confirmed that a Luhn-invalid NPI returns `{"result_count":0}` rather than an error — so "no results" is ambiguous between "mistyped" and "doesn't exist".
* **Name and taxonomy drift goes unnoticed.** Providers change names, add and drop taxonomy codes, relocate practices, and are deactivated. NPPES is self-reported and updated by the provider, so its `last_updated` date matters. Our records are rarely compared to it after the initial enrollment.
* **LOCATION versus MAILING addresses are conflated.** NPPES stores both. Directory and network-adequacy work needs the practice location; analysts routinely copy the mailing address (often a billing office, a PO box, or — for sole proprietors — a home address).
* **Volume work is impractical.** Roster onboarding for a new medical group (hundreds of NPIs) is done one NPI at a time, or not done.
* **Shared, unprotected effort.** The public API is shared infrastructure. Ad-hoc scripts written by individual analysts hammer it without caching or back-off, and are fragile when NPPES changes behavior.

### Impact (baseline hypotheses to be measured in pilot)

| Pain | Observable symptom | Pilot metric |
|---|---|---|
| Wrong/mistyped NPIs at intake | Claim rejections, directory complaints | % of enrollments with NPI mismatch found post-intake |
| No audit trail | Audit findings on primary source verification | % of credential files with verification evidence |
| Slow manual search | Analyst minutes per verification | Median time to verify one provider |
| Stale data | Directory inaccuracy, member complaints | % of active providers re-verified in last 12 months |

---

## 2. Target users

| Persona | Role | Primary needs |
|---|---|---|
| **Dana — Enrollment Analyst** | Keys new provider applications daily | Fast, forgiving lookup; instant confidence that the NPI belongs to the person on the application; no copy/paste errors |
| **Marcus — Credentialing Specialist** | Builds and maintains credential files for committee review | Defensible, time-stamped evidence of primary source verification; clear flags for deactivated NPIs and discrepancies |
| **Priya — Provider Data Steward** | Owns directory and roster data quality | Batch verification for medical group rosters and periodic re-verification sweeps; exportable discrepancy lists |
| **Lee — Compliance / Audit Liaison** | Responds to NCQA, URAC, CMS, state audits | Searchable audit log of every lookup and verdict |
| **Sam — Platform Admin** | Operates the tool | Control over access, cache, and upstream load; observability |

Out of the user set: members, providers themselves, and external partners (no external access in any phase).

---

## 3. Goals and non-goals

### Goals

1. **Cut time-to-verify** a single provider from minutes of browser work to under 30 seconds, including documenting the result.
2. **Eliminate ambiguous "not found"** — distinguish malformed NPI, check-digit failure, unregistered NPI, and upstream failure.
3. **Make every verification evidentiary**: who, when, what query, what NPPES returned (including NPPES `last_updated`), and what verdict we reached.
4. **Surface discrepancies** between our enrollment record and NPPES (name, primary taxonomy, practice location, status) in a structured, reviewable way.
5. **Support roster-scale work** (up to 500 NPIs per batch) without abusing NPPES.
6. **Be a good API citizen**: cache, rate-limit, and back off so one department never causes an upstream incident or an IP block.

### Non-goals

* **Not a credentialing system of record.** We do not store licenses, DEA, board certification, sanctions, or malpractice history. NPPES does not provide them; separate primary sources (state boards, OIG LEIE, SAM.gov, ABMS) are out of scope for v2.
* **Not an NPPES write path.** We never create or update NPIs; providers do that in NPPES.
* **No auto-correction of enrollment records.** The tool flags discrepancies; humans decide. (Write-back to the credentialing system is a Phase 3 candidate.)
* **No mirror of the full NPPES dissemination file.** We may revisit a bulk-file-backed search if API limits become a blocker; it is not in v2.
* **No external/provider-facing access.**
* **No claim of "licensed" or "credentialed" status.** An active NPI means the identifier is active. The UI must never imply licensure or network eligibility.

---

## 4. Requirements

Priority: **P0** = must ship in Phase 1; **P1** = Phase 2; **P2** = Phase 3 / stretch.

### REQ-001 — Direct NPI lookup with check-digit validation (P0)
The user can enter a 10-digit NPI and retrieve the matching registry record. Before any upstream call, the client and server MUST validate length (10 digits, numeric, whitespace/hyphens stripped) and the Luhn check digit computed with the CMS `80840` prefix. Invalid input is rejected with a specific message (not 10 digits vs. check digit fails) and no upstream call is made. A well-formed NPI with zero results is reported as "valid NPI format, not found in NPPES".
*Rationale:* NPPES does not validate check digits; both mistyped and nonexistent NPIs produce `result_count: 0`.

### REQ-002 — Individual provider search (NPI-1) (P0)
The user can search individuals by `last_name` (required) with optional `first_name` and `state`, executed with `enumeration_type=NPI-1`. Trailing wildcards are supported only with at least two leading characters (matching NPPES error 03); the UI prevents submitting a shorter wildcard. Name matching is displayed as-returned; the UI does not claim fuzzy matching beyond what NPPES provides.

### REQ-003 — Organization search (NPI-2) (P0)
The user can search organizations by `organization_name` (trailing wildcard allowed, ≥2 leading chars) with optional location filters, executed with `enumeration_type=NPI-2`. Results display the legal business name and any `other_names` of type "Doing Business As", and the authorized official's name and title where present.

### REQ-004 — Search filters and minimum-criteria guard (P0)
Users can narrow searches with `taxonomy_description`, `city`, `state`, and `postal_code`. The tool enforces NPPES's rule that `state` cannot be the sole criterion (error 07) by blocking submission client-side with an explanation. Postal codes accept 5-digit or 9-digit input. Taxonomy description is selected from a typeahead of known descriptions where available but accepts free text.

### REQ-005 — Paginated results with honest counts (P0)
Search results are paginated using NPPES `limit` and `skip`. Page size is user-selectable (10, 25, 50, 100, 200; default 25; never above 200). Because NPPES `result_count` reflects the size of the *returned page* and not a grand total, the UI MUST NOT display a total ("of N") and instead shows "Showing X–Y" with Next enabled when a full page was returned. Paging depth is capped at 1,000 records per query, after which the UI prompts the user to narrow criteria.

### REQ-006 — Provider detail view (P0)
Selecting a result opens a detail view presenting: NPI, enumeration type, status, enumeration date, `last_updated`; name/credential (NPI-1) or organization data (NPI-2); the **primary taxonomy** visually distinguished from other taxonomies, each with code, description, license number and state; **LOCATION and MAILING addresses presented separately and labeled**; phone; `other_names`; `identifiers[]`; `endpoints[]`; and `practiceLocations[]` where present. Postal codes are formatted (ZIP+4) from the unhyphenated 9-digit form NPPES returns. For `sole_proprietor: YES` records a notice warns that listed addresses may be a residence.

### REQ-007 — Verification against the enrollment record (P0)
Given an NPI and a set of submitted attributes (name, credential, primary taxonomy code, practice state/ZIP), the tool compares them to NPPES and returns a per-field result — **MATCH**, **MISMATCH**, or **NOT_PROVIDED** — and an overall verdict: **VERIFIED**, **REVIEW** (any mismatch), or **FAILED** (NPI not found, deactivated, or enumeration type wrong). Comparison is case-insensitive, whitespace- and punctuation-normalized, compares against all `other_names` as well as the primary name, and compares taxonomy against *all* taxonomies while noting whether the match was the primary one. A deactivated NPI (`basic.status` ≠ `A`) always yields FAILED regardless of other matches. (Open item: the API may omit deactivated NPIs entirely, in which case they surface as not-found; both paths yield FAILED and the not-found message mentions possible deactivation. To be confirmed against a known deactivated NPI in week 1.) The verification can be saved as an evidence snapshot (REQ-012) and exported as PDF and JSON.

### REQ-008 — Batch verification (P1)
A Data Steward can upload a CSV of up to 500 rows (`npi` required; optional name, taxonomy, state, ZIP) and receive per-row verdicts per REQ-007. Processing is asynchronous with visible progress, honors upstream rate limits (REQ-011), tolerates partial failure (failed rows are reported, not fatal), is cancellable, and yields a downloadable CSV with verdict, per-field results, and NPPES `last_updated`. Malformed rows are reported with row numbers and do not abort the batch.

### REQ-009 — Error handling and messaging (P0)
All NPPES failure modes are mapped to actionable user messages. Critically, NPPES returns validation errors with **HTTP 200** and an `Errors[]` body (`{description, field, number}`); the integration layer MUST treat the presence of `Errors` as failure. Known codes (03, 05, 06, 07, 17) map to field-level messages. Transport failures (timeout, 5xx, DNS, connection reset) are retried with bounded exponential backoff and surfaced as "NPPES is temporarily unavailable" — never as "no results". Unknown error numbers are shown generically with the raw description available under "details" and logged.

### REQ-010 — Caching with visible freshness (P0)
NPI lookups are cached for 24 hours; search results for 1 hour; negative results ("not found") for 15 minutes; errors are never cached. Every result shows when it was retrieved from NPPES ("Retrieved 2026-10-05 14:02 UTC · cached") alongside NPPES's `last_updated`. A user with the Verifier role can force a refresh that bypasses the cache; verification snapshots (REQ-012) always use a fresh fetch.

### REQ-011 — Upstream protection and resilience (P0)
All NPPES traffic originates from the server-side proxy (never directly from browsers). The proxy enforces a global concurrency ceiling (default 4 in-flight), a token-bucket rate (default 5 requests/second), de-duplicates identical in-flight requests (single-flight), honors `Retry-After` if ever returned, and opens a circuit breaker after sustained failure, serving stale cache entries (flagged as stale) where available. Limits are configurable without redeploy.

### REQ-012 — Audit trail and evidence snapshots (P0)
Every lookup, search, verification, batch run, export, and forced refresh is written to an append-only audit log containing: user ID, role, UTC timestamp, action, normalized query parameters, result NPIs (not full payloads for searches), verdict where applicable, cache hit/miss, and request ID. Verification evidence snapshots store the full NPPES payload used, its hash, and the comparison result, immutable once written. Retention: 7 years (aligned to our records-retention schedule). Compliance users can search/filter the log and export it.

### REQ-013 — Access control and data handling (P0)
Authentication via corporate SSO (OIDC). Three roles: **Viewer** (search, view), **Verifier** (+ verify, batch, refresh, export), **Auditor** (read-only on audit log and snapshots). Admin settings sit behind a separate **Admin** role. Although NPPES is public data, search activity reveals enrollment pipeline information and is therefore access-controlled and logged. No NPPES data is stored beyond the cache and evidence snapshots; free-text user input is never written to application logs beyond the audit record.

---

## 5. Non-functional requirements

* **Performance:** p95 server overhead ≤ 150 ms on cache hit; p95 end-to-end ≤ 3 s on cache miss under normal NPPES latency (observed ~0.4–1.2 s per call).
* **Availability:** 99.5% business-hours availability; degrade gracefully (stale cache) when NPPES is down.
* **Accessibility:** WCAG 2.1 AA; full keyboard operation; verdicts never conveyed by color alone.
* **Browser support:** current and previous major versions of Edge, Chrome, Safari.
* **Security:** OWASP ASVS L2 baseline; all inputs validated server-side; CSV uploads size-limited and formula-injection-safe on export (cells starting with `= + - @` prefixed).
* **Observability:** structured logs, metrics for upstream latency/error rate/cache hit ratio/rate-limiter wait, alerting on circuit open.

---

## 6. UX notes

* **One search box, smart routing.** A single input accepts an NPI or a name; a 10-digit numeric string routes to NPI lookup. An "Advanced" panel exposes the full filter set. Keep the common path (paste an NPI → get a verdict) to one screen and ≤ 2 interactions.
* **Verification is a first-class mode**, not a hidden feature: "Verify" tab with the enrollment fields on the left, NPPES record on the right, and a field-by-field comparison between them with textual badges (✔ Match / ✖ Mismatch / — Not provided), not just color.
* **Make the not-found taxonomy explicit.** Four distinct empty/error states: *Invalid format*, *Check digit failed (likely typo)*, *Valid format but not found in NPPES*, *NPPES unavailable — retry*. Each with a recommended next action.
* **Deactivated NPIs get a banner** at the top of the detail view and in list rows, with the deactivation context NPPES provides.
* **Show provenance on every screen**: "Source: CMS NPPES · Retrieved … · NPPES last updated …". Analysts quote this to auditors.
* **Address labeling**: "Practice Location" and "Mailing Address" as separate cards; never merge, never abbreviate to "Address".
* **Results table**: NPI, name/org, type, primary taxonomy, practice city/state, status, last updated. Sortable on the current page only (the UI states this) because NPPES controls ordering.
* **Copy affordances**: one-click copy of NPI, and "Copy verification summary" for pasting into the credentialing system until write-back exists.
* **Batch**: drag-and-drop CSV, template download, pre-flight validation summary ("483 valid, 17 rows with problems") before the run starts.
* **Accessibility**: focus management after search, `aria-live` for result counts and errors, table headers properly scoped.

---

## 7. Rollout and phasing

### Phase 1 — Pilot (target: 6 weeks)
Scope: REQ-001–007, 009–013 (single-record flows, audit, SSO/RBAC, caching, rate-limiting). Audience: 8–10 Enrollment Analysts and 2 Credentialing Specialists. Exit gate: pilot success criteria below, no open Sev-1/Sev-2 defects, security review passed.

### Phase 2 — Department GA (+6 weeks)
Scope: REQ-008 batch verification; discrepancy reporting; scheduled re-verification sweeps for active providers (nightly low-priority queue, off-peak, strict budget). Training and documentation; deprecate unaudited ad-hoc scripts.

### Phase 3 — Integration (backlog, subject to approval)
Credentialing-system integration (API to attach evidence snapshots to a file; write-back of corrected fields with approval); evaluate NPPES bulk-file mirror; monitoring of NPPES change feeds for providers in network.

### Feature flags and rollback
Batch, forced refresh, and scheduled sweeps are individually flagged. Rollback is a flag-off plus the manual NPPES web UI path, which remains available throughout.

### Success criteria (pilot)

| Metric | Target |
|---|---|
| Median time to verify one provider (incl. documentation) | ≤ 30 s (baseline measured pre-pilot) |
| Verifications with a saved evidence snapshot | ≥ 95% of pilot enrollments |
| NPI keying errors caught pre-submission by check digit | Tracked; expected > 0 |
| Upstream NPPES error rate attributable to the tool | < 1% and zero IP blocks |
| Analyst satisfaction (survey) | ≥ 4 / 5 |

---

## 8. Assumptions, dependencies, risks

* **Assumption:** NPPES API v2.1 remains available and unauthenticated. No SLA exists; we design for outages.
* **Assumption:** NPPES data is self-reported and may be stale or wrong; it is *one* source, not truth.
* **Dependency:** Corporate SSO (OIDC), audit-log storage with 7-year retention, outbound HTTPS egress allow-list for `npiregistry.cms.hhs.gov`.
* **Risk — undocumented limits:** NPPES publishes no formal rate limit; we operate conservatively and monitor. *Mitigation:* REQ-011.
* **Risk — over-trust:** users read "Active NPI" as "credentialed". *Mitigation:* UX copy, training, and explicit non-goal.
* **Risk — PII:** sole proprietors' addresses may be residences. *Mitigation:* warning banner (REQ-006), access control (REQ-013), no secondary storage.

## 9. Open questions

1. Which credentialing platform and API will Phase 3 target, and who owns the integration?
2. Does Compliance require a longer than 7-year retention for evidence snapshots for delegated entities?
3. Should REVIEW verdicts require a reviewer disposition (accept/reject) recorded in the tool, or remain advisory until Phase 3?
