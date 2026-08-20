# Scope 07 — Worker integrations & UI rendering

Files audited end to end: `worker/src/ui.ts` (3150 lines), `worker/src/email.ts`, `worker/src/webhooks.ts`, `worker/src/feeds.ts`, `worker/src/unfurl.ts`, `worker/src/youtube.ts`, `worker/src/delivery-queue.ts`, `worker/src/integration-snapshot.ts`, `worker/src/demo.ts`, `worker/src/themes.ts`, plus `test/{webhooks,email,feeds,youtube,delivery-queue,integration-snapshot}.test.ts` (18 tests, all pass on this tree). Call chains into `worker/src/security.ts` (`unfurlTarget`/`blockedHost`), `worker/src/index.ts` (route mounting, authz, headers), `worker/src/project.ts` (delivery loop, inbound email, preview plumbing), `worker/src/registry.ts` (id generation, theme storage), `src/core/{config,card,model,ops}.ts`, and `src/ui/themes.ts` (`validTheme`) were followed to confirm or reject exploitability.

Bottom line: the integration layer is unusually disciplined — one HTML escape helper applied consistently, per-hop SSRF revalidation, bounded queues, owner-only management endpoints. The three findings below are all Low; none is remotely critical.

## F07-1: iCalendar feed emits a raw carriage return from card titles

- Severity: Low
- CWE: 93 (Improper Neutralization of CRLF Sequences)
- Location: `worker/src/feeds.ts:87-91` (`icalText`), reachable via `calendarFeed` at `worker/src/feeds.ts:151-153`
- Description: `icalText` escapes newlines with `.replace(/\r?\n/g, '\\n')`, which rewrites `\n` and `\r\n` but **not a lone `\r`** (a CR not followed by LF). The result is folded by `foldLine` and joined with `\r\n`, so a bare CR lands mid-line in the ICS body. RFC 5545 content lines may only be split by CRLF; a raw CR corrupts the line structure, and lenient calendar parsers that treat CR as a line break will interpret attacker text as new iCalendar properties.
- Exploit scenario: any member with write access to a project creates a card titled e.g. `meet\rBEGIN:VEVENT…(forged event)…\rEND:VEVENT`. Everyone who subscribed to that project's iCal feed (member-scoped bearer URLs) gets a feed whose SUMMARY line contains raw CR bytes; in CR-tolerant parsers this injects attacker-controlled calendar content into the victim's calendar. No script execution; impact is forged/corrupted calendar entries plus a broken feed in strict parsers.
- Evidence:
  ```
  $ node /tmp/bf07-ical-poc.ts        # opAdd -> calendarFeed round trip
  stored title: "meet\rBEGIN:VEVENT evil"
  ICS SUMMARY line: "SUMMARY:meet\rBEGIN:VEVENT evil"
  contains raw CR: true
  ```
  (The engine stores the `\r` unmodified; `calendarFeed` emits it unmodified.) The existing test `test/feeds.test.ts:28` only exercises `\n`/`rn`-free and CRLF inputs, never a lone CR.
- Suggested fix: one-character class change in `icalText`: `.replace(/\r\n?|\n/g, '\\n')`. Add a lone-CR case to `test/feeds.test.ts`.

## F07-2: trailing-dot `localhost.` bypasses the SSRF host denylist

- Severity: Low
- CWE: 918 (Server-Side Request Forgery)
- Location: `worker/src/security.ts:284-303` (`blockedHost`, used by `unfurlTarget`; consumed by `worker/src/unfurl.ts`, `worker/src/webhooks.ts:58-63`, `worker/src/integration-snapshot.ts`)
- Description: `blockedHost` rejects `localhost` and `*.localhost`, but never strips a trailing dot from DNS names. `new URL('http://localhost./').hostname` is `localhost.` (WHATWG URL does not normalize DNS names), which matches neither check, so the target is accepted. Trailing-dot **IP literals** are fine — the URL parser normalizes `127.0.0.1.` → `127.0.0.1` and the numeric checks catch it (verified); only the name-based checks are affected. The codebase knows this pattern: `worker/src/youtube.ts:26` does `.replace(/\.$/,'')` on the host for exactly this reason.
- Exploit scenario: a write-role member attaches a link (triggering an unfurl) or an owner configures a webhook pointing at `http://localhost./admin` / `https://localhost./…`. On any deployment whose resolver maps `localhost.` to loopback (glibc, musl, and macOS all do — verified below) and whose egress does not independently refuse loopback connects (local `wrangler dev` / self-hosted workerd do not), the worker fetches the loopback service. On production Cloudflare, loopback egress is refused by the platform, which is why this stays Low — but the project's own guard is the layer that is documented and tested, and it is provably inconsistent here. Note the code comment at `security.ts:242-246` scopes only *DNS rebinding* to the resolver; `localhost.` is a static name the guard intended to block.
- Evidence:
  ```
  unfurlTarget('http://localhost./')   -> { ok: true }     # bypass
  unfurlTarget('https://localhost./')  -> { ok: true }     # also passes webhookTarget's HTTPS rule
  unfurlTarget('http://127.0.0.1./')   -> denied           # IP literal normalized, caught
  $ node -e "dns.lookup('localhost.',{all:true},…)"        -> ::1, 127.0.0.1
  ```
- Suggested fix: in `blockedHost`, strip one trailing dot before the name checks (`const name = host.endsWith('.') ? host.slice(0, -1) : host;` then compare). Add `http://localhost./` to the SSRF test list in `test/webhooks.test.ts:33-38`.

## F07-3: card cover and gallery images load attacker-chosen third-party URLs unproxied

- Severity: Low
- CWE: 200 (Exposure of Sensitive Information — viewer IP/origin — to an unauthorized actor)
- Location: `worker/src/ui.ts:1089` (`cardHtml`), `worker/src/ui.ts:2061` (`cardModalHtml`), `worker/src/ui.ts:2110-2117` (gallery: `p.images` and previews); write side `worker/src/project.ts:2139` (`patch.cover = String(args['cover'])`, no validation) and `src/core/card.ts:292` (`cover: optString(m['cover'])`)
- Description: two image classes render as raw `<img src>` of URLs taken straight from card content: the card `cover` frontmatter (any string, any host, no scheme/host validation anywhere) and image-looking attachment URLs (`p.images`). Only *link-preview* art is proxied through `/og/<hash>` — the code comments at `worker/src/index.ts:469-473` state the reason explicitly: "otherwise every stranger you send a board link to is reported to whoever hosts the image." Covers and gallery images do exactly that.
- Exploit scenario: a member (or bot) with write access sets `cover: https://attacker.example/beacon.png` on a card. Every operator viewing the board — and every anonymous visitor if the board is public-shared — makes a browser request to `attacker.example`, disclosing viewer IP and the deployment origin (path/token do not leak under the default `strict-origin-when-cross-origin` referrer policy). This is a tracking/watering-hole primitive, not script execution: `<img>` never executes `javascript:` URLs and SVG loaded via `<img>` cannot run script, and `esc()` prevents attribute breakout. The flaw is the unproxied request itself, which the project elsewhere treats as worth preventing.
- Evidence: `coverOf()` (`worker/src/ui.ts:1038-1044`) returns `c.cover` verbatim; `cardHtml` interpolates it as `src` with no `linkOk`-style scheme or host check; the only fetch-side validation (`fetchImage`, `unfurlTarget`) applies to the `/og/` proxy path, which covers never traverse.
- Suggested fix: minimal, zero-dep: when writing a cover, require http/https via the same `linkOk`-equivalent check the UI already has, or route cover/gallery URLs through the existing `/og/` proxy the way link previews do. Documenting the behavior is also defensible, but the current state contradicts the stated design goal at `index.ts:469-473`.

## F07-4 (Info): DNS-rebinding residual in unfurl/webhook targets

- Severity: Info
- CWE: 918 (Server-Side Request Forgery)
- Location: `worker/src/security.ts:242-246` (explicit design comment), `worker/src/security.ts:308-323`
- Description: `unfurlTarget` judges the URL's *literal* host only; a public hostname that resolves to a private address (or rebinds after the check) is knowingly deferred to "an egress-resolver responsibility." That is a reasonable posture on Cloudflare, but a self-hosted workerd deployment has no such resolver control, so unfurl/webhook there can reach internal services by name. Not demonstrated dynamically (requires controlling a DNS record), so Info only; worth one line in self-hosting docs. Not fixable in pure Node built-ins without doing DNS in-app, so the honest fix is documentation, not code.

## Checked clean

- Stored XSS in `worker/src/ui.ts`: every `innerHTML`/`outerHTML`/`insertAdjacentHTML` sink (all ~60 enumerated and read) builds from the single `esc()` helper (ui.ts:445, escapes `&<>"'`); the only raw interpolations are static strings, numbers, or values proven constrained upstream: `statechip()` args are always one of six canonical states (`src/core/config.ts:815-827` rejects/free-falls anything else), project/space ids are server-generated `p-<hex>`/`s-<hex>` (`registry.ts:177-181,1181`), theme `custom` is locked to `#rrggbb` by `validTheme` (`src/ui/themes.ts:297-307`), and share/feed tokens are regex-validated hex before reaching `uiHtml` (`index.ts:430,435`).
- JSON-in-`<script>` breakout: `uiHtml` escapes `<` → `<` in embedded JSON (ui.ts:3132-3146).
- Mini-markdown renderer `md()` (ui.ts:528-540): escapes the full source *before* applying code/bold/italic transforms, so generated tags are fixed strings over escaped text.
- Link hrefs: gated by `linkOk` (http/https/mailto only) with `target="_blank" rel="noopener"` (ui.ts:446, 2104, 2115); `<img src>` cannot execute script in any modern browser.
- Email header injection: recipients validated by a `<>…whitespace`-excluding regex, deduped, capped at 25 (`email.ts:37-54`); inbound `messageId`/`from`/`subject` stripped of CRLF and all control chars (`email.ts:56-75`); outbound subject/body components (`projectId`, `action`, `cardId`, `actor`) are charset-constrained upstream (`src/core/model.ts:55-56`, `security.ts:52`), so no CRLF can reach the bridge payload; bodies are plain text.
- Webhook signing/replay: HMAC-SHA256 over `<unix-seconds>.<exact-body>`, `sha256=` prefix, verified deterministic against `node:crypto` (`test/webhooks.test.ts:23-31`); receiver-side timestamp tolerance and `X-Botflow-Delivery` dedupe documented in the contract comment (webhooks.ts:77-78).
- Webhook SSRF: HTTPS-only, per-hop target revalidation, only 307/308 followed (signed POST never downgraded), credentials rejected, redirect count bounded — all confirmed by reading and by the passing redirect tests (`test/webhooks.test.ts:40-65`).
- SSRF IP spelling: decimal/hex/octal/short-form IPv4, IPv4-mapped/NAT64/6to4 IPv6, link-local, CGNAT, multicast, `.local`/`.internal`/`.home.arpa`, zone-id literals all denied — verified dynamically against `unfurlTarget` (see F07-2 for the one hole).
- Unfurl fetcher: content-type gate (html only), 512 KiB page cap and 5 MiB image cap via streamed `readCapped`, 5 s timeout, `image/svg+xml` rejected as script (unfurl.ts:147); `/og/` proxy resolves only hashes already present in the project's unfurl cache — not an open proxy (`index.ts:474-494`, `project.ts:1497-1500`) — and serves with `content-security-policy: sandbox` + `nosniff`.
- Feeds (Atom/RSS): every field XML-escaped including quotes (`feeds.ts:30-35`); served with correct content types, `nosniff`, `cache-control: private, max-age=60` (`index.ts:453-464`). (iCal escaping: see F07-1.)
- Delivery queue: claim is one synchronous transaction; lease expiry reclaims crashed `sending` rows; completed attempts are terminally `failed` at 6 attempts regardless of prior `sending` state (`project.ts:398-414`); hostile-endpoint `Retry-After` capped at 24 h; circuit breaker (5 failures / 15 min) bounds a dead endpoint; per-integration terminal history pruned to the newest 1000.
- Integration snapshot import: strict schema, per-prefix unique ids, `bfwhsec_` secret format enforced, token-hash duplication rejected, webhook URLs revalidated against the SSRF denylist on import (`integration-snapshot.ts`); snapshot secrets leave the deployment only through the owner-only export, whose UI copy warns it "is one" (credential) (ui.ts:3052).
- Demo loader: `/api/demo` is owner-only and runs through `validateOrgImportPayload` like any import (`index.ts:790-797`); demo content is static and benign.
- Inbound email: token is 256-bit random, stored/compared as SHA-256 hash, exact-match route lookup; per-route 100/hour cap; transactional message-id dedupe; card title/comment bounded and `sanitizeBlock`-ed (`project.ts:602-674`).
- Authz on integration management: webhooks/email routes/subscriptions/outbox/deliveries/replay all `requireOwner()`; outbox claim additionally accepts only the configured bridge bot (`index.ts:1232-1355`).
- CSRF/CORS: all API auth is bearer tokens from localStorage — no cookies, no ambient authority, no CORS headers — so cross-site request forgery has nothing to ride on.
- Clickjacking: HTML pages send `content-security-policy: frame-ancestors 'none'` (`index.ts:62-65`). (No script-src CSP exists, so defense-in-depth is absent; every data flow was nevertheless verified escaped, so this is noted, not reported.)
- Prototype pollution / ReDoS: no dynamic property assignment from integration input anywhere in scope; all regexes reviewed are linear-time with bounded quantifiers.
