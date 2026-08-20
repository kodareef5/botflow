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

- a **relative path** from the referencing board's root, resolving to a board root as: if `<path>/board.yaml` exists, `<path>` is the root; else if `<path>/.botflow/board.yaml` exists, `<path>/.botflow` is the root; else the reference is dangling (lint `board-path-missing`). The path MUST stay inside the project: an absolute path, or one whose `..` segments climb above the referencing board's root, is lint error `board-path-escape`, and tools MUST refuse to write such a value onto a card;
- **`project:<id>`**: a hosted-manager project reference. Only a botflow manager can resolve it (its Durable Objects roll the child project up exactly like the file engine); on the filesystem it is inert and lints as info `hosted-ref`, the card falling back to its own lane.

## 4. `board.yaml`

Written in the strict YAML subset (§9). Top-level keys:

| Key | Type | Required | Meaning |
|---|---|---|---|
| `botflow` | int | yes | Spec major version. This document defines `0`. |
| `name` | string | yes | Display name. |
| `ids` | `seq` \| `hash` | no (default `seq`) | Card id scheme (§8). |
| `features` | list of slugs | no | Additive capabilities the board relies on. Readers that do not support every declared feature MUST identify each unsupported feature and MUST refuse to mutate the board; read-only rendering MAY degrade. |
| `lanes` | list of lane maps | no | Defaults to the six canonical lanes, in canonical order, when omitted. |
| `labels` | list of label maps | no | Optional colors for card labels. Scoped single-select groups are derived from `Group/Value` names below. |
| `fields` | list of field maps | no | Typed declarations for board-specific card frontmatter fields. |
| `rollup` | map | no | Rollup policy (§7); defaults below. |

An implementation that encounters an unsupported `botflow` major MAY inspect and
render the board read-only, but MUST refuse every operation that rewrites its
documents. It MUST NOT replace the version with one it supports. Additive fields do
not require a major bump; the major is reserved for incompatible semantics.

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

Label map keys:

| Key | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Exact card-label value, unique in the registry. |
| `color` | `#RGB` \| `#RRGGBB` | no | Face color. Undeclared labels and entries without a color receive a deterministic derived color. |

A label containing `/` with non-empty text on both sides is scoped: the text before
the first slash is its group and the remainder is its value. A card MUST NOT carry two
labels from the same group (`Type/Bug` plus `Type/Feature`); lint reports
`label-group-conflict`, and conforming mutation tools MUST refuse to create the conflict.
Labels without a slash remain ordinary multi-select tags. The convention works without
a registry; the registry only supplies deliberate colors.

Custom-field map keys:

| Key | Type | Required | Meaning |
|---|---|---|---|
| `id` | frontmatter key | yes | Unique key matching `[a-z][a-z0-9_-]*`; MUST NOT shadow a built-in or reserved card key. |
| `name` | string | no | Display name; defaults to `id`. |
| `type` | `text` \| `number` \| `checkbox` \| `date` \| `select` \| `multi-select` \| `url` \| `person` | yes | Value contract below. |
| `options` | list of strings | iff select type | Allowed values for `select` / `multi-select`; unique and non-empty. |
| `face` | bool | no (default `false`) | Whether a filled value may appear on the compact card face. Registry order is display and graceful-degradation priority. |

Values live directly in card frontmatter under the declared `id`, so an older reader
still preserves them as unknown keys. `text`, `url`, `person`, and `select` are strings;
`number` is an integer (the YAML subset has no floats); `checkbox` is boolean; `date`
uses the `start`/`due` UTC forms; `multi-select` is a list of strings. Select values MUST
belong to `options`. A declared field is not lint `unknown-key`; a mistyped value is
error `custom-field-value`. Compact faces render only filled fields whose declaration
has `face: true`, in registry order, and MAY silently omit the lowest-priority tail when
space is constrained. Detail views MUST retain every filled field.

Unknown keys in the top-level board mapping, lane, label, custom-field, or `rollup`
mappings are lint `info` (`unknown-key`) and MUST be preserved semantically by any tool that
rewrites `board.yaml`, under the same normalization allowance as unknown card keys
(§5). This makes additive board capabilities safe across routine edits.

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
| `assignee` | string | no | Accountable human/owner. A normal claim (§12) sets it. Existing v0 cards that used this as the executing actor remain valid. |
| `delegate` | string | no | Agent currently executing the card. A delegate-mode claim (§12) sets it without replacing the accountable assignee. |
| `priority` | `p0`–`p3` | no | |
| `deps` | list of card ids | no | Same-board dependencies. A **task** card is **ready** when its effective canonical state (§6) is `todo` and every dep's effective state is `done` or `archive`. Board-cards are containers, not worker tasks: they are never ready and never appear in the work queue, which keeps `ready` and claimability (§12) consistent even when a board-card's lane drifts from its rollup. (Cross-board deps are out of scope for v0.) |
| `start` | date string | no | Planned start, `YYYY-MM-DD` or an ISO UTC datetime ending in `Z`. Stored and compared in UTC; no implicit local timezone. |
| `due` | date string | no | Due date/time in the same form as `start`. A date-only value means the end of that UTC date for overdue checks. |
| `estimate` | positive int | no | Board-local effort points. It is deliberately unitless; tools may sum it but MUST NOT reinterpret it as elapsed time. |
| `evergreen` | bool | no (default `false`) | Suppresses stale-card aging signals for intentionally long-lived reference work. It does not suppress time metrics. |
| `cover` | url \| `none` | no | Card art. Viewers show the image atop the card; when absent they MAY fall back to the first image attachment; `none` suppresses art entirely. |
| `cover_color` | `#RGB` \| `#RRGGBB` | no | Color band or fallback art behind the compact card; independent of `cover`. |
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

### 6a. Derived time and flow metrics

Tools MAY replay the append-only Log to derive metrics; no derived value is stored in
frontmatter. Date-only entries are interpreted at `00:00 UTC` for elapsed-day math.
Durations are whole elapsed UTC days, rounded down, because historic v0 logs may have
day-only precision.

- **Current/cumulative lane time:** creation and every `moved <from> → <to>` or
  `migrated <from> → <to>` entry define intervals. Lane totals include re-entry.
- **Stalled:** a card whose effective state is `doing` and whose last Log activity is
  at least 3 days old. `evergreen` suppresses the signal.
- **Aging:** only `doing`/`blocked` cards age visually, at 7/14/28 idle days;
  `evergreen` suppresses the visual level.
- **Cycle time:** first entry into a `doing`-canonical lane through first completion.
  **Lead time:** `created` (or its creation entry) through first completion.
- **Blocked duration:** accumulated intervals from `blocked:` Log entries through
  `unblocked`/completion, including the open interval of a currently blocked card.
- **Throughput:** first completions grouped by UTC date. **Cumulative flow:** end-of-day
  card counts reconstructed from the same creation and transition entries.

Incomplete historic logs produce `null` for a duration whose start or end cannot be
proven; tools MUST NOT invent precision.

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

This metric is named **structural progress**, and tools SHOULD present it as such. Every card on a board is one unit of that board's structure: a 500-card child board still fills exactly one parent unit (by its own fraction), the same as a sibling one-line task. That is deliberate: it preserves encapsulation (a parent needs no knowledge of child size) and makes the number mean "how much of this board's own shape is finished", not "how many leaf tasks exist beneath it". Anyone needing leaf-weighted numbers can walk the tree themselves; per-card `weight:` is a possible future extension (§13), not part of this version.

**Effort projection.** Estimates do not change structural progress. Tools additionally
MAY report `effort_progress(B) = estimate_done / estimate_total`, considering only
countable cards that carry `estimate`. A done task contributes its full estimate; an
unfinished task contributes zero; a board-card contributes its estimate scaled by its
resolved child's structural progress (or one/zero from its effective state when the
child is unresolved). The result is `null` when no countable card is estimated. Tools
MUST label this as estimated effort, not elapsed time, and SHOULD expose per-lane sums.

**Recursion** is depth-first. Implementations MUST detect reference cycles and MUST NOT loop: the reference that closes a cycle resolves to nothing, so its board-card falls back to `canonical(c)` (rule 1) and lint reports error `board-cycle`; references upstream of the broken edge roll up over it normally. Aggregate ("rollup") views may render the tree to any depth; canonical distributions are the only cross-level interface.

## 8. Card ids & merge semantics

- `ids: seq` (default): decimal, zero-padded to at least 3 (`042`; padding grows naturally). Next id = max existing + 1. Simple and readable; concurrent creation on two branches can collide: after merge, lint error `dup-id`; resolve by re-iding one card (file rename + `id` + inbound `deps`).
- `ids: hash`: 6 lowercase base36 characters, generated randomly, checked against existing ids at creation. Use for boards where multiple agents create cards concurrently on diverging branches.

One card = one file, so edits to different cards never conflict in git. Same-card edits merge as ordinary text; the append-only Log usually auto-merges. Tools MUST NOT renumber or rewrite cards they weren't asked to touch.

## 9. Strict YAML subset

botflow documents (board.yaml and card frontmatter) use a deliberately small YAML subset. Conforming parsers MUST accept exactly this; anything else is lint error `yaml-error`.

Supported:
- **Mappings**: `key: value`; nesting by 2-space indentation, bounded at 100 levels deep (deeper is a parse error, not a crash). Keys are plain scalars (`[A-Za-z0-9_-]+`). The one inline mapping form is `{}`, the empty map.
- **Sequences**: block form (`- item`, including `- key: v` starting an inline map whose further keys sit 2 spaces deeper), and flow form `[a, b, c]` for scalar items only.
- **Scalars**: plain, `"double-quoted"` (escapes: `\\`, `\"`, `\n`, `\t`), `'single-quoted'` (escape: `''`). Plain scalars type as: `true`/`false` → bool, `null`/empty → null, `-?(0|[1-9][0-9]*)` → int, anything else → string. Digit tokens with leading zeros (`042`) are **strings**: this keeps zero-padded card ids intact. Date-like plain scalars (`2026-08-16`, ISO datetimes) are strings: there is no date type. The key/value separator is the **first** `: ` on the line, so plain values may contain colons; a value containing ` #` (which would start a comment) MUST be quoted. Anything ambiguous MUST be quoted.
- **Comments**: `#` at line start or preceded by whitespace, to end of line.
- Blank lines anywhere; `\r\n` normalized to `\n`.

Not supported (parse error): anchors/aliases (`&`, `*`), tags (`!`), block scalars (`|`, `>`), flow mappings (`{…}`) other than the empty map `{}`, multi-document markers, merge keys (`<<`), complex keys, tab indentation, floats (quote them if you need them).

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
| `dep-cycle` | error | Dependency cycle (`deps` closes a loop): every member is permanently non-ready. Reported once per cycle, naming the loop. |
| `board-path-missing` | error | Board-card path doesn't resolve (§3). |
| `board-path-escape` | error | Board-card path is absolute or escapes the project root (§3). |
| `board-cycle` | error | Board reference cycle. |
| `id-scheme-mismatch` | error | Card id doesn't match the board's `ids` scheme. |
| `wip-breach` | warning | Lane exceeds its `wip`. |
| `filename-id-mismatch` | warning | Filename doesn't begin with the card id. |
| `bare-substate-lane` | warning | Card in a substated lane without a substate. |
| `rollup-drift` | warning | Board-card lane canonical ≠ rolled-up effective state. |
| `blocked-in-done` | warning | Blocked flag on a done/archive card. |
| `label-group-conflict` | error | Card carries more than one scoped label in the same group. |
| `custom-field-value` | error | A declared custom-field value violates its type/options. |
| `unknown-key` | info | Unrecognized frontmatter key (preserved). |
| `unsupported-feature` | warning | `board.yaml` declares a feature this reader does not implement; the board is read-only. |
| `hosted-ref` | info | Board-card uses a `project:` reference; resolvable only on a manager. |

Errors mean the board is not conformant; warnings are signals; infos are noise-level.

## 11. Conformance fixtures

Each directory under `test/fixtures/` is a board (or, for `invalid/`, a set of boards) with expected outputs beside it:

- `minimal/`: omitted `lanes` (canonical defaults); three tasks. → `expected.json`
- `standard/`: six lanes + specialty `needs-qa` (→ doing), wip limit, a blocked flag, a deps chain exercising **ready**. → `expected.json`
- `substates/`: strict-ordered `doing` substates, incl. a bare-lane warning case. → `expected.json`
- `nested/`: a parent whose cards include two board-cards (one all-done child, one mixed child with a blocked card); exercises rollup, drift, progress. → `expected.json`
- `card-features/`: scheduling, estimate, Evergreen, and accountable-assignee / executing-delegate fields. → `expected.json`
- `presentation/`: scoped/colored labels, typed custom fields, face flags, description/checklist previews, and cover color. → `expected.json`
- `invalid/`: one board per error class. → `expected.json` (lint findings)

Expected files record, per board: lint findings (rule ids + card ids), per-card canonical states, lane distributions, ready sets, and (where relevant) effective states and progress. A conforming engine must reproduce them exactly.

## 12. Conventions for tools

- **Claim is a coordination primitive, not a shortcut.** A claim MUST succeed only when the card is claimable by the actor: its local canonical state (lane canonical, or `blocked` when the flag is set) is `todo`, every dep resolves to a card whose local canonical state is `done` or `archive`, and the selected holder field is empty or already the actor. A normal (human/accountability) claim selects `assignee`; an explicit delegate-mode claim selects `delegate` and leaves `assignee` intact. Success sets the selected field and moves the card to a `doing`-canonical lane (first substate if any), appending a Log entry: one atomic rewrite. A claim by the actor already named in the selected field while the card is `doing` is an idempotent no-op. Two actors racing for the same selected role get exactly one winner; assignee and delegate are different roles and may coexist. Anything else MUST fail with a conflict that names the reason (`assigned`, `blocked`, `not-ready`, `deps`) and MUST NOT modify the card. Tools MAY offer an explicit force override for human operators; hosted APIs MUST restrict that override to admin identities and record its use. A forced normal claim clears an existing delegate because the human is taking execution back; a forced delegate claim replaces only the delegate. Board-cards never appear in `ready` (§5); claiming one explicitly is judged by its own lane, because rollup state is a view, not a lock.
- Every mutation appends a Log line; never rewrite existing Log lines. Comments append to `## Comments` and bump `updated` without a Log line (discourse isn't audit); checklist toggles and attachment changes DO log.
- **Single-line fields stay single-line.** Actor names, log messages, comment text, blocked reasons, and attachment labels/urls are interpolated into structured markdown lines; tools MUST collapse whitespace/control characters (newlines included) to a single space in those values, so a crafted value cannot forge extra entries or sections. Actor names additionally drop `:`, because an entry splits on the first `": "` and an actor carrying one reads back truncated. Attachment urls additionally percent-encode `)` so the link syntax cannot be closed early.
- **Multi-line body text stays inside its section.** Free-text written into a section (a description, say) and any caller-chosen section name MUST NOT be able to introduce a `## ` heading: tools MUST escape heading markers in that text, and MUST reject a section name that is not a single plain line. Otherwise a writer can splice a second `## Log` ahead of the real one, and since section-aware appends target the *first* matching heading, every later entry lands in the forged section: the append-only Log becomes attacker-chosen, and anything derived from it (such as a card's creator) reports whatever the forged entry says. `## Log` is never a valid target for a checklist item.
- Section-aware body edits (set/append section, checklist toggles, attachment removal) MUST ignore lines inside fenced code blocks: a literal `## ` or `- [ ]` inside a fence is content, not structure.
- **Same-tree concurrency.** git covers branch races (§8); two processes in one worktree are the tool's job. A mutating tool MUST serialize its load-mutate-write cycle against other processes (e.g. a short-lived `board.lock` file with stale-owner reaping), MUST allocate seq ids inside that critical section, and SHOULD write files crash-safely (temp file + rename). Lock files are derived state: never committed, safe to delete when their owner is gone.
- Preserve unknown card-frontmatter and `board.yaml` keys and all body content outside the section being edited.
- Only bump `updated` on meaningful change.
- `prime`: every conforming CLI SHOULD offer a command that prints the board's shape, rules, ready work, and the tool's own usage, so an agent can be taught with one line in AGENTS.md.
- Derived stores (indexes, caches) MUST be rebuildable from files alone and MUST NOT be committed.
- **Board reshaping.** A tool that edits `board.yaml` over live cards MUST leave the board conformant: cards stranded by a removed lane or substate migrate to a surviving lane (same canonical state unless the operator chose a target), and every migration appends a Log line on the moved card.
- **Snapshot sync contract.** When a file-truth board syncs with a hosted copy, the repo documents are truth and sync is whole-board snapshot, last write wins. The hosted side is that snapshot **plus a manager overlay**: hosted-native children (project-reference cards the repo snapshot does not carry) survive a push rather than being severed. Both directions MUST validate the entire snapshot before persisting any of it (fatal findings: `yaml-error`, `frontmatter-missing`, `schema`, `dup-id`; unsafe or duplicate paths), and a pull that would remove local files SHOULD refuse over uncommitted changes without an explicit force. Applying a snapshot is a **validated, crash-safe apply**, not an atomic set-replacement: individual writes are crash-safe, an interruption leaves only valid documents, and re-running the sync converges. Sync MUST NOT follow symlinks: a push skips non-regular files when reading documents, and a pull MUST refuse when the board root or any write/delete target passes through a symlink.

## 13. Future (non-normative)

The card-frontmatter names `spent`, `watchers`, `relates`, and `weight` are reserved for future botflow semantics. Implementations
MUST preserve them as unknown keys today and SHOULD warn before assigning unrelated
local meanings to them.

Cross-repo/branch board references (`repo#branch` URLs), cross-board deps, sweep policies (auto-archive of aged done cards), quorum `done_when`, per-card `weight:` for leaf-weighted progress (today's progress is structural, §7), CRDT-grade merge for same-card edits, signed Log entries.
