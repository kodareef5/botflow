---
id: 059
title: Harden CARD-FEATURES after independent review
lane: doing
assignee: codex
priority: p0
created: 2026-08-20
updated: 2026-08-20
---
## Log
- 2026-08-20 11:13 codex: created in todo
- 2026-08-20 11:13 codex: claimed, moved todo → doing
- 2026-08-20 11:17 codex: Mapped all four reviewer reports and the original UI/operator requests into docs/card-features-hardening-plan.md, with explicit invariants, acceptance tests, and an eight-commit local delivery sequence.
- 2026-08-20 11:39 codex: Core hardening complete: fail-closed rules, safe archive scheduling, cycle/effective-state claims, idempotent close, lossless invalid fields, and transition metrics. Full gate: 245 tests and both typechecks pass.
- 2026-08-20 11:54 codex: Company restore hardening complete: strict shared password-hash validation; two-pass exact structured project-reference remapping; atomic RegistryDO restore for org settings, members, sessions, API keys, shares, and audits; explicit additive legacy share migration; rollback and real upgrade coverage. Worker integration tests 4/4 and both TypeScript checks pass.
- 2026-08-20 12:17 codex: Hosted safety tranche complete: public page/feed reads are projection-only; alarm failures back off; transferred reminders schedule on both halves; ancestor refs are state-opaque/fail-closed; scoped feeds filter before their bound; capability view touches are throttled; webhook batches lease atomically before await with stable crash recovery; terminal history uses tested cutoffs; email bridge bot identity is explicit; IPv4/IPv6 special-use SSRF vectors expanded. Full gate: 249/249 tests and both TypeScript checks pass.
- 2026-08-20 12:36 codex: Interaction tranche complete: explicit settings view prevents fake-project refreshes; member scopes normalize safely; relation overlay and board controls preserve node identity; Hill/checklist/tab/dialog keyboard paths hardened; standalone viewer dialog/a11y parity added. Full suite 257/257 and both TypeScript checks pass before commit.
- 2026-08-20 12:57 mac: Operator tranche complete: project activity, webhook delivery, and email outbox histories use stable older/newer cursor pages; owners have full one-time-secret bot-key lifecycle with atomic replacement; cross-board relation link/unlink is available through filesystem, CLI, MCP, hosted API, and manager with target-first retry convergence and scope-oracle protection. Full suite 260/260 and both TypeScript checks pass.
