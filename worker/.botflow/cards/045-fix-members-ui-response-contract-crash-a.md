---
id: 045
title: Fix members UI response-contract crash and auth noise
lane: done
labels: [bug, ui, auth]
assignee: codex
priority: p0
created: 2026-08-19
updated: 2026-08-19
---
## Log
- 2026-08-19 21:47 codex: created in todo
- 2026-08-19 21:47 codex: claimed, moved todo → doing
- 2026-08-19 21:49 codex: Reproduced the supplied TypeError in a focused UI test. /api/members returns flat Registry Identity rows (scopeKind/scopeId), while scopeLabel and memberFields incorrectly read the nested /api/org.me shape (scope.kind/scope.id). Updated both helpers to the member endpoint contract and covered org, space, project labels plus edit-form selection. The isolated /api/org 401 is the startup session rejection path, not the members crash.
- 2026-08-19 21:49 codex: closed: Aligned member-list rendering and edit helpers with /api/members' flat scopeKind/scopeId contract and added a regression reproducing the reported exception; confirmed the lone /api/org 401 is the separate invalid-session fallback.
