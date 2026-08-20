# Scope 05 — Local viewer + UI audit

Files audited end to end: `src/viewer/serve.ts` (65 lines), `src/viewer/page.ts` (475 lines, incl. the full embedded `CLIENT_JS` and `CSS`), `src/ui/themes.ts` (308 lines), `src/cli/render.ts` (only where it feeds HTML — it just re-exports `boardJson`/`cardJson` from `src/core/json.ts`, which I also read), plus `test/viewer.test.ts` and `test/ui.test.ts`. Call chains were followed into `src/core/config.ts`, `card.ts`, `analyze.ts`, `model.ts`, `metrics.ts`, `body.ts`, `presentation.ts`, and `src/cli/main.ts` only to confirm whether attacker-controlled board content can reach unescaped HTML sinks.

Note: `test/ui.test.ts` exercises `worker/src/ui.ts` (the hosted manager) — that surface belongs to the worker scopes; I examined it only for shared-theme parity with the viewer.

Threat model applied: a malicious repo's `.botflow/` content is untrusted; the victim runs `botflow serve` or `botflow board --html` and views the page in their browser.

---

## F05-1: Stored XSS — custom field `name` rendered unescaped in the card detail drawer
- Severity: Medium
- CWE: 79 (Improper Neutralization of Input During Web Page Generation)
- Location: `src/viewer/page.ts:384` (row built from `f.name`) rendered at `src/viewer/page.ts:397` (`'<tr><td>'+r[0]+'</td>'` — `r[0]` not passed through `esc()`)
- Description: Every drawer row label is a compile-time constant except one: `...(c.fields||[]).map(f=>[f.name,fieldText(f.value)])`. `f.name` comes from the board config's custom-field definition (`fields[].name` in `board.yaml`), which `parseCustomFields` accepts as *any non-empty string* (`src/core/config.ts:650-654`). The drawer's `innerHTML` concatenation escapes every row *value* (`esc(r[1])`) but not the row *label* (`r[0]`), so a hostile board config injects raw HTML/script when a card carrying that field is opened. The same code path ships in both `botflow serve` (live page) and `botflow board --html` (self-contained snapshot), so the payload also persists in any exported/shared HTML file.
- Exploit scenario: Attacker publishes a repo whose `board.yaml` contains
  ```yaml
  features: [custom-fields]
  fields:
    - id: evil
      name: "<img src=x onerror=alert(document.location)>"
      type: text
  ```
  and a card with `evil: pwned` in its frontmatter. Victim clones the repo, runs `botflow serve` (or `board --html`), and clicks the card. The `onerror` handler executes in the victim's browser in the viewer origin (`http://127.0.0.1:<port>` or a `file://` export). The origin holds no credentials and the API is read-only, so direct data theft is limited to the attacker's own board — but arbitrary JS in the victim's browser can deface/phish from a trusted local UI, persist via `localStorage` on that origin, and issue drive-by requests from the victim's browser to other reachable services (e.g. other localhost dev servers' state-changing endpoints), which the viewer's own Host-header guard does nothing to prevent (the script runs *inside* the victim's browser).
- Evidence: PoC board at `/tmp/bf-poc` + `/tmp/bf-poc/prove.mjs`, which extracts the *actual shipped* `openDrawer` function from the generated page and runs it in a `node:vm` against the real `viewerData` output:
  ```
  $ node /tmp/bf-poc/prove.mjs
  --- drawer innerHTML (tail) ---
  ...<tr><td><img src=x onerror=alert(document.location)></td><td>pwned</td></tr>...
  --- verdict ---
  VULNERABLE: raw <img src=x onerror=...> from board config reached innerHTML
  ```
  Also confirmed the static export path: the embedded `__BOTFLOW__` JSON correctly transport-escapes `<` as `<` (no `</script>` breakout), but `JSON.parse` in the browser restores the live `<img ...>` string, which then hits the unescaped sink.
- Suggested fix: One-word, zero-dependency: escape the label at the sink — `rows.map(r=>'<tr><td>'+esc(r[0])+'</td><td>'+esc(r[1])+'</td></tr>')` in `openDrawer`. (Validating `name` in `parseCustomFields` is optional defense in depth; free-text display names are a legitimate feature, so the sink-side escape is the correct fix.) Consider adding a regression test asserting all drawer row labels pass through `esc()`.

## F05-2: Remote cover/attachment URLs auto-fetched by the victim's browser (tracking pixel / blind request)
- Severity: Low
- CWE: 200 (Exposure of Sensitive Information) — borderline; also CWE-829-ish inclusion of remote content
- Location: `src/viewer/page.ts:266` (`'<img class="art" src="'+esc(c.cover)+'" ... loading="lazy">'`); data source `src/core/json.ts:78` (`card.cover ?? parsed.images[0]`), where `cover` is any non-empty string (`src/core/card.ts:292`, `optString`) and body attachment URLs matching `IMAGE_RE` include arbitrary remote URLs and `data:image/*` (`src/core/body.ts:51`)
- Description: A card's `cover:` URL (or first image-looking attachment URL) is emitted as an `<img src>`. The attribute is properly escaped, so no XSS — `<img>` never executes `javascript:` or SVG scripts. But any absolute URL is fetched by the victim's browser when the card scrolls into view.
- Exploit scenario: Malicious repo sets `cover: https://attacker.example/track.png` on a card. When the victim views the board, their browser issues a request to the attacker's server, disclosing that the board was opened, when, and the victim's IP. Also usable as a blind GET primitive toward internal URLs (no response readable, but the request happens — e.g. hitting a GET-triggered endpoint on another localhost service).
- Evidence: `/tmp/bf-poc/cards/002-cover.md` with `cover: https://attacker.example/track.png`; `node /tmp/bf-poc/cover-test.mjs` prints `cover as served to browser: "https://attacker.example/track.png"`, and the emitted card markup is `<img class="art" src="https://attacker.example/track.png" alt="" loading="lazy">`.
- Suggested fix: Documented risk may be acceptable for a local viewer (boards are the user's own repo content most of the time). If hardening is wanted without a dependency: skip remote covers unless they match an allowlist, or render a placeholder for non-`data:`/non-relative URLs. At minimum, note the behavior in the serve/board docs.

## F05-3: No authentication on the loopback API — any local process/user can read the full board tree
- Severity: Info
- CWE: 306 (Missing Authentication for Critical Function) — by design, flagged for completeness
- Location: `src/viewer/serve.ts:30-65`
- Description: The server binds `127.0.0.1` only and enforces a loopback Host allowlist, but has no credential. While `botflow serve` runs, every process on the machine — including other user accounts on a multi-user host — can `curl http://127.0.0.1:4666/api/data` and read all boards, card bodies, and lint findings.
- Exploit scenario: On a shared workstation/CI runner, a co-tenant process reads potentially sensitive project board content (unreleased plans, security findings) whenever the victim happens to run the viewer. No write surface exists, so impact is read-only disclosure, and single-user laptops (the stated design target) are unaffected.
- Evidence: `POST /api/data` with no credentials returns the full tree (observed in `/tmp/bf-poc/serve-test.mjs`: `POST /api/data -> 200 {"root":".",...}`). The only gate is the Host allowlist, which any local client satisfies.
- Suggested fix: Acceptable as designed; if desired, listen on an ephemeral port by default and/or print a random token in the startup URL (`?t=...`) checked by the handler. Both are dependency-free.

---

## Checked clean

- Static-file path traversal: there is no static file serving at all — three exact-match routes (`/`, `/index.html`, `/api/data`); `GET /../etc/passwd` and `GET /%2e%2e%2fetc%2fpasswd` both 404 (verified live). No path is ever joined to the filesystem in `serve.ts`.
- DNS rebinding / Host-header attacks: fail-closed loopback allowlist (`serve.ts:16-22`), verified live against `evil.com`, `127.0.0.1.evil.com`, `localhost.evil.com`, trailing-dot hosts, uppercase `LOCALHOST`, `[::ffff:127.0.0.1]`, hex/decimal IP encodings — all 403; truly missing Host → 400 before the handler. Also covered by `test/viewer.test.ts:182`.
- CSRF / state-changing endpoints: none exist — the server is strictly read-only (no method check needed; POST returns the same read-only data). No cookies, no auth state, nothing to forge.
- CORS: no `Access-Control-Allow-Origin` is emitted (verified), so cross-origin pages cannot read responses; combined with the Host allowlist, browser-based exfiltration of board data is blocked.
- Response header / CRLF injection: all `writeHead` calls use constant status codes and constant `content-type` values; the only input-derived text (`err.message` in the 500 path, board name in `<title>`) goes to the body, the former as `text/plain`, the latter through `escHtml` (verified: `x</title><script>...` renders inert).
- Script breakout from embedded JSON/HTML: `viewerHtml` escapes `<` → `<` in the `__BOTFLOW__` payload (no `</script>` or `<!--` breakout — verified by inspecting the emitted blob) and `escHtml`s the `<title>`; `__LIVE__` is a server-side boolean literal; `__THEMES__` is a compile-time constant with no `<`.
- All other unescaped interpolations in `CLIENT_JS` are parser-validated enums or engine-computed numbers, confirmed by reading the validators: `c.state`/`lane.canonical`/`stateColor()` ∈ `CANONICAL_STATES` (`config.ts:815-827`, `model.ts:3-8`, rollup `else` restricted to `todo|wishlist` at `config.ts:900`), `c.priority` matches `/^p[0-3]$/` (`card.ts:157`), `estimate`/`hill`/`wip` are validated integers, `cover_color`/label colors are validated `#hex` (and additionally `esc()`'d), metrics fields (`dueChanges`, `idleDays`, `stagnation.days`, `progress`, throughput counts/dates) are computed numbers. I grepped every `'+'` concatenation in `page.ts` and classified each one.
- Markdown body renderer `md()`: input passes through `esc()` before any tag insertion; generated tags contain only already-escaped text; no attributes are built from content. Regexes are linear (`/^.../`, `[^*]+`, `[^\`]+`) — no ReDoS.
- `<img src>` from board content: attribute-escaped; `javascript:`/`data:` script execution is not possible in an `<img>` context (see F05-2 for the residual privacy issue).
- MIME sniffing: correct `content-type` on all responses; the JSON (`application/json`, starts with `{"root":`) is not sniffsable into HTML/JS by current browsers. Adding `X-Content-Type-Options: nosniff` would be cheap hardening but there is no demonstrated exploit without it.
- Caching: no cache headers and no `Last-Modified`, so no heuristic freshness; `/api/data` is re-read from disk per request and the poll compares payloads — no stale-data or cache-poisoning angle.
- Theme layer (`themes.ts` + viewer `applyTheme`): `validTheme` allowlists style/accent ids and regex-validates custom hex; the viewer's `localStorage`-backed theme falls back to allowlisted entries and only writes via `style.setProperty` (no stylesheet injection). Attacker control of that `localStorage` would require script execution on the origin in the first place — self-XSS only.
- Board/lane/substate/label/field values everywhere else in the page: all rendered through `esc()` (lane names, substates, board keys/`CUR`, label ids/values/colors, axis labels, findings, relationships, drawer values) or assigned via `textContent` (`b.name`, counts). The single exception is F05-1.
- `test/viewer.test.ts` coverage checked: endpoints, self-containment, rebinding guard, and one escaping invariant (CUR in findings heading) are tested; the drawer-label sink (F05-1) is not covered by any test.
