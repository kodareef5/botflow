# AGENTS.md

Project-specific guidance goes here.

## Task tracking (botflow)

This project tracks work on a botflow board (`.botflow/`). Start every session with:

```
botflow prime
```

Workflow: `botflow ready` → `botflow card claim <id> --actor <you>` → work, narrating with
`botflow log <id> "<what happened>"` → `botflow card mv <id> <lane[.substate]>` →
`botflow card close <id> --reason "<summary>"`. Stuck? `botflow card block <id> --reason "<why>"`
instead of stalling silently. Every command accepts `--json`.
