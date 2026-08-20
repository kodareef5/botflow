---
id: 026
title: Configure visible card tag count
lane: done
labels: [ui, worker]
assignee: Codex
priority: p2
created: 2026-08-20
updated: 2026-08-20
---
## Log
- 2026-08-20 15:37 mac: created in todo
- 2026-08-20 15:37 Codex: claimed, moved todo → doing
- 2026-08-20 15:38 Codex: Traced hosted and local card rendering: labels are mixed into a silent ten-badge cutoff. Chosen design is an explicit label limit with a +N more badge, preserving every non-label card signal.
- 2026-08-20 15:45 Codex: Implemented bounded tag-window semantics (default 3, configurable 0–10), hosted company preference/API propagation, +N more rendering with hidden-tag tooltip, and local-viewer per-browser control. Targeted UI/viewer tests and both TypeScript checks pass.
- 2026-08-20 15:45 Codex: closed: Added configurable 0–10 visible tag limits with +N more summaries in hosted cards and the local viewer; persisted hosted settings and restore/export behavior; targeted tests, Worker API test, and typechecks pass., moved doing → done
- 2026-08-20 16:09 Codex: User requested shipment to remote master; isolating the feature from concurrent security and pagination work before committing.
