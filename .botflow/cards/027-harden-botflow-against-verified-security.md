---
id: 027
title: Harden botflow against verified security-audit findings
lane: done
labels: [security, audit]
assignee: Codex
priority: p0
created: 2026-08-20
updated: 2026-08-20
---
## Log
- 2026-08-20 15:37 Codex: created in todo
- 2026-08-20 15:37 Codex: claimed, moved todo → doing
- 2026-08-20 15:39 Codex: Confirmed the audit against current sources; grouped work into parser/load DoS defenses, physical-path mutation containment, CLI/MCP/viewer boundary hardening, worker request/provisioning controls, and package/secret hygiene.
- 2026-08-20 16:11 Codex: Patched all verified Medium and Low findings plus practical Info items: bounded/iterative core processing, symlink-safe reads and writes, title/YAML protections, sanitized CLI and pinned MCP attribution, capability-gated local viewer, hardened Worker request/auth/DO/image boundaries, and package/secret hygiene. Focused core and live Worker regressions pass.
- 2026-08-20 16:22 Codex: Final verification: node --test passes 288/288; node --run typecheck passes; root and worker board lints are clean; git diff --check passes; npm dry-run pack contains 62 allowlisted files and excludes audit, tests, board state, and scratch/secret artifacts.
- 2026-08-20 16:22 Codex: closed: All actionable verified audit findings patched and covered by regression tests; residual DNS-rebinding risk is explicitly documented for deployment-level egress enforcement., moved doing → done
