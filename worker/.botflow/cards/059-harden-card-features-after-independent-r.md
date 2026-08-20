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
