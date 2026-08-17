---
id: 018
title: Lint: dep-cycle detection as error
lane: todo
labels: [engine, lint]
priority: p1
created: 2026-08-17
updated: 2026-08-17
---
## Description
From ChatGPT review. deps A->B->A currently just makes both cards never ready with no explanation; lint knows dangling-dep but not cycles. Add dep-cycle as an error finding in lintBoard (DFS over deps within the board), list the cycle members in the message, add to the SPEC lint catalog, and pin with fixtures.

## Log
- 2026-08-17 21:27 claude: created in todo
