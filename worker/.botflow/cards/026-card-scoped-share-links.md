---
id: 026
title: Card-scoped share links
lane: done
labels: [sharing]
assignee: claude
created: 2026-08-17
updated: 2026-08-17
---
## Log
- 2026-08-17 21:28 claude: created in wishlist
- 2026-08-17 22:45 claude: moved wishlist → todo
- 2026-08-17 22:45 claude: claimed, moved todo → doing
- 2026-08-17 22:50 claude: shares carry an optional card_id (guarded ALTER upgrades old instances); card-scoped links resolve to exactly one card (board and siblings 404 through them), never list on the gate, survive org export/import, and render a standalone live read-only card page; created from the card modal share button or the sharing tab card field; scope column in listings
- 2026-08-17 22:50 claude: closed: a single card can now be handed to anyone as a url
