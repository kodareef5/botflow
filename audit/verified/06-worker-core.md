# Verified Scope 06 — Worker core: auth, sessions, routing, registry

Verification of `audit/findings/06-worker-core.md`. Method: read every cited line in
`worker/src/index.ts`, `worker/src/security.ts`, `worker/src/registry.ts`,
`worker/src/project.ts`, `worker/src/feeds.ts`; re-ran the Wave 1 PoC
(`/tmp/audit06/poc.mjs`, throwaway `wrangler dev` with isolated `--persist-to` state,
no project files modified); cross-checked the cited tests in `test/worker.test.ts`
and the design docs in `docs/`.

PoC re-run output (this verifier's run, 2026-08-20):
```
setup race: 1/12 succeeded (statuses: 200,409,409,409,409,409,409,409,409,409,409,409)
owners after race: 1 -> racer0
sqlite files before /og/ probes: 18
/og/ probe p-auditfake0..5: all 404
sqlite files after /og/ probes: 39   # +18 DO files (6 sqlite + shm/wal), +3 cache-object
reader page-share attempt: 403 {"error":"owner only"}
reader feed create: 200 {"id":"sh-…","token":"56c52477…","atom":…}
anonymous feed fetch: 200, contains card title: true
```

## F06-1: Unauthenticated ProjectDO provisioning via `/og/?p=` — persistent resource/billing exhaustion
- Verdict: CONFIRMED
- Final severity: Medium
- Overlaps: none
- Verification: Reproduced. Six unauthenticated `GET /og/<64×hex>?p=p-auditfake<N>`
  requests all returned 404, and the isolated persist dir gained exactly 6 new
  `v3/do/<name>-ProjectDO/<hash>.sqlite` stores (+shm/-wal = 18 files; the 3 other new
  files are the one-time miniflare CacheObject db from `caches.default.match`). Code
  matches the report at every cite: the route (worker/src/index.ts:474-494) validates
  `?p=` only against `/^p-[a-z0-9]+$/` (:479) and then calls
  `project(pid).unfurlImageFor(hash)` (:480) where `project()` is
  `env.PROJECT.get(env.PROJECT.idFromName(id))` (:421) — any RPC to the stub
  instantiates the DO, and the `ProjectDO` constructor runs `this.sql.exec(DDL)`
  (worker/src/project.ts:201-205), allocating permanent SQLite storage. Confirmed no
  mitigation the auditor missed: the cache key includes the query string so each new
  pid is a cache miss, there is no rate limit on the route, and I traced every other
  unauthenticated path — `/s/` (:430-434, registry only), `/feeds/` (:435-465, resolves
  via registry first), `/api/public/` (:528-547, `resolveShare` 404s before any DO
  call), `/files/` (:495-513, R2 only, no DO), email inbound (:555, checks
  `registry.projectName` first), project routes (:1165, same check). `/og/` is the sole
  unauthenticated DO-instantiation vector, and no cleanup path exists for ids the
  registry never knew (`destroy()` runs only on cascade delete, index.ts:1126, and
  import rollback, :928/:982). Medium is right: unauthenticated, durable, billed
  storage growth with no self-healing; held back from High only because cost accrues
  linearly per request (no amplification).

## F06-2: Read-role members can mint unauthenticated public feed URLs, bypassing the owner-only page-share control
- Verdict: CONFIRMED-ADJUSTED
- Final severity: Info
- Overlaps: none
- Verification: The behavior is real and reproduced exactly: a `read`-role member gets
  403 `owner only` from `POST …/shares` (requireOwner at index.ts:1444) but 200 + token
  from `POST …/feeds` (index.ts:1462-1490 has no role gate; `createFeed` at
  registry.ts:288-307 requires only `reaches`), and an anonymous
  `GET /feeds/<token>.atom` returns 200 containing the card title. Feed contents are as
  described: project title, due cards, up to 100 events (project.ts:1408), comment/log
  details truncated to 200 chars (project.ts:2039, 2197). However, the report's key
  framing — "showing the asymmetry is not a deliberate, consistently-applied policy" —
  is refuted by the project's own docs: `docs/card-features-review.md:90-91` states
  under "Security and accepted operational decisions" that "Any current member may mint
  their own scoped, revocable feed. Disabling/removing the member or removing their
  project reach immediately invalidates it", and `docs/card-features-hardening-plan.md:359`
  (workstream E3) records the explicit decision to document exactly this. All claimed
  mitigations check out: 160-bit tokens (`randomToken`, registry.ts:166-170), feeds are
  owner-visible and revocable via `/api/org/shares` (`listAllShares` → `capabilityRows()`
  with no kind filter, registry.ts:354-386), and reach loss/disable kills the feed at
  resolve time (registry.ts:642-645).
- Corrected description: Any member reaching a project — including `read` role — can
  mint an unauthenticated feed URL exposing the project title, due cards, and up to 100
  activity events (200-char detail snippets), while page shares of the same project are
  owner-only. This is a documented, accepted design decision
  (docs/card-features-review.md:90), not an oversight: the capability is owner-visible,
  owner-revocable, and dies with the member's reach. The residual risk worth tracking is
  only that `read`-role publication of activity snippets happens without per-feed owner
  approval — a deliberate capability grant, owner-auditable after the fact. Info:
  hardening note, not an authorization bug.

## F06-3: Most authenticated JSON routes buffer the request body with no size ceiling
- Verdict: CONFIRMED
- Final severity: Low
- Overlaps: none
- Verification: Code reading; every cited line confirmed by grep. Sixteen routes use
  bare `req.json()` with no pre- or post-buffer size check: index.ts:744 (settings),
  :943 (spaces), :952 (projects), :1001 (keys POST), :1029 (keys PATCH), :1208 (config),
  :1217 (import), :1389 (buttons), :1420 (filters), :1438 (lane subscribe), :1448
  (shares), :1465 (feeds), :1494 (cards), :1571 (quick), :1579 (bulk), :1628 (card
  action). The correct primitive exists and is unused there: `smallJson` streams with a
  hard ceiling (:107-132), and its own comment concedes `bodyTooBig` "waves through"
  chunked requests since they declare no content-length (:100-106). Contrast the upload
  route's real post-buffer recheck (`bytes.byteLength > MAX_UPLOAD`, :1612).
  `bodyTooBig` gating exists only on setup/recover/login (:573/:588/:601), org-import
  (:794), and upload (:1609) — and is declarative-only even there. Not PoC'd end-to-end
  (same as Wave 1; impact is platform-dependent), but the absence of any ceiling is
  unambiguous. One sharpening of the report's framing: even on real Cloudflare the edge
  upload cap (100 MB free / larger on paid) exceeds the 128 MB isolate memory class, so
  the platform limit does not actually save the isolate — a chunked body of ~100 MB
  from any authenticated member (`read` suffices for feeds POST) can still OOM it. That
  keeps this at the top of Low rather than below it; authentication is still required,
  and the isolate self-heals, so Low stands.

## F06-4: SETUP_KEY gate has neither a timing-safe comparison nor attempt throttling
- Verdict: CONFIRMED
- Final severity: Low
- Overlaps: none
- Verification: Code reading. `security.ts:12` is a plain `supplied !== setupKey`
  string compare; the timing-safe `sameSecret` helper (security.ts:106-111) exists but
  is used only for password hashes. The throttle machinery (`authRetryAfter`/
  `authFailed`, registry.ts:980-1033) is wired only into `login` (:1051-1059),
  `verifyPasswordFor` (:951-954), and `verifyBasic` (:1103-1110); the `/api/setup` and
  `/api/recover` handlers (index.ts:571-597) never reference `client` or any throttle —
  confirmed by reading both handlers in full. A wrong key 403s inside `setupAccess`
  before any PBKDF2 work, so attempts run at line rate. The deliberate 409-first on
  initialized deployments is real (index.ts:572; test/worker.test.ts:181-185 exists as
  cited), so only `/api/recover` is a forever-oracle. Low is the right call: exploitation
  needs an operator-chosen low-entropy SETUP_KEY (nothing enforces or suggests strength
  — the Env comment at index.ts:32-34 is silent on it), and remote string-compare timing
  is not practically exploitable.

## F06-5: `/api/setup` double-initialize is non-atomic by construction (not reproduced on workerd)
- Verdict: CONFIRMED
- Final severity: Info
- Overlaps: none
- Verification: Code matches: `setup()` (registry.ts:711-731) checks `initialized()` at
  :712, awaits `hashPassword` at :718, and the `transactionSync` at :719-729 never
  re-checks; the route pre-check (index.ts:572) has the same time-of-check gap. The
  `members.username UNIQUE` constraint (registry.ts:201) only collapses same-username
  races; distinct usernames would both mint owners (and the second transaction renames
  the org via the `UPDATE org SET name` branch at :724). Re-ran the PoC: 12 concurrent
  setups on fresh workerd state → `1/12` succeeded, 11 × 409, one owner — exactly what
  Wave 1 reported; workerd's DO gating appears to serialize the crypto await in
  practice locally. On real Cloudflare, input gates only block during storage
  operations, and PBKDF2 is not one, so the interleave remains plausible there — but
  the report already frames this as latent non-atomicity, not a demonstrated exploit,
  and the prerequisite (reaching setup at all) requires the SETUP_KEY, which already
  grants full owner takeover via `/api/recover`. Info stands.

## F06-6: Project-existence oracle for scoped members (403 vs 404)
- Verdict: CONFIRMED
- Final severity: Info
- Overlaps: none
- Verification: Code reading; both branches confirmed verbatim: index.ts:1165 returns
  404 `no project <pid>` when `registry.projectName(pid)` is null, and :1168-1170
  returns 403 `this project is outside your scope` when `reaches()` fails — before any
  DO call. The contrast the report draws is also real: email-inbound deliberately
  equalizes the two cases (comment at index.ts:549-552, single 404 at :555), and the
  cross-link probes are equalized by test (test/worker.test.ts:1316-1337, both 403 with
  identical error text). Project ids are `p-` + 10 hex = 40 bits (registry.ts:1181,
  `shortId()` = 5 bytes at :177-181), so blind enumeration is infeasible; the oracle
  only confirms ids the attacker already saw. Info is right.

## F06-7: Integration create/process endpoints return raw `Error.message` to clients
- Verdict: CONFIRMED
- Final severity: Info
- Overlaps: none
- Verification: Code reading; all four catch blocks exist at the exact cited lines and
  return `error.message` for any `Error`, not just `UsageError`:
  project.ts:442-446 (`createWebhook`; note :443 special-cases `UsageError` and :444
  then leaks generic messages anyway), :575-578 (`createEmailRoute`), :691-694
  (`createEmailSubscription`), :670-673 (`processInboundEmail`). Route exposure
  confirmed: the first three sit behind `requireOwner()` (index.ts:1233, :1285, :1308)
  while `processInboundEmail` is reachable via the public token-capability route
  (index.ts:553-564), so a route-token holder sees internal error text — e.g. SQLite
  constraint phrasing with table/column names. Nothing credential-bearing was observed
  in reachable messages, and the global catch-all stays generic (index.ts:1715-1718).
  Info is right.

## F06-8: `member_keys.last_used` write on every API-key request — hot-path write amplification
- Verdict: CONFIRMED
- Final severity: Info
- Overlaps: none
- Verification: Code reading. `verifyBearer` (registry.ts:1080-1097) executes
  `UPDATE member_keys SET last_used = ?` (:1095) unconditionally on every successful
  API-key authentication — a synchronous SQLite write on the single serialized
  RegistryDO for what is often a read-only call. The deliberate contrast the report
  cites is real: share/feed capability touches are coarsened to one write per 15
  minutes (`SHARE_VIEW_TOUCH_MS`, registry.ts:152, applied at :647-652) with a comment
  (:148-151) stating exactly this rationale, and basic-auth verification is cached in
  memory for 5 minutes (`BASIC_CACHE_MS`, :145-147) for the same reason. Session-token
  reads also skip the write — only API keys pay it. Info is right: cost/latency
  amplification by an already-authenticated member, not a security boundary issue.

## Verification summary

Verdicts: 7 CONFIRMED, 1 CONFIRMED-ADJUSTED, 0 REJECTED.

This report is in unusually good shape: every cited line number was exact, every
claimed code behavior matched the source, the PoC re-ran verbatim (6 fake pids → 6 new
ProjectDO stores; reader feed mint → anonymous 200; setup race 1/12), and the severities
are honest — including the report's own admission that F06-5 was not reproducible on
workerd. The one correction is F06-2: the code does what was claimed, but the "not a
deliberate policy" framing is refuted by the project's own accepted-decisions doc
(docs/card-features-review.md:90), so it drops from Low to Info as a hardening note.
F06-1 is the only finding with real teeth (unauthenticated, durable, billed) and its
one-line registry guard is the correct fix; the rest are low-cost hygiene items on an
otherwise carefully gated surface.
