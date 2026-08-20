---
id: 062
title: Paginate card activity and remaining activity lists
lane: done
labels: [worker, ui, api]
assignee: codex
priority: p1
created: 2026-08-20
updated: 2026-08-20
---
## Log
- 2026-08-20 15:44 mac: created in todo
- 2026-08-20 15:44 codex: claimed, moved todo → doing
- 2026-08-20 15:47 mac: Traced hosted histories: company, project, webhook, and outbox activity already use newest-first cursor pages; card Log and Comments remain embedded, unbounded, and oldest-first. Scope is bounded server-side card activity and chat pages plus compact modal reads.
- 2026-08-20 15:53 mac: Implemented compact card/board/search projections plus GET card activity/comments endpoints with stable exclusive ordinal cursors. Authenticated and card-share routes enforce scope, UI pages both histories newest-first with 25-row older/newer navigation, and append-between-page tests pass.
- 2026-08-20 15:54 mac: closed: Card activity and comments now use bounded newest-first server pages with stable cursors; board/search/modal reads omit embedded histories; authenticated and public scoped routes are covered., moved doing → done
