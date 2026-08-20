# Scope 01 — Board file parsing

Audited: `src/core/load.ts`, `yaml.ts`, `json.ts`, `body.ts`, `card.ts`, `frontmatter.ts`,
`fields.ts`, `ids.ts`, `model.ts`, plus `spec/SPEC.md`, `test/fixtures/`, and the direct
consumers needed to confirm exploitability (`docs.ts`, `config.ts`, `analyze.ts`, `refs.ts`,
`metrics.ts`, `query.ts`, `mutate.ts:165`, `cli/main.ts`, `mcp/server.ts`).

Threat-model framing for all findings below: the attacker authors a malicious git repo;
the victim clones it and runs botflow tools (CLI, MCP server, viewer) inside it. No finding
requires write access beyond committing files to the repo. All PoCs were run against the
live code with Node 26 (`node /tmp/bf-audit/poc-*.mjs`); scripts are left in `/tmp/bf-audit/`.

## F01-1: YAML `__proto__` key pollutes the mapping prototype — defeats the missing-version read-only safeguard
- Severity: Medium
- CWE: CWE-1321 (Improperly Controlled Modification of Object Prototype Attributes)
- Location: `src/core/yaml.ts:133` (`const obj = {}`), `:155` (dup check), `:160`/`:165` (`obj[key] = …`); exploited through `src/core/config.ts:186-194`
- Description: `KEY_RE` (`yaml.ts:15`) allows `_`, so `__proto__` is a legal mapping key. `parseMap` builds plain object literals, and `obj['__proto__'] = <parsed block>` invokes the `Object.prototype.__proto__` setter: the nested block becomes the object's **prototype** instead of an own property. Consequences, all verified:
  1. Reads of absent keys fall through to the attacker-controlled prototype. A `board.yaml` with **no `botflow:` key** but a `__proto__: {botflow: 0}` block passes the version gate in `parseBoardConfig` — no schema finding, `mutationBlocked` stays `null`. Per SPEC §4 such a board MUST be read-only, but every mutation path gates on `mutationBlocked` (`mutate.ts:165`), so the board is fully writable.
  2. Duplicate `__proto__` keys bypass the duplicate-key `YamlError` (`Object.hasOwn` never sees the key) — a parser differential: `a: 1\na: 2` throws, `__proto__: …` twice does not.
  3. The key is invisible to `Object.keys`, so it is silently dropped from `extra` preservation (SPEC §5 "MUST be preserved") with no `unknown-key` finding, and any `board.yaml` rewrite deletes the block.
  4. A card whose entire frontmatter rides the prototype (`---\n__proto__:\n  id: 007\n  title: g\n  lane: todo\n---\n`) parses as a fully valid card with zero findings.
  The same gate-bypass applies to the hosted path: `validateBoardDocuments` (`docs.ts:162`) rejects imports only when `mutationBlocked !== null`.
- Exploit scenario: Attacker commits `.botflow/board.yaml` = `__proto__:\n  botflow: 0\nname: x\n` (a file that is, legitimately, an invalid/read-only board). Victim clones and runs `botflow add …`: the tool writes cards into a board it was required to refuse; the first board-shape edit rewrites `board.yaml` via `emitBoardYaml`, writing `botflow: 0` and dropping the prototype block — silent, unreviewable data mutation in a file the format promised to leave untouched.
- Evidence: `/tmp/bf-audit/poc1-proto.mjs` and `/tmp/bf-audit/poc1g-e2e.mjs`:
  ```
  mutationBlocked: null                     # should be 'botflow major is missing or invalid'
  version findings: []                      # no schema error at all
  addCard: SUCCEEDED (should have been refused as read-only)
  control addCard refused as expected: board is read-only: botflow major 1 …
  dup __proto__: accepted, no YamlError; own keys = [] ; proto = { y: 2 }
  ```
- Suggested fix: One-line class fix in the parser — build mapping objects with `Object.create(null)` in `parseMap` (and for the `{}` inline map in `parseScalar`), so `__proto__` is an ordinary own key. All downstream access patterns used (`Object.keys`, `Object.hasOwn`, spreads, `for…of Object.entries`) behave identically on null-prototype objects. Optionally also reject the literal keys `__proto__`, `constructor`, `prototype` in `parseEntry` for defense in depth. No dependency needed.

## F01-2: ReDoS — quadratic backtracking in the `parseBody` heading regex (and the `bodyHeadings` trim)
- Severity: Medium
- CWE: CWE-1333 (Inefficient Regular Expression Complexity)
- Location: `src/core/body.ts:46` (`HEADING_RE = /^##\s+(.+?)\s*$/`, applied to every body line at `:145` and `:278`); same shape at `:88` (`line.slice(3).replace(/[ \t]+$/, '')` in `bodyHeadings`)
- Description: For a line of the form `## ` + long non-space run + long space run + one trailing non-space, the lazy `(.+?)` followed by `\s*$` backtracks over the whole whitespace run for every position inside it — O(n²) in the space-run length. The regex eventually matches (any `## ` line does), so this is pure wasted CPU, not a mismatch. `parseBody` runs on every card body on every board read (`analyze.ts:116` boost scan, `json.ts:21`, `metrics.ts` via `cardFlowMetrics`), and `bodyHasSection` runs on attacker-controlled template bodies during config parse (`config.ts:776`).
- Exploit scenario: Malicious repo commits one card with a 1 MB single-line body of the shape above. Every `botflow board`/`ready`/`show`, every MCP `board`/`ready` tool call, and every viewer poll stalls for ~70 s per affected card; the MCP/viewer processes are single-threaded, so one crafted card denies service to every client. Cost scales with file size — a 10 MB body is effectively a hang.
- Evidence: `/tmp/bf-audit/poc6-heading.mjs` on a 1 000 001-byte line (`'## ' + 'a'×500k + ' '×500k + 'b'`):
  ```
  HEADING_RE on evil 1MB line: 69590ms, matched=true
  /^[ \t]+$/ trailing-trim (bodyHeadings): 87810ms
  parseBody(evil line): 77912ms
  bodyHasSection with evil heading line: 88616ms
  parseBody(non-heading evil): 0ms          # only `## `-prefixed lines bite
  startsWith+trimEnd: 0.1ms                 # the cheap equivalent
  ```
- Suggested fix: Drop the regex for this match: `line.startsWith('## ')` then `line.slice(3).trimEnd()` (builtins are linear; measured 0.1 ms on the same input) in `parseBody`, and replace `/[ \t]+$/` in `bodyHeadings` with the same `trimEnd()` approach (or a manual right-scan). Semantics are identical for the heading grammar in use.

## F01-3: `rollupJson` recomputes shared child boards — exponential blowup / OOM on a DAG
- Severity: Medium
- CWE: CWE-674 (Uncontrolled Recursion), CWE-400 (Uncontrolled Resource Consumption)
- Location: `src/core/json.ts:179-199` (recursive `rollupJson` with no memoization)
- Description: `loadTree` legitimately loads board DAGs — two parents may reference the same child board (cycle detection only kills true cycles). `analyze()` memoizes per board (`analyze.ts:289-305`), but `rollupJson` recurses per **edge**, recomputing each shared subtree. A layered DAG (2 boards per level, each level's boards referenced by both parents above) costs 2^depth.
- Exploit scenario: Malicious repo carries 46 tiny board directories wired as a 24-level DAG (≈5 KB of content, ordinary relative `board:` refs — nothing the loader flags). Victim runs `botflow board --rollup` (CLI, `main.ts:278`) or an MCP client calls `board` with `rollup: true` (`mcp/server.ts:166`): the process balloons past the 4 GB default heap and is OOM-killed. 24 levels → OOM in ~10 s; each additional level doubles it.
- Evidence: `/tmp/bf-audit/poc2b-dag-on-disk.mjs` (real on-disk repo, real `loadTree`/`analyze` path):
  ```
  loadTree: 51 boards in 11ms
  analyze: 1ms (memoized, fine)
  FATAL ERROR: Ineffective mark-compacts near heap limit … JavaScript heap out of memory
  ```
  In-memory scaling (`poc2-rollup.mjs`): 15 levels → 16 ms, 20 → 197 ms, 22 → 824 ms, 24 → OOM.
- Suggested fix: Make expansion request-scoped and shared-aware: keep a `Set` of board keys already expanded on this call and emit a stub (`{ id, title, child: { key, ref: true } }`) for repeats instead of recursing. Note that plain memoization alone is insufficient — `JSON.stringify` re-serializes shared objects, so the *output* stays exponential; repeated subtrees must be rendered as references. A depth/node budget reported as a lint finding would also work.

## F01-4: Long linear board chains overflow the call stack in `analyze()` — every command crashes
- Severity: Medium
- CWE: CWE-674 (Uncontrolled Recursion)
- Location: `src/core/analyze.ts:263-307` (`effectiveState`/`analyzeNode` recursion); `src/core/load.ts:82-119` (`visit`, lighter); `src/core/json.ts:196` (also recursive)
- Description: Board nesting is walked by genuine recursion. A chain of ~1 000–1 500 sibling boards (`a → ../b → ../c …`) — no cycles, nothing lint flags — overflows V8's stack inside `analyzeNode`/`analyzeBoard`. The `RangeError` is uncaught: the CLI prints a stack trace and exits 1. `loadTree` itself survives deeper (3 000 boards loaded fine in 147 ms), so the first wall hit is `analyze()`, which runs for essentially every command and every MCP tool call (`view()`).
- Exploit scenario: Malicious repo with ~1 500 two-file board directories (≈75 KB, committable without tripping any size heuristics). Victim clones; every `botflow` command and every MCP tool call crashes with `RangeError: Maximum call stack size exceeded`. The board is unusable until the attacker files are removed by hand.
- Evidence: `/tmp/bf-audit/poc3-chain.mjs`, `poc3b-threshold.mjs`, and end-to-end:
  ```
  analyze chain n=5000: RangeError: Maximum call stack size exceeded
  analyze() first fails at chain length ≈ 1000      (in-memory bisect)
  loadTree chain N=3000: ok, 3001 boards in 147ms
  $ node src/cli/botflow.ts board    # inside the 1500-board chain repo
      at analyzeBoard (src/core/analyze.ts:97:21)
      at analyzeNode (src/core/analyze.ts:294:22)   … EXIT=1
  ```
- Suggested fix: Convert `analyzeNode`/`effectiveState` to an explicit-stack iterative walk (the codebase already did exactly this for dep-cycle DFS, see `analyze.ts:178-224` and the 5 000-card chain tests), or enforce a tree-depth/tree-size budget at `loadTree` time with a finding instead of a crash.

## F01-5: Quadratic dedup in mention and `[[ref]]` extraction
- Severity: Low
- CWE: CWE-407 (Inefficient Algorithmic Complexity)
- Location: `src/core/body.ts:133` (`if (!mentions.includes(name)) mentions.push(name)`); `src/core/refs.ts:87` (`!out.includes(ref)`)
- Description: Both extractors dedup against a growing plain array, so extraction is O(n²) in the number of *distinct* names/refs in one body. Repeated identical mentions are cheap (2 ms for 40 k); the cost is driven by distinct values.
- Exploit scenario: Malicious card with a ≈240 KB Description holding 40 000 distinct `@mentions` (or `[[refs]]`): ~1 s of CPU **per parse**, and each card body is parsed several times per command (analyze boost scan, `cardJson`, metrics). 200 k mentions (1.7 MB body) → ~20 s per parse. Multiplied across cards and the MCP server's per-call `view()`, a small repo can keep the process saturated.
- Evidence: `/tmp/bf-audit/poc4-quadratic.mjs` + `poc5-misc.mjs`:
  ```
  mentions: 5k→19ms  10k→76ms  20k→193ms  40k→986ms  100k→6397ms  200k→19880ms
  [[refs]]: 5k→19ms  10k→66ms  20k→249ms  40k→1010ms
  40000 identical mentions: 2ms               # confirms dedup, not matching, is the cost
  ```
- Suggested fix: Dedup with a `Set` (`seen.has(name)` / `seen.add(name)`) and build the array alongside it. Two-line change per site, no dependency.

## F01-6: No size limits on board files or card counts — memory exhaustion via oversized documents
- Severity: Low
- CWE: CWE-400 (Uncontrolled Resource Consumption)
- Location: `src/core/load.ts:40-60` (`readBoardDocuments` — unbounded `readFileSync`, unbounded walk); amplified by `splitFrontmatter`/`parseBody` string copies
- Description: Every card file and `board.yaml` is read fully into memory, then copied several times (`\r\n` normalization, `split('\n')`, section joins). Nothing caps file size, file count, or directory count.
- Exploit scenario: Malicious repo with a ~1 GB card file (or a very large `cards/` tree): default-heap Node dies OOM during load; a 150 MB single card already pushes RSS from ~0.4 GB to ~0.83 GB for one `loadBoard`. Practicality is bounded by what an attacker can reasonably get a victim to clone (git hosts cap file sizes), hence Low.
- Evidence: `/tmp/bf-audit/poc7-bigfile.mjs`: `loadBoard 150MB card: 153ms, rss 407→825MB`.
- Suggested fix: A sanity cap (e.g. refuse to parse card files over a few MB, report a `yaml-error`-class finding and skip) is cheap and keeps the failure mode lint-visible instead of fatal. Card-count caps are less clearly worth it; documenting the assumption may suffice.

## F01-7: Integer-precision mangling of large unquoted card ids
- Severity: Info
- CWE: CWE-681 (Incorrect Conversion between Numeric Types)
- Location: `src/core/yaml.ts:230` (`parseInt(s, 10)`) + `src/core/card.ts:304-308` (`asIdString` re-stringifies numbers)
- Description: A plain-scalar id of ≥16 digits matching `INT_RE` is parsed to a double and re-stringified: `id: 9007199254740993` loads as `"9007199254740992"`. Lint does surface it (`filename-id-mismatch` warning), and two colliding mangled ids produce a `dup-id` error, so it fails visibly — but deps written against the source id silently dangle, and the stored identity no longer matches the file. `nextSeqId` itself is BigInt-safe (existing test), so this is load-path-only.
- Exploit scenario: Attacker commits cards with near-2^53 numeric ids; the victim's board shows different ids than the files say, and cross-references rot. Marginal impact — recorded for completeness.
- Evidence: `/tmp/bf-audit/poc5-misc.mjs`: `stored id: 9007199254740992 (file said 9007199254740993)`, findings: `filename-id-mismatch(9007199254740992)`.
- Suggested fix: In `parseScalar`, only take the integer branch when `Number.isSafeInteger(Number(s))` (else leave the token a string), or make `asIdString` reject non-safe integers. Both keep `"042"` string semantics intact.

## Checked clean

- YAML anchors/aliases (`&`, `*`), tags (`!`), block scalars (`|`, `>`), flow mappings other than `{}`: all hard `YamlError` (`yaml.ts:223-226`) — no alias-expansion/billion-laughs surface; flow list rejects nested collections (`:202-203`) and scales linearly (400 k items in 56 ms).
- YAML nesting depth: `MAX_DEPTH = 100` enforced before recursion (`yaml.ts:104`), covered by `test/security-core.test.ts` "deeply nested yaml throws YamlError"; 400 k flat keys parse linearly (152 ms).
- YAML duplicate keys: `Object.hasOwn` check (`yaml.ts:155`) — sound for every key except `__proto__` (see F01-1); `constructor`/`prototype` keys become inert own data properties (verified reading `parseEntry`).
- Tab indentation, unterminated quotes/flow lists, content after closing quote, empty sequence items: all rejected (`yaml.ts:44,119,208,245,263`).
- Leading-zero digit tokens stay strings (`INT_RE` requires `0|[1-9]…`), preserving `042` ids; `-0` accepted by numeric validators but equals 0 everywhere it's used — no effect.
- Frontmatter framing (`frontmatter.ts`): exact `---` line required; unclosed → error; BOM'd file drops the card with a visible `frontmatter-missing` error (fail-closed, verified); CRLF and lone-`\r` closers handled correctly (verified).
- Body regexes other than HEADING_RE: `ENTRY_RE`, `TASK_RE`, `LINK_RE`, `MENTION_RE`, `IMAGE_RE`, `FENCE_OPEN_RE` measured linear/constant on 1 MB pathological lines (poc5/poc6); metrics transition regexes (`metrics.ts:11-14`) use bounded negated classes, no nested quantifiers.
- Fenced-code handling in body ops is fence-aware on both read and write paths, incl. tilde/longer fences — covered by existing tests and re-read in `body.ts:60-66`.
- Log/comment/attachment injection sanitization (newline collapse, colon drop, `)` encoding) — covered by `test/security-core.test.ts` §3; write-side, out of this scope, mitigations verified present.
- Duplicate/empty card ids: dup → `dup-id` error (`docs.ts:104-108`); empty/missing → `schema` error (verified). Freeform (non-scheme) ids always trigger `id-scheme-mismatch`, so control-char/unicode ids are lint-visible.
- Unicode normalization: no canonicalization anywhere; identity is raw-string comparison — no parser-level confusion found (visual lookalike rendering is the viewer scope's problem, not parsing).
- Symlink exfiltration and board-path escape on load: `lstat`-guarded skips and workspace-boundary checks (`load.ts:36-60,99-105`), covered by existing security tests and re-verified by reading.
- Board cycle detection and cross-board ref discovery bounds (`load.ts:110-150`): cycle edges resolve to null + findings; ref discovery re-applies the workspace escape check.
- Snapshot import path safety: `safeCardDocumentPath` rejects `..`/empty/backslash segments and non-`cards/*.md` paths (`docs.ts:126-130`); duplicate paths and fatal findings gated (`:142-166`).
- Query/filter parsing (`query.ts`): hand-rolled tokenizer, no backtracking regex on attacker text; invalid filters are schema errors, fail-closed.
- `ids.ts`: `nextSeqId` BigInt-exact past 2^53 (existing test); `slugify` linear, length-capped, empty→`card`; `newHashId` uses `crypto.randomInt`.
