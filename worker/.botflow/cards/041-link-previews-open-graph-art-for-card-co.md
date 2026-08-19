---
id: 041
title: Link previews: Open Graph art for card covers
lane: done
labels: [ui, security]
assignee: claude
priority: p1
created: 2026-08-19
updated: 2026-08-19
---
## Log
- 2026-08-19 19:31 claude: created in todo
- 2026-08-19 19:31 claude: claimed, moved todo → doing
- 2026-08-19 19:31 claude: og:image from an attached link becomes cover art; worker fetches once, caches per project, and proxies the picture so a viewer never contacts the previewed site (verified: zero off-origin requests in a real browser)
- 2026-08-19 19:31 claude: SSRF guards are pure and exhaustively tested: the url parser folds decimal/octal/hex/short IPv4 into dotted quad, but IPv4-mapped IPv6 arrives in hex and is decoded before judging; every redirect hop is re-checked
- 2026-08-19 19:31 claude: cardJson gains coverAuto because cover is null both when art is suppressed and when none was found, so cover: none could not otherwise outrank a preview
- 2026-08-19 19:31 claude: off by default behind LINK_PREVIEWS: the residual risk is DNS, which no address check can see
- 2026-08-19 19:31 claude: closed: previews land as cover art, refusals proven specific rather than slow; 154 green
