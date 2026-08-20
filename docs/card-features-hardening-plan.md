# CARD-FEATURES independent-review hardening plan

Status: in progress locally on `worker/.botflow` card `059`.

Base: `1d6e255` plus the nine unpushed CARD-FEATURES commits. This program remains
local until the user reviews the finished commit series. The user-owned `.gitignore`
change and untracked `coverart.patch` are outside the program and must remain untouched.

## Outcome

The branch is ready for user review only when all four independent-review reports have
an explicit disposition and every accepted defect has a regression test. A green
existing suite is necessary but not sufficient. The handoff must include:

- a severity-ordered change summary tied to local commits;
- exact behavior and compatibility decisions in `spec/SPEC.md`;
- conformance fixtures for portable format behavior;
- executable coverage for core, CLI, MCP, worker, migration, and browser-script paths;
- root and worker TypeScript checks, `node --test`, `git diff --check`, and targeted
  performance smoke measurements;
- a clean implementation diff apart from `.gitignore` and `coverart.patch`;
- no remote push.

## Guardrails

1. **Spec first.** Portable behavior changes begin in the spec and fixtures before
   implementation. Hosted-only security and UI contracts begin in worker tests.
2. **Fail closed without eating data.** Invalid known values and broken references may
   render with findings, but automated or unrelated mutations must neither execute an
   unsafe interpretation nor silently erase the original text.
3. **One semantic core.** Ready/claim, relations, automation, scheduling, metrics, and
   query behavior must not diverge across local CLI, MCP, hosted APIs, or viewers.
4. **Read-only means side-effect free.** Public page/feed capability reads may update
   coarse access metadata, but may not mutate cards or enqueue integrations.
5. **Credential restore is a transaction.** A rejected company import must leave
   members, password hashes, sessions, keys, shares, org metadata, spaces, and project
   storage observably unchanged, apart from one failure audit event.
6. **No new runtime dependencies.** Tests and browser harnesses use Node/workerd and
   repository-owned minimal DOM utilities.
7. **Compatibility stays additive.** `botflow: 0`, unknown-data round trips, and
   unsupported-major/feature read-only behavior remain intact.

## Workstream A — safe configuration and mutation

### A1. Archive automation must be total

Problem: `archive_done_after` is lint-legal without an archive-canonical lane. A due
sweep then throws on CLI/MCP/hosted reads and causes the Durable Object alarm to re-arm
at `now` forever.

Plan:

- add a schema finding when the policy has no archive lane;
- make the planner omit impossible sweeps, so read paths never throw even on an
  already-invalid hand-authored board;
- make alarm rescheduling back off after an automation failure rather than re-arm an
  unchanged past-due action immediately;
- ensure other reminder/snooze work still drains if one action is inapplicable.

Acceptance:

- conformance fixture for `archive_done_after` without an archive lane;
- CLI `board`, `prime`, `ready`, and `query`, plus MCP view, remain readable;
- worker board reads and alarms do not throw or hot-loop;
- adding an archive lane makes the previously due sweep run exactly once.

### A2. Saved-filter references fail closed

Problem: a missing rule filter becomes `null`, which means “all cards”; deleting the
filter therefore widens the rule. Board buttons and invalid saved-filter queries have
related inconsistent error handling.

Plan:

- distinguish “no filter was declared” from “a declared filter is invalid” while
  parsing; invalid rules/buttons remain preserved as raw configuration but inert;
- refuse `filter rm` while a rule, button, feed, or other persisted capability depends
  on it, returning the referencing ids;
- surface structured button/query errors in CLI, MCP, and manager instead of stack
  traces, HTTP 500s, regex-matched prose, or silent promise rejections;
- avoid a full board analysis per filtered rule by preparing one analysis/query cache
  per primary mutation.

Acceptance:

- a typo or deleted filter never fires a rule globally and survives round-trip for
  manual repair;
- every removal surface enforces the same referential check;
- invalid queries yield consistent typed errors;
- a performance test demonstrates one analysis per event, not one per rule.

### A3. Invalid known card fields cannot disappear

Problem: invalid hand-authored `due`, `estimate`, `hill`, cover color, reminder, and
other known values are normalized to `null` and silently omitted by the next unrelated
mutation.

Plan:

- define a mutation-safety gate for error-bearing source documents;
- preserve raw invalid known values in the parsed document representation so a
  read/emit cycle remains lossless;
- refuse an unrelated mutation of the affected card with a concise repair message;
- allow an explicit edit that replaces the invalid value with a valid one;
- audit older known fields (`priority`, ids, lane/substate, relation values) under the
  same rule rather than protecting only the new fields.

Acceptance:

- fixtures round-trip each invalid known value byte-for-semantics;
- comment/watch/vote/automation cannot delete it;
- a correcting edit succeeds and removes the finding;
- CLI and hosted responses identify the bad field.

## Workstream B — dependency and relation semantics

### B1. Cycles are never ready or claimable

Problem: readiness is computed before cycle detection and claimability performs its own
immediate-dependency check. Some cycle members can therefore appear ready and be
claimed. Hosted cross-project cycles are not assembled, and board-card dependencies use
different local/effective state rules between readiness and claim.

Plan:

- compute dependency strongly connected components before readiness;
- put cycle membership and resolved dependency state in shared analysis data consumed
  by both readiness and claimability;
- settle the spec on effective canonical state for board-card dependencies and apply it
  consistently;
- add a bounded hosted dependency-graph snapshot RPC that can detect ancestor/
  descendant cross-project cycles without recursive state calls or unrelated scope;
- make force remain the only explicit owner override and audit it.

Acceptance:

- mixed-state two-card and long cycles are non-ready and non-claimable;
- local, MCP, and hosted results match;
- cross-project cycles are reported once and do not recurse indefinitely;
- rolled-up board-card dependencies cannot produce ready/claim disagreement.

### B2. Cross-board authorization and authoring

Problem: ancestor reference resolution can reveal card existence/state to a writer
scoped only to a child. Conversely, supported link operations are same-board even
though cross-board typed relations are advertised.

Plan:

- permit ancestor `copied-from` provenance without exposing canonical state; reject
  ancestor dependencies and arbitrary typed relations from narrower scopes;
- add supported cross-board link/unlink operations for descendant targets in the
  filesystem, CLI, MCP, hosted API, and manager, using target-first idempotent halves;
- validate labels, blocker ids, and typed custom-field values against the destination
  before a transfer is committed;
- reuse the same bounded hierarchy/scope checks as transfer and dependency resolution.

Acceptance:

- a child-scoped credential cannot probe an ancestor card id or state;
- authorized cross-board relations can be created and removed from every mutation
  surface, with inverse relations and retry convergence;
- incompatible transferred cards fail before either side changes.

### B3. Text references and duplicate disposition

Problem: the requested auto-relation behavior accepts only `[[042]]`, not an
unambiguous bare card-id mention. Duplicate handling archives and links a card but does
not expose duplicate as a first-class disposition.

Plan:

- derive auto-related edges from whole-token known card ids in Description and Comments,
  excluding Log, fenced/inline code, URLs, dates, and the card's own id; retain
  `[[...]]` for explicit cross-board references;
- expose duplicate disposition (`duplicateOf`) in analysis/JSON/query/viewer semantics,
  exclude duplicates from ready work, and keep typed relations as the lossless storage
  and provenance mechanism;
- ensure merge transfers attachments/checklists/comments according to the spec and
  does not lose unknown data.

Acceptance:

- fixture coverage for true and false bare-id matches;
- derived edges never rewrite prose merely by viewing it;
- duplicate cards render/query as duplicates and cannot be claimed as ordinary work.

## Workstream C — scheduling, replay, and metrics

### C1. Replay-safe close and transfer scheduling

Problem: replaying close suppresses only a second recurring successor; it still appends
logs, reruns rules, emits events/webhooks/email, and can move an archived source back to
done. A received transferred card does not schedule its reminders/snooze alarm.

Plan:

- make an already-closed close a semantic no-op unless an explicit owner force action
  requests a state change;
- return `changed`/`created` metadata through core, CLI, MCP, and worker so no-op retries
  emit no event or integration work;
- schedule destination alarms after first receive and idempotent reuse, and reschedule
  the source after completion;
- test retry after timeout, after sweep, and after partial transfer convergence.

Acceptance:

- repeated close has identical files, events, rules, webhook/email rows, and lane;
- recurrence still creates exactly one successor;
- a transferred reminder fires on time without a later board read or mutation.

### C2. Trustworthy flow metrics

Problem: transition replay ignores `swept` and transfer-move log forms, reason text can
spoof a transition, and due churn misses edits carrying `(woke snooze)`.

Plan:

- specify and emit a consistent, anchored set of transition log forms for move,
  migrate, sweep, claim, close, and transfer;
- recognize historical forms for backward compatibility while matching only the
  mutation text prefix, never arbitrary reason text;
- include sweep and transfer transitions in lane time and cumulative flow;
- normalize the snooze-wake suffix before extracting edited fields;
- decide that `snooze expired` is system bookkeeping and does not reset human activity
  aging; clear inherited Hill position on a recurring successor.

Acceptance:

- cumulative flow and lane time place swept/transferred cards in archive;
- adversarial close/block reasons cannot forge moves;
- due churn counts snooze-waking edits;
- conformance fixtures pin throughput, cumulative flow, and lane-time outputs.

### C3. Projection performance

Problem: standard three-second board polling repeatedly parses every log for per-card
and board metrics; filtered automation can repeat full analysis per rule.

Plan:

- parse each card's flow events once per projection and reuse them for card and board
  metrics;
- separate expensive board-series data from the ordinary board payload or request it
  only for metrics views while preserving API compatibility;
- cache rule-query analysis within one mutation;
- add deterministic performance smoke tests with generous non-flaky ceilings and
  operation-count assertions.

Acceptance:

- the 400-card/80-log projection no longer repeats the same parse/analysis work;
- normal board polling does not build unused 30-day cumulative series;
- output remains byte-for-semantics compatible when metrics are requested.

## Workstream D — import, migration, and restore integrity

### D1. Fully prevalidated credential bundles

Problem: import accepts password hashes authentication rejects; restore results and
`INSERT OR IGNORE` collisions are ignored; missing remapped scopes can silently drop
members/keys; rollback does not restore credentials or sessions.

Plan:

- centralize strict stored-password parsing (iteration bounds, salt length/hex, hash
  length) and reuse it in authentication, payload validation, and restore;
- construct and validate the complete remapped member/key/share plan before changing
  any registry row; a missing scope is an error, never coerced to org/null;
- preflight username/hash/token/id collisions and define exact replace-versus-reject
  behavior;
- apply org metadata, members, session revocation, keys, and shares in one RegistryDO
  SQLite transaction after project trees and integrations have staged successfully;
- check every restore result; on failure compensate staged spaces/project storage and
  leave the original registry transaction untouched;
- make audit text report actual counts, not payload counts.

Acceptance:

- zero/huge iterations, malformed salts, missing scopes, duplicate tokens/hashes, and
  restore failures make no observable credential/session change;
- sole-owner demotion/disable is rejected before mutation;
- valid v1–v4 imports and same-instance restore retain existing tokens;
- failure tests compare full before/after registry snapshots.

### D2. Reference-aware project-id remapping

Problem: global split/join replacement corrupts prefix ids and rewrites literal prose,
logs, URLs, and titles.

Plan:

- parse imported documents first and rewrite only structured board paths, dependencies,
  typed relation targets, and recognized explicit text-reference tokens;
- apply longest-id matching only as a compatibility fallback for historical explicit
  tokens, never arbitrary substrings;
- serialize with unknown-data preservation and validate the remapped result before
  importing any project.

Acceptance:

- ids `a` and `ab` remap correctly regardless of map iteration order;
- prose and URLs containing `project:a` remain unchanged unless they are recognized
  references;
- all remapped refs resolve after restore.

### D3. Real legacy RegistryDO migration

Plan:

- seed the actual pre-column `shares` table and existing member/key/session data;
- activate current RegistryDO code and prove additive columns, values, and indexes;
- replace catch-all `ALTER TABLE` swallowing with duplicate-column-specific handling or
  explicit `PRAGMA table_info` checks;
- retain the existing ProjectDO upgrade test.

## Workstream E — network and integration safety

### E1. IPv6 and redirect SSRF boundary

Problem: multicast, site-local, IPv4-compatible, and other non-global IPv6 literals can
pass the current denylist.

Plan:

- classify literal IPv6 against non-global/special-use ranges, including multicast,
  site-local, unspecified/loopback, link/unique-local, mapped/compatible private IPv4,
  documentation, discard-only, and benchmarking ranges;
- keep redirect-hop revalidation and production HTTPS requirements;
- add canonical/compressed/mixed-form vectors for every range.

### E2. Webhook/email delivery durability

Plan:

- verify webhook leasing under interleaved Durable Object requests; atomically claim a
  bounded batch before any network await and preserve one stable delivery id;
- add crash-recovery and duplicate-observation tests and retain the documented
  at-least-once receiver contract;
- replace same-table history-prune SQL with a tested cutoff/delete form if workerd does
  not guarantee the current query;
- keep email dedupe/leases, but explicitly designate or document the trusted bridge
  identity instead of implying every write bot is equally safe;
- add UI pagination for email outbox history.

### E3. Public capabilities and feeds

Problem: public board polls run automation and can archive cards or enqueue integrations;
scoped feeds filter only after taking the latest 100 project events; every capability
read writes the global registry.

Plan:

- split board materialization from automation and skip automation for public page/feed
  reads; authenticated reads and alarms retain the deterministic pass;
- query/filter scoped activity before applying the limit and add stable cursors;
- throttle `last_viewed` writes to a coarse interval;
- explicitly document that any current member may mint their own revocable feed and
  that membership loss revokes it.

Acceptance:

- repeated unauthenticated polls do not change cards/events/outbox/delivery tables;
- a scoped feed still returns older matching events after 100 unrelated events;
- hot feed polling does not write RegistryDO on every request.

## Workstream F — manager and viewer interaction integrity

### F1. Settings state and member operations

Problem: settings reuses `VIEW === 'board'`; member mutations call `reloadOrg`, which
requests `::settings` as a project and dereferences a missing `#view`. Full settings
rerenders lose company drafts and focus.

Plan:

- represent settings as an explicit view state, and make org refresh independent from
  board refresh;
- update member tables/tree/header in place after member operations;
- update theme controls in place after save rather than calling `renderSettings`;
- preserve company-name draft, selection, scroll, active modal, and focus across any
  legitimate refresh;
- recheck `/api/org` 401 handling and normalize both old nested and current flat scope
  shapes defensively so one malformed member cannot prevent the list from rendering.

Acceptance:

- clicking/focusing company and member controls causes no content redraw;
- member create/edit/delete succeeds without an invalid project request; modal and
  underlying focus behavior are deterministic;
- stale or legacy member scope data renders a safe fallback instead of throwing.

### F2. Board morphing and controls

Problem: the imperatively prepended relation SVG shifts positional reconciliation and
forces full column replacement. View controls and board buttons also replace
`innerHTML` unconditionally on changed polls.

Plan:

- make the relation overlay a keyed/rendered child or explicitly exclude it from
  reconciliation without changing column positions;
- signature-guard view-control and button updates, preserving focused elements;
- keep lane “add card” controls as hover/focus-visible footers at the bottom;
- compute WIP badges from the unfiltered lane population while search filters cards;
- catch and toast board-button failures using structured server error codes.

Acceptance:

- MiniDOM tests retain node identity, focus, and scroll with/without relation SVG;
- active select/button focus survives background changes;
- WIP never changes merely because search is active;
- add-card footers remain keyboard reachable and visually appear on lane hover/focus.

### F3. Keyboard and accessibility parity

Plan:

- ensure checklist promote key handling ignores its checkbox-row ancestor;
- queue Hill keyboard increments against a pending value and coalesce network writes;
- add visible table-row focus styling;
- give local-viewer card/table activators appropriate button semantics and accessible
  names; make drawers real dialogs with focus entry, trap, Escape, and restoration;
- implement arrow-key tablist behavior, meaningful chart roles/descriptions, and
  non-interactive semantics for read-only Hill values;
- avoid card-level accessible names that hide descendant badge text.

Acceptance:

- executable DOM tests cover focus, keyboard activation, modal trapping, and rapid
  Hill increments; static source-substring assertions are supplementary only.

## Workstream G — operator surfaces and honest scope

### G1. Activity pagination

- retain and test company-audit cursor pagination;
- add cursor pagination to project events and the activity tab instead of `limit=200`;
- add older/newer controls with stable ordering and no duplicates under concurrent
  event insertion;
- paginate webhook deliveries and email outbox consistently.

### G2. Bot-key lifecycle

- retain owner-side key creation for a bot without bot login;
- add owner-only per-bot key listing with label, created, last-used, and revoked state;
- allow rename, individual revoke, and replacement; never reveal token material after
  creation;
- audit every lifecycle action and preserve self-service current-user key behavior.

### G3. Honest atomicity and requirements traceability

- either add a recovery journal for filesystem multi-card mutations or narrow
  “atomic batch” documentation to prevalidated, per-file crash-safe writes; do not claim
  cross-file crash atomicity without fault-injection proof;
- keep the authoritative requirement-to-test matrix in tracked docs so reviewers do not
  need the ignored local `CARD-FEATURES.md`; do not modify `.gitignore` or force-add the
  user's research file;
- document accepted decisions: feed minting by any current member, credential-bearing
  exports, provider-bridge trust, DNS-rebinding egress responsibility, and bracketed
  syntax for explicit cross-board text references.

### G4. Dogfood-board compatibility

The root card `008` points from `.botflow` to `../worker`, which the current escape check
rejects even though it resolves within the repository and is the documented roll-up
board. Define the workspace boundary correctly, preserve protection against leaving the
repository, and make both dogfood boards lint clean.

## Test matrix

| Layer | Required additions |
|---|---|
| Spec/fixtures | archive-without-lane, bad rule filter, invalid-known-value round trip, mixed dependency cycles, sweep/transfer metrics, bare references, duplicate disposition |
| Core unit | mutation gate, filter removal references, cached rule analysis, recurrence replay, transition spoofing, due churn, target registry validation |
| CLI | all read paths on invalid automation, repair of invalid card data, cross-board links, no-op close, project-event pagination contracts |
| MCP | parity for filter, claim, relation, transfer, and structured errors |
| Worker unit | strict hash validation, reference remapping, IPv6 vectors, scoped feed queries, public-read side effects, bot-key authorization |
| Real workerd | company-import before/after snapshots, legacy RegistryDO upgrade, alarm scheduling/backoff, webhook interleaving/prune, transfer reminder alarm |
| Browser script | settings focus/drafts, member modal/actions, morph identity with SVG, controls, checklist promote, Hill repeats, WIP/search, activity/outbox pagination |
| Accessibility | manager and local-viewer keyboard paths, dialog focus, tablist keys, focus-visible rules, meaningful read-only semantics |
| Performance | one flow parse per card, one rule analysis per mutation, ordinary poll omits unused board series |

## Planned local commit series

Commits stay cohesive and independently testable; no commit includes `.gitignore` or
`coverart.patch`.

1. **Plan independent-review hardening** — this plan and dogfood card.
2. **Specify hardening invariants and conformance cases** — normative decisions and
   fixtures/tests that fail against `1d6e255`.
3. **Harden core automation, dependency, mutation, and metrics semantics** — A, B1/B3,
   and C core behavior.
4. **Make company restore and migrations failure-safe** — D.
5. **Harden hosted scheduling, scopes, feeds, and integrations** — B2, C1 worker side,
   and E.
6. **Preserve manager and viewer interaction state** — F plus executable UI coverage.
7. **Complete activity, bot-key, and relation operator surfaces** — G1/G2 and the
   supported cross-board authoring portions of B2.
8. **Finish release evidence and documentation** — performance checks, accepted-risk
   decisions, traceability, dogfood lint, final review report, and full gate.

Commit boundaries may split when a migration or fixture needs an isolated review, but
they will not be collapsed into one opaque change.

## Final review gate

Before handoff:

1. run every targeted regression during its workstream;
2. run `node --test` from the repository root;
3. run `node --run typecheck`;
4. run `npx tsc --noEmit -p worker`;
5. run `git diff --check origin/master...HEAD` and per-commit `git show --check`;
6. run root and worker `botflow lint`;
7. verify the only uncommitted paths are the user's `.gitignore` and
   `coverart.patch`;
8. inspect the full `origin/master...HEAD` diff and update the release review honestly;
9. obtain a fresh independent read-only review if requested;
10. stop before any remote push and present the local commits to the user.
