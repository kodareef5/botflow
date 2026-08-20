---
id: 061
title: Implement scoped admin role for board-shape management
lane: done
labels: [auth, permissions, api, ui]
assignee: codex
priority: p1
deps: [060]
created: 2026-08-20
updated: 2026-08-20
---
## Log
- 2026-08-20 13:18 codex: created in todo
- 2026-08-20 13:18 codex: claimed, moved todo → doing
- 2026-08-20 13:18 codex: Implementation started from docs/scoped-admin-role-user-story.md. Beginning with red tests for role ordering, scoped board edits, owner-only isolation, snapshot config changes, export v5, and UI capability gates.
- 2026-08-20 13:33 codex: Implemented scoped admin role, v5 restore contract, atomic snapshot authorization, browser capability gates, and end-to-end coverage; targeted policy/UI/Worker tests and both typechecks pass.
- 2026-08-20 13:33 codex: closed: Scoped admin role shipped with project/space board-shape authority, owner boundaries, atomic snapshot gating, v5 restore support, UI controls, documentation, and complete green verification., moved doing → done
