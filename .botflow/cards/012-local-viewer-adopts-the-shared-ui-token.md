---
id: 012
title: Local viewer adopts the shared UI token/component layer
lane: done
labels: [viewer]
assignee: claude
created: 2026-08-16
updated: 2026-08-17
---
## Log
- 2026-08-16 21:51 claude: created in wishlist
- 2026-08-17 22:41 claude: moved wishlist → todo
- 2026-08-17 22:41 claude: claimed, moved todo → doing
- 2026-08-17 22:45 claude: themes.ts moved to src/ui (worker re-exports), viewer CSS rewritten onto the shared tokens (--page/--acc/--st-x/--rc/--bw/--shadow/--font) with compact per-world flair, header paint controls (style, accent, mode) persisted in localStorage, five worlds now render in botflow serve and --html exports, page stays one self-contained file
- 2026-08-17 22:45 claude: closed: local viewer and hosted manager paint from one token source
