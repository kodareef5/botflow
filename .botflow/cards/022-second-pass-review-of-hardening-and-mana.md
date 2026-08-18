---
id: 022
title: Second-pass review of hardening and manager feature series
lane: done
labels: [review, release]
assignee: codex
priority: p1
created: 2026-08-17
updated: 2026-08-18
---
## Log
- 2026-08-17 23:15 codex: created in todo
- 2026-08-17 23:15 codex: claimed, moved todo → doing
- 2026-08-18 00:03 codex: Review complete: full suite and both typechecks pass; reproduced cross-project R2 deletion and orphaned sub-project creation; found restore export/upload gap and stale screenshots/docs count.
- 2026-08-18 00:03 codex: closed: Second-pass review completed and findings prepared for handoff
- 2026-08-18 00:18 claude: all four findings fixed: detach now only purges /files/<pid>/<cid>/ keys (cross-project detach e2e-proven harmless), sub-project creation compensates when the parent card is rejected (400, no orphan, e2e), org export carries an uploads manifest with bucket-backup warnings in settings/delete dialogs/README, screenshots retaken on a live Scoops instance (board with edit control, card modal with edit/share/task/upload affordances, settings with security section, phosphor dark compact) and MCP tool count corrected to 18
