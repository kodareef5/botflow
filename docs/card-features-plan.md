# Card feature implementation program

This is the implementation companion to the research in `CARD-FEATURES.md`. The
research appendix is evidence, not a request to clone every competing product. The
actionable proposals in its main report are the program scope, sequenced here by
format and subsystem dependency.

## Guardrails

- Files remain truth; SQLite, caches, metrics, feeds, and notification state are
  rebuildable projections or explicit manager overlays.
- Additive fields stay on `botflow: 0`; unknown data round-trips losslessly.
- An unsupported major or declared feature makes a board read-only to that reader.
- Atomic single-actor claim remains load-bearing. Accountability (`assignee`) and
  execution (`delegate`) become separate concepts; co-assignment does not replace it.
- No runtime dependencies. Network egress reuses the SSRF policy and is signed,
  bounded, observable, retryable, and revocable.
- Every format behavior begins in the spec and conformance fixtures, then reaches
  core, CLI/MCP, manager, viewer, tests, migration, and documentation.

## Delivery phases

1. **Compatibility foundation** — reserved names; lossless top-level, lane, and
   rollup extras; unknown-major refusal; `features:` declarations.
2. **Core semantics and metrics** — consistent log datetimes; stalled, age,
   time-in-lane, blocked, lead/cycle, throughput, and cumulative-flow derivation;
   `due`, `start`, `estimate`, recurrence, Evergreen, and human-owner/agent-delegate.
3. **Structured presentation** — description and local-viewer badge parity; due and
   aging signals; scoped label groups and colors; typed custom fields with per-field
   face flags; cover colors; unfinished-only and graceful badge degradation; summed
   estimates.
4. **Structure and operations** — checklist promotion; same- and cross-board typed
   relations/dependencies; resolved-blocker relation decay; duplicate merge; card
   templates; move/copy; quick-add; bulk actions; relationship visualization and
   cross-board handoff targets.
5. **Discovery and collaboration** — CLI/MCP/manager search and saved filters;
   watchers and lane subscriptions; mentions; voting and short-text boosts; scoped,
   revocable RSS/Atom and iCal feeds (which also provide the first Slack path).
6. **Scheduling and automation** — due reminders, recurring instances, snooze,
   lazy archive sweeps, named blockers with duration, WIP allow/justify/deny modes,
   safe card/board buttons, and bounded event rules.
7. **Views and analytics** — table, swimlane, calendar, timeline, metrics dashboard,
   arbitrary supported grouping axes, dependency strings, and manual Hill Chart
   uncertainty.
8. **Integrations and media** — hardened outbound webhooks and delivery history,
   provider-neutral email ingress/egress seams, and deterministic rich embeds including
   YouTube without weakening proxy or SSRF controls.
9. **Release hardening** — migrations, import/export compatibility, security and
   accessibility review, fixtures, CLI/MCP/UI parity, full tests, and review notes.

## Deliberate non-features

The report explicitly rejects stopwatch time tracking, co-assignees that undermine
claim, shared-identity mirror cards, and an always-written rank field whose only result
is merge noise. Slack OAuth is not a prerequisite for the feed-based Slack path;
calendar UI follows the interoperable iCal contract. These are design decisions, not
unfinished checklist items.
