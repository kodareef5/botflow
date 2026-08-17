---
id: 025
title: Admin token rotation plus lost-token recovery path
lane: done
labels: [auth, security]
assignee: claude
priority: p1
created: 2026-08-17
updated: 2026-08-17
---
## Log
- 2026-08-17 21:27 claude: created in todo
- 2026-08-17 22:35 claude: claimed, moved todo → doing
- 2026-08-17 22:38 claude: registry.rotateAdminToken (one UPDATE, audited as rotate-token or recover-admin); POST /api/rotate-token admin-only; POST /api/recover pre-auth gated by setupAccess (same trust anchor as setup, loopback zero-config, wrong key 403, unconfigured public 503); settings security section with confirm+auto-switch; gate gains lost-your-token flow; e2e proves old tokens die on both paths and both are audited
- 2026-08-17 22:38 claude: closed: admin credential is now rotatable and recoverable, never a dead end
