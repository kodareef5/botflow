---
id: 025
title: Review Claude recent changes
lane: done
labels: [review]
assignee: codex
priority: p1
created: 2026-08-19
updated: 2026-08-19
---
## Log
- 2026-08-19 15:37 codex: created in todo
- 2026-08-19 15:37 codex: claimed, moved todo → doing
- 2026-08-19 15:38 codex: Identified 1,489-line uncommitted members/auth/UI change set; began source review and full verification.
- 2026-08-19 15:46 codex: Review confirmed recovery can create an owner without an org (500 thereafter), empty-password recovery succeeds but cannot log in, legacy v2 exports are rejected, org-wide write can create root projects, and deleted scopes do not fully revoke credentials.
- 2026-08-19 15:47 codex: closed: Reviewed Claude member/auth/UI changes; full suite and typechecks pass, with actionable recovery, compatibility, authorization, revocation, attribution, and UI refresh findings.
