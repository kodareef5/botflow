---
id: 027
title: R2 binary attachment uploads
lane: done
labels: [attachments]
assignee: claude
created: 2026-08-17
updated: 2026-08-17
---
## Log
- 2026-08-17 21:28 claude: created in wishlist
- 2026-08-17 22:51 claude: moved wishlist → todo
- 2026-08-17 22:51 claude: claimed, moved todo → doing
- 2026-08-17 22:59 claude: optional ATTACHMENTS R2 binding (commented example in wrangler.jsonc keeps the deploy button provisioning-free); POST cards/:id/upload stores to R2 and records a normal markdown attachment line at /files/<key>; /files serves capability-by-key with nosniff+sandbox and inline only for safe types (html/svg download); detach and project deletion purge objects; org response advertises uploads and the UI shows the button only then; e2e covers round trip, xss disposition, purge; stress test proves the 503 degrade without a bucket
- 2026-08-17 22:59 claude: closed: images and files attach for real when a bucket exists, nothing breaks when it does not
