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
| `templates` | list of template maps | no | Reusable defaults for creating cards; templates never appear as live work. |
| `filters` | list of filter maps | no | Named, portable card queries (§5b). |
| `subscriptions` | list of subscription maps | no | Members watching every card in a lane (§5b). |
| `blockers` | list of blocker maps | no | Reusable named blocker reasons and face colors. |
| `buttons` | list of button maps | no | Bounded, declarative card or board actions (§12a). |
| `rules` | list of rule maps | no | Bounded, non-recursive event actions (§12a). |
| `automation` | map | no | Lazy/scheduled time automation policy (§6b). |
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
| `wip_mode` | `allow` \| `justify` \| `deny` | no (default `allow`) | Enforcement when an entry would exceed `wip` (§12a). It is invalid without `wip`. |

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

Template map keys:

| Key | Type | Required | Meaning |
|---|---|---|---|
| `id` | slug | yes | Stable template identifier, unique within the board. |
| `name` | string | no | Display name; defaults to `id`. |
| `lane` | position | no | Default lane or lane.substate. |
| `labels` | list of strings | no | Default labels; scoped-group rules still apply. |
| `priority` | `p0`–`p3` | no | Default priority. |
| `assignee` / `delegate` | string | no | Default accountable/executing identities. |
| `start` / `due` | date string | no | Concrete UTC defaults. Relative dates belong to quick-add input, not stored templates. |
| `estimate` | positive int | no | Default effort points. |
| `evergreen` | bool | no | Default aging behavior. |
| `cover_color` | color | no | Default compact color band. |
| `fields` | map | no | Declared custom-field defaults, validated against `fields:`. |
| `body` | string | no | Initial markdown body. `{{title}}` is replaced with the new card title. |

Explicit card-create arguments override template defaults; a supplied custom-field map
merges over template fields. Instantiation copies values into an ordinary card and opens
its normal Log. The resulting card has no live link to the template. Unknown keys inside
a template map are preserved like other board configuration maps.

Saved-filter map keys:

| Key | Type | Required | Meaning |
|---|---|---|---|
| `id` | slug | yes | Stable identifier, unique within the board. |
| `name` | string | no | Display name; defaults to `id`. |
| `query` | string | yes | Query expression using §5b syntax. An empty expression matches every card. |

Lane-subscription maps contain `lane` (an existing lane id) and `watcher` (a non-empty
actor name). The pair is unique; order is presentation order. A subscription follows
activity on cards currently in that lane without copying the watcher onto each card.
Moving a card out of the lane changes that derived audience. Unknown keys inside filter
and subscription maps are preserved like the other board registries.

Named-blocker maps contain a unique slug `id`, optional non-empty `name` (defaulting to
the id), and optional `color` (`#RGB` or `#RRGGBB`). A card's `blocker:` value resolves
through this registry. Freeform `blocked:` remains valid without a named blocker for
backward compatibility; named and unnamed intervals are both measurable (§6a).

Button maps contain a unique slug `id`, optional non-empty `name` (defaulting to the id),
optional `scope` (`card` by default, or `board`), `action`, and action-specific `value`.
The safe v0 actions are `move` (value is a valid position), `close` (no value), and
`label` (value is a non-empty label to add idempotently). A board button additionally
requires `filter`, naming a saved filter, and applies to at most 100 matching cards as
one validated bulk mutation. A card button MUST NOT carry `filter`; `close` MUST NOT
carry `value`; the other actions require it.

Rule maps contain a unique slug `id`, `event` (`enter`, `close`, or `block`), optional
`lane`, optional `filter`, `action`, and `value`. `enter` requires a valid `lane`; the
other events MUST omit it. `filter`, when present, names a saved filter evaluated after
the primary mutation. Safe rule actions are `label`, `unlabel`, `assign`, `delegate`,
and `comment`; every action requires a non-empty `value`. Rules are evaluated in file
order and are subject to the execution bounds in §12a. Unknown keys inside blocker,
button, and rule maps are preserved.

A declared button/rule filter that does not resolve is a schema error and the affected
button/rule is inert; it MUST NOT be interpreted as an omitted filter or match every
card. A mutation that removes a saved filter MUST refuse while a button or rule names
it. This keeps a typo or stale reference fail-closed and preserves it for repair.

The automation map currently accepts `archive_done_after`, a positive whole number of
elapsed days. When set, a done card whose first completion can be proven from its Log is
eligible for a lazy sweep after that interval (§6b). Unknown automation keys are
preserved. Setting `archive_done_after` without an archive-canonical lane is a schema
error. Readers and automation passes remain total on such hand-authored input: they
skip impossible sweeps rather than throwing or repeatedly scheduling the same action.

Unknown keys in the top-level board mapping, lane, label, custom-field, template,
saved-filter, subscription, blocker, button, rule, `automation`, or `rollup`
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
| `watchers` | list of strings | no | Unique actor names explicitly following this card, in subscription order. |
| `votes` | list of strings | no | Unique actor names supporting or prioritizing this card, in vote order. A member has at most one vote. |
| `priority` | `p0`–`p3` | no | |
| `deps` | list of card refs | no | Gating dependencies. A **task** card is **ready** when its effective canonical state (§6) is `todo` and every resolved dep's effective state is `done` or `archive`. Board-cards are containers, not worker tasks: they are never ready and never appear in the work queue, which keeps `ready` and claimability (§12) consistent even when a board-card's lane drifts from its rollup. |
| `relations` | list of relation maps | no | Non-gating typed links (§5a). |
| `start` | date string | no | Planned start, `YYYY-MM-DD` or an ISO UTC datetime ending in `Z`. Stored and compared in UTC; no implicit local timezone. |
| `due` | date string | no | Due date/time in the same form as `start`. A date-only value means the end of that UTC date for overdue checks. |
| `reminders` | list of nonnegative ints | no | Unique offsets in minutes before the current `due`; requires `due` (§6b). Input order is preserved. |
| `repeat` | recurrence map | no | Materialize one independent next instance when this task first closes (§6b); requires `due` and is invalid on board-cards. |
| `snooze` | date string | no | Hide otherwise-ready work until this UTC instant/date or genuine new card activity, whichever comes first (§6b). |
| `estimate` | positive int | no | Board-local effort points. It is deliberately unitless; tools may sum it but MUST NOT reinterpret it as elapsed time. |
| `hill` | int 0–100 | no | Manual Hill Chart position. `0` begins uphill discovery, `50` is the uncertainty crest, and `100` ends downhill execution (§6c). |
| `evergreen` | bool | no (default `false`) | Suppresses stale-card aging signals for intentionally long-lived reference work. It does not suppress time metrics. |
| `cover` | url \| `none` | no | Card art. Viewers show the image atop the card; when absent they MAY fall back to the first image attachment; `none` suppresses art entirely. |
| `cover_color` | `#RGB` \| `#RRGGBB` | no | Color band or fallback art behind the compact card; independent of `cover`. |
| `blocked` | string | no | Blocked **flag** with a reason. Presence overrides projection (§6). |
| `blocker` | slug | no | Optional reusable reason id from the board's `blockers:` registry; requires `blocked:`. Exactly one named blocker may be active. |
| `created` | date string | no | `YYYY-MM-DD` or ISO datetime; stored as a plain string. |
| `updated` | date string | no | Tools SHOULD touch this only on meaningful changes (merge-noise discipline). |

A recurrence map contains `every` (positive integer), `unit` (`day`, `week`, or
`month`), and optional `from` (`due` by default, or `completion`). Unknown recurrence
keys are preserved. Calendar-month addition clamps to the last valid UTC day (January
31 + one month is February 28 or 29); day/week addition is elapsed UTC calendar days.
The materialization rules in §6b preserve whether the source due value was date-only or
a datetime.

Unknown frontmatter keys are lint `info` (`unknown-key`) and MUST be preserved
semantically by any tool that rewrites a card. Rewriters MAY normalize key order,
scalar quoting, whitespace, and comments inside frontmatter; the parsed value and
all markdown body content outside the requested edit MUST survive.

A recognized frontmatter key whose value is rejected by schema validation MUST likewise
survive an unrelated rewrite with its original parsed YAML value. The semantic card model
MAY use its documented fallback while the finding remains, but it MUST NOT silently erase
the rejected value. An explicit valid mutation of that key replaces the preserved value.

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
- **`## Boosts`**: lightweight support more expressive than a vote, append-only in the same entry shape. Text MUST be non-empty, single-line, and no longer than 12 Unicode code points. A card may have multiple boosts from one actor; history is never rewritten when a vote or watcher is toggled.

### 5a. Card references and relations

A **card ref** is either a bare card id (same board) or `<board-ref>#<card-id>`.
Local `board-ref` uses the same board-root resolution as §3, relative to the card's
board; it MUST remain inside the loaded project tree. Hosted refs use
`project:<project-id>#<card-id>`. A missing board or card is `dangling-dep` for `deps`
and `dangling-relation` for `relations`. A dependency cycle may cross boards and is
still `dep-cycle`; claim MUST refuse every member of it.

Relation maps contain `type` and `target` plus preservable unknown keys. The v0 types
are `relates`, `duplicates`, `supersedes`, `parent`, `subtask`, `copied-from`,
`copied-to`, `recurs-from`, and `recurs-to`. Relations do not gate readiness.
Conforming link tools SHOULD write the natural inverse when both cards are writable
(`parent` ↔ `subtask`, `duplicates` ↔ `supersedes`, `copied-from` ↔ `copied-to`,
`recurs-from` ↔ `recurs-to`; `relates` is symmetric). A self-relation is
`self-relation`. A link/unlink target MAY be a full card ref. Mutation tools that
support project trees MUST accept a target on a descendant board, write/remove the
target's inverse half first, then write/remove the source half. Each half is
idempotent, so retry after interruption converges without inventing a second edge.
Sibling, unrelated, and ancestor targets MUST be refused before probing the named
card. Local refs are rebased for each board; hosted refs use
`project:<project-id>#<card-id>`.

Dependency edges are presented as active `blocks` relationships while unresolved.
Once their target is done/archive, presentation degrades them to an ordinary resolved
relation; the raw `deps` entry is deliberately retained as history. Text may opt into a
derived relation with `[[card-ref]]` in Description or Comments. Derived text relations
are a view and are never written to frontmatter.

A dependency-cycle member is never ready or claimable even when its immediate
dependency happens to be in a done/archive lane. For a board-card dependency,
readiness and claimability both use the target's effective rollup state; they MUST NOT
disagree by mixing effective and local lane state.

On a hosted manager, state-bearing `project:` references follow the project grant
direction: a project may resolve itself and descendants, never an ancestor, sibling, or
unrelated project. An inverse relation written on a descendant by an authorized
cross-project operation MAY retain its ancestor endpoint as opaque provenance, but
rendering it MUST NOT ask the ancestor whether the named card exists or reveal its
state. An ancestor dependency remains unresolved and cannot satisfy readiness;
hand-authored ancestor refs are refused before any existence-sensitive lookup. This
keeps a credential scoped to a child from using refs as an ancestor-card oracle while
allowing a legitimate inverse edge to remain visible and removable.

### 5b. Search, mentions, and audiences

A mention is derived from `@name` in Description or Comment prose, excluding fenced
code. `name` begins with an ASCII letter or digit and continues with up to 63 ASCII
letters, digits, `_`, `-`, or `.`. Tools de-duplicate mentions in first-occurrence
order; trailing full stops are sentence punctuation, not part of the name. They MUST
NOT write a derived `mentions:` key. A card's current collaboration
audience is the union of its accountable assignee, delegate, explicit watchers,
mentions, and subscriptions for its current lane. Votes and boosts are signals, not
subscriptions.

The v0 query language is whitespace-separated and implicitly ANDed. Double or single
quotes preserve whitespace; a leading `-` negates one term. A bare term performs a
case-insensitive substring search over id, title, full markdown body, labels, actors,
and declared custom-field values. Qualifiers use `name:value`:

- `id`, `title`, `board`, `lane`, `state`, `label`, `assignee`, `delegate`, `watcher`,
  `voter`, `mention`, `priority`, `blocker`, and `type` match the named projection. Identity
  qualifiers accept `@me`, resolved from the invoking actor; without an actor it cannot
  match.
- `field.<id>` matches the string form of one declared custom-field value.
- `is:` accepts `ready`, `blocked`, `snoozed`, `overdue`, `stalled`, `evergreen`,
  `unassigned`, and `watched`. `due:` accepts `none`, `overdue`, `today`, and `future`.

Qualifier names and enum-like values are case-insensitive; stored identity, label,
field, id, title, and board values use case-insensitive substring matching. Invalid
quoting, an unknown qualifier, an unknown `is:`/`due:` predicate, or a query that names
an undeclared custom field is a query error rather than an empty result. Results are
deterministic in board traversal and card-file order. Search is a derived projection:
indexes MAY exist but MUST be rebuildable from board documents.

## 6. Projection

For a card `c` in lane `L`:

```
canonical(c) = blocked          if c.blocked is set and canonical(L) ∉ {done, archive}
             = canonical(L)     otherwise
```

A `blocked` flag on a done/archive card is inert (lint warning `blocked-in-done`). A lane whose canonical **is** `blocked` is also legal: the flag and the lane are two styles of the same signal; the flag is recommended because the card keeps its place in the flow.

At a supplied UTC clock value, `snooze` is **active** while its parsed instant is later
than that clock. A date-only snooze wakes at `00:00 UTC` at the beginning of that date.
An actively snoozed task is omitted from `ready` and claim reports without changing its
canonical state or distribution. Projections that depend on the clock MUST accept an
injected clock for deterministic tests and replay.

Cards in a substated lane SHOULD carry a substate (`doing.review`). A bare lane id where substates exist is lint warning `bare-substate-lane` and is treated as the **first** substate.

### 6a. Derived time and flow metrics

Tools MAY replay the append-only Log to derive metrics; no derived value is stored in
frontmatter. Date-only entries are interpreted at `00:00 UTC` for elapsed-day math.
Durations are whole elapsed UTC days, rounded down, because historic v0 logs may have
day-only precision.

- **Current/cumulative lane time:** creation and every tool-written transition entry
  define intervals. Conforming v0 transition forms include `moved <from> → <to>`,
  `migrated <from> → <to>`, and `swept <from> → <archive> after <n> days`; claim/close
  entries may carry their final `moved <from> → <to>` clause, and historical transfer
  entries may prefix it with `moved to <ref>,`. Parsers match the mutation form from
  the start of its Log message and MUST NOT treat arrow-shaped user reason text as a
  transition. Lane totals include re-entry.
- **Stalled:** a card whose effective state is `doing` and whose last Log activity is
  at least 3 days old. `evergreen` suppresses the signal.
- **Aging:** only `doing`/`blocked` cards age visually, at 7/14/28 idle days;
  `evergreen` suppresses the visual level.
- **Cycle time:** first entry into a `doing`-canonical lane through first completion.
  **Lead time:** `created` (or its creation entry) through first completion.
- **Due-date changes:** count standard `edited …` Log entries whose exact
  comma-separated field list contains `due`. Initial creation does not count. This is
  planning-churn history, not another stored card field.
- **Blocked duration:** accumulated intervals from `blocked:` or `blocked [id]:` Log
  entries through `unblocked`/completion, including the open interval of a currently
  blocked card. Tools additionally expose the same duration grouped by blocker id;
  freeform intervals use `unclassified`. Board metrics sum those proven per-card
  groups. Changing the reason requires an unblock followed by a new block, so an
  interval never changes identity midway through.
- **Throughput:** first completions grouped by UTC date. **Cumulative flow:** end-of-day
  card counts reconstructed from the same creation and transition entries.

System reminder and snooze-expiry entries are audit history but not human/agent work
activity: they MUST NOT reset stalled/aging clocks and MUST NOT wake snooze.

Incomplete historic logs produce `null` for a duration whose start or end cannot be
proven; tools MUST NOT invent precision.

### 6b. Scheduling and deterministic automation

For reminder and overdue math, a datetime's due instant is the encoded instant and a
date-only due instant is the next UTC midnight (the exclusive end of that date). A
reminder offset `m` becomes eligible at `dueInstant - m minutes`. The automation engine
appends exactly one Log entry per `(card, due value, offset)` in the form
`botflow: reminder <m>m for due <due>`. Moving the due value therefore moves every
pending reminder naturally and permits the new tuple to fire; replay of the same pass
does nothing. Eligible reminders are emitted in scheduled-time then card-file then
frontmatter-order order. They are also hosted activity events and therefore reach
feeds/audiences, but they do not clear snooze. Cards in done/archive do not emit pending
reminders.

Closing a task with `repeat` materializes exactly one independent successor and links
the pair with `recurs-to` / `recurs-from`. The successor uses the first todo-canonical
lane, keeps stable planning data (title, labels, assignee, watchers, priority, deps,
start/due cadence, reminders, repeat, estimate, Evergreen, cover, declared/unknown
custom data, Description, checklists, and attachments), resets checked checklist items,
and clears delegate, votes, blocked/blocker, snooze, Comments, Boosts, Log, and all
unrelated relations. `from: due` advances the source due by whole recurrence intervals
until the next due instant is strictly after completion, skipping missed slots while
retaining cadence. `from: completion` advances the UTC completion date/time by one
interval. When both start and due exist, the successor preserves their elapsed offset.
The new creation entry and inverse relations are part of the same mutation. A surviving
`recurs-to` target makes close replay idempotent; more generally, closing any card that
is already in done/archive is a no-op: it does not move the card, append another Log
entry, rerun rules, or emit another hosted event/integration delivery. File writers
create the valid target before rewriting the source, and hosted writers transact both.

Genuine card activity before `snooze` expires clears it as part of the same mutation and
records that wake in the mutation's Log text. Genuine activity includes edit, move,
claim, close, block/unblock, comment, boost, checklist, description, attachment, and an
explicit Log entry; watcher/vote toggles and system reminder/sweep bookkeeping do not
wake it. Expired snooze no longer affects readiness even before cleanup. An automation
pass removes an expired stored value and logs `snooze expired` once.

With `archive_done_after: n`, a pass sweeps a card only when its first completion is
proven, at least `n` whole UTC days have elapsed, and an archive-canonical lane exists.
It moves to the first archive-canonical lane and logs
`swept <from> → <archive> after <n> days`. A run applies
at most 100 reminder, snooze-expiry, or sweep mutations; when work remains it MUST
schedule or request another pass rather than silently discard it. File-backed tools
offer an explicit automation command and SHOULD run the same lazy pass before `board`,
`ready`, `prime`, and `search`. A hosted project runs it before an authenticated board
read and via a Durable Object alarm set to the earliest pending reminder, snooze expiry,
or sweep. A public share is an observational capability: its board/card/feed reads MUST
NOT run automation, append project events, or enqueue integration work. An unexpected
hosted pass failure MUST leave the board readable and schedule a bounded retry rather
than repeatedly arming an already-due alarm.
Alarm/lazy state is a cache: tuple markers and card Logs make it completely rebuildable
from board documents.

### 6c. Views and manual uncertainty

Board views are projections over the same cards, never alternate stores. Table,
calendar, timeline, swimlane, field-grouped, and metrics views MUST therefore preserve
card identity and MUST NOT write presentation-only ordering state. Calendar projection
uses `due`; timeline projection uses `start` and `due`; metrics are derived under §6a.

An implementation MAY group columns by a stored single-value axis: lane, assignee,
delegate, priority, a scoped label group, or a declared `select`, `person`, or
`checkbox` custom field. Moving a card between such columns changes that underlying
field using the ordinary validated card mutation. It MUST NOT synthesize a generic
rank field or silently treat a multi-value label/field as single-select.

`hill` is a deliberately human-generated signal of uncertainty, independent of flow
progress. Values `0` through `49` mean the work is uphill (figuring the approach out),
`50` is the crest, and `51` through `100` mean it is downhill (executing a known
approach). A missing value is unplotted. No move, claim, close, estimate, Log entry,
automation rule, or elapsed-time process may change it. Only an explicit card edit may
set or clear it, and that edit follows the normal Log and `updated` discipline.

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
| `wip-breach` | warning | Lane exceeds its `wip`; persisted breaches remain visible regardless of enforcement mode. |
| `filename-id-mismatch` | warning | Filename doesn't begin with the card id. |
| `bare-substate-lane` | warning | Card in a substated lane without a substate. |
| `rollup-drift` | warning | Board-card lane canonical ≠ rolled-up effective state. |
| `blocked-in-done` | warning | Blocked flag on a done/archive card. |
| `unknown-blocker` | error | Card names a blocker absent from the board registry. |
| `label-group-conflict` | error | Card carries more than one scoped label in the same group. |
| `custom-field-value` | error | A declared custom-field value violates its type/options. |
| `dangling-relation` | error | A relation target does not resolve. |
| `self-relation` | error | A card relates to itself. |
| `boost-value` | error | A Boost entry is empty or longer than 12 Unicode code points. |
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
- `relations/`: templates, typed relations, and a resolved cross-board dependency. → `expected.json`
- `collaboration/`: saved filters, lane subscriptions, watchers, votes, boosts, mentions, and query results. → `expected.json`
- `automation/`: reminders, recurrence policy, snooze readiness, named-blocker duration, WIP modes, buttons, rules, and sweep eligibility. → `expected.json`
- `invalid/`: one board per error class. → `expected.json` (lint findings)

Expected files record, per board: lint findings (rule ids + card ids), per-card canonical states, lane distributions, ready sets, and (where relevant) effective states and progress. A conforming engine must reproduce them exactly.

## 12. Conventions for tools

- **Claim is a coordination primitive, not a shortcut.** A claim MUST succeed only when the card is claimable by the actor: its effective canonical state (lane canonical for task cards, rollup state for board-cards, or `blocked` when the flag is active) is `todo`, it is not actively snoozed, it is not a dependency-cycle member, every dep resolves to a card whose effective canonical state is `done` or `archive`, and the selected holder field is empty or already the actor. A normal (human/accountability) claim selects `assignee`; an explicit delegate-mode claim selects `delegate` and leaves `assignee` intact. Success sets the selected field and moves the card to a `doing`-canonical lane (first substate if any), appending a Log entry: one atomic rewrite. A claim by the actor already named in the selected field while the card is `doing` is an idempotent no-op. Two actors racing for the same selected role get exactly one winner; assignee and delegate are different roles and may coexist. Anything else MUST fail with a conflict that names the reason (`assigned`, `blocked`, `snoozed`, `not-ready`, `deps`) and MUST NOT modify the card. Tools MAY offer an explicit force override for human operators; hosted APIs MUST restrict that override to admin identities and record its use. A forced normal claim clears an existing delegate because the human is taking execution back; a forced delegate claim replaces only the delegate. Board-cards never appear in `ready` (§5), but an explicit claim is judged by the same effective-state and dependency analysis so it cannot disagree with projections.
- Every workflow mutation appends a Log line; never rewrite existing Log lines. Comments append to `## Comments` and Boosts append to `## Boosts`; both bump `updated` without a redundant Log line because their append-only sections are already the record. Checklist toggles and attachment changes DO log.
- Promoting a checklist item creates a normal card, checks the source item, and writes inverse `parent`/`subtask` relations in the same atomic mutation. The promoted card inherits labels, accountable/delegated actors, due date, and estimate unless the caller overrides them.
- Duplicate merge never deletes history: it transfers unique attachments to the canonical card, rewires same-board inbound references, writes `duplicates`/`supersedes`, and archives the duplicate. Both cards are logged.
- Bulk mutations validate the complete batch before writing any card. A failed member leaves every card unchanged. Cross-board transfer likewise creates a valid target before retiring or removing a source; recovery or replay MUST converge rather than lose the only copy. A transfer target MUST be a descendant in the source project's loaded tree, so the source can retain a non-escaping `copied-to` reference; hosted managers enforce the same rule against their project hierarchy.
- **Single-line fields stay single-line.** Actor names, log messages, comment text, blocked reasons, and attachment labels/urls are interpolated into structured markdown lines; tools MUST collapse whitespace/control characters (newlines included) to a single space in those values, so a crafted value cannot forge extra entries or sections. Actor names additionally drop `:`, because an entry splits on the first `": "` and an actor carrying one reads back truncated. Attachment urls additionally percent-encode `)` so the link syntax cannot be closed early.
- **Multi-line body text stays inside its section.** Free-text written into a section (a description, say) and any caller-chosen section name MUST NOT be able to introduce a `## ` heading: tools MUST escape heading markers in that text, and MUST reject a section name that is not a single plain line. Otherwise a writer can splice a second `## Log` ahead of the real one, and since section-aware appends target the *first* matching heading, every later entry lands in the forged section: the append-only Log becomes attacker-chosen, and anything derived from it (such as a card's creator) reports whatever the forged entry says. `## Log` is never a valid target for a checklist item.
- Section-aware body edits (set/append section, checklist toggles, attachment removal) MUST ignore lines inside fenced code blocks: a literal `## ` or `- [ ]` inside a fence is content, not structure.
- **Same-tree concurrency.** git covers branch races (§8); two processes in one worktree are the tool's job. A mutating tool MUST serialize its load-mutate-write cycle against other processes (e.g. a short-lived `board.lock` file with stale-owner reaping), MUST allocate seq ids inside that critical section, and SHOULD write files crash-safely (temp file + rename). Lock files are derived state: never committed, safe to delete when their owner is gone.
- Preserve unknown card-frontmatter and `board.yaml` keys and all body content outside the section being edited.
- Watching and voting are idempotent set mutations. Boosts append and never edit history. A saved-filter or lane-subscription edit is a board mutation and follows the same locking/read-only rules as every other `board.yaml` rewrite.
- A hosted RSS/Atom or iCalendar URL MUST be an unguessable, revocable capability scoped to one member and project, optionally narrowed to one card, lane, or saved filter. Resolution MUST fail when the capability is revoked, the member is disabled/removed, or that member no longer reaches the project. Retrieval updates only coarse hosted access metadata, never board documents; repeated polling SHOULD NOT write that metadata more than once per bounded interval. RSS/Atom applies card/lane/filter scope before its bounded newest-first activity limit, so unrelated newer events cannot hide an older matching event. iCalendar is read-only and contains only matching cards with due dates. These pull feeds perform no outbound request; Slack may consume the RSS URL without a botflow Slack credential.
- Only bump `updated` on meaningful change.
- `prime`: every conforming CLI SHOULD offer a command that prints the board's shape, rules, ready work, and the tool's own usage, so an agent can be taught with one line in AGENTS.md.
- Derived stores (indexes, caches) MUST be rebuildable from files alone and MUST NOT be committed.
- **Board reshaping.** A tool that edits `board.yaml` over live cards MUST leave the board conformant: cards stranded by a removed lane or substate migrate to a surviving lane (same canonical state unless the operator chose a target), and every migration appends a Log line on the moved card.
- **Snapshot sync contract.** When a file-truth board syncs with a hosted copy, the repo documents are truth and sync is whole-board snapshot, last write wins. The hosted side is that snapshot **plus a manager overlay**: hosted-native children (project-reference cards the repo snapshot does not carry) survive a push rather than being severed. Both directions MUST validate the entire snapshot before persisting any of it (fatal findings: `yaml-error`, `frontmatter-missing`, `schema`, `dup-id`; unsafe or duplicate paths), and a pull that would remove local files SHOULD refuse over uncommitted changes without an explicit force. Applying a snapshot is a **validated, crash-safe apply**, not an atomic set-replacement: individual writes are crash-safe, an interruption leaves only valid documents, and re-running the sync converges. Sync MUST NOT follow symlinks: a push skips non-regular files when reading documents, and a pull MUST refuse when the board root or any write/delete target passes through a symlink.

### 12a. WIP, named blockers, buttons, and rules

WIP enforcement is evaluated only when a mutation enters a different lane and its
post-mutation card count would exceed that lane's limit. Leaving a lane and moving
between substates of the same lane remain possible. `allow` preserves the v0 behavior:
the mutation succeeds and reports a warning. `justify` requires a non-empty, sanitized
written reason and appends `wip justification for <lane>: <reason>` to the card Log.
`deny` rejects the mutation without a write. An explicit force may override `deny` only
with a written reason; hosted force remains owner/admin-only and logs
`wip override for <lane>: <reason>`. The rule applies to add, move, claim, close, buttons,
and bulk operations; import/migration and recurrence recovery remain convergent system
operations, preserve any resulting `wip-breach`, and do not fail on capacity.

A named-blocked card is physically immobile: ordinary move/claim and button operations
MUST refuse it until unblock. Close remains available as an explicit resolution, and a
force move may recover bad state with its normal audit trail. Blocking requires a
non-empty reason; selecting a blocker validates it against the board registry and writes
`blocked [<id>]: <reason>`. A second block while already blocked is rejected so duration
identity cannot change silently. Unblock clears both `blocked` and `blocker`.

Button execution resolves its complete target set, clones and validates every mutation,
then commits all or none. It uses the invoking actor and the normal operation logs,
WIP policy, label-group validation, and permissions. A board button over 100 matches is
rejected rather than partially applied. Buttons are data, not code: they cannot name a
URL, shell command, plugin, or arbitrary field.

After a successful primary `enter`, `close`, or `block` mutation, at most 16 matching
rules execute in definition order as part of the same atomic mutation. More than 16 is
an error and leaves the primary mutation unapplied. `label` adds idempotently and still
obeys scoped-label constraints; `unlabel` removes; `assign`/`delegate` sanitize the actor
value; `comment` appends to Comments. Every applied rule also appends a concise
`rule <id>: <action>` Log entry so file history alone explains the result. Rule actions
never trigger another rule, cannot transition a lane, create/close a card, or perform
network/file execution, and a failing action aborts the complete mutation.

## 13. Future (non-normative)

The card-frontmatter names `spent`, `relates`, and `weight` are reserved for future botflow semantics. Implementations
MUST preserve them as unknown keys today and SHOULD warn before assigning unrelated
local meanings to them.

Cross-repo/branch board references (`repo#branch` URLs), quorum `done_when`, per-card
`weight:` for leaf-weighted progress (today's progress is structural, §7), CRDT-grade
merge for same-card edits, signed Log entries.
