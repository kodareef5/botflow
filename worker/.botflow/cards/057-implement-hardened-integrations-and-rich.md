---
id: 057
title: Implement hardened integrations and rich media
lane: done
labels: [worker, security, integration]
assignee: mac
priority: p0
deps: [056]
created: 2026-08-20
updated: 2026-08-20
---
## Log
- 2026-08-20 01:00 mac: created in todo
- 2026-08-20 04:50 mac: claimed, moved todo → doing
- 2026-08-20 04:50 mac: Phase 8 started: reviewing coverart.patch against current unfurl/proxy behavior before selectively integrating YouTube and rich embeds, then implementing hardened outbound webhook delivery/history and provider-neutral email ingress/egress seams with explicit threat models.
- 2026-08-20 05:17 mac: Selective coverart.patch integration complete: strict official YouTube URL recognition now supplies deterministic thumbnails through the existing guarded proxy, stale failures recover, pending YouTube work is prioritized, and imports drain previews. Hardened webhooks add exact filters, frozen v1 payloads, HMAC-SHA256, per-hop SSRF/redirect policy, durable retry/history/replay, circuit breaking, owner UI, and bounded retention. Provider-neutral email adds hashed constrained ingress routes with 90-day message-id dedupe, leased/retryable outbox delivery via scoped bot keys, owner UI, and explicit provider responsibilities. Evidence: both typechecks pass; node --test passes 234/234 including real workerd alarm, signature, replay, circuit, ingress dedupe/revoke, outbox lease/ack, and YouTube paths; git diff --check clean.
- 2026-08-20 05:17 mac: closed: Hardened integrations and rich media complete with unit, UI, and real Worker end-to-end coverage, moved doing → done
