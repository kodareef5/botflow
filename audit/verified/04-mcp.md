# Verified scope 04 — MCP server security audit

Wave-2 adversarial verification of `audit/findings/04-mcp.md`. Every finding was
re-checked against the cited code and reproduced with fresh PoCs written under
`/tmp/verify-04/` (`poc-mcp.mjs` spawns the real server via
`node src/cli/botflow.ts mcp`; `poc-proto.mjs` exercises `src/core/yaml.ts`,
`card.ts`, and `load.ts` directly). No project source was modified. Existing
suites re-run: `node --test test/mcp-security.test.ts test/mcp.test.ts` → 8/8
pass, and none of the asserted mitigations (buffer cap, error labeling,
`board_path` rejection, argument type checks) cover any finding below.

## F04-1: Template `{{title}}` interpolation injects forged sections (incl. a fake append-only `## Log`) into new cards

- Verdict: CONFIRMED
- Final severity: Medium
- Overlaps: none
- Verification: Code matches: `src/core/ops.ts:472-473` runs
  `bodyHasSection(body, 'Log')` on the *pre*-interpolation template body, and
  `ops.ts:505` then does `body.replaceAll('{{title}}', opts.title)`; the title
  reaches `opAdd` raw via `strOf` (`src/mcp/server.ts:82-85,297`) — no newline
  rejection or `sanitizeInline` anywhere in the chain (checked `addCard`
  `mutate.ts:172-180`, `serializeCard`, and `opEdit`'s title path). PoC: board
  with template `body: "## Checklist\n- [ ] reproduce {{title}}\n"` (the same
  documented pattern as `test/mcp.test.ts:41`), then `card_add` with title
  `"Bug x\n\n## Log\n- 2020-01-01 09:00 ceo: approved budget…"` returned
  `isError: false`. The written card contains the forged section, and the real
  entry lands *inside* it (decisive lines from the card file):

  ```
  ## Log
  - 2020-01-01 09:00 ceo: approved budget, ship it
  - 2020-01-01 09:01 security-team: audit passed
  - 2026-08-20 14:14 evil-agent: created in todo
  ```

  `card_show` parses the forged lines as genuine entries
  (`{when: "2020-01-01 09:00", actor: "ceo"}`) — `appendToSection`
  (`body.ts:198`) targets the first `## Log` heading, so the forged section
  permanently captures the append-only trail. Frontmatter stays valid YAML
  (`emitScalar` quotes the newline-laden title), so the bypass is body-only,
  exactly as reported. Severity reasoning: unlike `log_append` (server-stamped
  timestamp, `sanitizeInline`-collapsed single line), this vector backdates and
  bulk-forges multi-line history and arbitrary sections — it defeats an
  explicit, purpose-built guard, so Medium is right, not Low.

## F04-2: Workspace containment checks are lexical — a symlinked child board lets `card_link`/`card_transfer` write outside the workspace

- Verdict: CONFIRMED
- Final severity: Medium
- Overlaps: F02-1, F02-2, F02-4
- Verification: Code matches: `resolveBoardRoot` (`load.ts:15-21`) uses
  `existsSync` (follows symlinks, no `realpath`); containment is
  `relative(sourceRoot, targetRoot)` on lexical paths at `mutate.ts:220-223`
  (relation) and `mutate.ts:350-353` (transfer); same lexical pattern in
  `loadTree` (`load.ts:97-105`). `realpathSync` exists only in
  `src/cli/remote.ts:126,136` (push/pull), nowhere in the MCP/mutate chain.
  PoC: workspace board at `/tmp/v04-2-repo-…/.botflow`, second board entirely
  outside at `/tmp/v04-2-OUTSIDE-…/.botflow`, symlink
  `.botflow/child -> <outside>/.botflow`. `card_link {id:"001",
  target:"child#001", type:"relates", actor:"evil-agent"}` → `isError: false`;
  the *outside* card gained `relations: [{type: relates, target: ..#001}]` and
  log line `evil-agent: linked relates ..#001`. Then
  `card_transfer {id:"001", target_board:"<abs path to symlinked child>"}` →
  `isError: false` and wrote a **new** attacker-controlled file
  `cards/002-source-card.md` into the outside board. Both are silent
  cross-boundary writes outside the workspace the server was started on; per
  the audit rubric that lifts this above the "attacker controls committed repo
  content → Low at most" cap, so Medium stands. Note: sibling report F02-2
  rates the identical root cause Low citing the targetability constraint
  (attacker must predict a valid sibling board layout); the divergence is a
  judgment call — the candor note in F04-2 states the same prerequisites
  accurately, and the transfer variant's whole-file write supports Medium.
  Read-side hardening (`lstat` skip of symlinked card files/dirs,
  `load.ts:39-58`) is real but does not cover a symlinked *board root* — the
  gap is confirmed as a hole in a deliberate defense, not an unconsidered case.

## F04-3: `actor` is self-asserted on every tool call — full identity impersonation, including claim-ownership bypass

- Verdict: CONFIRMED
- Final severity: Low
- Overlaps: none
- Verification: Code matches: `actorOf` (`server.ts:77`) takes `args['actor']`
  verbatim; `claimability` (`ops.ts:610-613`) trusts `holder === actor`. PoC:
  server started with `--actor mallory`. `card_add {actor:"alice"}` → log reads
  `- 2026-08-20 14:15 alice: created in todo`. Claim check demonstrated both
  directions on one card assigned to alice: `card_claim {actor:"bob"}` →
  `isError: true` ("cannot claim 001: already assigned to alice (todo)"), while
  `card_claim {actor:"alice"}` → `isError: false`, moved todo → doing, no
  `force` needed. `card_comment {actor:"ceo"}` landed verbatim in
  `## Comments`. Severity: Low is right, not Medium — the ownership check is
  not a real boundary (`force: true` overrides it for any actor anyway), stdio
  MCP fundamentally cannot authenticate its client, and the impact is
  audit-attribution forgery against a trail that is already self-asserted. The
  report's framing (documentation + opt-in `--pin-actor` knob rather than an
  auth scheme) is the honest ask.

## F04-4: YAML subset parser assigns `__proto__` via the prototype setter — inherited keys readable as card fields, duplicate-key guard bypassed

- Verdict: CONFIRMED
- Final severity: Low
- Overlaps: F01-1, F02-5
- Verification: Code matches: `KEY_RE` (`yaml.ts:15`) admits `__proto__`;
  `parseMap` builds `{}` literals (`yaml.ts:133`) and `parseEntry` assigns
  `obj[key] = …` (`yaml.ts:155-166`). PoC `poc-proto.mjs` reproduced every
  claimed consequence, with controls:

  ```
  own keys: [ 'title' ]                      # __proto__ block not an own key
  m['id'] (inherited read): 999              # card.ts:28-style m['id'] reads prototype
  m['lane'] (inherited read): done
  Object.hasOwn(m,'__proto__'): false        # duplicate guard never fires
  duplicate __proto__ accepted; m2.id = 2    # …while control 'id: 1\nid: 2' still throws
  scalar __proto__: 5 → own keys ['title']   # scalar value silently dropped
  Object.prototype polluted? undefined undefined   # no global pollution
  ```

  `parseCard` on frontmatter whose *only* id/lane/title ride a `__proto__:`
  block returns `{id:'999', title:'plain', laneId:'done'}` with **zero**
  findings — "card id is required" (`card.ts:29-31`) is suppressed. End-to-end
  through `loadBoard` on a hostile `cards/001-hidden.md`: loads as a valid card
  with zero findings, and `Object.keys`-based `extra` (`card.ts:262`) never
  sees the inherited keys (no `unknown-key` finding, nothing round-trips to
  emitted YAML). Severity: Low is right — requires attacker-controlled repo
  content, no cross-boundary write, no code execution; it is schema/lint
  evasion and parser differential. Worth noting the shared root cause's ceiling
  is documented higher elsewhere: F01-1 shows the same setter quirk defeats the
  mandatory read-only gate for a `board.yaml` missing `botflow:` — that
  consequence belongs to F01-1, not this finding, but it means fixing
  `parseEntry` (reject `__proto__` or `Object.create(null)`) pays off across
  three reports at once.

## F04-5: Internal tool errors leak absolute filesystem paths into the agent-visible JSON-RPC error

- Verdict: CONFIRMED
- Final severity: Info
- Overlaps: none (same CWE-209 class as F06-7 in the worker scope, different mechanism)
- Verification: Code matches: `server.ts:648-651` relays any non-`UsageError`
  as `-32603 internal error: <err.message>`. PoC: `chmod 555` on
  `.botflow/`+`cards/`, then `card_add` →
  `{"code":-32603,"message":"internal error: EACCES: permission denied, open '/var/folders/q6/…/v04-5-…/.botflow/board.lock'"}`
  — absolute host path (and tmpdir user structure) delivered to the MCP client.
  The existing test (`test/mcp-security.test.ts:122-139`) asserts only the
  code/id, not message content, as the report says. Info is right: the spawning
  client normally knows the board path already; residual value is host-layout
  recon for an agent that did not spawn the server. Suggested fix (generic
  client message, full detail to stderr) is correct and one line.

## F04-6: Read-only tools are not read-only, and there are no payload/board size caps beyond the 8 MiB frame limit

- Verdict: CONFIRMED
- Final severity: Info
- Overlaps: F01-6 (the no-size-cap half; the mutate-on-read half is MCP-specific)
- Verification: Both halves reproduced. (1) `view()` (`server.ts:140-148`) calls
  `runAutomation(root)` — which persists via `writeCard` (`mutate.ts:309-315`) —
  whenever snooze/reminder/archive state exists. PoC: `card_add` with
  `snooze: "2020-01-01"`, then a single `board` call (a read tool): the card
  file changed on disk — `snooze:` gone and a new log line
  `- 2026-08-20 14:15 botflow: snooze expired` — attribution to `botflow`
  included, exactly as reported. (2) A single `card_add` with a ~6 MiB title
  (under the 8 MiB stdin cap, `server.ts:54,665`) returned `isError: false` and
  landed wholesale: card file on disk is 6,291,582 bytes. No field-level length
  caps exist in `strOf`/ops; `readFileSync` at `load.ts:42,53` has no size
  check; every tool call reloads the full tree. Info is right: the actor is
  local and could achieve the same directly; the value of the finding is
  documenting that "read" tools take the board lock and write, which a
  read-only-scoped client would not expect.

## Verification summary

- CONFIRMED: 6 (F04-1, F04-2, F04-3, F04-4, F04-5, F04-6)
- CONFIRMED-ADJUSTED: 0
- REJECTED: 0

This scope's report is unusually healthy: every finding reproduced on the first
attempt with independent PoCs, every cited line number and code behavior
checked out, and the severities are honestly rated (including the candor about
F04-2's prerequisites and F04-3's stdio-inherent nature). The two Mediums are
the real work items: template-title injection silently defeats the append-only
Log guard that the rest of the write path carefully enforces, and the lexical
containment check turns a committed symlink into cross-workspace writes
(shared root cause with F02-1/F02-2/F02-4 — one `realpath` fix covers all).
The Low/Info items are accurate documentation-grade observations; the
`__proto__` fix should be coordinated with F01-1/F02-5 since all three name the
same one-line repair in `yaml.ts parseEntry`.
