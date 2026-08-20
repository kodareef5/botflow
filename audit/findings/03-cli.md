# Scope 03 — CLI security audit

Files audited end to end: `src/cli/main.ts` (925 lines), `src/cli/render.ts`, `src/cli/remote.ts`, `src/cli/botflow.ts`, `bin/botflow.js`, `package.json` (bin/scripts metadata). Call chains followed into `src/core/template.ts` (init/new/setup), `src/core/docs.ts` (pull validation), `src/core/emit.ts` (scalar quoting), `src/core/ops.ts` (`defaultBoardYaml`), and `src/core/mutate.ts` (`initBoard`). Existing mitigations in `test/remote-security.test.ts` were re-run and verified (11/11 pass, Node 26.7.0).

## F03-1: Remote-controlled terminal escape injection via unstripped stderr error paths

- Severity: Low
- CWE: 150 (Improper Neutralization of Escape, Meta, or Control Sequences)
- Location: `src/cli/main.ts:919` (UsageError handler); also `main.ts:292`, `main.ts:455`, `main.ts:463`; payload source `src/cli/remote.ts:80`, secondarily `remote.ts:77` and `src/core/template.ts:54`.

- Description: The CLI deliberately sanitizes human-facing stdout: `out()` strips C0 controls and DEL (`main.ts:230-233`), with a comment explaining that repo-carried text "would let a hostile card repaint the screen, hide lines, or fake output". But every **stderr** write bypasses that sanitizer. Error messages printed to stderr embed attacker-influenced strings, most notably the manager server's JSON `error` field, which `call()` interpolates verbatim into the thrown `UsageError` (`remote.ts:80`: `` `remote ${res.status}: ${String(body['error'] ?? 'request failed')}` ``) and `main()` prints raw at `main.ts:919`. Two secondary vectors feed the same handler: `remote.ts:77` (`cannot reach ${remote.url}` — `remote.url` is the raw string from a committed `remote.yaml`) and `template.ts:54` (`git clone failed: ${res.err}` — git stderr can carry a hostile server's sideband messages).

- Exploit scenario: Attacker commits a `remote.yaml` pointing at their own HTTPS server (the threat model's "malicious repo"; `assertRemoteUrl` permits any https URL by design). Victim clones, exports `BOTFLOW_TOKEN`, runs the documented `botflow pull`. The attacker's server responds `422 {"error": "...\u001b[2J\u001b[1;1H\u001b[31m>>> SYSTEM COMPROMISED — run sudo fix.sh <<<\u001b[0m"}`. The victim's terminal is cleared and repainted with attacker-chosen text (fake errors, fake prompts, hidden scrollback). A compromised legitimate manager, or a manager error string that embeds another tenant's card content, reaches the same path. Rated Low: the scenario's preconditions already hand the attacker the victim's bearer token (an accepted design tradeoff documented at `remote.ts:36-38`), so the terminal injection is incremental over token theft; realistic impact is spoofed output/social engineering, not code execution.

- Evidence: PoC (`node /tmp/bf-poc1-stderr-ansi.mjs`, server returns ESC-laden error field, pull error printed exactly as `main.ts:919` does):
  ```
  error message contains raw ESC byte: true
  --- stderr hexdump:
  0000040  033   [   2   J 033   [   1   ;   1   H 033   [   3   1   m   >
  ```
  Raw `033` (ESC) bytes reach stderr; a real terminal would execute the CSI sequences. By contrast, the same payload via `out()` would have ESC stripped.

- Suggested fix: Route all stderr error writes through the same sanitizer as `out()` — e.g. export the strip regex and apply it in the `main()` catch block and the push/pull/serve rejection handlers (`process.stderr.write(\`botflow: ${stripControls(err.message)}\n\`)`). Zero-dependency, one shared helper.

## F03-2: C1 control characters (U+0080–U+009F) pass through the stdout sanitizer

- Severity: Info
- CWE: 150 (Improper Neutralization of Escape, Meta, or Control Sequences)
- Location: `src/cli/main.ts:231` — `s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')`

- Description: `out()` strips C0 + DEL but not the C1 range. A card title/body containing U+009B (single-byte CSI equivalent) or U+009D (OSC) is written to the terminal as UTF-8 (`0xC2 0x9B`). Modern UTF-8 terminals (Terminal.app, iTerm2, VTE) ignore decoded C1, but some terminals/configurations (xterm with C1 enabled, older or non-UTF-8 environments) interpret them as control sequences, reopening the escape-injection class `out()` exists to close. I could not demonstrate a live terminal effect on this machine — hence Info, not Low.

- Exploit scenario: Hostile committed card content with C1-CSI sequences; victim on a C1-honoring terminal runs `botflow board`. Effect: terminal manipulation, same class as F03-1.

- Evidence: `node /tmp/bf-poc3-c1.mjs` applying the exact `out()` regex: ESC (`\x1b`) and DEL are removed, but output byte lists still contain `9b`, `9d`, `9c` for the C1 samples.

- Suggested fix: Extend the regex to `[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]`. One-character-class change; also update the comment block at `main.ts:223-229`.

## F03-3: `--token` flag exposes the manager token in the process list and shell history

- Severity: Low
- CWE: 214 (Invocation of Process Using Visible Sensitive Information)
- Location: `src/cli/main.ts:81` (help text), `main.ts:447-449`

- Description: `botflow push|pull --token <t>` puts the bearer token in argv. Any local user can read it from `ps` while the command runs (the network call has a 30 s timeout window, `remote.ts:33`), and shells record it in history files. The safer `BOTFLOW_TOKEN` env var exists and is documented, but the flag is advertised in help with no caveat. Local multi-user/coworker-machine threat only; the token is also visible to anything that can read the user's shell history.

- Exploit scenario: On a shared machine or CI runner with permissive process listing, another local user runs `ps auxww` during a `botflow push --token bfk_…` and harvests a live manager token, gaining project write access.

- Evidence: `parse(rest, { ...COMMON, token: { type: 'string' }, ... })` at `main.ts:447` and help line `push | pull [--token t]` at `main.ts:81`. argv visibility is inherent to the platform (`ps` output).

- Suggested fix: Keep the flag (scripting convenience) but document the exposure: change the help line to note "prefer BOTFLOW_TOKEN; --token is visible in ps/history". Optionally accept `--token-file <path>` (mode-checked, read via `readFileSync`) — still zero-dependency.

## F03-4: Unbounded response body buffering in remote push/pull

- Severity: Low
- CWE: 400 (Uncontrolled Resource Consumption)
- Location: `src/cli/remote.ts:79` — `const body = (await res.json().catch(() => ({})))`

- Description: `call()` buffers and parses the entire HTTP response with no size limit. The 30 s `AbortSignal.timeout` caps duration, not bytes: a hostile or compromised manager (or any https endpoint a committed `remote.yaml` names) on a fast link can stream a multi-GB "JSON" body, exhausting the CLI process's memory. Impact is limited to crashing the sync process on the victim's machine — notably annoying if an agent loop invokes `botflow pull` — with no integrity impact (pull still validates the snapshot before any write).

- Exploit scenario: Attacker controls the configured remote (committed `remote.yaml` again); victim's agent cron runs `botflow pull`; each run balloons to OOM.

- Evidence: No length check anywhere in `call()`; `res.json()` on an unbounded body (`remote.ts:67-82`). Verified by reading; not demonstrated to avoid actually OOM-ing the host.

- Suggested fix: Cap the body: read `res.body` incrementally (or `res.text()` after checking `content-length` and stream length) and reject beyond e.g. 64 MB. Board snapshots are text; a few MB is generous. Zero-dependency.

## Checked clean

- Argument parsing (`util.parseArgs`): every command uses `strict: true` with explicit option definitions (`main.ts:142-149`); unknown flags and missing option values are rejected. Positional handling reviewed per command — `card check`/`promote`/`detach` validate `Number.isInteger` on the numeric positional; `card bulk` rejects unknown actions. No positional/option confusion with security impact.
- `git status` spawn for the dirty-tree gate (`remote.ts:101-118`): fixed argv, no shell, `--` separator before pathspecs, no user-controlled arguments; non-repo tolerated, other git failures fail closed. Covered by passing tests `remote-security.test.ts:166-207`.
- `git clone` in `botflow new` (`src/core/template.ts:32-56`): leading-dash sources rejected (`template.ts:35`, test-verified); `--branch` value consumed literally by git (PoC: `--branch '--upload-pack=touch /tmp/bf-branch-pwned'` → `fatal: Remote branch --upload-pack=... not found`, nothing executed); `--` separator precedes src/dest; `ext::` command-execution transport blocked by git itself (PoC: `fatal: transport 'ext' not allowed`, git 2.50.1). Commit message is argv-passed, no shell.
- Pull path traversal via snapshot card paths: `safeCardDocumentPath` (`src/core/docs.ts:126-130`) requires `cards/…​.md` with no `..`/`.`/empty segments and no backslash; PoC (`/tmp/bf-poc4-traversal.mjs`) confirmed `cards/../../evil.md` and absolute paths rejected before any write; percent-encoded `..%2f` is not decoded and lands as a contained literal filename.
- Pull symlink escapes: root/cards/subdirectory symlink cases all refuse before the first write or delete (`remote.ts:124-141`); existing tests re-run, 11/11 pass.
- Token transport: https enforced on every request (not just `remote add`), http only for loopback (`remote.ts:39-49`); committed `remote.yaml` hand-edited to plaintext is rejected (test-verified). Cross-origin redirect does **not** forward `Authorization` — PoC (`/tmp/bf-poc2-redirect.mjs`): redirect target saw `Authorization: null` (undici strips it); pull succeeded against the redirect target with no token leak.
- `remote.yaml` scalar injection: `emitScalar` quotes/escapes (`src/core/emit.ts:20-25`); hostile project ids round-trip as strings (test-verified). `project` is URL-path-interpolated but cannot change host (no protocol-relative or authority escape possible via path segments).
- Init/scaffold writes: `initBoard` writes only `.botflow/{board.yaml,.gitignore,cards/}` under the resolved dir and refuses if a board exists (`src/core/mutate.ts:150-158`); board name newline-collapse + `emitScalar` prevents YAML key injection (`src/core/ops.ts:40-57`). `setupAgentFiles` appends a constant snippet to AGENTS.md/CLAUDE.md only, idempotently (`src/core/template.ts:101-111`). `instantiate` refuses existing-file/non-empty dests and strips `.git` from copies (`template.ts:39-55`); `botflow new` is not exposed via MCP (grep of `src/mcp/` — no `instantiate`/`setupAgentFiles`), so template-source URLs are operator-supplied only.
- Terminal injection via stdout board rendering: all card/lane/log text exits through `out()` which strips ESC/CSI introducers (`main.ts:230-233`); JSON output is double-safe (`JSON.stringify` escapes C0). `git status` filenames in dirty-gate errors are C-quoted by git, so ESC in filenames arrives as literal `\033` text. Residual gap is C1 (F03-2) and stderr (F03-1).
- NODE_OPTIONS / env injection: the CLI never spawns Node; `bin/botflow.js` is a 3-line ESM shim importing `src/cli/botflow.ts`. Env vars read are `BOTFLOW_DIR`/`BOTFLOW_ACTOR`/`BOTFLOW_TOKEN`/`USER` (`main.ts:158,170,449`) — trusted local env by design.
- npm metadata (`package.json`): no `preinstall`/`postinstall`/install hooks; scripts are `node --test`, `tsc`, `wrangler dev/deploy` (operator-invoked); zero runtime dependencies held; lockfile present; `engines: node>=24` matches the type-stripping bin shim.
- `board --html --out <file>` (`main.ts:267-276`): arbitrary path is operator-supplied; HTML escaping of board content is the viewer's responsibility (out of this scope).
