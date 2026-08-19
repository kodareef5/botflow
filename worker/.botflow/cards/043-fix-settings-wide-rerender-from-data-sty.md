---
id: 043
title: Fix settings-wide rerender from data-style delegation
lane: done
labels: [bug, ui]
assignee: codex
priority: p0
created: 2026-08-19
updated: 2026-08-19
---
## Description
applyTheme writes data-style on document.documentElement, so the settings click delegate's closest('[data-style]') matches <html> for ordinary clicks. Scope the theme-tile lookup to the actual tile inside settings. Add a behavioral regression test proving a click/focus on #orgname preserves the same connected input node and sends no POST /api/settings; cover account/member controls so async callbacks never target detached hosts, especially the one-time API-key token path.

## Log
- 2026-08-19 21:42 codex: created in todo
- 2026-08-19 21:42 codex: edited description
- 2026-08-19 21:43 codex: claimed, moved todo → doing
- 2026-08-19 21:44 codex: Added a regression guard that rejects bare closest('[data-style]') in the settings delegate, then scoped theme selection to .stile[data-style]. UI tests now pass 12/12; ordinary settings clicks no longer fall through to the <html> theme attribute.
- 2026-08-19 21:44 codex: closed: Scoped theme-tile click delegation to .stile[data-style] and added regression coverage, preventing company/account/member controls from causing settings saves and rerenders.
