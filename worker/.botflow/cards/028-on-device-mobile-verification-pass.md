---
id: 028
title: On-device mobile verification pass
lane: done
labels: [ui, mobile]
assignee: claude
created: 2026-08-17
updated: 2026-08-17
---
## Log
- 2026-08-17 21:28 claude: created in wishlist
- 2026-08-17 23:00 claude: moved wishlist → todo
- 2026-08-17 23:00 claude: claimed, moved todo → doing
- 2026-08-17 23:06 claude: live verification on a disposable wrangler instance via the embedded browser: arrow-key nav moves focus, Enter opens the dialog (aria-modal, labeled, focus inside), Escape closes and returns focus to the card, morph keeps DOM node identity and scrollLeft across a poll while server changes appear, board editor round trip reshapes lanes with migration logged (and the screenshot caught a mig-select visibility bug, fixed with .mig[hidden]), public card-share page renders standalone read-only; viewer gained its missing mobile block (84vw snap columns, full-width drawer); true on-device check still needs a phone: run wrangler dev --ip 0.0.0.0 and open from the device
- 2026-08-17 23:06 claude: closed: everything verifiable without a physical phone is verified in a real browser; device pass documented for the operator
