---
id: 049
title: Paginate company activity in settings
lane: done
labels: [worker, ui, api]
assignee: mac
priority: p1
created: 2026-08-19
updated: 2026-08-19
---
## Log
- 2026-08-19 23:50 mac: created in todo
- 2026-08-19 23:50 mac: claimed, moved todo → doing
- 2026-08-19 23:54 mac: Implemented exclusive before-sequence pagination, a 25-row cached settings pager, cursor validation, and UI/Worker regressions; typecheck and all 158 tests pass.
- 2026-08-19 23:54 mac: closed: Company activity now pages server-side with stable cursor navigation; full suite passes.
