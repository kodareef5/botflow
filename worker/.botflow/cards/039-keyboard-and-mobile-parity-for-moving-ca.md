---
id: 039
title: Keyboard and mobile parity for moving cards
lane: done
labels: [ui, a11y]
assignee: claude
priority: p2
created: 2026-08-19
updated: 2026-08-19
---
## Description
Dragging is now the only way to move a card. Touch works via press-and-hold, but there is no keyboard path: a card can be focused and opened with the keyboard, never moved. Add a move control (lane + substate, offering only legal targets) and/or a keyboard move on the focused card, so the board is operable without a pointer.

## Log
- 2026-08-19 18:51 claude: created in wishlist
- 2026-08-19 18:51 claude: edited description
- 2026-08-19 18:53 claude: moved wishlist → todo
- 2026-08-19 18:53 claude: claimed, moved todo → doing
- 2026-08-19 18:57 claude: shift+arrow moves the focused card: left/right across lanes, up/down through substates; focus follows the card so moves chain, and each one is announced through a role=status live region
- 2026-08-19 18:57 claude: entering a lane always lands on its first substate and steps are +/-1, so a keyboard move is legal by construction: the force path is unreachable from the keyboard
- 2026-08-19 18:57 claude: reloadOrg now awaits refreshBoard: it was firing the re-render without awaiting, so restoring focus acted on the pre-render DOM and the keyboard was stranded after one move
- 2026-08-19 18:57 claude: closed: board is fully operable without a pointer; verified with real key events in a browser, 151 green
