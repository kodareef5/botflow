# botflow — Deep Security Audit

Date: 2026-08-20 · Method: multi-wave swarm audit — Wave 1: 8 parallel scope auditors, Wave 2: 8 independent adversarial verifiers (every finding re-checked against live code, all PoCs re-run), Wave 3: this consolidation.
Result: **43 findings, 0 rejected in verification** — 8 Medium, 20 Low, 15 Info.

Raw reports: `audit/findings/*.md` · Verified verdicts + evidence: `audit/verified/*.md`

## Executive summary

No Critical or High issues. The codebase is in good security shape: the YAML subset is genuinely closed, git invocations are injection-proof, the worker authN/authZ design (hashed tokens, throttled login, single `reaches()` choke point, owner-only integration management) held up, HTML rendering uses one escape helper applied consistently (~60 sinks, no stored XSS in the worker UI), and no secrets exist in the tree or history.

The risk concentrates in three systemic root causes, each fixable in a few lines with stdlib only:

1. **The mutation write path lacks the realpath/symlink containment the pull path already has.** `src/cli/remote.ts:124-141` implements `assertContainedTargets`; nothing equivalent guards `writeCard`/`initBoard`/cross-board relation writes (`src/core/mutate.ts`). A committed symlink in a malicious clone turns routine `botflow add` / MCP `card_link`/`card_transfer` into silent writes outside the board/workspace. Closes F02-1, F02-2, F02-4, F04-2.
2. **The YAML parser assigns `__proto__` via the prototype setter** (`src/core/yaml.ts:133,155-166`, `KEY_RE` at `:15` admits it). This bypasses the duplicate-key guard, hides config keys from lint, silently launders them on rewrite, and — the sharpest edge — defeats the SPEC §4 mandatory read-only gate for a `board.yaml` missing `botflow:`. Fix: reject `__proto__`/`constructor`/`prototype` keys or build maps with `Object.create(null)`. Closes F01-1, F02-5, F04-4.
3. **No algorithmic bounds on adversarially structured boards.** Three tiny committed payloads reliably DoS every CLI command, MCP call, and viewer poll: a crafted heading line (quadratic ReDoS in `parseBody`, `src/core/body.ts:46`), a ~24-level shared-child DAG (`rollupJson` exponential blowup → OOM at ~4 GB from ~5 KB, `src/core/json.ts:179-199`), a ~1000-deep linear board chain (`analyze()` recursion → `RangeError`, `src/core/analyze.ts:282,297`). An iterative-DFS pattern already exists in-tree (`analyze.ts:178-224`) to model the fix on.

Plus two standalone Mediums: template `{{title}}` injection that forges append-only `## Log` sections (guard checks pre-interpolation, substitutes raw after — `src/core/ops.ts:472-473,505`), and unauthenticated Durable Object provisioning via `/og/?p=` (any anonymous request with a syntactically valid fake pid permanently allocates DO SQLite storage — `worker/src/index.ts:474-494`).

## Fix-first list (recommended order)

| # | Fix | Closes | Effort |
|---|-----|--------|--------|
| 1 | Reject `__proto__` keys / `Object.create(null)` in `yaml.ts parseEntry` + inline maps | F01-1, F02-5, F04-4 | one line + tests |
| 2 | Port `assertContainedTargets`-style realpath guard to mutation write paths (`mutate.ts`, `withBoardLocks`) | F02-1, F02-2, F02-4, F04-2 (+F02-3 `isAbsolute` check) | small |
| 3 | Rewrite `HEADING_RE` usage as `startsWith`+`trimEnd` (`body.ts:46,88,145,278`) | F01-2 | small |
| 4 | Make `analyze()` board recursion iterative; memoize/stub shared nodes in `rollupJson` | F01-3, F01-4 | medium |
| 5 | Re-validate (or sanitize) `{{title}}` substitution in `ops.ts:505`; reject newlines in card titles | F04-1 | one line |
| 6 | Escape `r[0]` in the viewer drawer row (`src/viewer/page.ts:397`) | F05-1 (stored XSS) | one word |
| 7 | Add registry existence check to `/og/` before `project(pid)` RPC (`worker/src/index.ts:479`) | F06-1 | one line |
| 8 | `.gitignore` `.dev.vars`/`.env*`/`*.tgz`; add `files` allowlist to `package.json` | F08-1, F08-2, F08-3 | config only |

## Findings by severity (post-verification)

### Medium (8)

- **F01-2** ReDoS: quadratic backtracking in `parseBody` heading regex — 200k-char crafted line = 12.3 s CPU on every board read; reachable via CLI, MCP (`view()` reloads+analyzes every call), viewer. `src/core/body.ts:46`
- **F01-3** `rollupJson` per-edge recursion, no memoization/stubbing — 24-level DAG (~5 KB committed) OOM-kills the process at ~4 GB heap. CLI `--rollup`, MCP `rollup:true`. `src/core/json.ts:179-199`
- **F01-4** ~1000-deep linear board chain overflows the stack in `analyze()` — every command crashes with `RangeError` until files removed by hand. `src/core/analyze.ts:282,297`
- **F02-1** Mutation writes follow committed symlinks out of the board: `cards/` symlink → `addCard` plants files in an arbitrary dir; `.botflow` symlink → `initBoard` clobbers the target's `.gitignore`. Read side has `lstat` discipline; write side has none. `src/core/mutate.ts:146-156`
- **F04-1** Template `{{title}}` injection: `bodyHasSection` guard runs pre-interpolation, raw substitution after — a malicious agent forges multi-line sections incl. backdated, misattributed `## Log` entries that permanently capture the append-only trail. `src/core/ops.ts:472-473,505`
- **F04-2** Lexical-only containment: symlinked child board lets MCP `card_link`/`card_transfer` write relations and whole cards outside the workspace. Same root cause as F02-1/2. `src/core/mutate.ts:220-223,350-353`
- **F05-1** Stored XSS: custom-field `name` from `board.yaml` rendered unescaped into the card drawer's `innerHTML` (value escaped, label not) — arbitrary JS in the victim's browser via a hostile cloned board. `src/viewer/page.ts:384,397`
- **F06-1** Unauthenticated ProjectDO provisioning via `/og/?p=`: anonymous requests with fake but well-formed pids permanently allocate DO SQLite stores; no registry existence check, no rate limit, no cleanup path. Verified: 6 requests → 6 new stores. `worker/src/index.ts:474-494`

### Low (20)

- **F01-1** YAML `__proto__` key pollutes config-object prototype — defeats the missing-version read-only gate (SPEC §4 MUST), suppresses schema findings, silently rewrites `board.yaml`. Overlaps F02-5/F04-4; one fix closes all three.
- **F01-5** Quadratic dedup (`Array.includes`) in mention and `[[ref]]` extraction — 40k distinct values ≈ 1–1.5 s per parse. `src/core/body.ts:133`, `src/core/refs.ts:87`
- **F01-6** No size/count limits on board files — 150 MB card loads with RSS ~900 MB; ~1 GB file OOMs a default heap. `src/core/load.ts:40-60`
- **F02-2** Cross-board link/transfer escape via committed symlink (lexical nesting check, no `realpath`); needs a guessable external board path — targetability caps impact.
- **F02-3** Windows cross-drive/UNC targets bypass the `relative()`-based nesting check (`isAbsolute` never tested). Code gap + win32 semantics confirmed; no Windows host for full exploit.
- **F02-4** Self-referential board symlink self-deadlocks cross-board ops for the 5 s lock timeout. Realpath dedupe in `withBoardLocks` fixes.
- **F02-5** `__proto__` config keys hidden from lint, silently dropped/laundered on rewrite. Root cause shared with F01-1.
- **F02-6** 300-digit string card id → every subsequent `add` crashes with raw `ENAMETOOLONG` (persistent per-board DoS until manual removal).
- **F03-1** Remote-controlled terminal escape injection: stdout `out()` strips C0/DEL, but every stderr write is raw — a hostile remote's error JSON reaches the terminal verbatim. `src/cli/main.ts:230-233` vs `:455,463,919`
- **F03-3** `--token` flag exposes the manager token in `ps` output and shell history (env var exists and is documented; help text should steer to it).
- **F03-4** Unbounded response body buffering in remote push/pull — 256 MB body → ~1.1 GB RSS; validation gate held, integrity unaffected. `src/cli/remote.ts:79`
- **F04-3** MCP `actor` is self-asserted on every call — full identity impersonation in Log/Comments and claim-ownership bypass (stdio MCP cannot authenticate; document + optional `--pin-actor`).
- **F04-4** `__proto__` frontmatter keys: inherited values readable as card fields, dup-guard bypass, required-field findings suppressed. Root cause shared with F01-1.
- **F05-2** Remote `cover:`/attachment URLs auto-fetched as `<img>` by the viewer's browser (tracking pixel / blind GET). Escaped properly — no XSS. Overlaps F07-3.
- **F06-3** 16 authenticated JSON routes buffer bodies with no size ceiling; `bodyTooBig` trusts `content-length` (chunked bypasses); ~100 MB chunked body can OOM the 128 MB isolate. `smallJson` exists but is unused on these routes. `worker/src/index.ts` (16 sites listed in verified report)
- **F06-4** `SETUP_KEY` gate: plain `!==` compare, no attempt throttling on `/api/setup` + `/api/recover` (throttle machinery exists, just not wired there).
- **F07-2** Trailing-dot `localhost.` (and `*.localhost.`) bypasses the SSRF host denylist; `unfurlTarget`/`webhookTarget` allow it. Bites only on `wrangler dev`/self-hosted workerd. Strip one trailing dot; `youtube.ts:26` already does. `worker/src/security.ts:284-303`
- **F07-3** Card cover/gallery images render attacker-chosen third-party URLs unproxied (contradicting the `/og/` proxy design); no explicit cover needed — attachment fallback puts remote art on the board face. Overlaps F05-2.
- **F08-1** `.gitignore` lacks `.dev.vars`/`.env*` — wrangler local-secret workflow unprotected from accidental commit (SETUP_KEY exposure would compromise an internet-facing deployment).
- **F08-2** No `files`/`.npmignore` allowlist — `npm publish` ships the whole working tree incl. untracked files (demonstrated live: this audit's own reports got packed in the dry-run).

### Info (15)

- **F01-7** Unquoted ≥16-digit card ids mangled by float precision (`9007199254740993` → `…992`); unquoted deps mangle identically and still resolve; quoted deps dangle with a visible finding; only text `[[refs]]` dangle silently.
- **F02-7** Unsafe-integer extras drift number→string on rewrite (`1e+21` round-trip), breaking the lossless-preservation promise.
- **F03-2** C1 control chars (U+0080–U+009F) pass through the stdout sanitizer; no live terminal effect demonstrable on modern UTF-8 terminals.
- **F04-5** `-32603` internal errors embed absolute fs paths in the agent-visible message (one-line fix: generic client message, detail to stderr).
- **F04-6** "Read" MCP tools aren't read-only (`view()` runs lazy automation writes — attribution included); no payload size caps beyond the 8 MiB frame limit.
- **F05-3** No auth on the loopback `/api/data` (read-only, single-user design target; any local process can read the full board while `botflow serve` runs).
- **F06-2** Read-role members can mint unauthenticated public feed URLs while page shares are owner-only — **documented, accepted design decision** (`docs/card-features-review.md:90`), owner-visible and revocable; downgraded from Low in verification.
- **F06-5** `/api/setup` double-initialize race is non-atomic by construction (1/12 on local workerd; latent on real Cloudflare; SETUP_KEY is a prerequisite anyway).
- **F06-6** Project-existence oracle: 403 vs 404 split on `/api/projects/:pid` (40-bit ids cap real impact; email-inbound already equalizes this deliberately).
- **F06-7** Four integration endpoints return raw `Error.message` to clients (owner-only except `processInboundEmail` via public capability route).
- **F06-8** `member_keys.last_used` write per API-key request — write amplification on the serialized RegistryDO (shares/feeds already coarsen this deliberately).
- **F07-1** iCalendar feed misses lone-CR neutralization — real latent bug, but the strict YAML parser drops any CR-bearing card on reload, so the injection is unreachable; downgraded from Low in verification. One-char fix: `.replace(/\r\n?|\n/g, '\\n')`.
- **F07-4** DNS-rebinding residual in unfurl/webhook targets — documented platform posture; only a self-hosting docs note.
- **F08-3** `*.tgz` not gitignored — `npm pack` artifact committable; compounds F08-2.
- **F08-4** devDep toolchain has binary postinstalls (esbuild, workerd, fsevents) — dev-only, pinned, integrity-hashed; no action.

## Checked clean (highlights)

- **Parser**: YAML subset genuinely closed (anchors/tags/block scalars/nested flows rejected), depth-bounded; read-side symlink `lstat` guards real and tested; duplicate/empty ids fail visibly.
- **CLI**: `parseArgs` strict; git invocations verified injection-proof (leading-dash, `--branch` value, `ext::` all safe by PoC); pull traversal/symlink/https mitigations hold (11/11 remote-security tests + fresh PoCs); no token leak on cross-origin redirect; no npm install hooks.
- **Worker**: authN (hashed tokens, PBKDF2 with absent-user equalization, real login throttle, revocation semantics) and authZ (single `reaches()` choke point, scoped-admin role enforced, no IDOR found across all routes) hold; webhook HMAC/redirect/attempt discipline verified; SSRF denylist robust against decimal/hex/octal/mapped/NAT64/6to4 IP spellings; email header injection closed by construction; snapshot import revalidates secrets/URLs.
- **Worker UI**: single escape helper applied consistently across ~60 HTML sinks — no stored XSS found in `worker/src/ui.ts`.
- **Repo**: no committed secrets in working tree or all 67 commits; lockfile fully integrity-hashed; `npm audit` 0 vulnerabilities (dev included).
