---
id: 037
title: Login throttle plus the deferred correctness backlog
lane: done
labels: [auth, hardening, spec]
assignee: claude
priority: p1
created: 2026-08-19
updated: 2026-08-19
---
## Log
- 2026-08-19 18:17 claude: created in todo
- 2026-08-19 18:17 claude: claimed, moved todo → doing
- 2026-08-19 18:17 claude: failed-credential throttle on login, basic auth and password proof: bucket is (client, account) so a flood locks the attacker's own pair, never a member out of their own board; 429 with Retry-After
- 2026-08-19 18:17 claude: emit: an empty map in a block sequence emitted a bare dash the parser rejects, so the card vanished on the next rewrite
- 2026-08-19 18:17 claude: spec+core: actor names drop colons (an actor with a colon read back truncated, nulling the audit trail and derived author); CLI stdout strips C0 so a committed card cannot fire escape sequences at whoever runs botflow board
- 2026-08-19 18:17 claude: worker: card text clamped (log/block/comment were unbounded and permanent); mcp: every tool arg goes through the strict helper instead of String() coercion; priority validated at write time; priority escaped in the UI
- 2026-08-19 18:17 claude: closed: throttle shipped plus 8 backlog items; 146 green twice, typecheck and lint clean
