# Verified: Scope 02 — Board mutation & filesystem writes

Verification of `audit/findings/02-mutation.md`. Every finding was re-checked against the cited source (Node type-stripping, throwaway PoCs under `/tmp/bf-v0*.ts`, no project files modified, no git mutations). Existing coverage checked: `test/security-core.test.ts` covers only the *read* side (symlink skipping in `readBoardDocuments`), `test/remote-security.test.ts` covers only the *pull* side (`assertContainedTargets`); neither touches the mutation write path. MCP reachability confirmed: `src/mcp/server.ts:296,352,387` call `addCard`/`linkCards`/`transferCard` from `mutate.ts` directly, so the MCP-agent vector hits the same unguarded paths.

## F02-1: Mutation writes follow committed symlinks out of the board (cards/ dir, .botflow root, initBoard clobber)
- Verdict: CONFIRMED
- Final severity: Medium
- Overlaps: F02-2, F02-4, F04-2
- Verification: Code matches the report — `writeCard` is `atomicWrite(join(boardRoot, card.file), …)` (src/core/mutate.ts:146-148) with no symlink guard anywhere on the write path, while the read side deliberately `lstat`-skips symlinks (src/core/load.ts:40-60). PoC `/tmp/bf-v01.ts`:
  - Part A: `.botflow/cards -> /tmp/bf-v01/victim-dir`. `loadBoard` saw **0 cards, 0 findings** (board looks clean), then `addCard(root, {title: 'Planted by prompt injection'})` succeeded and `readdirSync(victim-dir)` showed `001-planted-by-prompt-injection.md` next to the intact pre-existing `KEEPME.txt`. Create-only, deterministic name, `.md` suffix — as reported.
  - Part B: `.botflow -> other-project/` (no board.yaml at target). `initBoard` proceeded (the `resolveBoardRoot` existence check follows the symlink and finds nothing) and wrote `board.yaml`, `cards/`, and **overwrote the target's pre-existing `.gitignore`** (`node_modules\ndist\n` → `index.db\nindex.db-*\nboard.lock\n`, mutate.ts:156 — unconditional `writeFileSync`).
- Notes: Medium is fair, not generous — this is a silent cross-boundary write triggered by a routine `botflow add` on a clean-looking clone, which is the exact exception to "attacker controls repo content ⇒ Low". Bounding factors the report states correctly: card writes are create-only (`existsSync` collision check, mutate.ts:176) with constrained names; the `.gitignore` clobber writes *fixed* non-attacker-controlled content (integrity destruction of an existing file, not content injection).

## F02-2: Cross-board link/transfer escape via committed symlink — nesting check is purely lexical
- Verdict: CONFIRMED
- Final severity: Low
- Overlaps: F02-1, F04-2
- Verification: The check is `relative(sourceRoot, targetRoot)` + a `..` test (src/core/mutate.ts:220-223 for `mutateRelation`, 350-353 for `transferCard`); `resolveBoardRoot` uses `existsSync` (symlink-following) and nothing calls `realpathSync`. PoC `/tmp/bf-v02.ts` with `.botflow/sub -> /tmp/bf-v02/other-project/.botflow`:
  - `linkCards(root, '001', 'sub#005', 'relates', 'mallory')` succeeded; the **external** board's `005-real-card-5.md` gained a `relates` relation and the log line `- 2026-08-20 14:12 mallory: linked relates ..#001`.
  - `transferCard(root, '<src>/.botflow/sub', '001', 'mallory')` wrote `006-source-card.md` into the external board's `cards/`.
  - One PoC nuance: `transferCard` resolves `targetDir` against the process cwd (mutate.ts:347), so the CLI invocation must run from the repo (normal usage) — I passed the absolute symlink path instead; the escape mechanism is identical.
- Notes: Low is correct. The attacker must guess an absolute victim path that exists *and* hosts a parseable board (plus a card id for `link`); that targetability constraint caps real-world impact. (Cosmetic: the report's `../..#001` reciprocal ref vs my `..#001` is just PoC directory layout, not a discrepancy.)

## F02-3: Windows cross-drive / UNC targets bypass the "nested inside" check
- Verdict: CONFIRMED
- Final severity: Low
- Overlaps: none
- Verification: The rejection is only `targetPath === '..' || targetPath.startsWith('..' + sep)` (src/core/mutate.ts:221, 351) with no `isAbsolute` test. `validateBoardPath` (ops.ts:119-134) is never applied to resolved relation/transfer targets — grep shows its only call sites are ops.ts:456 (add boardPath), 827 (edit boardPath), 1581 (transfer board-card rewrite). PoC `/tmp/bf-v03.ts` via `path.win32`: `win32.relative('C:\\repo\\.botflow', 'D:\\other\\.botflow')` → `'D:\\other\\.botflow'` (absolute) and `win32.relative(…, '\\\\server\\share\\.botflow')` → UNC absolute; both pass the `..`-only check, and the suggested `|| isAbsolute(targetPath)` fix catches both. Full exploitation not executed (no Windows host available) — the verdict rests on the unambiguous code gap plus the reproduced win32 path semantics, which is what the report itself claimed.
- Notes: Low is honest: Windows-only, and unlike F02-2 the escape target comes from direct CLI/MCP input (an attacker repo cannot commit a drive-letter symlink), so it needs a tricked agent/user plus an existing target board on another drive.

## F02-4: Self-referential board symlink deadlocks cross-board ops until lock timeout
- Verdict: CONFIRMED
- Final severity: Low
- Overlaps: F02-1, F04-2
- Verification: `withBoardLocks` dedupes by lexical `resolve(root)` (src/core/mutate.ts:334), so `.botflow/self -> .` yields a second, distinct string for the same physical directory; the second `openSync(lock, 'wx')` hits `EEXIST`, and `reapStaleLock` refuses to reap because the lock contains the **current process's own live pid** (mutate.ts:93-94). PoC `/tmp/bf-v04.ts`: `linkCards(root, '001', 'self#001', …)` threw after **5023 ms** with `board is locked by another process (/tmp/bf-v04/.botflow/self/board.lock)` — matching the 5000 ms default `BOTFLOW_LOCK_TIMEOUT_MS` (mutate.ts:71-73). No lock file was left behind (the outer lock's `finally` unlinks the same physical file), so impact is a per-invocation 5 s hang + error, exactly as reported.
- Notes: Low is right — availability nuisance on cross-board verbs only, no corruption; the suggested realpath dedupe in `withBoardLocks` is the correct minimal fix.

## F02-5: `__proto__` YAML keys hit the prototype setter — config keys hidden from lint, silently rewritten away
- Verdict: CONFIRMED
- Final severity: Low
- Overlaps: F01-1, F04-4
- Verification: `KEY_RE = /^([A-Za-z0-9_-]+):(.*)$/` (src/core/yaml.ts:15) admits `__proto__`, and `parseEntry` assigns onto a `{}` literal (yaml.ts:133, 160-165), invoking the `Object.prototype.__proto__` setter. PoC `/tmp/bf-v05.ts` with `botflow: 0\n__proto__:\n  name: smuggled-name\n  ids: hash\n  mystery: 42`:
  - `Object.keys` → `['botflow']` only; `Object.hasOwn(…, '__proto__')` → false, so the duplicate-key check (yaml.ts:155) is bypassed (two `__proto__` blocks parsed without error, second replacing the first's prototype).
  - `parseBoardConfig` read `name: 'smuggled-name'`, `ids: 'hash'` through the prototype chain with **zero findings** — including suppressing the mandatory "name is required" schema error (config.ts:196-198) and the unknown-key finding for `mystery` (the `Object.keys` loop at config.ts:264 never sees it).
  - `emitBoardYaml(config)` output contained no `__proto__` and no `mystery`, but **did** contain `name: smuggled-name` — the first rewrite silently normalizes smuggled keys into real ones and drops unknown sub-keys, as reported.
  - No global pollution: `({}).name` and `({}).ids` remained `undefined` after parsing.
- Notes: Low is correct — audit-trail evasion + silent data loss gated on attacker-controlled repo content; explicitly not RCE-class. The report's framing (parser-owned, mutation-side is where the silent loss lands) is accurate.

## F02-6: Oversized numeric card id crashes every subsequent `add` with raw ENAMETOOLONG
- Verdict: CONFIRMED
- Final severity: Low
- Overlaps: none
- Verification: `nextSeqId` takes BigInt max+1 and pads to the widest existing id (src/core/ids.ts:5-16); filename is `cards/${id}-${slugify(title)}.md` (ops.ts:504); `atomicWrite` lets the errno propagate (mutate.ts:140-144). PoC `/tmp/bf-v06.ts`: planted card `999-trap.md` (short filename; frontmatter `id: "<300 nines>"` quoted to stay a string — the filename/id mismatch is only a finding, not a rejection, which my first PoC attempt confirmed the hard way: a 300-digit *filename* can't even be created). Board loaded with id length 300 and only a `filename-id-mismatch` finding; `addCard` threw raw `Error: ENAMETOOLONG: name too long, open '…/cards/1000…000-next.md…'` — **not** a `UsageError` — and a second `addCard` failed identically (persistent until manual removal). Reads kept working; no tmp litter left.
- Notes: Low is right (per-board creation availability + ugly crash, attacker-repo precondition, `ids: hash` immune). The report's evidence line matches my run byte-for-byte in substance.

## F02-7: Unsafe-integer extras change type on rewrite (YAML emit round-trip fidelity)
- Verdict: CONFIRMED
- Final severity: Info
- Overlaps: none
- Verification: `parseScalar` returns `parseInt(s, 10)` for any `INT_RE` match with no safe-integer bound (src/core/yaml.ts:230); `emitScalar` emits `String(v)` for numbers (src/core/emit.ts:22). PoC `/tmp/bf-v07.ts`: card extra `priority-x: 999999999999999999999` loaded as number `1e21`; after a routine `addLogEntry` rewrite the file contained `priority-x: 1e+21`, which reloaded as the **string** `"1e+21"` — silent number→string drift in the preserved-keys path (write.ts:46). Also confirmed the cross-reference: an unquoted 300-digit `id:` loads as `"1e+300"` via `asIdString` (card.ts:304-307) with no findings, which is exactly why F02-6 needs a quoted id.
- Notes: Info is correct — integrity noise only, no security impact.

## Verification summary

Verdicts: 7 CONFIRMED, 0 CONFIRMED-ADJUSTED, 0 REJECTED. Every PoC reproduced on the first or second attempt against the real source, all cited line numbers and code shapes checked out, and every severity rating was honest (the two with cross-boundary write impact correctly landed above the "attacker controls the repo ⇒ Low" floor; the rest correctly at Low/Info).

This scope's systemic weakness is singular and clear: the pull side got realpath containment (`assertContainedTargets`, src/cli/remote.ts:124-141) and the read side got `lstat` discipline, but the mutation write side has neither — F02-1, F02-2, and F02-4 are one missing guard seen from three angles, and porting the pull-side pattern to `writeCard`/`initBoard`/`withBoardLocks` would close all three. The remaining findings are parser polish (`__proto__` key rejection, safe-integer bounds, id-width caps) that are cheap to fix but individually minor.
