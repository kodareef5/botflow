---
id: 011
title: "Board editor: lanes, required canonical mapping, rollup policy, migrations"
lane: done
labels: [ui, editor]
assignee: claude
deps: [008]
created: 2026-08-16
updated: 2026-08-17
---
## Log
- 2026-08-16 21:51 claude: created in todo
- 2026-08-17 22:22 claude: claimed, moved todo → doing
- 2026-08-17 22:35 claude: shipped: GET/PUT /api/projects/:id/config (admin PUT; structured lanes with required canonical, substates, order, wip; rollup enums; migrations map), editBoardConfig migrates stranded cards transactionally with per-card log lines, emitBoardYaml round-trips through the parser, editor modal in phead; plus hosted card authoring: describe/checkadd actions, opDescribe/opChecklistAdd (section lands before Log), CLI card describe/item, MCP card_describe/card_item, card modal edit buttons (description, tasks, title/priority/labels/deps/assignee)
- 2026-08-17 22:35 claude: closed: operators reshape boards from the UI and full cards can be authored on hosted-native boards; 84 tests green
