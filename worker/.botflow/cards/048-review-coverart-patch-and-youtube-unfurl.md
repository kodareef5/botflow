---
id: 048
title: Review coverart patch and YouTube unfurls
lane: done
labels: [worker, review, unfurl]
assignee: mac
priority: p1
created: 2026-08-19
updated: 2026-08-19
---
## Log
- 2026-08-19 23:44 mac: created in todo
- 2026-08-19 23:44 mac: claimed, moved todo → doing
- 2026-08-19 23:49 mac: Reviewed coverart.patch without applying it to the working tree. It applies cleanly; isolated clone passes 159 tests, both typechecks, and Wrangler dry-run. Live diagnosis: YouTube watch HTML is ~1.4 MiB, above the 512 KiB unfurl cap, while official oEmbed points to the proposed hqdefault.jpg and that image returns 200 image/jpeg. Core deterministic resolver is sound and preserves proxy/SSRF guards. Before landing, bound pendingUnfurls candidate arrays/scan behavior, migrate stale ok rows whose cached image differs from the deterministic URL, and add coverage for cache migration/import-trigger behavior.
- 2026-08-19 23:49 mac: closed: Review complete: core fix validated, with bounded-queue and cache-migration hardening recommended before landing.
