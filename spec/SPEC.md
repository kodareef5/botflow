# botflow format specification

**Version: 0.1.** This document is normative for `botflow: 0` documents. The fixtures under `test/fixtures/` are conformance vectors: a conforming implementation must produce the expected outputs recorded beside them. MUST/SHOULD/MAY are used in the RFC 2119 sense.

## 1. Concepts

- A **board** is a directory containing a `board.yaml` and a `cards/` directory. Files in git are the source of truth; anything else (SQLite indexes, web views) is derived and rebuildable.
- A board has ordered **lanes**. Every lane projects onto exactly one of six **canonical states**. Lanes may carry an ordered list of **substates** (a sub-state machine inside the lane).
- A **card** is one markdown file: YAML frontmatter + free markdown body. A card is either a `task` or a `board`: a board-card points at a child board directory, making boards recursive.
- **Projection** maps any card to a canonical state; **distribution** counts a board's cards by canonical state; **rollup** derives a board-card's effective state from its child board's distribution. Because aggregation consumes only canonical distributions, a parent never needs to know a child board's shape.

## 2. Canonical states

| State | Meaning |
|---|---|
| `wishlist` | Captured, not committed to. |
| `todo` | Committed, not started. |
| `doing` | Started; includes review/QA-type activity. |
| `blocked` | Cannot proceed; waiting on something external to the card. |
| `done` | Complete; no further action. |
| `archive` | Out of play. Excluded from progress and rollup by default (dropped, superseded, or swept-away done work). |

## 3. Directory layout & discovery

```
<board root>/
  board.yaml
  cards/
    042-fix-auth.md
    051-payments.md        # type: board → points at another board root
    …                      # subdirectories under cards/ are allowed and scanned recursively
```

Repo convention: the board root is `.botflow/` at the repo root. Tools resolve the active board as, in order:

1. an explicit `--board <path>` argument or `BOTFLOW_DIR` environment variable;
2. walking up from the current directory, the nearest ancestor containing `.botflow/board.yaml`;
3. walking up, the nearest ancestor that itself contains `board.yaml` + `cards/` (a bare board root).

A **child board reference** (`board:` field, §5) takes one of two forms:

- a **relative path** from the referencing board's root, resolving to a board root as: if `<path>/board.yaml` exists, `<path>` is the root; else if `<path>/.botflow/board.yaml` exists, `<path>/.botflow` is the root; else the reference is dangling (lint `board-path-missing`);
- **`project:<id>`**: a hosted-manager project reference. Only a botflow manager can resolve it (its Durable Objects roll the child project up exactly like the file engine); on the filesystem it is inert and lints as info `hosted-ref`, the card falling back to its own lane.

## 4. `board.yaml`

Written in the strict YAML subset (§9). Top-level keys:

| Key | Type | Required | Meaning |
|---|---|---|---|
| `botflow` | int | yes | Spec major version. This document defines `0`. |
| `name` | string | yes | Display name. |
| `ids` | `seq` \| `hash` | no (default `seq`) | Card id scheme (§8). |
| `lanes` | list of lane maps | no | Defaults to the six canonical lanes, in canonical order, when omitted. |
| `rollup` | map | no | Rollup policy (§7); defaults below. |

Lane map keys:

| Key | Type | Required | Meaning |
|---|---|---|---|
| `id` | slug | yes | Unique within the board. Slug = `[a-z0-9][a-z0-9-]*`. |
| `name` | string | no | Display name; defaults to the id. |
| `canonical` | canonical state | iff `id` is not itself one of the six | Which canonical state this lane projects to. When `id` **is** a canonical name, `canonical` defaults to it (and MUST equal it if given). |
| `substates` | list of slugs | no | Ordered sub-states. Position notation: `lane.substate`. |
| `order` | `strict` \| `free` | no (default `free`) | `strict`: conforming tools MUST only move a card between **adjacent** substates of this lane (either direction). Enforced at mutation time; lint cannot see transitions, only positions. |
| `wip` | positive int | no | Soft work-in-progress limit; exceeding it is lint warning `wip-breach`, and mutating tools SHOULD warn (not fail) when a move would breach it. |

A board MAY have several lanes projecting to the same canonical state (e.g. `needs-qa` → `doing`), and MAY omit canonical states it doesn't use. Lane order in the file is the display order.

Default rollup policy (all keys optional):

```yaml
rollup:
  blocked_when: any-blocked    # or: never
  done_when: all-done          # (only value in v0)
  doing_when: any-started      # or: any-doing
  else: todo                   # or: wishlist
```

## 5. Card files

Filename: `<id>-<slug>.md` (SHOULD; the slug is cosmetic). The filename MUST begin with the card's `id` followed by `-` or `.`; otherwise lint warning `filename-id-mismatch`. **Frontmatter is the source of truth, never the filename.**

Frontmatter keys:

| Key | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Unique within the board (§8). |
| `title` | string | yes | |
| `lane` | `laneId` or `laneId.substate` | yes | Current position. |
| `type` | `task` \| `board` | no (default `task`) | |
| `board` | relative path | iff `type: board` | Child board reference (§3). |
| `labels` | list of strings | no | |
| `assignee` | string | no | Freeform actor name. Claiming (§12) sets it. |
| `priority` | `p0`–`p3` | no | |
| `deps` | list of card ids | no | Same-board dependencies. A card is **ready** when its effective canonical state (§6; for board-cards, §7) is `todo` and every dep's effective state is `done` or `archive`. (Cross-board deps are out of scope for v0.) |
| `cover` | url \| `none` | no | Card art. Viewers show the image atop the card; when absent they MAY fall back to the first image attachment; `none` suppresses art entirely. |
| `blocked` | string | no | Blocked **flag** with a reason. Presence overrides projection (§6). |
| `created` | date string | no | `YYYY-MM-DD` or ISO datetime; stored as a plain string. |
| `updated` | date string | no | Tools SHOULD touch this only on meaningful changes (merge-noise discipline). |

Unknown frontmatter keys are lint `info` (`unknown-key`) and MUST be preserved
semantically by any tool that rewrites a card. Rewriters MAY normalize key order,
scalar quoting, whitespace, and comments inside frontmatter; the parsed value and
all markdown body content outside the requested edit MUST survive.

Body: free markdown. Conventional sections, all optional:

```markdown
## Description
…
## Checklist
- [x] repro
- [ ] fix
## Log
- 2026-08-16 agent-1: created in todo
- 2026-08-16 agent-1: moved todo → doing.implement
```

`## Log` is append-only by convention: tools MUST append entries (`- <date-or-datetime> <actor>: <message>`) rather than editing history. Git history plus the Log constitute the local audit trail.

Further conventional body sections, all optional and all plain markdown:

- **Checklists**: every GFM task item (`- [ ]` / `- [x]`) anywhere in the body belongs to the card's checklist aggregate; items group under the `##` section they appear in (`Checklist` when unnamed). Tools address items by their **global 0-based ordinal** in body order, and surface the aggregate (`done/total`) on card faces.
- **`## Comments`**: discourse between operators and agents, append-only like the Log, same entry shape (`- <date-or-datetime> <actor>: <text>`). Comments are conversation; the Log is audit: tools MUST NOT merge them.
- **`## Attachments`**: one markdown link per line (`- [label](url)`). Attachments whose urls are images form the card's gallery (and the default cover, §5 `cover`). Attachments are urls; binary upload storage is a hosted-manager concern, not part of the format.

## 6. Projection

For a card `c` in lane `L`:

```
canonical(c) = blocked          if c.blocked is set and canonical(L) ∉ {done, archive}
             = canonical(L)     otherwise
```

A `blocked` flag on a done/archive card is inert (lint warning `blocked-in-done`). A lane whose canonical **is** `blocked` is also legal: the flag and the lane are two styles of the same signal; the flag is recommended because the card keeps its place in the flow.

Cards in a substated lane SHOULD carry a substate (`doing.review`). A bare lane id where substates exist is lint warning `bare-substate-lane` and is treated as the **first** substate.

## 7. Nesting & rollup

**Distribution.** `dist(B)` counts B's cards by canonical state. A task card contributes its `canonical(c)`. A board-card contributes its **effective state** (below): it counts as exactly one card in the parent; child internals never leak upward.

**Effective state of a board-card** `c → child board K`, computed with the **parent's** rollup policy over `dist(K)` (countable = all cards of K not in `archive`):

1. If countable = 0 → effective = `canonical(c)` (the card's own lane speaks).
2. If `blocked_when: any-blocked` and any countable child is `blocked` → `blocked`.
3. If all countable children are `done` → `done`.
4. `doing_when: any-doing`: any countable child `doing` → `doing`.
   `doing_when: any-started` (default): any countable child `doing`, **or** a mix of `done` and not-`done` children → `doing`.
5. If all countable children are `wishlist` → `wishlist`.
6. Otherwise → the `else:` value (default `todo`).

The board-card's frontmatter `lane` remains authoritative for its **position** (a human may park it anywhere); its effective state is what distribution, progress, and aggregate views use. When lane-canonical and effective state disagree, lint reports warning `rollup-drift`: files stay truth, drift stays visible.

**Progress.** `progress(B) = weight_done / weight_total` over countable cards, where a task card has weight 1 (1 if `done`, else 0 toward done) and a board-card has weight 1 scaled by `progress(K)` (a child 3⁄4 done contributes 0.75). A childless (countable=0) board-card contributes 1 if its effective state is `done`, else 0. `progress` of a board with no countable cards is `null`.

**Recursion** is depth-first. Implementations MUST detect reference cycles and MUST NOT loop: the reference that closes a cycle resolves to nothing, so its board-card falls back to `canonical(c)` (rule 1) and lint reports error `board-cycle`; references upstream of the broken edge roll up over it normally. Aggregate ("rollup") views may render the tree to any depth; canonical distributions are the only cross-level interface.

## 8. Card ids & merge semantics

- `ids: seq` (default): decimal, zero-padded to at least 3 (`042`; padding grows naturally). Next id = max existing + 1. Simple and readable; concurrent creation on two branches can collide: after merge, lint error `dup-id`; resolve by re-iding one card (file rename + `id` + inbound `deps`).
- `ids: hash`: 6 lowercase base36 characters, generated randomly, checked against existing ids at creation. Use for boards where multiple agents create cards concurrently on diverging branches.

One card = one file, so edits to different cards never conflict in git. Same-card edits merge as ordinary text; the append-only Log usually auto-merges. Tools MUST NOT renumber or rewrite cards they weren't asked to touch.

## 9. Strict YAML subset

botflow documents (board.yaml and card frontmatter) use a deliberately small YAML subset. Conforming parsers MUST accept exactly this; anything else is lint error `yaml-error`.

Supported:
- **Mappings**: `key: value`; nesting by 2-space indentation. Keys are plain scalars (`[A-Za-z0-9_-]+`).
- **Sequences**: block form (`- item`, including `- key: v` starting an inline map whose further keys sit 2 spaces deeper), and flow form `[a, b, c]` for scalar items only.
- **Scalars**: plain, `"double-quoted"` (escapes: `\\`, `\"`, `\n`, `\t`), `'single-quoted'` (escape: `''`). Plain scalars type as: `true`/`false` → bool, `null`/empty → null, `-?(0|[1-9][0-9]*)` → int, anything else → string. Digit tokens with leading zeros (`042`) are **strings**: this keeps zero-padded card ids intact. Date-like plain scalars (`2026-08-16`, ISO datetimes) are strings: there is no date type. The key/value separator is the **first** `: ` on the line, so plain values may contain colons; a value containing ` #` (which would start a comment) MUST be quoted. Anything ambiguous MUST be quoted.
- **Comments**: `#` at line start or preceded by whitespace, to end of line.
- Blank lines anywhere; `\r\n` normalized to `\n`.

Not supported (parse error): anchors/aliases (`&`, `*`), tags (`!`), block scalars (`|`, `>`), flow mappings (`{…}`), multi-document markers, merge keys (`<<`), complex keys, tab indentation, floats (quote them if you need them).

**Frontmatter framing** (outside the YAML grammar): a card file MUST begin with `---\n`, followed by subset-YAML lines, closed by a line consisting of `---`; the remainder is the body. A file without frontmatter is lint error `frontmatter-missing`.

## 10. Lint rules

| Id | Severity | Meaning |
|---|---|---|
| `yaml-error` | error | Document violates §9 or is unreadable. |
| `frontmatter-missing` | error | Card file has no frontmatter block. |
| `schema` | error | Missing/mistyped required field; bad enum value; `board` on a task; etc. |
| `dup-id` | error | Two cards share an id. |
| `unknown-lane` | error | Card's lane id not in the board's lanes. |
| `bad-substate` | error | Substate not among the lane's `substates`. |
| `dangling-dep` | error | Dep references a nonexistent card id. |
| `board-path-missing` | error | Board-card path doesn't resolve (§3). |
| `board-cycle` | error | Board reference cycle. |
| `id-scheme-mismatch` | error | Card id doesn't match the board's `ids` scheme. |
| `wip-breach` | warning | Lane exceeds its `wip`. |
| `filename-id-mismatch` | warning | Filename doesn't begin with the card id. |
| `bare-substate-lane` | warning | Card in a substated lane without a substate. |
| `rollup-drift` | warning | Board-card lane canonical ≠ rolled-up effective state. |
| `blocked-in-done` | warning | Blocked flag on a done/archive card. |
| `unknown-key` | info | Unrecognized frontmatter key (preserved). |
| `hosted-ref` | info | Board-card uses a `project:` reference; resolvable only on a manager. |

Errors mean the board is not conformant; warnings are signals; infos are noise-level.

## 11. Conformance fixtures

Each directory under `test/fixtures/` is a board (or, for `invalid/`, a set of boards) with expected outputs beside it:

- `minimal/`: omitted `lanes` (canonical defaults); three tasks. → `expected.json`
- `standard/`: six lanes + specialty `needs-qa` (→ doing), wip limit, a blocked flag, a deps chain exercising **ready**. → `expected.json`
- `substates/`: strict-ordered `doing` substates, incl. a bare-lane warning case. → `expected.json`
- `nested/`: a parent whose cards include two board-cards (one all-done child, one mixed child with a blocked card); exercises rollup, drift, progress. → `expected.json`
- `invalid/`: one board per error class. → `expected.json` (lint findings)

Expected files record, per board: lint findings (rule ids + card ids), per-card canonical states, lane distributions, ready sets, and (where relevant) effective states and progress. A conforming engine must reproduce them exactly.

## 12. Conventions for tools

- **Claim is a coordination primitive, not a shortcut.** A claim MUST succeed only when the card is claimable by the actor: its local canonical state (lane canonical, or `blocked` when the flag is set) is `todo`, every dep resolves to a card whose local canonical state is `done` or `archive`, and `assignee` is empty or already the actor. Success = set `assignee` to the actor and move the card to a `doing`-canonical lane (first substate if any), appending a Log entry: one atomic rewrite. A claim of a card the actor already holds in `doing` is an idempotent no-op. Anything else MUST fail with a conflict that names the reason (`assigned`, `blocked`, `not-ready`, `deps`) and MUST NOT modify the card; two actors racing to claim the same card get exactly one winner. Tools MAY offer an explicit force override for human operators; a forced claim logs that it was forced. Board-cards judge claimability by their own lane: rollup state is a view, not a lock.
- Every mutation appends a Log line; never rewrite existing Log lines. Comments append to `## Comments` and bump `updated` without a Log line (discourse isn't audit); checklist toggles and attachment changes DO log.
- **Same-tree concurrency.** git covers branch races (§8); two processes in one worktree are the tool's job. A mutating tool MUST serialize its load-mutate-write cycle against other processes (e.g. a short-lived `board.lock` file with stale-owner reaping), MUST allocate seq ids inside that critical section, and SHOULD write files crash-safely (temp file + rename). Lock files are derived state: never committed, safe to delete when their owner is gone.
- Preserve unknown frontmatter keys and all body content outside the section being edited.
- Only bump `updated` on meaningful change.
- `prime`: every conforming CLI SHOULD offer a command that prints the board's shape, rules, ready work, and the tool's own usage, so an agent can be taught with one line in AGENTS.md.
- Derived stores (indexes, caches) MUST be rebuildable from files alone and MUST NOT be committed.

## 13. Future (non-normative)

Cross-repo/branch board references (`repo#branch` URLs), cross-board deps, sweep policies (auto-archive of aged done cards), quorum `done_when`, CRDT-grade merge for same-card edits, signed Log entries.
