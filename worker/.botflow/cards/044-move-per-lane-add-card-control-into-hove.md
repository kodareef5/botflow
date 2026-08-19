---
id: 044
title: Move per-lane add-card control into hover and focus footer
lane: done
labels: [ui, accessibility]
assignee: codex
priority: p1
created: 2026-08-19
updated: 2026-08-19
---
## Description
Remove the + control from each lane heading and render a full-width add-card footer after the deck. Reveal it on lane hover or :focus-within without layout shift; keep it visible on non-hover/touch devices. Preserve delegated click behavior and an accessible lane-specific label. Add markup/order and CSS visibility regression coverage.

## Log
- 2026-08-19 21:44 codex: created in todo
- 2026-08-19 21:44 codex: claimed, moved todo → doing
- 2026-08-19 21:44 codex: edited description
- 2026-08-19 21:46 codex: Moved data-addcard from the h3 into a full-width footer after each writable lane deck. The footer reveals on .col:hover or .col:focus-within without layout shift, remains visible under hover:none, and preserves the delegated click hook plus lane-specific accessible label. Added renderer/order, read-only, hover/focus, touch, and no-display-none regression checks; UI tests pass 13/13.
- 2026-08-19 21:46 codex: closed: Per-lane add-card action now lives in a stable footer after the deck, revealed by hover or focus-within and always visible for non-hover devices; renderer and accessibility regressions are covered.
