---
id: 023
title: "Third-pass review fixes: hosted force auth, live-lock reaping, sync lock placement, ready/claim coherence, upload capability bits"
lane: done
labels: [review, hardening]
assignee: claude
priority: p0
created: 2026-08-18
updated: 2026-08-18
---
## Log
- 2026-08-18 00:35 claude: created in todo
- 2026-08-18 00:35 claude: claimed, moved todo → doing
- 2026-08-18 00:41 claude: 1 hosted force is now an authorization capability: agent+force gets 403 with a clear message, admin+force works and lands a force-override entry in the org audit plus (forced) in project events; 2 lock reaper never age-reaps a live pid (liveness wins, EPERM counts as alive, mtime fallback only for unreadable pids) with a lock-theft regression test; 3 push snapshots under the board lock, pull runs its dirty gate inside the lock and the guard is scoped to board.yaml+cards; 4 docs now say validated crash-safe snapshot apply, not transactional; 5 ready lists task cards only so ready and claim can never disagree on containers (SPEC 5+12, fixture-checked); 6 upload keys are 128-bit and the bearer-capability semantics are documented in README and settings; 7 carded as 024 (deletion repair GC); package.json description matches the protocol positioning
- 2026-08-18 00:41 claude: closed: the three release-blocking edges are closed; 88 tests green
