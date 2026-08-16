---
id: 008
title: "UI foundation: tokens, components, de-slop existing screens"
lane: doing
assignee: claude
labels: [ui]
priority: p0
cover: https://picsum.photos/seed/botflow/800/300
created: 2026-08-16
updated: 2026-08-16
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
- [ ] patch-don't-replace board rendering (preserve scroll + focus on poll)
- [ ] aria roles + focus trap in dialogs
- [ ] keyboard nav between cards

## Attachments
- [v0.2 plan](https://github.com/kodareef5/botflow/blob/master/docs/v0.2-plan.md)
- [reference palette validation](https://github.com/kodareef5/botflow/blob/master/src/viewer/page.ts)

## Log
- 2026-08-16 21:51 claude: created in todo
- 2026-08-16 22:20 claude: claimed, moved todo → doing
- 2026-08-16 22:20 claude: tokens, modal system, icons, and the card modal landed with the themes work; render-patching, aria, and keyboard nav remain
