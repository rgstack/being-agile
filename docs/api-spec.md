# API Specification — Provider Lookup & NPI Verification

This document has two parts: **Part A** describes the upstream CMS NPPES NPI Registry API v2.1 as it actually behaves (including behaviors verified by live probe on 2026-10-05; see `evidence/probe.py`), and **Part B** specifies the internal REST API our service exposes to the UI.

---

# Part A — Upstream: CMS NPPES NPI Registry API v2.1

## A.1 Endpoint

```
GET https://npiregistry.cms.hhs.gov/api/?version=2.1&<params>
```

* Public, no authentication or API key. HTTPS only.
* A single endpoint serves every query; behavior is determined by query parameters.
* `version` is **required**. Omitting it or sending an unknown value returns error 17 "Unsupported Version" (observed).
* Responses are `application/json` with `Cache-Control: no-cache, no-store, must-revalidate`, so intermediaries and browsers will not cache for us — we must cache ourselves.
* No rate-limit headers (`X-RateLimit-*`, `Retry-After`) were observed. There is no published quota.

## A.2 Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `version` | string | **Required.** We always send `2.1`. |
| `number` | 10-digit string | The NPI. Exact match. NPPES does **not** validate the check digit: a Luhn-invalid but 10-digit value returns `result_count: 0`, not an error. A value that is not 10 digits returns error 06. |
| `enumeration_type` | `NPI-1` \| `NPI-2` | Individual vs. organization. Other values → error 05. |
| `taxonomy_description` | string | e.g. `Cardiology`, `Counselor`. Wildcard rules apply. |
| `first_name` | string | NPI-1. Trailing `*` wildcard. (Whether it also matches `other_names` aliases is not verified; we do not assume it.) |
| `last_name` | string | NPI-1. Trailing `*` wildcard. |
| `organization_name` | string | NPI-2. Trailing `*` wildcard; also matches Doing-Business-As names. |
| `city` | string | Which address purpose (LOCATION vs MAILING) NPPES matches is not verified; results are shown with both addresses so users can see the match basis. |
| `state` | 2-letter code | **Cannot be the only criterion** — error 07 (observed). |
| `postal_code` | 5 or 9 digits | Can be combined with other criteria. |
| `country_code` | 2-letter code | Not exposed in v2 UI. |
| `limit` | integer | Default 10. **Maximum 200**; larger values are silently clamped to 200 (observed: `limit=300` → 200 results). |
| `skip` | integer | Offset for paging. Observed to work at 1000 and 1200; documentation has historically cited a ceiling of 1000, so we cap at 1000 and do not rely on deeper behavior. |
| `pretty` | `true` | Formatting only; we don't use it. |

**Wildcards:** a trailing `*` requires at least two leading characters (error 03, observed with `s*`). Names are case-insensitive.

**Not a general query language:** parameters are ANDed; no OR, no negation, no sorting control, no total-count return.

## A.3 Response shape (success)

```jsonc
{
  "result_count": 1,          // number of results in THIS response (page size), NOT a grand total
  "results": [ { ...provider... } ]
}
```

`result_count: 0` with an empty `results` array means no match (not an error).

### Provider object — NPI-1 (individual), abridged from a live response

```jsonc
{
  "number": "1063837144",
  "enumeration_type": "NPI-1",
  "created_epoch": "1393416364000",       // string, ms
  "last_updated_epoch": "1619378753000",  // string, ms
  "basic": {
    "first_name": "JACKELYN", "middle_name": "RAE", "last_name": "KELLEY",
    "credential": "LCSW", "sex": "F",
    "enumeration_date": "2014-02-26", "last_updated": "2021-04-25",
    "certification_date": "2021-04-23",
    "sole_proprietor": "NO",
    "status": "A"                          // "A" = active (observed). Deactivated representation unverified
  },
  "other_names": [ { "type": "Other Name", "code": "5", "first_name": "JACK", "last_name": "SMITH", "middle_name": "RAE", "prefix": "--", "suffix": "--" } ],
  "addresses": [
    { "address_purpose": "MAILING",  "address_type": "DOM", "address_1": "141 OAK PL", "city": "PITTSBURG", "state": "CA", "postal_code": "945653820", "country_code": "US", "telephone_number": "724-544-3437" },
    { "address_purpose": "LOCATION", "address_type": "DOM", "address_1": "1001 POTRERO AVE", "address_2": "WARD 93", "city": "SAN FRANCISCO", "state": "CA", "postal_code": "941103518", "country_code": "US", "telephone_number": "724-544-3437" }
  ],
  "taxonomies": [
    { "code": "101Y00000X",  "desc": "Counselor", "primary": false, "state": "CA", "license": "60311", "taxonomy_group": "" },
    { "code": "1041C0700X", "desc": "Social Worker, Clinical", "primary": true, "state": "CA", "license": "100708", "taxonomy_group": "" }
  ],
  "identifiers": [],
  "endpoints": [],
  "practiceLocations": []
}
```

### Provider object — NPI-2 (organization), differences

`basic` carries `organization_name`, `organizational_subpart` ("YES"/"NO"), `status`, `enumeration_date`, `last_updated`, and authorized-official fields (`authorized_official_first_name`, `_last_name`, `_title_or_position`, `_credential`, `_telephone_number`, …). `other_names` entries use `type: "Doing Business As"` with `organization_name`.

### Field-handling rules (our integration layer)

| Observation | Rule |
|---|---|
| `postal_code` arrives as 5 or 9 digits **without hyphen** (`945653820`) | Normalize for display to `94565-3820`; compare on first 5 digits unless the enrollment ZIP is 9 digits. |
| Exactly one taxonomy has `primary: true` (verified on sample) | Treat `primary:true` as authoritative; if none or multiple, flag data anomaly rather than guess. |
| Placeholders `"--"` appear for empty prefix/suffix | Treat as empty. |
| Epoch fields are **strings** | Parse to integer ms before use. |
| Numeric-like fields are strings (`number`, `license`) | Never coerce to integer (leading zeros). |
| Names are upper-case | Compare case-insensitively; display in title case only with the original available. |
| `identifiers[]` and `endpoints[]` may be empty arrays | UI hides empty sections. |
| Unknown additional fields may appear | Parse permissively; ignore unknown keys; keep raw payload for snapshots. |

## A.4 Error responses

Validation errors are returned with **HTTP 200** and a body containing `Errors`; there is no `results` key. Example (observed):

```json
{"Errors":[{"description":"NPI must be 10 digits","field":"number","number":"06"}]}
```

| Number | Field | Observed description | Cause | Our user-facing message |
|---|---|---|---|---|
| `03` | e.g. `last_name` | Wildcards require at least two leading characters | `s*` | "Enter at least two letters before the \*." |
| `05` | e.g. `enumeration_type` | Field contains special character(s) or wrong number of characters | `NPI-3` | "Provider type must be Individual or Organization." |
| `06` | `number` | NPI must be 10 digits | `number=123` | "An NPI is exactly 10 digits." |
| `07` | e.g. `state` | Field state requires additional search criteria | `state` alone | "Add a name, city, ZIP, or specialty — state alone is too broad." |
| `17` | `version` | Unsupported Version | missing/unknown `version` | Internal error (our bug) — "Service misconfigured"; page on-call. |

Other codes exist upstream and are not exhaustively documented; unknown numbers fall through to a generic message with the `description` logged.

**Transport-level:** timeouts, connection resets, and 5xx (including 502/503/504 from the CMS edge) are possible and unpublished in frequency. 4xx for malformed URLs may occur. These are handled by retry/backoff (design §6).

## A.5 Rate-limit and API-citizen etiquette

NPPES publishes no numeric limit. We therefore commit to the following, stricter than any limit we have reason to expect:

1. Server-side only; browsers never call NPPES.
2. ≤ 5 requests/second global (token bucket, burst 5) and ≤ 4 concurrent; both configurable.
3. Identical concurrent requests collapse to one upstream call (single-flight).
4. Cache aggressively (24 h NPI / 1 h search / 15 min negative) because the registry's own caching is disabled.
5. Retry only idempotent GETs, ≤ 3 attempts, exponential backoff 500 ms → 1 s → 2 s with ±25% jitter; stop immediately on `Errors` (those are deterministic, not transient).
6. Circuit breaker: open after 5 consecutive transport failures or >50% failures in 30 s over ≥ 10 requests; half-open probe every 30 s.
7. Batch and scheduled work runs at lower priority than interactive requests and respects a daily budget.
8. Send a descriptive `User-Agent` (`<org>-provider-lookup/<version> (contact: <team-mailbox>)`) so CMS can reach us if we misbehave.
9. Never page beyond `skip=1000`; ask users to narrow criteria instead.

---

# Part B — Internal API (service → UI)

Base path `/api/v1`. JSON. Auth: OIDC bearer/session cookie; roles per REQ-013. All responses include `X-Request-Id`. Errors use a uniform envelope:

```json
{ "error": { "code": "NPI_CHECK_DIGIT_INVALID", "message": "…", "field": "npi", "retryable": false, "requestId": "…" } }
```

| HTTP | Meaning |
|---|---|
| 400 | Validation failure (our rules or mapped NPPES `Errors`) |
| 401/403 | Not authenticated / role insufficient |
| 404 | Valid NPI, not found in NPPES (`NPI_NOT_FOUND`) |
| 429 | Local rate limit (per-user) exceeded; `Retry-After` set |
| 502 | NPPES returned unusable output |
| 503 | NPPES unavailable and no (stale) cache available; `retryable: true` |

### B.1 `GET /providers/{npi}` — Viewer+
Returns one normalized provider.

Query: `refresh=true` (Verifier+) bypasses cache.

Errors: `400 NPI_FORMAT_INVALID`, `400 NPI_CHECK_DIGIT_INVALID`, `404 NPI_NOT_FOUND`, `503 UPSTREAM_UNAVAILABLE`.

```jsonc
// 200
{
  "npi": "1063837144",
  "type": "INDIVIDUAL",
  "status": "ACTIVE",                 // ACTIVE | DEACTIVATED | UNKNOWN(<raw>)
  "name": { "first": "JACKELYN", "middle": "RAE", "last": "KELLEY", "credential": "LCSW" },
  "organization": null,
  "primaryTaxonomy": { "code": "1041C0700X", "description": "Social Worker, Clinical", "license": "100708", "state": "CA" },
  "taxonomies": [ { "code": "…", "description": "…", "primary": true, "license": "…", "state": "…" } ],
  "locationAddress": { "line1": "1001 POTRERO AVE", "line2": "WARD 93", "city": "SAN FRANCISCO", "state": "CA", "postalCode": "94110-3518", "phone": "724-544-3437" },
  "mailingAddress":  { "…": "…" },
  "otherNames": [ { "type": "Other Name", "first": "JACK", "last": "SMITH" } ],
  "soleProprietor": false,
  "identifiers": [], "endpoints": [], "practiceLocations": [],
  "nppes": { "enumerationDate": "2014-02-26", "lastUpdated": "2021-04-25" },
  "provenance": { "source": "CMS NPPES API v2.1", "retrievedAt": "2026-10-05T14:02:11Z", "cache": "HIT|MISS|STALE|BYPASS" }
}
```

### B.2 `GET /providers` — Viewer+
Search. Query params map to NPPES: `type` (INDIVIDUAL|ORGANIZATION → `enumeration_type`), `firstName`, `lastName`, `organizationName`, `taxonomy`, `city`, `state`, `postalCode`, `pageSize` (10|25|50|100|200, default 25), `page` (1-based; internally `skip=(page-1)*pageSize`).

Validation (before upstream call): at least one criterion besides `state`; wildcard rule; `page*pageSize ≤ 1000` else `400 PAGING_DEPTH_EXCEEDED`.

```jsonc
// 200
{
  "items": [ { "npi": "…", "type": "…", "displayName": "…", "primaryTaxonomy": "…", "city": "…", "state": "…", "status": "ACTIVE", "lastUpdated": "2021-04-25" } ],
  "page": 1, "pageSize": 25,
  "hasMore": true,                    // true iff items.length == pageSize (NPPES gives no total)
  "provenance": { … }
}
```
There is deliberately no `total` field.

### B.3 `POST /verifications` — Verifier+
Runs a verification. Always fetches fresh from NPPES, writes an evidence snapshot.

```jsonc
// request
{
  "npi": "1063837144",
  "expected": {
    "type": "INDIVIDUAL",                 // optional
    "firstName": "Jackelyn", "lastName": "Kelley", "credential": "LCSW",
    "primaryTaxonomyCode": "1041C0700X",
    "practiceState": "CA", "practiceZip": "94110"
  }
}
// 201
{
  "verificationId": "ver_01J…",
  "verdict": "VERIFIED",                  // VERIFIED | REVIEW | FAILED
  "reason": null,                         // e.g. NPI_NOT_FOUND | NPI_DEACTIVATED | TYPE_MISMATCH
  "fields": {
    "name":       { "result": "MATCH", "expected": "Jackelyn Kelley", "actual": "JACKELYN KELLEY", "matchedOn": "primary" },
    "credential": { "result": "MATCH" },
    "taxonomy":   { "result": "MATCH", "matchedOn": "primary" },     // or "secondary"
    "location":   { "result": "MATCH" }
  },
  "snapshotId": "snap_01J…",
  "nppes": { "lastUpdated": "2021-04-25", "status": "A" },
  "retrievedAt": "2026-10-05T14:02:11Z"
}
```
Verdict rules: `FAILED` if NPI not found, status ≠ `A`, or provided `type` ≠ enumeration type. Else `REVIEW` if any provided field is `MISMATCH`. Else `VERIFIED`. `NOT_PROVIDED` fields do not affect the verdict but are shown.

`GET /verifications/{id}` returns the stored result; `GET /verifications/{id}/export?format=pdf|json` returns the evidence artifact.

### B.4 `POST /batches` — Verifier+ (Phase 2)
`multipart/form-data` with `file` (CSV, ≤ 500 data rows, ≤ 1 MB, UTF-8). Header: `npi` (required), `first_name`, `last_name`, `credential`, `taxonomy_code`, `state`, `zip`.
Response `202 { "batchId": "bat_…", "accepted": 483, "rejected": [ { "row": 17, "code": "NPI_CHECK_DIGIT_INVALID" } ] }`.
`GET /batches/{id}` → `{ status: QUEUED|RUNNING|COMPLETE|CANCELLED|FAILED, processed, total, counts: {VERIFIED, REVIEW, FAILED, ERROR} }`.
`DELETE /batches/{id}` cancels. `GET /batches/{id}/results.csv` downloads (formula-injection-safe). Rows with transport failure after retries are marked `ERROR` (retryable), not `FAILED`.

### B.5 `GET /audit` — Auditor+
Filters: `user`, `action`, `npi`, `from`, `to`; cursor pagination (`cursor`, `limit ≤ 200`); `GET /audit/export.csv`. Read-only; there is no mutation endpoint.

### B.6 Operational
`GET /healthz` (liveness), `GET /readyz` (readiness, includes cache/DB), `GET /metrics` (Prometheus; internal network only). An upstream NPPES outage affects `/readyz` detail but does not fail readiness, since stale cache can still serve.

## B.7 Reference: NPI check-digit algorithm
Prefix the 9-digit base with `80840`, compute the Luhn check digit; the 10th digit of the NPI must equal it. Equivalent: run Luhn validation on `80840` + the full 10-digit NPI and require `sum % 10 == 0`. Known valid example from CMS documentation: `1234567893`.
