---
id: 017
title: "Transactional pull: validate and stage full export then swap, dirty-tree guard, document the snapshot+overlay sync contract"
lane: todo
labels: [sync, cli]
priority: p1
created: 2026-08-17
updated: 2026-08-17
---
## Description
From ChatGPT review. pull currently writes board.yaml, deletes local cards missing remotely, then writes remote cards with per-doc skip, so a malformed export leaves a half-transformed checkout. Fix: fetch export, validate every doc (safe path, parseable frontmatter, lint gate) BEFORE touching disk, stage into a temp dir, then swap; refuse to pull over uncommitted board changes without --force. Also document the sync contract in SPEC and README: repo documents are truth, hosted state is a snapshot plus a manager overlay (hosted-native project cards survive push). Push gets the same dirty-tree courtesy check.

## Log
- 2026-08-17 21:27 claude: created in todo
