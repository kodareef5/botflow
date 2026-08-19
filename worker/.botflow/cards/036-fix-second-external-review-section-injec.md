---
id: 036
title: "Fix second external review: section injection, credential rotation, import trust"
lane: done
labels: [auth, hardening, spec]
assignee: claude
priority: p0
created: 2026-08-19
updated: 2026-08-19
---
## Log
- 2026-08-19 17:30 claude: created in todo
- 2026-08-19 17:31 claude: claimed, moved todo → doing
- 2026-08-19 17:31 claude: spec: multi-line body text and caller-chosen section names cannot introduce a heading; appends target the first match, so a forged ## Log captured the audit trail and the derived author
- 2026-08-19 17:31 claude: core: sanitizeBlock escapes heading markers in describe; sanitizeSectionName rejects multi-line names and the Log is refused as a checklist target
- 2026-08-19 17:31 claude: worker: recovery names an existing owner instead of minting a second; password change and recovery revoke member api keys; pre-v3 members blocks are no longer applied unvalidated; restored owners normalize to org scope; import refuses to leave zero live owners and itemizes restored credentials
- 2026-08-19 17:31 claude: worker: delete-member modal escapes the display name (stored XSS); credential routes read with a real byte ceiling instead of trusting content-length; member removal reserves the username so nobody inherits its card history
- 2026-08-19 17:31 claude: closed: 10 findings fixed, 5 regression tests added; 145 green, every reproduced failure re-verified dead against a live worker
