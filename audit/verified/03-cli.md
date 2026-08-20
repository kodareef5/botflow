# Scope 03 — CLI: verification of audit/findings/03-cli.md

Verified on Node v26.7.0 against the working tree. PoCs were written under
`/tmp/bf-verify/` (throwaway boards under `/tmp/bf-verify/board*`, hostile
servers on 127.0.0.1 ports 8974–8976). No project source was modified.

## F03-1: Remote-controlled terminal escape injection via unstripped stderr error paths

- Verdict: CONFIRMED
- Final severity: Low
- Overlaps: none

- Verification: Read the cited code. `out()` at `src/cli/main.ts:230-233` strips
  C0/DEL (`s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')`); every stderr
  write (`main.ts:292, 455, 463, 919`; `src/mcp/server.ts:666`) is raw
  `process.stderr.write` with no sanitizer — grep confirms no strip helper is
  applied to stderr anywhere. The payload source is real: `remote.ts:80`
  interpolates the server's JSON `error` field verbatim
  (`` `remote ${res.status}: ${String(body['error'] ?? 'request failed')}` ``).
  Reproduced end-to-end: hostile HTTP server on 127.0.0.1 answered
  `422 {"error": "\u001b[2J\u001b[1;1H\u001b[31m…\u001b[0m"}` to
  `botflow pull`; `od -c` of the CLI's stderr shows raw `033` bytes:
  ```
  0000020    4   2   2   :     033   [   2   J 033   [   1   ;   1   H 033
  ```
  (For pull/push the bytes exit via the rejection handler at `main.ts:463`, not
  the `main.ts:919` catch — same unsanitized sink either way.) No mitigation
  found: no stderr path in `test/cli.test.ts` / `test/remote-security.test.ts`
  asserts sanitization. Severity Low is right: the primary scenario needs a
  committed hostile `remote.yaml`, which already hands the attacker the victim's
  bearer token (documented tradeoff, `remote.ts:36-38`); residual impact is
  terminal spoofing/social engineering, not code execution or file writes. The
  secondary vectors (`remote.ts:77` URL echo, `template.ts:54` git-clone stderr)
  carry the same class with equal or heavier preconditions.

## F03-2: C1 control characters (U+0080–U+009F) pass through the stdout sanitizer

- Verdict: CONFIRMED
- Final severity: Info
- Overlaps: none

- Verification: The regex at `src/cli/main.ts:231` is exactly as quoted and
  excludes `\x80-\x9f`. Unit check with the exact regex: input containing
  U+009B comes out unchanged (`c2 9b 5b 33 31 6d …`), while an ESC-CSI sample
  is stripped. End-to-end: card `001-c1.md` with `title: "C1 payload
  \u009b[31mHERE\u009c"` rendered via `botflow board`; stdout contains the
  UTF-8 C1 bytes (`grep` matched `c2 9b [31mHERE c2 9c`) and zero raw `0x1b`.
  Nothing in `src/core` (yaml/emit/load) normalizes C1 — grep for
  `\x9b|\x9f|\u009b|C1` finds no handling. Like the Wave 1 auditor, I could not
  demonstrate a live terminal effect on this machine (UTF-8 Terminal.app/iTerm2
  ignore decoded C1); the exposure is real as a code fact, impact is
  configuration-dependent. Info is the honest rating.

## F03-3: `--token` flag exposes the manager token in the process list and shell history

- Verdict: CONFIRMED
- Final severity: Low
- Overlaps: none

- Verification: Code matches: help line `push | pull [--token t]` at
  `main.ts:81` with no caveat; `main.ts:447-449` parses `token: { type:
  'string' }` and falls back to `BOTFLOW_TOKEN`. Reproduced: ran
  `botflow pull --token bfk_SECRET_canary_12345` against a server that hangs;
  during the network window `ps -Ao pid,args` shows the full argv:
  ```
  60808 node …/botflow.ts pull --board /tmp/bf-verify/board --token bfk_SECRET_canary_12345
  ```
  The report's "exists and is documented" claim for the env var is accurate
  (README.md:365-369 shows `BOTFLOW_TOKEN=bfk_… botflow push`; the
  missing-token UsageError also names it). Local multi-user/shared-CI threat
  only; Low stands.

## F03-4: Unbounded response body buffering in remote push/pull

- Verdict: CONFIRMED
- Final severity: Low
- Overlaps: none

- Verification: `remote.ts:79` is `const body = (await res.json().catch(() =>
  ({})))` — no size check anywhere in `call()` (`remote.ts:67-82`); the only
  bound is `AbortSignal.timeout(30_000)` (`remote.ts:33, 73`), which caps time,
  not bytes. Reproduced without endangering the host: a local server streamed a
  256 MB valid-JSON body; the CLI buffered it whole (peak RSS 1,149,534,208
  bytes ≈ 1.1 GB per `/usr/bin/time -l`) before failing closed with
  `refusing pull, remote snapshot is invalid: config and cards required` — the
  validation-before-write gate held, confirming "no integrity impact".
  Precondition is again a hostile/compromised remote (which already has the
  token); impact is local resource exhaustion of the sync process. Low stands.

## Verification summary

4 findings: 4 CONFIRMED, 0 CONFIRMED-ADJUSTED, 0 REJECTED.

This scope's report is in good shape: every cited line checked out, the PoC
claims reproduced (stderr carries raw ESC bytes; C1 survives `out()`; `--token`
is visible in `ps`; a 256 MB response is buffered uncapped to ~1.1 GB RSS), and
the severities are honest — each flaw's precondition (attacker controls the
committed `remote.yaml` / shares the local machine) already implies a worse
capability, so the Low/Info ratings are earned rather than generous. The
"Checked clean" section's claims I spot-checked (sanitizer on stdout, strict
parseArgs, https enforcement on every request) also match the code. The one
cosmetic correction: for push/pull the escape bytes actually exit through the
promise-rejection handlers at `main.ts:455/463`, with `main.ts:919` covering
synchronous UsageErrors — the finding's sink list already includes both.
