---
id: 019
title: "Adversarial multi-agent stress suite: concurrent claims, local write races, push/pull races, dep cycles, seq merge collisions"
lane: todo
labels: [test, hardening]
priority: p1
deps: [015, 016, 017, 018]
created: 2026-08-17
updated: 2026-08-17
---
## Description
From ChatGPT review: make botflow the nastiest botflow test case. node:test suite spawning real concurrent processes against one board and one wrangler-dev manager: A and B race to claim the same ready card (exactly one wins); parallel card adds mint distinct seq ids; local edit races hosted edit then push/pull converges; a dep cycle introduced mid-run is flagged; strict substate escape is rejected; seq branch merge collision surfaces dup-id. Green only when 015, 016, 017, 018 hold under fire.

## Log
- 2026-08-17 21:27 claude: created in todo
