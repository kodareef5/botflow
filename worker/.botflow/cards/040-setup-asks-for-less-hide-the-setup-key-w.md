---
id: 040
title: "Setup asks for less: hide the setup key where it is ignored, make the company name renameable"
lane: done
labels: [ui]
assignee: claude
priority: p1
created: 2026-08-19
updated: 2026-08-19
---
## Log
- 2026-08-19 19:04 claude: created in todo
- 2026-08-19 19:04 claude: claimed, moved todo → doing
- 2026-08-19 19:04 claude: the gate now reports whether a setup key is required or setup is locked, so the form stops asking for one on a loopback instance that ignores it
- 2026-08-19 19:04 claude: company name was set once at setup and unreachable afterwards: added POST /api/org/name plus a rename in settings, so the field can be optional
- 2026-08-19 19:04 claude: renderHeader never updated the h1, so a rename only showed after a reload
- 2026-08-19 19:04 claude: closed: loopback setup is two fields; verified in a browser, 152 green
