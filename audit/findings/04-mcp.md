# Scope 04 — MCP server security audit

In scope: `src/mcp/server.ts` (read end to end), the `src/core/*` call chains it
reaches (`mutate.ts`, `ops.ts`, `load.ts`, `yaml.ts`, `emit.ts`, `body.ts`,
`write.ts`, `card.ts`, `query.ts`, `refs.ts`, `presentation.ts`, `docs.ts`,
`frontmatter.ts`, emit side of `config.ts`), and `test/mcp-security.test.ts` +
`test/mcp.test.ts`. All 8 existing MCP tests pass (`node --test
test/mcp-security.test.ts test/mcp.test.ts`), and the mitigations they assert
(buffer cap, error labeling, `board_path` rejection, argument type checks) were
verified to hold by reading the code, not just the tests.

Threat framing used below: the MCP server is spawned per board over stdio by a
local client (usually an agent host). "Malicious agent" = an agent issuing
arbitrary `tools/call`s; "malicious repo" = hostile `.botflow/` content the
server loads.

## F04-1: Template `{{title}}` interpolation injects forged sections (incl. a fake append-only `## Log`) into new cards

- Severity: Medium
- CWE: CWE-93 (Improper Neutralization of CRLF Sequences) / CWE-74 (Injection)
- Location: `src/core/ops.ts:472-473` (check runs on the raw template), `src/core/ops.ts:505` (`body.replaceAll('{{title}}', opts.title)`); reached via MCP `card_add` (`src/mcp/server.ts:296-320`) and `card_promote` (`src/mcp/server.ts:333-342`)

- Description: `opAdd` guards the initial card body with `bodyHasSection(body, 'Log')` *before* substituting `{{title}}`. The card title is a free-form string — `strOf` in the MCP layer accepts newlines — so a title containing `\n\n## Log\n- 2020-01-01 09:00 ceo: …` smuggles complete, well-formed sections past the guard. The injected `## Log` then becomes the section that `appendToSection` targets, so real subsequent entries append to the forged section, and `parseBody` reads the forged lines as genuine log entries with attacker-chosen timestamps and actor names. This defeats exactly what `sanitizeInline`/`sanitizeActor`/`sanitizeBlock` (`src/core/write.ts:67-103`) enforce for every other body-writing path. Frontmatter is not injectable (emitter quotes newlines); the flaw is body-only.

- Exploit scenario: Malicious agent with ordinary MCP access on a board whose config defines a template with `{{title}}` in its body (documented in `spec/SPEC.md:134`; used in `test/mcp.test.ts:41`). It calls `card_add` with `template: "bug"` and a multi-line title to pre-seed the append-only audit trail with backdated entries attributed to `ceo`, `security-team`, etc. — e.g. fabricate an approval or an "audit passed" record. Also works for `## Comments` (fake discourse), `## Attachments` (fake links), or pre-checked `## Checklist` items.

- Evidence: PoC `/tmp/poc-title-inject.mjs` (spawns the real server via `node src/cli/botflow.ts mcp`) produced card `001` whose file contains:

  ```
  ## Log
  - 2020-01-01 09:00 ceo: approved budget, ship it
  - 2020-01-01 09:01 security-team: audit passed
  - 2026-08-20 13:47 evil-agent: created in todo
  ```

  and `card_show` parsed the forged lines as real log entries (`actor: "ceo"`, `when: "2020-01-01 09:00"`). The tool returned `isError: false`.

- Suggested fix: Treat the title as inline text at the `opAdd`/`opEdit` boundary — e.g. `title = sanitizeInline(opts.title)` (or reject titles containing `\n`), matching how every other inline field is handled. Defense in depth: run the `bodyHasSection(body, 'Log')` check on the *post*-interpolation body. No new dependencies needed.

## F04-2: Workspace containment checks are lexical — a symlinked child board lets `card_link`/`card_transfer` write outside the workspace

- Severity: Medium (prerequisites discussed below; see candor note)
- CWE: CWE-22 (Path Traversal) / CWE-59 (Link Following)
- Location: `src/core/load.ts:15-21` (`resolveBoardRoot` uses `existsSync`, which follows symlinks; no `realpath`); `src/core/mutate.ts:215-223` (relation target containment via `resolve`/`relative` on lexical paths); `src/core/mutate.ts:347-353` (same pattern in `transferCard`); `src/core/load.ts:97-105` (same in `loadTree`)

- Description: Cross-board writes verify containment with `relative(sourceRoot, targetRoot)` on paths produced by `resolve()` — never `realpathSync`. A `.botflow/child` entry that is a *symlink* to a board outside the workspace passes the check lexically (`relative` yields `"child"`), and `writeCard` then lands in the symlink target. The read path was deliberately hardened against symlinked card files/dirs (`readBoardDocuments` uses `lstat`, `src/core/load.ts:39-58`), so this is a real gap in an intended defense, not an unconsidered case.

- Exploit scenario: Malicious repo: git round-trips symlinks, so a hostile repo can commit `.botflow/child -> ../<victim-repo>/.botflow`. When the victim clones the attacker’s repo as a sibling of their real repo (a targeted attack can require exactly this in its README/AGENTS.md), `prime`/`board` will advertise the "child" board, and an agent following the repo’s own instructions (or a `card_link`/`card_transfer` call with target `child#001` / `target_board: "child"`) rewrites cards in the victim’s *other* repo — outside the workspace the MCP server was started on. Candor: exploitation requires the symlink target to exist and contain a valid board; the attacker must know or guess a sibling layout, so this is a targeted supply-chain scenario rather than a drive-by. A purely MCP-bound agent (no shell) cannot create the symlink itself.

- Evidence: PoC `/tmp/poc-symlink.mjs`: workspace board at `/tmp/…/repo/.botflow`, second board entirely outside at `/tmp/botflow-poc-OUTSIDE-…/.botflow`, symlink `.botflow/child` → outside board. `card_link {id:"001", target:"child#001", type:"relates"}` returned `isError: false` and the outside board’s card file was modified (gained `relations: [{type: relates, target: ..#001}]` and a log line `evil-agent: linked relates ..#001`).

- Suggested fix: In `resolveBoardRoot` (or at the three containment checks), compare `realpathSync.native()` of both sides instead of lexical paths; alternatively reject a board root whose final component is a symlink (`lstatSync(p).isSymbolicLink()`). Both are stdlib-only.

## F04-3: `actor` is self-asserted on every tool call — full identity impersonation, including claim-ownership bypass

- Severity: Low
- CWE: CWE-306 (Missing Authentication for Critical Function) — inherent to stdio MCP, but the code treats actor as a boundary
- Location: `src/mcp/server.ts:77` (`actorOf` takes `args['actor']` verbatim); `src/core/ops.ts:610-613` (`claimability` trusts `holder === actor`)

- Description: Every mutating tool accepts an `actor` argument with no binding to the client’s identity. The value is written into the append-only `## Log` audit trail, `## Comments`, watchers, votes, and assignee/delegate fields. Beyond cosmetic forgery, it defeats the one ownership check that exists: `claimability` refuses to claim a card held by someone else *unless the caller asserts that same name* — so a malicious agent claims alice’s in-flight card simply by passing `actor: "alice"` (no `force` needed if the card is still todo; `force: true` covers the rest).

- Exploit scenario: Malicious agent on a shared board wants to launder its actions: it performs edits/closes/comments as `actor: "ceo"`, or takes over a card assigned to another agent by claiming with their name. The audit trail then attributes everything to the victim. Note this is largely a property of local stdio MCP (the server cannot authenticate its client), so the practical ask is documentation + an opt-in hardening knob, not a full auth scheme.

- Evidence: PoC `/tmp/poc-actor.mjs`: server started with `--actor mallory`; calls `card_add`/`card_claim` with `actor: "alice"` both succeed (`isError: false`); card log reads `- 2026-08-20 13:51 alice: claimed, moved todo → doing`; `card_comment` with `actor: "ceo"` lands verbatim in `## Comments`.

- Suggested fix: Document in SPEC/SPEC.md that Log attribution is self-asserted and not an identity proof. Optionally add a server startup flag (e.g. `--pin-actor`) that makes the MCP layer ignore per-call `actor` and always use the startup identity — one-line change in `actorOf`.

## F04-4: YAML subset parser assigns `__proto__` via the prototype setter — inherited keys readable as card fields, duplicate-key guard bypassed

- Severity: Low
- CWE: CWE-1321 (Prototype Pollution) — localized, no `Object.prototype` contamination observed
- Location: `src/core/yaml.ts:133` (`const obj = {}`), `src/core/yaml.ts:155-166` (`Object.hasOwn` duplicate check, then `obj[key] = …`)

- Description: Map keys are assigned with `obj[key] = value`, and the key charset (`KEY_RE`, `src/core/yaml.ts:15`) allows `__proto__`. For a mapping value this invokes the `__proto__` setter and replaces the parsed map’s prototype instead of creating an own property. Consequences, all confirmed dynamically: (1) downstream readers that use `m['id']`-style access (`src/core/card.ts`) silently read *inherited* values, so a card can source `id`/`lane`/`title` from a `__proto__:` block and suppress the "card id is required" schema finding; (2) the duplicate-key guard (`Object.hasOwn`) never fires for repeated `__proto__` keys; (3) a scalar `__proto__` value is silently dropped. `Object.prototype` itself is *not* polluted (verified), and `Object.keys`/`Object.entries` iteration skips the inherited keys, so nothing propagates into `card.extra` or emitted YAML.

- Exploit scenario: Malicious repo ships a card whose frontmatter hides fields under `__proto__:` to evade lint/schema findings or to produce parser behavior that differs subtly from what a human reviewer sees in the file. No privilege gain — the attacker already controls the file contents — hence Low; this is a parser-correctness/audit-evasion issue.

- Evidence: `node /tmp/poc-proto.mjs` against `src/core/yaml.ts`:

  ```
  own keys: [ 'title' ]
  m['id'] (inherited read): 999
  m['lane'] (inherited read): done
  duplicate __proto__ accepted; m2.id = 2
  Object.prototype polluted? undefined undefined
  ```

- Suggested fix: In `parseEntry`, reject the key `__proto__` with a `YamlError` (one line), or build maps with `Object.create(null)`. Stdlib-only either way.

## F04-5: Internal tool errors leak absolute filesystem paths into the agent-visible JSON-RPC error

- Severity: Info
- CWE: CWE-209 (Generation of Error Message Containing Sensitive Information)
- Location: `src/mcp/server.ts:648-651`

- Description: Non-`UsageError` exceptions are relayed as `-32603 internal error: <err.message>`. Node fs errors embed absolute paths (`EACCES: permission denied, open '/var/folders/…/.botflow/cards/002-….tmp'`), which then flow into the MCP client and typically into the LLM agent’s context window, from where they may be quoted onward. Impact is small — the client that spawned the server already knows the board path — but error text is also how an agent learns about the host’s directory layout when it did *not* spawn the server (e.g. a pre-configured MCP server in someone else’s setup).

- Exploit scenario: Agent on a locked-down setup probes failing mutations and harvests absolute paths/usernames from `-32603` messages for later social-engineering or path-guessing.

- Evidence: PoC `/tmp/poc-actor.mjs` step 3 (read-only `cards/` dir): `{"code":-32603,"message":"internal error: EACCES: permission denied, open '/var/folders/q6/…/botflow-poc-actor-VuI9pH/.botflow/cards/002-will-fail.md.46837.txzs77.tmp'"}`. (The existing test at `test/mcp-security.test.ts:122-139` exercises this path but asserts only the code, not the message content.)

- Suggested fix: Send `internal error` (or the `err.name`) to the client and write the full message to `process.stderr` instead. One-line change; keep the request id correlation as-is.

## F04-6: Read-only tools are not read-only, and there are no payload/board size caps beyond the 8 MiB frame limit

- Severity: Info
- CWE: CWE-770 (Allocation of Resources Without Limits) — partial
- Location: `src/mcp/server.ts:140-148` (`view()` runs `runAutomation` when archive/snooze/reminder state exists); per-call `loadTree` in every tool handler

- Description: Two resource/integrity observations, both by design but worth recording. (1) `prime`, `board`, `ready`, `query_cards`, `filters_list`, `buttons_list`, `lint`, and `card_show` all call `view()`, which takes the board lock and *writes* card files (reminder log lines attributed to `botflow`, snooze wakeups, archive sweeps of up to 100 cards) when lazy automation is due — a "read" tool is a mutation vector a read-only-scoped client might not expect. (2) Every tool call re-reads and re-parses the entire board tree synchronously, and no field-level size limits exist: a single `card_add` with a ~8 MiB title/message lands on disk wholesale, and board files of unbounded size are read fully into memory on every call. A malicious agent can therefore bloat the git repo or keep the (single-threaded) server busy with full-tree reloads; a malicious repo with giant card files makes every MCP call expensive. Both require a local actor who could achieve the same more directly, hence Info.

- Exploit scenario: Agent repeatedly calls `board` on a large tree (full fs scan + analysis per call) or adds multi-MiB titles to inflate the repo; or a malicious repo ships a multi-GB `cards/*.md` that is slurped on every call.

- Evidence: Code reading: `view()` at `src/mcp/server.ts:140-148` calls `runAutomation(root)` which persists via `writeCard` (`src/core/mutate.ts:309-315`); `readFileSync` without size checks at `src/core/load.ts:42,53`; frame cap is the only size limit (`src/mcp/server.ts:54,665`).

- Suggested fix: Optional: gate lazy automation behind a `mutationBlocked`-style config flag for read tools, and/or cap title/message/custom-field string lengths (e.g. 64 KiB) in the `strOf` layer. Not urgent.

## Checked clean

Attack classes examined in scope with no issue found:

- Tool argument type confusion: `strOf`/`list`/`priorityOf`/`positiveIntOf`/`hillOf`/`fieldsOf`/`offsetsOf` reject wrong shapes loudly (`src/mcp/server.ts:82-138`); ops layer revalidates everything (e.g. `checkedRepeat` catches the server’s unchecked `unit` cast, `src/core/ops.ts:228-236`). Covered by `test/mcp-security.test.ts` (verified passing).
- `board_path` traversal in `card_add`/`card_edit`: absolute paths rejected, `..` depth-tracked with exactly one segment of allowance for `.botflow` roots (`src/core/ops.ts:119-138`); `/etc` and `../../..` rejected by test. Only the symlink variant escapes — see F04-2.
- Card filename traversal via title: `slugify` reduces titles to `[a-z0-9-]` and `card.file` is always `cards/<id>-<slug>.md` (`src/core/ids.ts:28-36`, `src/core/ops.ts:504`).
- YAML value injection on write: `emitScalar` quotes/escapes newline/tab/quote/backslash and every structurally significant leading char (`src/core/emit.ts:6-25`); emitted keys are either fixed built-ins or charset-constrained (`KEY_RE` `[A-Za-z0-9_-]+`, slug-validated config ids), so key-position injection is not reachable.
- YAML alias/anchor/tag/block-scalar abuse and billion-laughs-style expansion: explicitly rejected (`src/core/yaml.ts:223-226`); recursion depth capped at 100 (`src/core/yaml.ts:20,104`); duplicate keys rejected (`:155`) except the `__proto__` edge (F04-4).
- Log/comment/boost line forgery through message or actor fields: whitespace/control collapse plus colon stripping (`src/core/write.ts:67-103`) — holds for every direct-write path; the only bypass is template interpolation (F04-1).
- Section forgery via `card_describe`: `sanitizeBlock` escapes ATX headings; both body parsers are fence-aware (`src/core/write.ts:79`, `src/core/body.ts:60-95`).
- Attachment line injection: URL whitespace/control chars stripped and `)` percent-encoded; label brackets stripped (`src/core/write.ts:92-94`, `src/core/body.ts:265`). Note for the viewer scope: URL *schemes* are unrestricted (`javascript:`/`data:` are stored), unlike custom-field `url` values which require http/https (`src/core/presentation.ts:62-68`) — exploitability depends on renderer sanitization, out of this scope.
- Query-language ReDoS/injection: no regex is built from query text; matching is substring `includes` over a closed qualifier set (`src/core/query.ts:80-195`).
- JSON-RPC transport: newline framing with an 8 MiB stdin cap that exits cleanly (`src/mcp/server.ts:53-54,661-668`); garbage frames → `-32700` with `id:null`; scalars/arrays → `-32600`; unknown tools/methods → `-32602`/`-32601` with request id preserved; `arguments` must be a plain object; EPIPE on client disconnect exits quietly (`:597`). All asserted by passing tests. Batch arrays are rejected rather than processed.
- JSON-RPC id reflection: ids are echoed but only through `JSON.stringify` — no framing injection.
- Relation/transfer reference validation: `parseCardReference` charset (`src/core/refs.ts:13-23`), self-relation ban, `project:` refs refused for local mutations (`src/core/mutate.ts:214`), target-first write ordering for crash recovery; `card_transfer` requires an existing target board and lexical containment (symlink caveat = F04-2).
- Prototype pollution via MCP JSON inputs: custom `fields` must match declared, slug-charset config field ids (`src/core/ops.ts:268-289`), so `__proto__` cannot reach `card.extra` over MCP; yaml-side quirk is F04-4 with no `Object.prototype` contamination.
- Custom field value confusion: scalar/flat-array types enforced, `url` fields restricted to http/https (`src/core/presentation.ts:56-81`).
- Automation resource bounds: one pass capped at 100 actions; rule fan-out per event capped at 16 (`src/core/ops.ts:410,1511`); board buttons capped at 100 matched cards (`:1485`).
- Quick-add parsing: line-based (no multi-line titles), magic tokens validated, `^estimate` re-checked as safe integer downstream (`src/core/ops.ts:1319-1403`).
- Read-side symlink hygiene: symlinked card files and `cards/` dirs skipped via `lstat` (`src/core/load.ts:39-58`) — deliberate and effective for reads; the write-side board-root gap is F04-2.
- MCP handshake: `initialize` reports the fixed protocol version without negotiation, tools work without handshake — acceptable for a local stdio transport; no network listener, no shell exec, no `eval` anywhere in the server path.
- Locking: `board.lock` pid-reaping never steals live locks; stale lock error message discloses the lock path only to the local caller.
