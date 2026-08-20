# Verified — Scope 05: Local viewer + UI

Source report: `audit/findings/05-viewer.md`. Verified against the working tree at
`/Users/mac/dev/botflow` on 2026-08-20. PoC board and scripts live at
`/tmp/bf-verify-05/` (hostile board: `board.yaml` with an XSS field name, cards
001–003 covering the XSS carrier, explicit remote cover, and attachment-fallback
cover). All PoCs ran the *real shipped code*: `loadTree`/`analyze`/`viewerData`
for the data path, and the actual functions extracted from the generated
`viewerHtml` CLIENT_JS executed under `node:vm` (the same slice-eval technique
`test/viewer.test.ts:127-180` already uses).

## F05-1: Stored XSS — custom field `name` rendered unescaped in the card detail drawer
- Verdict: CONFIRMED
- Final severity: Medium
- Overlaps: none
- Verification:
  - Parse-time acceptance confirmed at `src/core/config.ts:650-654`: `name` is
    kept if `typeof map['name'] === 'string' && map['name'] !== ''` — any
    non-empty string, no markup rejection. My hostile `board.yaml`
    (`name: "<img src=x onerror=alert(document.location)>"`) parsed with zero
    lint findings.
  - Flow confirmed: `cardCustomFields` (`src/core/presentation.ts:95-105`) maps
    `definition.name` verbatim into card JSON; `node /tmp/bf-verify-05/prove-f05-1.mjs`
    shows real `viewerData` output carrying
    `"name": "<img src=x onerror=alert(document.location)>"`.
  - Sink confirmed at the exact cited lines: `src/viewer/page.ts:384`
    (`...(c.fields||[]).map(f=>[f.name,fieldText(f.value)])`) and
    `page.ts:397` (`'<tr><td>'+r[0]+'</td><td>'+esc(r[1])+'</td>'` — value
    escaped, label not). Every other row label is a compile-time constant;
    `f.name` is the only attacker-controlled one.
  - Reproduced with the real shipped `openDrawer` extracted from the generated
    page and executed in `node:vm` with minimal DOM stubs against the real card
    JSON. Captured `innerHTML` contains:
    `<tr><td><img src=x onerror=alert(document.location)></td><td>pwned</td></tr>`
    — raw, unescaped. `$` is a plain `querySelector` alias (`page.ts:174`); no
    sanitization layer exists anywhere in the chain.
  - Static-export path confirmed: `viewerHtml` (`page.ts:443`) embeds the payload
    as a JS literal with `<` → `<` transport escaping (verified: payload
    contains `<img`, no `</script>` breakout, `<title>` is `escHtml`'d), and
    evaluating it restores the live `<img ...>` string, which then hits the same
    sink. (Minor wording nit in the original: the browser restores the string by
    *evaluating a JS object literal* — `window.__BOTFLOW__={...}` at
    `page.ts:471` — not by calling `JSON.parse`; identical effect.) Both
    `botflow serve` (`serve.ts:43`) and `botflow board --html`
    (`src/cli/main.ts:269`) ship the same `viewerHtml`/`CLIENT_JS`.
  - Mitigation check: no test covers this sink. The only escaping invariant in
    `test/viewer.test.ts` is CUR-in-findings (`:207-211`); the `*security*.test.ts`
    files don't touch the viewer drawer.
  - Severity: the rubric caps repo-content-controlled flaws at Low *unless* they
    produce code execution — this one does (arbitrary JS in the victim's
    browser, crossing the repo→browser boundary, and able to drive-by other
    localhost services from the browser). It needs victim interaction (clone,
    serve/export, open the card) and the origin holds no credentials, so Medium
    is right — neither higher nor lower.

## F05-2: Remote cover/attachment URLs auto-fetched by the victim's browser (tracking pixel / blind request)
- Verdict: CONFIRMED
- Final severity: Low
- Overlaps: F07-3
- Verification:
  - Data path confirmed: `src/core/json.ts:78`
    (`cover: card.cover === 'none' ? null : (card.cover ?? parsed.images[0] ?? null)`),
    `src/core/card.ts:292` + `optString` (`card.ts:310-312`: any non-empty
    string), `src/core/body.ts:51,186` (`IMAGE_RE` matches any URL ending in an
    image extension and `^data:image/`).
  - Reproduced via `node /tmp/bf-verify-05/prove-f05-2.mjs` with the real shipped
    `cardHtml`: card with `cover: https://attacker.example/track.png` emits
    `<img class="art" src="https://attacker.example/track.png" alt="" loading="lazy">`,
    and a card with *no* explicit cover but a remote `.gif` attachment gets
    `cover = "https://attacker.example/pixel.gif?board=verify05"` emitted the
    same way (the attachment-fallback vector the report mentions and I verified
    independently).
  - The report's no-XSS claim is accurate: `page.ts:266` runs the URL through
    `esc()`, which escapes `"` (`page.ts:175`), so attribute breakout is
    impossible; `<img>` doesn't execute `javascript:`/`data:` scripts.
  - Mitigation check: none found — no allowlist, no proxying, no test pinning
    remote-cover behavior. `loading="lazy"` defers but does not prevent the
    fetch (all kanban cards are in the DOM and fetch as they approach the
    viewport).
  - Severity: Low is correct per the rubric — requires attacker control of
    committed repo content, and the effect is a one-way blind GET (discloses
    open-time/IP to the attacker; can poke GET endpoints elsewhere). No
    cross-boundary write, no response readable. Not understated: the blind-GET
    angle against other localhost services is real but weak (no response, GET
    only from an `<img>`).

## F05-3: No authentication on the loopback API — any local process/user can read the full board tree
- Verdict: CONFIRMED
- Final severity: Info
- Overlaps: none
- Verification:
  - `src/viewer/serve.ts:30-65` read in full: binds `127.0.0.1` only (`:60`),
    the only gate is the loopback Host allowlist (`:16-22,32-36`), no
    credential, no method check.
  - Reproduced via `node /tmp/bf-verify-05/prove-f05-3.mjs` against the real
    `serveBoard`: `GET /api/data` → 200 with the full tree including raw card
    bodies and lint findings (no `www-authenticate` header); `POST /api/data`
    → 200 (no method gate); a raw-socket request with `Host: localhost` → 200.
  - The report's framing is accurate: strictly read-only (three exact-match
    routes; the only state-changing surface is nonexistent), so impact is
    disclosure to co-tenant processes/users on a multi-user host while the
    victim runs the viewer. Single-user design target unaffected.
  - Severity: Info is right; the report itself labels it "by design, flagged
    for completeness," and the suggested token/ephemeral-port hardening is
    optional, not a fix for a live vulnerability.

## Verification summary

3 CONFIRMED, 0 CONFIRMED-ADJUSTED, 0 REJECTED.

This report is unusually solid: every cited line number is exact, every claim
reproduced against the real shipped code (including the browser-side sink,
executed verbatim under `node:vm`), and the severities match the threat model —
the one finding that crosses into code execution (F05-1) is correctly rated
above Low, while the two repo-content-gated issues stay Low/Info. The "Checked
clean" section also held up under spot-checks (Host-header guard, no static
file serving, constant response headers, `<` transport escaping,
no-method-check CSRF irrelevance). The single real gap worth acting on is the
one-word fix for F05-1: escape `r[0]` at `src/viewer/page.ts:397`.
