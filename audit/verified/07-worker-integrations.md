# Verified: 07-worker-integrations (Wave 2)

Verification of `audit/findings/07-worker-integrations.md` against the live tree. PoCs
live in `/tmp/bf07/` (`f07-1-full.ts`, `f07-1-debug.ts`, `f07-2-ssrf.ts`, `f07-3-cover.ts`);
no project source was modified. Existing suites re-run: `node --test test/feeds.test.ts
test/webhooks.test.ts` → 7/7 pass.

## F07-1: iCalendar feed emits a raw carriage return from card titles

- Verdict: CONFIRMED-ADJUSTED
- Final severity: Info
- Overlaps: none
- Verification: the code claim is exactly right — `worker/src/feeds.ts:89` does
  `.replace(/\r?\n/g, '\\n')`, which misses a lone `\r`, and feeding a CR-bearing title
  straight into `calendarFeed` reproduces the Wave 1 evidence verbatim:
  `SUMMARY:meet\rBEGIN:VEVENT evil`, raw CR present. The end-to-end exploit scenario,
  however, does not survive contact with the real call chain. A lone CR in a title makes
  the card file unparseable: `src/core/yaml.ts:15` `KEY_RE = /^([A-Za-z0-9_-]+):(.*)$/`
  cannot match a line containing `\r` (`.`
  excludes line terminators and `$` only anchors end-of-string), and `emitScalar`
  (`src/core/emit.ts:20-25`) neither quotes a mid-string CR nor escapes it when quoting.
  PoC result (`f07-1-full.ts`):
  - `opAdd` stores `meet\rBEGIN:VEVENT evil` verbatim; `serializeCard` emits
    `title: meet\rBEGIN:VEVENT evil` raw — matches the report.
  - Reloading the persisted text (the worker's only read path: `persistCard` → SQLite →
    `loadBoardDocs` re-parse, `worker/src/project.ts:218-224`, used by `feedSnapshot` at
    `project.ts:1385`) yields `yaml-error: 001-x.md: expected "key: value" (line 2)` and
    **zero cards**; the real-chain ICS then contains no raw CR and no VEVENT at all.
  - The other feed fields are equally unreachable: `X-WR-CALNAME`/suffix come from
    `board.config.name`/lane/filter names (`project.ts:1392,1411`), and a `\r` there breaks
    config parsing the same way.
  The Wave 1 PoC evidently called `calendarFeed` with the in-memory card, skipping the
  persist/reload cycle every worker request goes through. Residual real impact: a
  write-role member can make their own new card vanish on next load (with a `yaml-error`
  finding) — strictly less than the card deletion they already have. The `icalText` gap is
  a genuine latent bug and the suggested one-char fix (`.replace(/\r\n?|\n/g, '\\n')`) plus
  a lone-CR test in `test/feeds.test.ts` remains correct and worth taking, but nothing
  attacker-controlled crosses a boundary today.
- Corrected description: `icalText` does not neutralize a lone CR, but the forged-VEVENT
  scenario is not reachable: any card whose title carries a lone CR is dropped as
  unparseable on the next storage round trip, before any feed can emit it. Severity
  reduced Low → Info.

## F07-2: trailing-dot `localhost.` bypasses the SSRF host denylist

- Verdict: CONFIRMED
- Final severity: Low
- Overlaps: none
- Verification: `worker/src/security.ts:284-303` (`blockedHost`) never strips a trailing
  dot; `unfurlTarget` (security.ts:308-323) passes `url.hostname` straight in. PoC
  (`f07-2-ssrf.ts`) on this machine:
  - `new URL('http://localhost./').hostname` → `"localhost."` (no normalization);
    `127.0.0.1.` → `"127.0.0.1"` (normalized, then denied by the numeric checks).
  - `unfurlTarget('http://localhost./')` → ALLOWED; `'https://localhost./'` → ALLOWED;
    `webhookTarget('https://localhost./admin')` → ALLOWED (passes the HTTPS rule, matching
    the report's note); `http://localhost/` and `http://127.0.0.1./` → denied. Also
    ALLOWED: `http://foo.localhost./` — the trailing-dot variant slips the
    `.endsWith('.localhost')` suffix check too. Control `http://example.com./` stays
    allowed, so the fix must not blanket-reject dots.
  - `dns.lookup('localhost.')` on this macOS host resolves to `::1, 127.0.0.1`.
  Mitigation sweep: the unfurl fetcher re-judges each redirect hop (`unfurl.ts:29,43`) but
  with the same `unfurlTarget`, so the hole survives every hop; there is deliberately no
  post-DNS resolved-IP check (that is F07-4's accepted residual). The codebase contrast
  the report cites is real: `worker/src/youtube.ts:26` does `.replace(/\.$/,'')` for
  exactly this reason. Severity Low is right: webhook targets are owner-only
  (`index.ts` `requireOwner()`), unfurl needs a write member, and production Cloudflare
  refuses loopback egress at the platform layer — the bypass only bites on
  `wrangler dev` / self-hosted workerd. Suggested fix (strip one trailing dot before the
  name checks; add `http://localhost./` to `test/webhooks.test.ts:33-38`) is correct.

## F07-3: card cover and gallery images load attacker-chosen third-party URLs unproxied

- Verdict: CONFIRMED
- Final severity: Low
- Overlaps: F05-2
- Verification: every cited line matches. Render side: `worker/src/ui.ts:1089`
  (`<img class="art" src="'+esc(cov)+'"`), `ui.ts:2061` (banner), `ui.ts:2110-2117`
  (gallery: `(p.images||[])` mapped to raw `<img src>`, `linkOk` gates only the `<a>`
  href). Write side: `worker/src/project.ts:2139` (`patch.cover = String(...)`, no
  validation) and `src/core/card.ts:292` + `optString` (card.ts:310-312, no validation).
  Attachments: `opAttach` runs only `sanitizeUrl` (whitespace/control stripping,
  `src/core/write.ts:92-94`); `p.images` is any attachment URL matching an image
  extension on any host (`src/core/body.ts:51,186`). PoC (`f07-3-cover.ts`): an
  `https://attacker.example/...` cover and image attachment are stored, persisted, and
  reloaded verbatim and land in `parsed.images`. Meanwhile link-preview art is proxied:
  `project.ts:1436` rewrites preview images to `/og/<hash>?p=...`, and the design-intent
  comment at `index.ts:469-473` says exactly what the report quotes. Public reachability
  confirmed: `/s/<token>` serves the same `uiHtml` to anonymous visitors
  (`index.ts:430-433`). The report if anything understates the trigger: no explicit cover
  is needed — `cardJson` (`src/core/json.ts:78`) falls back to `parsed.images[0]`, so
  merely attaching an image URL puts unproxied art on the board face. Impact ceiling
  verified as described: `esc()` (ui.ts:445) blocks attribute breakout, `<img>` executes
  no script (including SVG/data:), and the default referrer policy leaks viewer IP +
  deployment origin but not path/token. Low stands: tracking/watering-hole primitive,
  requires write access, no code execution.

## F07-4 (Info): DNS-rebinding residual in unfurl/webhook targets

- Verdict: CONFIRMED
- Final severity: Info
- Overlaps: none
- Verification: the design comment at `worker/src/security.ts:242-246` matches the report
  verbatim ("DNS names remain an egress-resolver responsibility because a hostname can
  rebind after this pure URL check"), and `unfurlTarget` (security.ts:308-323) indeed
  judges only the literal host — no DNS resolution happens anywhere in the guard, so a
  public name resolving to private space passes. Not dynamically reproducible without
  controlling a DNS record, which the report states honestly. Info is the right call: a
  documented posture on Cloudflare, a self-hosting documentation gap off it, and not
  fixable in zero-dep Node without doing DNS in-app.

## Verification summary

CONFIRMED: 2 (F07-2, F07-3) · CONFIRMED-ADJUSTED: 1 (F07-1) · REJECTED: 0 ·
Info-as-reported: 1 (F07-4).

This scope is in good shape: the integration layer's discipline the Wave 1 auditor
praised (single escape helper, per-hop SSRF revalidation, owner-only management) holds up
under re-reading, and all four cited locations match the code exactly. The one meaningful
correction is F07-1, whose calendar-injection scenario collapses on the storage round
trip — the same strictness that makes the YAML subset safe incidentally kills the payload
— leaving a latent one-character `icalText` fix rather than a live Low. F07-2 and F07-3
are real, correctly scoped Lows with cheap, already-suggested fixes.
