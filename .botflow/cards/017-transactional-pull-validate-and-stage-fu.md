---
id: 017
title: "Transactional pull: validate and stage full export then swap, dirty-tree guard, document the snapshot+overlay sync contract"
lane: done
labels: [sync, cli]
assignee: claude
priority: p1
created: 2026-08-17
updated: 2026-08-17
---
## Description
From ChatGPT review. pull currently writes board.yaml, deletes local cards missing remotely, then writes remote cards with per-doc skip, so a malformed export leaves a half-transformed checkout. Fix: fetch export, validate every doc (safe path, parseable frontmatter, lint gate) BEFORE touching disk, stage into a temp dir, then swap; refuse to pull over uncommitted board changes without --force. Also document the sync contract in SPEC and README: repo documents are truth, hosted state is a snapshot plus a manager overlay (hosted-native project cards survive push). Push gets the same dirty-tree courtesy check.

## Log
- 2026-08-17 21:27 claude: created in todo
- 2026-08-17 22:03 claude: claimed, moved todo → doing
- 2026-08-17 22:07 claude: pull now validates the entire snapshot via shared core validateBoardDocuments (also used by hosted import), applies under the board lock with atomic writes, and refuses over uncommitted git changes without --force; sync contract documented in SPEC 12 and README; 7 tests incl dirty-tree force path
- 2026-08-17 22:07 claude: closed: a malformed export can no longer half-transform a checkout
