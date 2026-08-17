---
id: 016
title: "Atomic local mutation: temp-file+rename writes, board lockfile, seq id race fix"
lane: todo
labels: [engine, concurrency]
priority: p0
created: 2026-08-17
updated: 2026-08-17
---
## Description
From ChatGPT review. Local mutations are load, mutate in memory, writeFileSync: no lock, no temp+rename, so two processes interleave and two seq creates can mint the same next id. Fix: write card and board.yaml via temp file in same dir then renameSync (atomic on POSIX); take a short-lived .botflow/board.lock (mkdir or O_EXCL, stale after a few seconds) around load-mutate-write in mutate.ts ops; re-read max id inside the lock before assigning seq ids. Keep pure core untouched: this lives in the fs layer only.

## Log
- 2026-08-17 21:27 claude: created in todo
