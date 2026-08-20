---
id: 058
title: Finish card-feature migrations docs and verification
lane: done
labels: [docs, test, security]
assignee: mac
priority: p0
deps: [057]
created: 2026-08-20
updated: 2026-08-20
---
## Log
- 2026-08-20 01:00 mac: created in todo
- 2026-08-20 05:17 mac: claimed, moved todo → doing
- 2026-08-20 05:17 mac: Phase 9 started: auditing migration and restore behavior for every new format/config field and manager overlay, checking CLI/MCP/viewer/UI parity against CARD-FEATURES.md, then running security, accessibility, fixture, upgrade, and end-to-end release verification.
- 2026-08-20 05:35 mac: Release hardening complete: company export v4 preserves validated active webhook/email configuration while resetting remapped delivery state; v1-v3 compatibility, malformed-v4 prevalidation, semantic rollback, and a persisted pre-integration ProjectDO upgrade are covered. Added due-date churn projection, operator docs, security/accessibility/parity review. Final evidence: node --test 239/239, both typechecks, real workerd E2E, and git diff --check pass.
- 2026-08-20 05:35 mac: closed: All card-feature phases are implemented, migrated, documented, security/accessibility reviewed, and fully verified; held locally for user review., moved doing → done
