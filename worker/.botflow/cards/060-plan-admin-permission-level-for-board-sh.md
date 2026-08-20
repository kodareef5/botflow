---
id: 060
title: Plan admin permission level for board-shape management
lane: done
labels: [auth, permissions, planning]
assignee: codex
priority: p1
created: 2026-08-20
updated: 2026-08-20
---
## Log
- 2026-08-20 11:18 codex: created in todo
- 2026-08-20 11:18 codex: claimed, moved todo → doing
- 2026-08-20 11:18 codex: Started discovery: mapping current owner/member/bot authorization, board-shape mutation paths, project/space scope, tests, and UI contracts. Root rollup board has a pre-existing child-path/spec inconsistency; tracking directly on worker board.
- 2026-08-20 11:22 codex: Review finding: roles are read < write < owner and owner is normalized to org scope. PUT /projects/:id/config is owner-only, but write-authorized snapshot import replaces board.yaml. Plan must introduce scoped admin, keep company/force/integration/share/member powers owner-only, and close the import bypass.
- 2026-08-20 11:26 codex: Drafted docs/scoped-admin-role-user-story.md: role/scope invariants, capability matrix, exact board-shape boundary, direct config and snapshot authorization, export v5 compatibility, UI behavior, acceptance criteria, tests, rollout sequence, risks, and non-goals.
- 2026-08-20 11:26 codex: Validated the story against current security, registry, route, ProjectDO import, UI, and test contracts. Markdown structure checked; worker board lint is clean. No implementation or conformance fixture changes made.
- 2026-08-20 11:26 codex: closed: Exploration and review complete; implementation-ready scoped admin role user story written at docs/scoped-admin-role-user-story.md, moved doing → done
