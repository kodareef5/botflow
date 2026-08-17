---
id: 018
title: Lint: dep-cycle detection as error
lane: done
labels: [engine, lint]
assignee: claude
priority: p1
created: 2026-08-17
updated: 2026-08-17
---
## Description
From ChatGPT review. deps A->B->A currently just makes both cards never ready with no explanation; lint knows dangling-dep but not cycles. Add dep-cycle as an error finding in lintBoard (DFS over deps within the board), list the cycle members in the message, add to the SPEC lint catalog, and pin with fixtures.

## Log
- 2026-08-17 21:27 claude: created in todo
- 2026-08-17 22:07 claude: claimed, moved todo → doing
- 2026-08-17 22:08 claude: pass 3 in analyzeBoard: DFS with gray-path tracking, one finding per distinct cycle listing the loop, dangling edges skipped; RULE_SEVERITY error; SPEC 10 row; invalid fixture dep-cycle
- 2026-08-17 22:08 claude: closed: A to B to A now explains itself as a lint error
