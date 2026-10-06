# Technical Design (condensed) — Provider Lookup & NPI Verification
Implements REQ-001..REQ-013. Upstream: CMS NPPES NPI Registry API v2.1. Full text: design.md.

## Drivers
Upstream is public/unauthenticated/unmetered/no-SLA: design for fewer calls + graceful degradation. Probed sharp edges: validation errors = HTTP 200 + Errors[]; no check-digit validation; result_count = page size; limit clamps at 200; Cache-Control: no-store. Output is evidence: snapshot payloads, never re-derive. Small team, internal tool: boring, operable tech over scale-first.

## Architecture
Browser SPA -> Provider Lookup Service (stateless, N>=2): API layer -> AuthZ -> input validation -> Lookup/Search/Verification services -> Redis cache + Postgres (audit, snapshots, batches) + Postgres-backed job queue; NPPES client (limiter, single-flight, retry, breaker) -> npiregistry.cms.hhs.gov/api/. Batch workers on a low-priority lane.
Stack: TypeScript/Node 22 (Fastify) or org-standard JVM; React SPA; Redis (TTLs, token bucket, single-flight locks); Postgres (7-year retention); OIDC SSO; OpenTelemetry/Prometheus.

## Components
API layer: authentication, RBAC (REQ-013), request IDs, schema validation, uniform error envelope, per-user 60 req/min.
Input validator (shared client+server, dependency-free): normalizeNpi strips whitespace/hyphens, rejects non-digits; isValidNpi = 10 digits + Luhn("80840"+s) returning FORMAT | CHECK_DIGIT | OK; validateSearch requires >=1 criterion besides state, wildcard >=2 chars, ZIP 5/9 digits, depth <=1000, pageSize in {10,25,50,100,200}. Server re-validates everything.
NPPES client (sole upstream talker): always version=2.1; parameter whitelist; descriptive User-Agent with contact mailbox; 8s timeout; single-flight (in-process + Redis SET NX PX 10000); token bucket 5 rps burst 5 + counting semaphore 4 (interactive priority lane; batch yields); circuit breaker; retry transport/502/503/504 only, 3 attempts jittered backoff; parse: Errors present -> NppesValidationError (never retried, never cached); neither results nor Errors -> NppesProtocolError.
Mapper: raw NPPES -> normalized model; ZIP+4 display; "--" -> empty; string epochs parsed to ms; exactly one primary:true taxonomy else anomaly flag; LOCATION vs MAILING split; status A -> ACTIVE else DEACTIVATED/UNKNOWN (raw preserved); unknown fields tolerated; raw payload retained for snapshots.
Verification engine (pure function, no I/O): name normalization (NFKD, strip diacritics, uppercase, punctuation-normalized; generational suffixes separated); match against primary name OR any other_names (report matchedOn); credential token-set comparison (M.D. = MD); taxonomy vs ALL taxonomies (secondary-only match = MATCH with note); location: state equality required, ZIP at 5 digits (9 if expected 9), LOCATION address only (MAILING-only -> MISMATCH + note). Verdict per api-spec B.3; deactivated or not-found short-circuits FAILED.
Audit writer: append-only audit_log; fail-closed (audit insert fails -> request fails). Evidence writer: {snapshot_id, npi, raw_payload jsonb, payload_sha256, expected, result, retrieved_at, user_id}; insert-only table, no UPDATE/DELETE role.
Batch worker (Phase 2): Postgres queue, FOR UPDATE SKIP LOCKED; same NPPES client (global limits apply); cancel checked between items; crash recovery via lease re-queue; batch lane max 3 rps; 500 rows ~3 min cold.

## Data flows
Lookup (cache miss): UI -> GET /providers/{npi} -> authn/z -> validator OK -> audit LOOKUP_REQUESTED -> Redis GET npi:v1:{npi} miss -> NPPES client -> mapper -> SETEX 24h -> audit LOOKUP_COMPLETED -> 200 with provenance. Zero results -> 404 NPI_NOT_FOUND + 15-min negative sentinel. Errors body -> 400, no cache. Transport failure -> retry -> breaker -> stale (flagged) else 503.
Search: canonicalize criteria -> search:v1:sha256 key, 1h TTL; opportunistically warm npi:v1 entries (1h, source:search) if absent.
Verification: POST /verifications (Verifier) -> ALWAYS fresh upstream fetch (evidence must be current; also refreshes 24h cache) -> verify() -> transaction inserts snapshot + audit row -> 201. Transport failure -> 503, no snapshot, audit VERIFY_ERROR.
Batch: upload -> local validate every row (Luhn, columns) -> reject bad rows with row numbers -> enqueue valid -> workers verify (cache allowed, <=24h staleness documented) -> progress polling -> CSV.

## Caching
npi:v1:{npi} 24h; negative npi:v1:{npi}:404 15min; search:v1:{hash} 1h (includes page/pageSize); taxonomy:v1 7d. Errors/transport failures never cached. Versioned keys (bump invalidates). Soft TTL + 7-day hard TTL: stale-while-error served flagged STALE (verification never uses stale). +/-10% TTL jitter. Forced refresh (Verifier, audited, rate-limited). retrievedAt + NPPES last_updated always shown. Browser Cache-Control: private, no-store for provider data.

## Errors
Local validation -> 400, no upstream call. Upstream validation (Errors[] 03/05/06/07) -> 400 + metric nppes_validation_escape. Error 17 -> 500 "service misconfigured", page on-call. Not found -> 404. Transient -> retry 3x -> 503 "NPPES temporarily unavailable". Protocol anomaly -> 502. Per-user limit -> 429 with Retry-After. CRITICAL RULE: HTTP 200 is not success — inspect Errors[] first (unit fixtures + nightly live contract test guard this).
Circuit breaker: open after 5 consecutive transport failures or >50% failures in 30s window (>=10 requests); while open serve stale where permitted else 503 retryable + Retry-After: 30; half-open probe every 30s, 2 successes close; state in Redis; UI banner.
All upstream calls are GETs (safe to retry). Batch items independent; one failure never fails the batch. Fail-closed: audit write fails -> request fails; Redis down -> bypass cache with in-process limiter (degraded); Postgres down -> reads fail (cannot audit).

## Security and operations
OIDC SSO, RBAC in middleware + services, separate Admin role. Searches audit-logged; logs hold request IDs + NPIs, never free-text names. Sole-proprietor residence warnings in UI and exports. CSV formula-escape; upload size/row limits. Egress allow-list: npiregistry.cms.hhs.gov only; TLS on. Secrets from manager. SAST + dep scanning in CI.
Metrics: upstream requests/latency, cache hits, limiter wait, breaker state, verdict counts, validation escapes. Alerts: breaker open >5min, upstream errors >5%/10min, any audit write failure, p95 SLO breach. All limits/flags configurable without redeploy. 2+ stateless replicas, rolling deploys. Runbooks: NPPES down, IP blocked/429. Retention 7 years, monthly partitions.
