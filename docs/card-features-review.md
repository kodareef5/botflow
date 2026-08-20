# Card feature release review

This is the release record for the complete `CARD-FEATURES.md` program and the
hardening pass prompted by four independent reviews. The review unit is the local
commit range `origin/master..HEAD`; it remains intentionally unpushed for owner review.
The research appendix compares other products, but its explicit rejected ideas are not
silently treated as requirements.

## Independent-review disposition

Every reproducible defect from the Opus, Kimi, Grok, and Codex reviews is covered below.
Related observations are grouped where one invariant fixes several failure modes.

| Finding | Disposition | Regression evidence |
|---|---|---|
| Missing archive lane made a scheduled sweep throw and hot-loop alarms | Impossible sweeps now lint and plan inertly; hosted failures back off while the board remains readable | `invalid/archive-without-lane`, `test/automation.test.ts`, `test/cli.test.ts`, `test/mcp.test.ts`, `test/worker.test.ts` |
| Missing/deleted automation filters widened rules to every card | Declared-but-invalid filters remain distinct from no filter, fail closed, survive round-trip, and block referenced filter deletion | `invalid/bad-rule-filter`, `test/automation.test.ts` |
| Each filtered rule repeated full-board analysis and could observe earlier rule actions | One immutable post-primary snapshot, one analysis per event, and one query per distinct filter | `test/automation.test.ts` operation-count assertion |
| Invalid hand-written known fields disappeared on an unrelated edit | Raw invalid values are preserved; unrelated mutation is refused; an explicit correcting edit succeeds | `invalid/invalid-known-values`, `test/fields.test.ts`, CLI/worker coverage |
| Dependency-cycle members could appear ready or be claimed | Cycle membership and effective dependency state are shared by readiness and claimability, including hosted cross-project graphs | `test/relations.test.ts`, `test/security-core.test.ts`, `test/worker.test.ts` |
| Child-scoped writers could probe ancestor card state through references | Unauthorized ancestors are opaque provenance only; dependencies/relations fail closed without an existence oracle | `test/relations.test.ts`, `test/worker.test.ts` |
| Cross-board relations were advertised but not authorable | Link/unlink now spans filesystem, CLI, MCP, hosted API, and manager with target-first idempotent halves and descendant scope checks | `test/relations.test.ts`, `test/cli.test.ts`, `test/mcp.test.ts`, `test/worker.test.ts`, `test/ui.test.ts` |
| Transfers could land values invalid in the destination registry | Destination labels, blockers, and typed custom fields are validated before either half changes | `test/relations.test.ts`, worker transfer cases |
| Duplicate disposition and prose references were incomplete | Duplicate is derived/queryable/non-claimable; conservative whole-token same-board references exclude code, URLs, dates, logs, and self | `relations` fixture, `test/relations.test.ts`, viewer/UI tests |
| Retried close could log, rerun rules/integrations, or resurrect swept cards | Already-closed close is a semantic no-op; recurring creation and event enqueue happen once | `test/automation.test.ts`, `test/worker.test.ts` |
| Transferred reminders were not scheduled | Destination and source alarms are rescheduled for first receive and replay reuse | real workerd transfer/reminder coverage in `test/worker.test.ts` |
| Flow ignored sweep/transfer transitions and due edits with snooze suffixes | Anchored historical transition parsing includes both forms, rejects reason-text spoofing, and counts normalized due edits | `test/metrics.test.ts` |
| Polling reparsed logs and built unused 30-day series | One request-scoped flow projection per card; ordinary authenticated/public polls request `flow=0`; metrics views request the compatible full payload | 400-card/80-entry operation-count smoke test, `test/ui.test.ts`, real workerd coverage |
| Company restore accepted unusable password hashes, ignored collisions/failures, and could falsely claim rollback | Strict shared hash validation, complete remap preflight, checked restore plan, and one RegistryDO transaction preserve credentials/sessions on failure | `test/security-core.test.ts`, company before/after and v1-v4 cases in `test/worker.test.ts` |
| Project-id replacement corrupted prefixes or literal prose | Only parsed structured references and explicit reference tokens are remapped, with two-pass validation | `test/worker.test.ts` prefix/prose restore cases |
| Legacy RegistryDO migration swallowed arbitrary ALTER failures | Schema introspection drives additive changes; the real pre-column schema is upgraded without losing auth/shares | real legacy workerd test in `test/worker.test.ts` |
| IPv6 special-use targets escaped the SSRF denylist | Literal IPv4/IPv6 classification rejects non-global ranges and every redirect hop is revalidated | `test/security-core.test.ts`, `test/webhooks.test.ts`, `test/integration-snapshot.test.ts` |
| Webhook lease/prune behavior was unsafe under interleaving or long history | Batches are leased before network awaits, delivery ids survive recovery, and cutoff deletes are exercised beyond the cap | `test/delivery-queue.test.ts`, `test/worker.test.ts` |
| Public board polls could mutate cards and enqueue integrations | Public pages and feeds use projection-only reads; authenticated reads/alarms retain automation | `test/worker.test.ts` event/outbox invariants |
| Scoped feeds took the newest 100 events before applying scope and wrote access metadata on every poll | Scope precedes the bound; capability touches are coarsely throttled | `test/worker.test.ts` 105-event and repeated-poll cases |
| Company/member controls redrew settings, lost focus/drafts, and malformed scope data crashed the directory | Settings is an explicit view; org/member/theme updates patch stable regions and normalize old/current scope shapes | executable UI tests in `test/ui.test.ts` |
| Relation SVG and unconditional controls defeated morphing and stole focus | Overlay no longer participates in positional reconciliation; keyed controls preserve node identity | MiniDOM morph/focus tests in `test/ui.test.ts` |
| Add-card placement, filtered WIP, button errors, and several keyboard paths regressed | Add controls are lane footers visible on hover/focus; WIP uses the unfiltered population; structured errors and keyboard/dialog/tab/Hill paths are covered | `test/ui.test.ts`, `test/viewer.test.ts` |
| Project/integration activity was fixed-size and bot owners lacked a complete key lifecycle | Stable older/newer cursor pages cover project, webhook, and email history; owners can list, mint, rename, revoke, and atomically replace bot keys with one-time secret display | `test/ui.test.ts`, `test/worker.test.ts` |
| Root dogfood board rejected its documented `../worker` child | A conventional `<repo>/.botflow` is bounded by `<repo>`; bare boards remain bounded by themselves | `test/security-core.test.ts`, root and worker CLI lint |
| “Atomic batch” wording overstated filesystem crash guarantees | The spec now promises full prevalidation, one lock, and crash-safe per-file replacement—not a cross-file transaction; cross-board retries converge | `spec/SPEC.md` §12 and mutation tests |

## Requirements-to-test matrix

| Requirement area | Portable contract and fixtures | Core / CLI / MCP | Hosted / browser / migration |
|---|---|---|---|
| Version and compatibility | `botflow: 0`; feature declarations; unknown board/card keys retained; unsupported majors/features read-only | `test/fixtures.test.ts`, `test/editor.test.ts`, `test/pull.test.ts`, `test/security-core.test.ts` | worker snapshot/import compatibility cases |
| Scheduling and flow | ISO dates, due/start, estimates, reminders, recurrence, snooze, Evergreen, event-derived lane/block/lead/cycle/throughput/CDF | `card-features` and `automation` fixtures; `test/metrics.test.ts`; `test/automation.test.ts`; CLI/MCP reads | alarms, no-op replay, compact polling, metrics UI in worker/UI tests |
| Presentation | Structured description/checklists, label groups/colors, typed fields, covers, estimates, aging | `presentation` fixture; `test/fields.test.ts`; core JSON tests | manager/local viewer parity and cover-art tests |
| Relations and dependencies | Typed relations, conservative text refs, cycles, duplicate disposition, effective dependency state | `relations` fixture; `test/relations.test.ts`; CLI/MCP lifecycle | bounded hierarchy snapshots, scope-oracle tests, manager authoring |
| Templates and batch work | Template defaults, quick add, checklist promotion, duplicate merge, prevalidated bulk actions, transfer/copy | `test/relations.test.ts`; CLI/MCP parity | hosted transfer, retry, destination validation, reminder scheduling |
| Collaboration | Search grammar, saved filters, watchers, votes, boosts, mentions, subscriptions | `collaboration` fixture; `test/feeds.test.ts`; CLI/MCP tests | scoped capabilities, pagination, manager controls, membership revocation |
| Automation and WIP | WIP allow/justify/deny, named blockers, declarative buttons, bounded rules, safe archive sweeps | `automation` and invalid fixtures; `test/automation.test.ts`; CLI/MCP tests | alarms/backoff and owner-only force behavior in workerd tests |
| Alternate views | Kanban, table, grouped, swimlane, calendar, timeline, metrics, Hill, dependency connectors | core projection plus `test/viewer.test.ts` | UI source/DOM tests for every layout, keyboard paths, morph identity |
| Webhooks | frozen signed payload, allow/deny filters, redirect validation, leases, retries, circuit, replay, bounded history | `test/webhooks.test.ts`, `test/delivery-queue.test.ts` | real signed delivery/replay/cursor/prune/restore tests |
| Email | provider-neutral normalized ingress, hashed capabilities, dedupe, frozen outbox, leases/history | `test/email.test.ts`, snapshot tests | trusted-bridge auth, delivery lifecycle, cursor history, restore tests |
| Media | upload limits/types, capability serving, strict YouTube canonicalization, guarded unfurl/OG preview | `test/youtube.test.ts`, `test/security-core.test.ts` | R2 and preview/cover round trips in workerd/UI tests |
| Company backup | v1-v4 import, v4 credential-bearing export, structured id remap, all-or-none registry restore | strict security and integration snapshot tests | full before/after failure snapshots and real legacy upgrades |
| Operator lifecycle | project/integration cursors, member safety, bot keys, share/feed lifecycle | API contract tests | workerd authorization/audit tests and manager reachability tests |
| Accessibility | Text equivalents for state; non-pointer operations; dialog/tab semantics | local viewer keyboard tests | manager syntax plus executable MiniDOM focus, trap, and key tests |
| Performance | One automation analysis/event and one flow projection/card | deterministic operation counts and 400×80 smoke fixture | ordinary/public polling omits board series until metrics is selected |

## Compatibility, migration, and durability

- All portable additions remain additive `botflow: 0` syntax. Unsupported declared
  features block writes instead of being downgraded, and invalid known values are kept
  for repair rather than erased.
- Existing Durable Object class identities and the Cloudflare `v1` migration remain
  unchanged. New tables/columns are added by inspected, idempotent migrations.
- Company import accepts the earlier v1 demo, v2 project-key, and v3 member-era shapes.
  Pre-member project keys cannot be safely assigned to a person and are dropped with an
  explicit audit entry. v3 extension-shaped integration data remains untrusted/ignored.
- Export v4 intentionally contains active credential material needed for restoration:
  password hashes, API/share/feed token hashes, webhook signing secrets, and inbound
  email token hashes. Operators must protect exports accordingly. Health/history,
  dedupe rows, leases, and queued deliveries are reset so stale work cannot escape.
- R2 export remains a manifest, not a binary backup. Attachment objects require a
  separate operator backup.
- Local multi-card changes prevalidate all members and hold one worktree lock. Each
  file uses crash-safe replacement, but a process or machine failure between file
  renames is not claimed to be a cross-file transaction. Hosted registry/project
  changes use SQLite transactions where documented; cross-project halves are
  target-first and retry-convergent.

## Security and accepted operational decisions

- Credential-bound identity controls audit actors. Only owners administer company
  exports, integrations, shares, members, and other bots' API keys. Minted/replacement
  secrets are displayed once; stored listings expose metadata only.
- Any current member may mint their own scoped, revocable feed. Disabling/removing the
  member or removing their project reach immediately invalidates it.
- `EMAIL_BRIDGE_USERNAME` identifies the deliberately trusted delivery bot. Other
  write-capable bots cannot lease email outbox work merely because they can edit cards.
- Webhook delivery is at-least-once. The stable `X-Botflow-Delivery` id is the receiver's
  deduplication key; crash recovery may legitimately redeliver the same id.
- Production webhooks require HTTPS, classify literal special-use addresses, and
  revalidate redirects. Self-hosted operators that permit private egress remain
  responsible for resolver/connection pinning against DNS rebinding.
- Explicit cross-board references in prose retain bracket syntax. Bare-id inference is
  same-board and deliberately conservative to avoid turning dates, URLs, logs, or code
  into relations.
- Public page/feed capabilities are observational: they may update coarse last-viewed
  metadata at a throttled interval, but never cards, project events, automation, or
  integration queues.

## Accessibility review

Cards, project rows, lane footers, table rows, timeline bars, tabs, and Hill controls
are keyboard reachable with visible focus. Dialogs move and trap focus, close on Escape,
and restore focus to their opener. Due, blocked, aging, progress, and flow values expose
text/count semantics in addition to color. Read-only viewer controls use button/dialog/
tab roles rather than pointer-only containers. The exact shipped scripts are syntax
checked and the focus-critical paths run in the repository's minimal DOM harness.

## Deliberate non-features

Stopwatch tracking duplicates the event log; multiple assignees weaken the single-winner
claim primitive; shared-identity mirror cards obscure file ownership; and a permanently
written rank field creates merge noise. Bounded free-text boosts cover lightweight
reaction needs without an emoji taxonomy. Repository undo remains Git, Slack can consume
scoped RSS without a botflow OAuth subsystem, and iCalendar remains read-only. These are
documented scope choices from the research, not unfinished implementation.

## Local commit map

| Commit | Reviewable outcome |
|---|---|
| `45f3b41` | Independent-review plan and dogfood tracking |
| `fc24dfb` | Spec-first invariants, invalid fixtures, and initially failing regressions |
| `a790b3a` | Core automation, dependency, mutation, close-replay, and metric semantics |
| `db68659` | Transactional company restore, strict hashes, remapping, and legacy migration |
| `08d219e` | Hosted scheduling, scope, feed, webhook/email, public-read, and SSRF safety |
| `1796989` | Settings/member stability, morphing, keyboard, and viewer accessibility |
| `75a7479` | Cursor histories, full bot-key lifecycle, and cross-board relation authoring |
| this commit | Projection/query performance, workspace-path compatibility, honest durability text, and this release record |

## Release gate

The 2026-08-20 local release gate passed after the final implementation edits:

- `node --test`: 264/264 tests passed in 21.55 seconds;
- `node --run typecheck`: passed;
- `npx tsc --noEmit -p worker`: passed;
- root and worker `botflow lint`: no findings;
- `git diff --check`: passed.

The final commit is followed by aggregate and per-commit whitespace checks plus a clean
staged-scope audit. User-owned `.gitignore`, `coverart.patch`, and the unrelated scoped-
admin planning files are excluded. No remote push is part of this gate.
