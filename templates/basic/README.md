# basic botflow workspace

A minimal "kanban batteries included" workspace template:

- `.botflow/` — a standard six-lane board with starter cards
- `AGENTS.md` — the playbook that teaches any agent the workflow (`botflow prime`)

Instantiate it as a new project:

```
botflow new <this-repo-or-dir> my-project --name my-project
cd my-project && botflow prime
```

Branch this template to create specialty workflow variants (review-gated lanes,
strict substate machines, different WIP policies) and instantiate with
`botflow new <repo>#<branch> <dir>`.
