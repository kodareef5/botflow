---
id: 042
title: Review settings company input page refresh on focus
lane: done
labels: [bug, ui]
assignee: codex
priority: p0
created: 2026-08-19
updated: 2026-08-19
---
## Log
- 2026-08-19 21:36 codex: created in todo
- 2026-08-19 21:36 codex: claimed, moved todo → doing
- 2026-08-19 21:42 codex: Reproduced in isolated Chrome against local Worker: clicking #orgname sent POST /api/settings, replaced the input node, and did not navigate. Root cause: applyTheme sets data-style on <html>, while settings delegation uses e.target.closest('[data-style]'), so every otherwise-unhandled settings click matches <html> and calls save/renderSettings. Scope includes stale account/member hosts; API-key creation can insert its one-time token into a detached node.
- 2026-08-19 21:42 codex: closed: Review complete: confirmed delegated data-style selector escapes the settings subtree and forces a save/rerender on ordinary clicks; no source fix applied during review.
