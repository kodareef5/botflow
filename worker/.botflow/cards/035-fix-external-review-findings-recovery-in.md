---
id: 035
title: "Fix external review findings: recovery integrity, credential revocation, export versioning"
lane: done
labels: [auth, hardening]
assignee: claude
priority: p0
created: 2026-08-19
updated: 2026-08-19
---
## Log
- 2026-08-19 16:10 claude: created in todo
- 2026-08-19 16:10 claude: claimed, moved todo → doing
- 2026-08-19 16:10 claude: P1 recovery on a never-set-up deployment created an owner with no org row: /api/org 500d and setup locked out forever; recover now owns the same org-row invariant as setup, transactionally
- 2026-08-19 16:10 claude: P1 recovery skipped password validation, setting a hash nothing could verify: locked the owner out rather than recovering them
- 2026-08-19 16:10 claude: P1 basic-auth cache held full identities for 5 min; now caches only the member id so disable/scope changes are live, and space deletion disables space-scoped members
- 2026-08-19 16:10 claude: P1 export bumped to v3; v2 payloads restore their boards and drop legacy project-keyed api keys with an audit line instead of failing whole
- 2026-08-19 16:10 claude: P2 root-project creation is owner-only (matches the UI); member form defaults to read not owner; author needs a created entry; adoptOrg refreshes directory+role flags on every reload; absent accounts cost a real PBKDF2 derivation
- 2026-08-19 16:10 claude: closed: 9 findings fixed, 6 regression tests added; 143 green, all reproduced failures re-verified dead against a live worker
