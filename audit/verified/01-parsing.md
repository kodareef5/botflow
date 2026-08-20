# Verified Scope 01 — Board file parsing

Wave 2 verification of `audit/findings/01-parsing.md`. Every finding was re-verified against
the live code (Node v26.7.0) by reading the cited lines, re-running the Wave 1 PoCs left in
`/tmp/bf-audit/`, and writing independent PoCs (`/tmp/bf-verify-*.mjs`) where the report's
claims needed adversarial scrutiny. Project source was not modified.

Existing-mitigation sweep (applies to all findings below): `test/security-core.test.ts:74`
tests the version read-only gate only with an honest `botflow: 1` file — the `__proto__`
bypass is untested. `:310` covers YAML `MAX_DEPTH` (checked-clean claim holds). `:323`
covers *dep* chains (iterative DFS), not *board-nesting* chains. No test covers
`__proto__` keys, `HEADING_RE`, `rollupJson` sharing, board-chain depth, dedup cost,
file-size caps, or unsafe-integer id loads. No missed mitigations found.

## F01-1: YAML `__proto__` key pollutes the mapping prototype — defeats the missing-version read-only safeguard
- Verdict: CONFIRMED-ADJUSTED
- Final severity: Low
- Overlaps: F02-5, F04-4
- Verification: Code confirmed at `yaml.ts:133` (`const obj = {}`), `:155` (`Object.hasOwn`
  dup check), `:160`/`:165` (`obj[key] = …`), `config.ts:186-194` (`map['botflow']` read +
  `mutationBlocked` gate), `mutate.ts:165` (mutation gate), `docs.ts:162` (hosted import
  gate). Re-ran `/tmp/bf-audit/poc1-proto.mjs`: `__proto__:` block becomes the object's
  prototype (`Object.hasOwn` false, `v['botflow']` → 0 through the chain); duplicate
  `__proto__` keys accepted while `a: 1\na: 2` throws; board.yaml with no `botflow:` key →
  `mutationBlocked: null` with zero schema findings; prototype-riding card frontmatter
  parses as a valid card; `__proto__` dropped from `extra` with no unknown-key finding.
  Re-ran `poc1g-e2e.mjs`: `addCard` SUCCEEDED on a versionless board; control (`botflow:
  1`) refused with "board is read-only". Independently verified the rewrite claim with
  `/tmp/bf-verify-01-rewrite.mjs`: `saveFilter` → `writeBoardConfig` (`mutate.ts:517`) →
  `emitBoardYaml` rewrites board.yaml as `botflow: 0\n…` and silently deletes the
  `__proto__:` block. Every technical claim in the report reproduces exactly.
- Corrected description: The technical description is accurate; the Medium severity is not,
  under this threat model. Exploitation requires the attacker to already control the
  victim's committed repo content *and* the victim to run mutating commands inside it. All
  writes land inside the attacker's own repo (cards/, board.yaml — the tool's normal
  domain); there is no global `Object.prototype` pollution (only the parsed config object's
  own prototype), no code execution, and no cross-boundary write. The hosted-path variant
  (`validateBoardDocuments` bypass) affects only the attacker's own imported board — no
  tenant crossing. Notably, an attacker who simply commits a *valid* `botflow: 0` board
  gets the victim's writes anyway; the bug's delta is defeating a fail-closed SPEC §4 MUST
  plus silent board.yaml data loss, which is a real integrity/spec violation but a small
  victim harm. Low per the audit rubric (repo-content-control flaw without silent
  cross-boundary writes or code execution). The suggested fix (`Object.create(null)` in
  `parseMap` and the `{}` inline-map branch) is correct and sufficient.

## F01-2: ReDoS — quadratic backtracking in the `parseBody` heading regex (and the `bodyHeadings` trim)
- Verdict: CONFIRMED
- Final severity: Medium
- Overlaps: none
- Verification: `HEADING_RE = /^##\s+(.+?)\s*$/` at `body.ts:46`, applied per line at `:145`
  and `:278`; trailing trim at `:88`. Independent PoC `/tmp/bf-verify-02-redos.mjs`
  (`'## ' + 'a'×n + ' '×n + 'b'`): n=50k → 754 ms, n=100k → 3154 ms, n=200k → 12270 ms —
  clean 4× per doubling (quadratic), extrapolating to the report's ~70 s at its 1MB input.
  Non-heading control (no `## ` prefix): 0.1 ms — confirms only heading-prefixed lines
  bite. `startsWith+trimEnd` equivalent: 0.4 ms. `parseBody` and `bodyHasSection` on the
  400KB line: ~12–13 s each. Call chain confirmed: `analyze.ts:116` (uncached `parseBody`
  per card per analyze), `json.ts:21` (cardJson), `metrics.ts:103`, `config.ts:776`
  (`bodyHasSection` on attacker-controlled template bodies). MCP `view()`
  (`mcp/server.ts:140-147`) re-runs `loadTree`+`analyze` on *every* tool call, so one
  crafted card stalls every CLI command, every MCP call, and every viewer poll.

## F01-3: `rollupJson` recomputes shared child boards — exponential blowup / OOM on a DAG
- Verdict: CONFIRMED
- Final severity: Medium
- Overlaps: none
- Verification: `json.ts:179-199` recurses per edge with no memoization or shared-node
  stub; `load.ts:82-119` legitimately builds DAGs (`byAbs` memo loads each board once, two
  parents can reference the same child). Consumers confirmed: `main.ts:278` (CLI
  `--rollup`), `mcp/server.ts:166` (`rollup: true`). Independent scaling PoC
  (`/tmp/bf-verify-03-dag.mjs`, real `loadTree`/`analyze` on-disk DAGs): 14 levels → 18 ms,
  16 → 32 ms, 18 → 108 ms, 20 → 340 ms (~3.5× per 2 levels — exponential). Re-ran the full
  24-level on-disk PoC: `loadTree: 51 boards in 12ms`, `analyze: 1ms`, then
  `FATAL ERROR: Ineffective mark-compacts near heap limit` — process OOM-killed at ~4 GB
  from ~5 KB of committed content. The report's caveat is also correct: plain memoization
  is insufficient because `JSON.stringify` re-serializes shared subtrees — repeats must be
  emitted as reference stubs.

## F01-4: Long linear board chains overflow the call stack in `analyze()` — every command crashes
- Verdict: CONFIRMED
- Final severity: Medium
- Overlaps: none
- Verification: Recursion confirmed at `analyze.ts:282` (`effectiveState`) and `:297`
  (`analyzeNode`); per-board memoization does not help the first descent. Re-ran
  `poc3b-threshold.mjs`: `analyze()` first fails at chain length ≈ 1000 (RangeError);
  `loadTree` survives N=3000 (3001 boards in 148 ms). Independent end-to-end PoC
  (`/tmp/bf-verify-04-chain.mjs` + real CLI): 1500 chained boards (~75 KB), then
  `node src/cli/botflow.ts board` → `RangeError: Maximum call stack size exceeded`,
  exit 1, thrown from analyze. Since `analyze()` runs for essentially every CLI command
  and every MCP tool call (`view()`), the whole board is bricked until the attacker files
  are removed by hand. Report's claim of an existing iterative pattern for dep DFS
  (`analyze.ts:178-224`) verified — the fix pattern exists in-tree.

## F01-5: Quadratic dedup in mention and `[[ref]]` extraction
- Verdict: CONFIRMED
- Final severity: Low
- Overlaps: none
- Verification: `body.ts:133` (`!mentions.includes(name)`) and `refs.ts:87`
  (`!out.includes(ref)`) confirmed. Independent PoC `/tmp/bf-verify-05-quad.mjs`: mentions
  5k→16 ms, 10k→66 ms, 20k→195 ms, 40k→1077 ms; refs 5k→17 ms, 10k→67 ms, 20k→268 ms,
  40k→1470 ms — quadratic in *distinct* values, matching the report within noise. Control:
  40k identical mentions → 3 ms (dedup, not matching, is the cost). Low is right: needs a
  large all-distinct payload and only burns CPU per parse, though it multiplies across the
  several `parseBody` calls per command.

## F01-6: No size limits on board files or card counts — memory exhaustion via oversized documents
- Verdict: CONFIRMED
- Final severity: Low
- Overlaps: none
- Verification: `load.ts:40-60` reads `board.yaml` and every `cards/**/*.md` with unbounded
  `readFileSync`; no size/count caps anywhere in the load path (grep-verified).
  Independent PoC `/tmp/bf-verify-06-bigfile.mjs`: a ~150 MB single card loads in 172 ms
  with RSS 158→898 MB and **zero findings** — consistent with the report's 407→825 MB.
  A ~1 GB card would OOM a default-heap process. Low is right: practicality is bounded by
  what a victim will clone (git hosts cap file sizes), and the failure is a visible crash,
  not silent corruption.

## F01-7: Integer-precision mangling of large unquoted card ids
- Verdict: CONFIRMED-ADJUSTED
- Final severity: Info
- Overlaps: none
- Verification: `yaml.ts:230` (`INT_RE.test(s) → parseInt(s, 10)`, no digit cap) +
  `card.ts:304-308` (`asIdString` re-stringifies numbers) confirmed. PoC
  `/tmp/bf-verify-07-float.mjs`: `id: 9007199254740993` loads as `"9007199254740992"`;
  `filename-id-mismatch` finding fires as claimed. The report's `nextSeqId`-is-BigInt-safe
  note matches `test/security-core.test.ts:298-305`.
- Corrected description: The sub-claim "deps written against the source id silently
  dangle" is wrong in both directions (`/tmp/bf-verify-07b-deps.mjs` through `analyze()`):
  an **unquoted** dep `9007199254740993` is mangled by the identical code path
  (`card.ts:107` → same `asIdString`) to `"9007199254740992"` and therefore still
  **resolves** — no dangle at all; a **quoted** dep `"9007199254740993"` does dangle, but
  **not silently** — it produces a visible `dangling-dep(002)` finding. The accurate
  "silent" variant the report was reaching for: text refs `[[9007199254740993]]` in
  descriptions/comments are never mangled and never lint-checked — `cardJson`
  (`json.ts:35-40`) emits them as `relates` relationships to a nonexistent card with no
  finding. Core behavior and Info severity stand.

## Verification summary

CONFIRMED: 5 (F01-2, F01-3, F01-4, F01-5, F01-6). CONFIRMED-ADJUSTED: 2 (F01-1 → Low,
severity overstated for this threat model; F01-7 → Info with the deps-dangle wording
corrected). REJECTED: 0.

This scope's report is in good health: every technical claim reproduced, code citations
were accurate, PoCs were sound, and the "checked clean" section held up to spot checks
(MAX_DEPTH test exists, symlink/`lstat` guards and workspace-escape checks verified by
reading). The only adjustments are calibration, not correctness: F01-1's Medium assumed
more victim harm than the repo-content threat model supports, and F01-7's deps wording was
imprecise. The three Mediums (F01-2/3/4) are the real fix-first items: tiny committed
payloads that reliably stall, OOM, or crash every CLI/MCP/viewer interaction with the
board.
