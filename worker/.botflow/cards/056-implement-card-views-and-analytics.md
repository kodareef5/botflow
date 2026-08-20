---
id: 056
title: Implement card views and analytics
lane: done
labels: [worker, ui, viewer, metrics]
assignee: mac
priority: p0
deps: [055]
created: 2026-08-20
updated: 2026-08-20
---
## Log
- 2026-08-20 01:00 mac: created in todo
- 2026-08-20 04:17 mac: claimed, moved todo → doing
- 2026-08-20 04:17 mac: Phase 7 started: implementing table, swimlane, calendar, timeline, grouped axes, analytics dashboard, dependency strings, and Hill Chart uncertainty without adding merge-noisy card rank state.
- 2026-08-20 04:49 mac: Completed all eight projections across hosted manager, public shares, and local viewer; grouped-axis mutations reuse validated edits/moves, filtered metrics distinguish card and board aggregates, Hill remains explicit/manual, and browser smoke caught and fixed inline date escaping plus unplotted/completed-card crowding. Verification: 222/222 full tests, both typechecks, Worker E2E, diff check, and dated browser renders all pass.
- 2026-08-20 04:49 mac: closed: Implemented and verified card views, analytics, grouping, and manual Hill uncertainty across every read surface, moved doing → done
