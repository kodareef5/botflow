---
id: 038
title: "Board interaction: drag to move, claim/close/block from the card, conflict dialogs"
lane: done
labels: [ui]
assignee: claude
priority: p0
created: 2026-08-19
updated: 2026-08-19
---
## Log
- 2026-08-19 18:39 claude: created in todo
- 2026-08-19 18:39 claude: claimed, moved todo → doing
- 2026-08-19 18:51 claude: drag to move: pointer events (one path for mouse, pen and touch; touch lifts on a 260ms hold so column scrolling still works), ghost follows the pointer, legal targets computed from the lane rules before the drop
- 2026-08-19 18:51 claude: every substate group renders even when empty: a strict lane must be entered at its first substate, which is usually the empty one, so hiding it hid the only legal drop
- 2026-08-19 18:51 claude: claim/close/block/unblock on the card; a lost claim names the holder by display name and offers owners the force override the spec allows
- 2026-08-19 18:51 claude: found by driving it in headless chrome: pointerup still fires a click, so a drop was also opening the card; and formModal closes its own overlay after the handler, so reopening the card had to be deferred past it
- 2026-08-19 18:51 claude: closed: board is operable: drag to move with strict-lane legality, all four verbs on the card, conflicts explained; 150 green, verified end to end in a real browser
