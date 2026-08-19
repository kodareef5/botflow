---
id: 047
title: Let owners provision bot API keys
lane: done
labels: [worker, ui, auth]
assignee: mac
priority: p1
created: 2026-08-19
updated: 2026-08-19
---
## Log
- 2026-08-19 22:23 mac: created in todo
- 2026-08-19 22:23 mac: claimed, moved todo → doing
- 2026-08-19 22:27 mac: Added an owner-only + key action to bot member rows. The modal mints through /api/keys?member=<bot>, explains the resulting identity/scope, reveals the bfk token once, supports clipboard copy, and updates the key count without a settings redraw. Added UI coverage, explicit non-owner API denial coverage, README guidance; 157 tests, both typechecks, and worker board lint pass.
- 2026-08-19 22:27 mac: closed: Owners can now mint one-time API credentials directly for bot accounts without creating a bot session.
