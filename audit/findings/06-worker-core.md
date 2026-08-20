# Scope 06 — Worker core: auth, sessions, routing, registry

Audited: `worker/src/index.ts` (all 1720 lines), `worker/src/security.ts`, `worker/src/project.ts`,
`worker/src/registry.ts`, `worker/src/about.ts`, `wrangler.jsonc`, `test/worker.test.ts`.
Every route in `index.ts` was traced to its auth check; candidate findings were proven
dynamically against a real `wrangler dev` instance where feasible (throwaway PoC at
`/tmp/audit06/poc.mjs`; no project files modified).

## F06-1: Unauthenticated ProjectDO provisioning via `/og/?p=` — persistent resource/billing exhaustion
- Severity: Medium
- CWE: 770 (Allocation of Resources Without Limits or Throttling)
- Location: worker/src/index.ts:474-494
- Description: The unauthenticated og-image proxy route validates `?p=` only against the
  regex `/^p-[a-z0-9]+$/`, then calls `project(pid).unfurlImageFor(hash)`. `project()` is
  `env.PROJECT.get(env.PROJECT.idFromName(id))` (index.ts:421): any RPC to the stub
  instantiates the Durable Object, and the `ProjectDO` constructor runs DDL that allocates
  permanent SQLite storage (project.ts:201-205). Unlike `/api/email/inbound/<pid>/...`
  (index.ts:555) and `/api/projects/<pid>/...` (index.ts:1165), this route never checks
  `registry.projectName(pid)` first. Each fake but well-formed pid therefore creates a new,
  never-deleted Durable Object. There is no rate limit on the route.
- Exploit scenario: Unauthenticated internet attacker loops
  `GET /og/<64 hex chars>?p=p-evil<N>` with distinct N. Every request 404s but permanently
  provisions a new ProjectDO with its own SQLite storage (+ WAL). Millions of requests →
  millions of DOs: durable, billed storage growth and namespace pollution with no cleanup
  path (`destroy()` only runs on cascade delete of registry-known projects).
- Evidence: PoC (`node /tmp/audit06/poc.mjs`, wrangler dev, isolated state): 6
  unauthenticated requests with pids `p-auditfake0..5` all returned 404, and the persist
  dir gained exactly 6 new `v3/do/<name>-ProjectDO/<hash>.sqlite` stores (plus -shm/-wal):
  `sqlite files before /og/ probes: 18` → `after: 39` (18 DO files + 3 cache-object files).
- Suggested fix: Mirror the email-inbound guard before touching the DO:
  `if ((await registry.projectName(pid)) === null) return json({ error: 'not found' }, 404);`
  One RegistryDO lookup is cheap and closes instantiation of unknown ids entirely.

## F06-2: Read-role members can mint unauthenticated public feed URLs, bypassing the owner-only page-share control
- Severity: Low
- CWE: 863 (Incorrect Authorization)
- Location: worker/src/index.ts:1462-1490 (POST `/api/projects/:pid/feeds` has no role gate),
  worker/src/registry.ts:288-307 (`createFeed` requires only `reaches`)
- Description: Creating a public *page share* is owner-only (`requireOwner()` at
  index.ts:1444). Creating a *feed* capability — an unauthenticated, world-readable URL
  serving the project's title, due cards, and up to 100 activity events (including 200-char
  comment/log snippets, feeds are rendered at `/feeds/<token>.{atom,rss,ics}` without any
  auth) — is open to every member who reaches the project, including `read` role. A
  read-only member ("a spectator", per index.ts:629) can thus publish live project activity
  to the public internet under the company's own domain without owner approval. Mitigating:
  tokens are 160-bit unguessable, owners can see and revoke feeds via `/api/org/shares`
  (feeds are shares with `kind='feed'`), and a feed dies when its member loses reach
  (registry.ts:642-645) or is disabled.
- Exploit scenario: A read-scoped bot member (`role: 'read'`) posts
  `POST /api/projects/<pid>/feeds {}` → 200 with a token; anyone on the internet then reads
  `GET /feeds/<token>.atom` and receives card titles and event text. The same member gets
  403 `owner only` from `POST .../shares`, showing the asymmetry is not a deliberate,
  consistently-applied policy.
- Evidence: PoC against wrangler dev: reader page-share attempt → `403 {"error":"owner only"}`;
  reader feed create → `200` with token `696c1baf…`; anonymous
  `GET /feeds/<token>.atom` → `200`, body contains the card title `Sensitive milestone`.
- Suggested fix: Add `requireWrite()` (or owner, matching page shares) to the feeds POST
  branch in index.ts. If member-minted feeds are intentional, document the difference and
  consider an org pref like `gateShares`.

## F06-3: Most authenticated JSON routes buffer the request body with no size ceiling
- Severity: Low
- CWE: 770 (Allocation of Resources Without Limits or Throttling)
- Location: worker/src/index.ts — routes using bare `req.json()`: `/api/settings` POST (:744),
  `/api/spaces` POST (:943), `/api/projects` POST (:952), `/api/keys` POST (:1001),
  `/api/keys/:id` PATCH (:1029), `/api/projects/:pid/config` PUT (:1208),
  `/api/projects/:pid/import` PUT (:1217), `/api/projects/:pid/cards` POST (:1494),
  `cards/quick` (:1571), `cards/bulk` (:1579), `buttons/:id` (:1389), `filters` (:1417-1420),
  `lanes/:lane/subscribe` (:1438), `shares` POST (:1448), `feeds` POST (:1465),
  `cards/:cid/:action` (:1628). `bodyTooBig` exists only on setup/recover/login/org-import/upload,
  and even there it trusts the declared `content-length` (index.ts:100-101) — a chunked body
  declares none, so `req.json()` buffers whatever arrives.
- Description: The codebase already has the correct primitive — `smallJson` (index.ts:107-132)
  streams with a hard byte ceiling — but credential/admin/adjacent endpoints are the only ones
  using it. All board-mutation endpoints buffer unboundedly. On real Cloudflare the edge caps
  upload size, bounding impact; self-hosted workerd (explicitly contemplated by the Env comment
  at index.ts:39-43) has no such cap, and a multi-hundred-MB JSON body is parsed in-isolate
  (128 MB memory class), killing the isolate and co-located requests.
- Exploit scenario: Any authenticated member (a `read` member suffices for `feeds` POST; `write`
  for the rest) sends `Transfer-Encoding: chunked` bodies of hundreds of MB to
  `PUT /api/projects/<pid>/import` or `POST .../cards`. Repeated: repeated isolate teardown —
  an authenticated availability/cost attack.
- Evidence: Code reading; `smallJson`'s own comment concedes `bodyTooBig` "waves through"
  chunked requests, and the listed routes have no post-buffer recheck (contrast the upload
  route's real `bytes.byteLength > MAX_UPLOAD` recheck at index.ts:1612). Not PoC'd end-to-end
  (impact is platform-limit dependent); the absence of a ceiling is unambiguous in code.
- Suggested fix: Route every JSON body through `smallJson` (add a `max` parameter where a
  larger payload is legitimate, e.g. import). Zero-dependency; the helper already exists.

## F06-4: SETUP_KEY gate has neither a timing-safe comparison nor attempt throttling
- Severity: Low
- CWE: 208 (Observable Timing Discrepancy), 307 (Improper Restriction of Excessive Authentication Attempts)
- Location: worker/src/security.ts:12 (`supplied !== setupKey`), consumed at
  worker/src/index.ts:571-597 (`/api/setup`, `/api/recover`)
- Description: The deployment's root trust anchor is compared with plain `!==`, and the
  failed-credential throttle (`auth_attempts`) is wired only into login / password-change /
  basic-auth paths — `/api/setup` and `/api/recover` accept unlimited attempts at line rate,
  each costing no PBKDF2 (a wrong key 403s before any hashing). The deliberate 409-first
  behavior on initialized deployments (test/worker.test.ts:181-185) removes the setup side
  channel there, but `/api/recover` answers 403 vs 200/409 on every guess forever.
  Real-world impact hinges on operators choosing a strong SETUP_KEY (nothing enforces or
  suggests strength) and on remote string-compare timing being practically unexploitable;
  both keep this Low.
- Exploit scenario: Operator sets a low-entropy SETUP_KEY (e.g. a short word). Attacker
  brute-forces `/api/recover` with `{"username":"<owner>","password":"<new>","setupKey":<guess>}`
  until a 200 resets the owner password, kills all sessions, and hands the attacker a session.
- Evidence: security.ts:12 `if (setupKey !== null && supplied !== setupKey)`; index.ts:587-597
  shows no throttle call around `registry.recover`; the throttle helpers
  (registry.ts:984-1033) are only referenced by `login`, `verifyPasswordFor`, `verifyBasic`.
- Suggested fix: Compare via SHA-256 of both sides + the existing `sameSecret`
  (security.ts:106-111), and count failures with the existing `authFailed`/`authRetryAfter`
  machinery keyed on the client bucket (`c:<client>`) — no new dependencies.

## F06-5: `/api/setup` double-initialize is non-atomic by construction (not reproduced on workerd)
- Severity: Info
- CWE: 367 (Time-of-check Time-of-use Race Condition)
- Location: worker/src/registry.ts:711-731 (`setup`: `initialized()` check →
  `await hashPassword` → `transactionSync` write without re-check), route-level pre-check at
  worker/src/index.ts:572
- Description: Both the route gate and the DO gate check "already initialized" before the
  PBKDF2 await and never re-check inside the write transaction, so two interleaved setups
  could mint two owners on a runtime that admits a request during the crypto await.
- Exploit scenario: Attacker who can legitimately reach setup (knows SETUP_KEY, or loopback
  dev instance) races N concurrent `POST /api/setup` with distinct usernames → multiple
  owner accounts. Requires setup access in the first place, which is why real impact is small.
- Evidence: PoC: 12 concurrent setups on a fresh wrangler dev state → `1/12` succeeded
  (11 × 409); workerd's DO input/output gates appear to serialize this in practice. Reporting
  the latent non-atomicity, not a demonstrated exploit.
- Suggested fix: Re-check `this.initialized()` (or rely on a uniqueness constraint on the
  org row / a `CHECK` on live owners) inside the `transactionSync` in `setup()`.

## F06-6: Project-existence oracle for scoped members (403 vs 404)
- Severity: Info
- CWE: 204 (Observable Response Discrepancy)
- Location: worker/src/index.ts:1165 (`404 no project <pid>`) vs :1168-1170
  (`403 this project is outside your scope`)
- Description: A member probing `/api/projects/<pid>/board` learns whether a project id
  exists anywhere in the company: 403 means "exists, outside your scope", 404 means "does not
  exist". The codebase deliberately equalizes exactly this signal for email-inbound
  (index.ts:549-555 comment) and for cross-link probes (test/worker.test.ts:1316-1337), so
  the project-route split looks accidental. Impact is modest: project ids are 40-bit random
  (`p-` + 10 hex), so blind enumeration is infeasible; the oracle only confirms known/leaked ids.
- Exploit scenario: A project-scoped agent that sees a foreign project id in a screenshot or
  log line confirms its existence and space membership via the status code.
- Evidence: Code reading; the two branches return distinct statuses/messages.
- Suggested fix: Return the same 404 `no such project` for both branches, matching the
  email-inbound pattern.

## F06-7: Integration create/process endpoints return raw `Error.message` to clients
- Severity: Info
- CWE: 209 (Generation of Error Message Containing Sensitive Information)
- Location: worker/src/project.ts:442-446 (`createWebhook`), :575-578 (`createEmailRoute`),
  :691-694 (`createEmailSubscription`), :670-673 (`processInboundEmail`)
- Description: These catch-alls return `error.message` for any `Error`, not just
  `UsageError`, so a SQLite/constraint/internal error's text (table/column names, internal
  phrasing) is returned to the caller. The first three are owner-only; `processInboundEmail`
  sits on the public token-capability route, so a holder of a route token (or the email
  bridge) sees internal error text on failure paths. Nothing credential-bearing was observed
  in reachable messages.
- Exploit scenario: A route-token holder feeds malformed normalized payloads and harvests
  internal error strings to map the storage schema.
- Evidence: Code reading — `catch (error) { if (error instanceof Error) return { error: error.message } ... }`.
- Suggested fix: Keep `UsageError` messages; map anything else to a fixed string
  (`'could not create webhook'` style), logging the real error server-side.

## F06-8: `member_keys.last_used` write on every API-key request — hot-path write amplification
- Severity: Info
- CWE: 770 (Allocation of Resources Without Limits or Throttling)
- Location: worker/src/registry.ts:1095 (`verifyBearer`)
- Description: Every request authenticated with an API key performs an `UPDATE member_keys
  SET last_used` — a synchronous SQLite write on the single serialized RegistryDO for what is
  often a read-only API call. A bot polling a board with an API key turns every read into a
  billed/serializing write. The share-view touch was deliberately coarsened to one write per
  15 minutes (registry.ts:148-152) for exactly this reason; the key path was not.
- Exploit scenario: A misconfigured or malicious member script polling with an API key at high
  rate amplifies RegistryDO write load (the DO that serializes all auth).
- Evidence: Code reading; contrast with `SHARE_VIEW_TOUCH_MS` throttling at registry.ts:647-652.
- Suggested fix: Coalesce identically: only update when `last_used` is older than N minutes.

## Checked clean

- Route authN coverage: every `/api/` route traced — public set is explicit and minimal
  (gate, `/api/public/<token>`, email inbound, theme, setup/recover/login); everything else
  passes the single `verifyCredential` gate at index.ts:619-621, and every project route
  passes the single `reaches()` scope check at index.ts:1168 before any DO call.
- Token generation: sessions/keys/shares 160-bit CSPRNG (`randomToken`, registry.ts:166-170),
  email-route tokens and webhook secrets 256-bit (email.ts:25-28, webhooks.ts:70-73).
- Token storage: sessions, API keys, and email-route tokens stored as SHA-256 hashes only;
  listings never return token material (test/worker.test.ts:1145); hash lookup makes online
  token guessing and timing attacks impractical.
- Password hashing: PBKDF2-SHA-256, 100k iterations, per-user salt; stored-hash parser
  enforces salt/hash lengths and a 10M-iteration ceiling, so a hostile import cannot turn
  login into an unbounded WebCrypto job (security.ts:130-140); `verifyPassword` fails closed
  on malformed hashes.
- Timing side channels on passwords: `sameSecret` length-independent compare
  (security.ts:106-111); `absentPasswordHash` makes unknown usernames cost the same PBKDF2
  derivation (security.ts:155-164, registry.ts:1057, 1107).
- Failed-credential throttle: per-client (30) and per-(client,account) (10) windows with
  429 + retry-after; cannot be weaponized to lock out other users; tested end-to-end
  (test/worker.test.ts:1979-2002). XFF-spoofing trade-off is documented and fails safe
  (index.ts:409-419).
- Session lifecycle: 30-day TTL, expiry pruning on read/create, real logout, password change
  and recovery kill all sessions and revoke the member's keys (registry.ts:935-945, 759-779),
  member disable/delete kills sessions + basic-auth cache while member state is re-read every
  request (registry.ts:928-930, 964-978, 240 comment). Covered by tests (1685-1697, 1937-1942).
- Scoped-admin (board-shape) role: `admin`+`org` scope refused at create, update, resolveScope,
  `memberById`, and import (v5 envelope gate); force override stays owner-only across card
  actions, bulk, buttons, and add-card; config reshape admin-gated; snapshot shape-change
  requires admin and is atomic on denial; scope/role edits are live on existing credentials —
  all exercised in test/worker.test.ts:331-516 and re-verified by reading every check.
- IDOR: key management gated by `keySubject`/`keyOwner` (index.ts:990-1016); feed revoke/delete
  restricted to the owning member; members/shares/org-activity/export owner-only; the PoC
  additionally confirmed a non-owner gets 403 on another member's keys (test 1154-1157).
- Cross-project reference abuse: writes require descendant-of-source (or authorized inverse
  unlink) plus `reaches` on the target (index.ts:1641-1694); resolution fails closed so
  smuggled refs render inert and leak no distribution/state (project.ts:954-1030; tests
  533-559, 1303-1372); real-vs-fake probe responses are equalized.
- SQL injection: all queries use bound parameters; the only dynamic SQL text is a locally
  generated `?`-placeholder list (project.ts:2261-2274).
- CORS/CSRF: no `Access-Control-*` headers emitted anywhere; auth is bearer-header only with
  no cookies, so there is no ambient authority for CSRF, and cross-origin JSON POSTs are
  preflight-blocked by default.
- SSRF (unfurl/webhook egress policy in security.ts): http(s)-only, URL credentials rejected,
  loopback/private/CGNAT/link-local IPv4 and special-use IPv6 blocked including NAT64/6to4/
  Teredo embeddings; redirect targets re-validated per hop (test 892-896); daily cap + small
  batch (index.ts:84-88, 1181-1197). Residual DNS-rebinding gap is explicitly documented and
  gated behind operator opt-in (index.ts:39-47).
- Header injection: upload filenames charset-restricted at write and quote-stripped at serve
  (index.ts:1607, 510); `cleanName` strips CR/LF/TAB on org/space/project/member/key/share
  names (registry.ts:185-189); audit details truncated to 500 chars.
- Uploads: 10 MiB cap with a real post-buffer recheck, 128-bit random capability segment,
  HTML/SVG never inline, `content-security-policy: sandbox` + `nosniff` on every served object,
  and cross-project detach cannot delete foreign objects (index.ts:1696-1710; tests 1458-1497).
- Share/feed capabilities: 160-bit unguessable tokens; card-scoped shares expose exactly one
  card (tests 1499-1508); feed capability dies when its member loses reach or is disabled
  (registry.ts:642-645); revocation is immediate (test 1428-1429); page vs feed kind cannot be
  confused (`expectedKind`, registry.ts:635-637).
- HTML/feed injection at the seams this scope serves: `uiHtml` escapes `<` when embedding
  JSON into `<script>` (ui.ts:3132-3149 — confirmed to neutralize attacker-controlled card
  ids in `__PUBCARD__`); feed XML escaped (feeds.ts:30-35). Deeper UI-rendering XSS is the
  UI auditor's lane.
- Recovery path: requires an existing owner by name, refuses unusable passwords/usernames,
  refuses to mint a second owner on a typo, kills every session and the member's keys;
  covered by tests 1968-2036 and the never-set-up deployment test (2188-2237).
- Import/restore integrity: full validation before any registry row; owner-liveness
  projection; key re-homing and share-token collisions rejected; pre-v3 members/keys data
  ignored rather than trusted; rollback removes staged spaces (tests 1181-1807).
- `about.ts`: fully static HTML, no user-controlled interpolation.
- `wrangler.jsonc`: no secrets committed; SETUP_KEY / bridge username are env/secret
  references; R2 binding opt-in and documented.
- Error handling on the request path: catch-all returns generic `internal error` with the
  real error only in `console.error` (index.ts:1715-1718) — with the F06-7 exceptions noted.
