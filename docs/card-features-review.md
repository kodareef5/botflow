# Card feature release review

This review closes the actionable program distilled from `CARD-FEATURES.md`. The
research appendix surveys many products; it is not interpreted as a request to clone
every competitor quirk. The main report's recommendations are implemented, while its
explicit rejections remain deliberate non-features.

## Coverage

| Area | Delivered contract | Principal verification |
|---|---|---|
| Compatibility | Reserved names, lossless unknown board/card data, feature declarations, and read-only handling for unsupported majors/features | `test/fixtures.test.ts`, `test/editor.test.ts`, `test/pull.test.ts` |
| Time and flow | ISO mutation logs; idle, lane, blocked, lead/cycle, due-date churn, throughput, cumulative-flow, due, start, estimate, reminders, recurrence, snooze, and Evergreen | `test/metrics.test.ts`, `test/automation.test.ts`, `card-features` fixture |
| Presentation | Description/checklist previews, badge parity, scoped labels/colors, typed custom fields, cover colors, estimate rollups, and aging signals | `test/fields.test.ts`, `test/viewer.test.ts`, `test/ui.test.ts` |
| Structure | Checklist promotion, typed/cross-board relations and dependencies, duplicate merge, templates, quick add, atomic batch actions, move/copy, and nested-project handoff targets | `test/relations.test.ts`, CLI/MCP/Worker tests |
| Collaboration | Search language and saved filters, watchers, lane subscriptions, mentions, votes, boosts, and scoped RSS/Atom/iCal capabilities | `test/feeds.test.ts`, CLI/MCP/Worker tests, `collaboration` fixture |
| Automation | Bounded alarm passes, lazy archive sweeps, WIP modes, named blockers, declarative buttons, and bounded event rules | `test/automation.test.ts`, Worker alarm coverage |
| Views | Kanban, table, swimlane, calendar, timeline, arbitrary supported grouping, metrics, dependency strings, and manual Hill Charts | `test/ui.test.ts`, `test/viewer.test.ts`, `test/metrics.test.ts` |
| Integrations/media | Signed filtered webhooks, retry/circuit/replay history, provider-neutral email ingress/outbox, strict deterministic YouTube art, guarded OG proxying | `test/integration-snapshot.test.ts`, `test/webhooks.test.ts`, `test/email.test.ts`, security-core and real Worker tests |

## Format and surface parity

Format-backed behavior begins in `spec/SPEC.md` and the `card-features`,
`presentation`, `relations`, `collaboration`, and `automation` conformance fixtures.
The same data then reaches the core JSON projection, local CLI, MCP tools, hosted API,
manager, and read-only viewer. Mutation-only actions appear in CLI/MCP/hosted surfaces;
read-only views appear in both manager and local viewer. Hosted credentials, queues,
shares, and feeds remain manager overlays and intentionally do not enter repository
card files.

## Upgrade and restore review

- All card and board additions remain additive `botflow: 0` syntax. Unknown fields and
  nested configuration extras round-trip; an unknown major or unsupported declared
  feature blocks mutation instead of being silently downgraded.
- Existing `RegistryDO` and `ProjectDO` class identities and the Cloudflare `v1`
  migration remain unchanged. New integration tables use `CREATE TABLE IF NOT EXISTS`
  when an existing project object next activates; existing cards and events are not
  rewritten or deleted.
- Company imports continue to accept v1 demo data, v2 board backups, and v3 member-era
  backups. Pre-member project-keyed credentials cannot be safely re-homed and are
  dropped with an explicit audit entry; v3 extension-shaped integration data is ignored.
- Company export v4 validates and restores active webhook/email configuration. Project
  ids and references are remapped. Signing secrets and inbound token hashes survive;
  webhook health/history, inbound dedupe, and email outbox/history/leases reset so no
  frozen old-project event can escape after restore.
- R2 exports remain manifests, not binary backups. Operators must back up attachment
  bytes separately.

## Security review

- Authenticated actor identity is credential-bound. Owners alone can view or mutate
  integration configuration and company exports. A scoped write-capable bot may lease
  email outbox work but cannot read webhook secrets or route configuration.
- Inbound email tokens are random bearer capabilities stored only by SHA-256 hash, are
  fixed to one create/comment authority, rate-limited, normalized, and deduplicated.
- Webhooks sign the exact frozen body, keep a stable automatic-delivery id, revalidate
  every redirect hop, require HTTPS in production, bound attempts/history, and isolate
  failing endpoints with a circuit breaker.
- Uploads and unfurled art retain content-type, size, proxy, and CSP protections. Strict
  official YouTube URL parsing does not weaken the SSRF boundary.
- Remaining deployment responsibilities are explicit: self-hosted LAN egress must
  defend DNS rebinding, provider bridges must authenticate their provider, exports must
  be protected as credentials, and R2 bytes need their own backup.

## Accessibility review

- Cards, project rows, lane footers, table rows, timeline bars, tabs, and Hill controls
  are keyboard reachable; focus-visible styling is shared across visual themes.
- Modal overlays expose dialog semantics, move and trap focus, close on Escape, and
  restore focus to their opener. Form controls use labels or explicit accessible names;
  search status uses a polite live region.
- Due/blocked/aging/flow states carry text, symbols, counts, or accessible labels in
  addition to color. Drag-and-drop actions have keyboard move alternatives.
- The manager's accessibility invariants are syntax/static regression tested, and the
  local viewer exposes the same structured values without requiring pointer input.

## Deliberate non-features

Stopwatch time tracking duplicates the event log, multiple assignees undermine atomic
claim, shared-identity mirror cards obscure file ownership, and a permanently written
rank field creates merge noise. Bounded free-text boosts cover the useful reaction case
without an emoji taxonomy, and repository-side undo remains Git rather than an opaque
second history model in the manager. Slack can consume the scoped RSS capability without
an OAuth subsystem; iCal is read-only rather than a second mutable source of truth.
These are scope decisions from the report, not unfinished work.

## Release gate

The 2026-08-20 local release gate passed:

- `node --test`: 239/239 tests;
- `node --run typecheck`: passed;
- `npx tsc --noEmit -p worker`: passed;
- `git diff --check`: passed.

The suite includes every conformance fixture, CLI/MCP parity, browser-script syntax and
accessibility invariants, v1–v4 company imports, malformed-v4 prevalidation and rollback,
a persisted pre-integration `ProjectDO` upgrade, and real workerd round trips for auth,
scheduling, media, webhook signing/replay/circuits, email dedupe/leases, export/restore,
and deletion. No remote push is part of this gate.
