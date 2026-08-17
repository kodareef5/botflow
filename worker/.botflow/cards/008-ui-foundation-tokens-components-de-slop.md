---
id: 008
title: "UI foundation: tokens, components, de-slop existing screens"
lane: done
labels: [ui]
assignee: claude
priority: p0
cover: https://picsum.photos/seed/botflow/800/300
created: 2026-08-16
updated: 2026-08-17
---
## Description
Turn the manager UI into a small **real design system**: one structural
stylesheet driven by tokens, a dozen specified components, and interaction
quality that stops feeling vibe-coded. Everything else (themes, board editor,
sharing) rides on this.

## Checklist
- [x] design tokens: shape + palette variables drive one structural stylesheet
- [x] modal forms replace every prompt() dialog
- [x] inline SVG icon set replaces emoji glyphs
- [x] large tabbed card modal (card / chat / activity)
- [x] patch-don't-replace board rendering (preserve scroll + focus on poll)
- [x] aria roles + focus trap in dialogs
- [ ] keyboard nav between cards

## Attachments
- [v0.2 plan](https://github.com/kodareef5/botflow/blob/master/docs/v0.2-plan.md)
- [reference palette validation](https://github.com/kodareef5/botflow/blob/master/src/viewer/page.ts)

## Log
- 2026-08-16 21:51 claude: created in todo
- 2026-08-16 22:20 claude: claimed, moved todo → doing
- 2026-08-16 22:20 claude: tokens, modal system, icons, and the card modal landed with the themes work; render-patching, aria, and keyboard nav remain
- 2026-08-17 22:22 claude: checked "large tabbed card modal (card / chat / activity)"
- 2026-08-17 22:22 claude: checked "patch-don't-replace board rendering (preserve scroll + focus on poll)"
- 2026-08-17 22:22 claude: checked "aria roles + focus trap in dialogs"
- 2026-08-17 22:22 claude: morph reconciler (nodeKey/morphChildren/morphNode) patches board+public views in place so polls preserve scroll and focus; dialogs get focus trap, focus restore, aria labels/roles, alert regions; cards/rows tabbable with arrow-key deck nav, Enter/Space open, keyboard checklist toggles; pinned by test/ui.test.ts incl extracted-morph identity tests
- 2026-08-17 22:22 claude: closed: UI foundation complete: tokens, components, dialogs, and interaction quality
