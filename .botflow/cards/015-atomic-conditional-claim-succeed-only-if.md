---
id: 015
title: "Atomic conditional claim: succeed only if ready and unassigned, else conflict (core + DO + MCP)"
lane: todo
labels: [engine, concurrency]
priority: p0
created: 2026-08-17
updated: 2026-08-17
---
## Description
From ChatGPT review. opClaim currently sets assignee and moves to doing unconditionally: no ready check, no unassigned check, so agent B silently overwrites agent A. Redefine claim as a coordination primitive: succeed iff canonical state is todo, deps satisfied, and assignee is null; otherwise return a structured conflict (who holds it, current lane) with a nonzero exit / error result. Same semantics in core opClaim, the DO action switch, MCP tool, and REST. Optional --force keeps the old behavior for humans. Tests: two sequential claims, claim on doing card, claim on dep-blocked card.

## Log
- 2026-08-17 21:27 claude: created in todo
