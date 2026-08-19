---
id: 046
title: Fix remaining settings redraw on ordinary clicks
lane: done
labels: [worker, bug]
assignee: mac
priority: p1
created: 2026-08-19
updated: 2026-08-19
---
## Log
- 2026-08-19 22:15 mac: created in todo
- 2026-08-19 22:15 mac: claimed, moved todo → doing
- 2026-08-19 22:22 mac: edited title
- 2026-08-19 22:22 mac: Fresh Chrome reproduction showed company and + member clicks POSTing /api/settings: data-density delegation still escaped the panel and matched html. Bounded every settings delegated lookup to currentTarget; browser verification now keeps DOM identity and makes zero settings calls. Full 157 tests and both typechecks pass.
- 2026-08-19 22:22 mac: closed: Panel-bounded delegation prevents html theme attributes from turning ordinary settings clicks into saves and redraws; verified in fresh Chrome.
