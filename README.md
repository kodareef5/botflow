# botflow

**Git-native kanban for AI agents**: a file format your repo carries, a CLI agents drive, a board humans read, and an optional self-hosted manager for the whole company.

## The idea

- **Boards are directories.** `board.yaml` (lanes, rules) + `cards/*.md` (one card, one file). Truth is plain files in git: history is your audit log, branches are workflow variants, merges are card merges.
- **Six canonical states**: `wishlist · todo · doing · blocked · done · archive`. Every custom lane declares which canonical state it projects onto (like Jira's status categories, but in a plain-text spec). That projection is what lets *any* two boards be aggregated, no matter how specialized their lanes are.
- **Cards can be boards.** A card with `type: board` contains another board (a subdirectory). Parents roll up children by canonical distribution: portfolio kanban without the parent ever knowing the child's shape.
- **Lanes can be state machines.** `doing` may carry ordered substates (`design → implement → review`) with strict or free transitions; it still projects to `doing` from above.
- **Agents are the primary users.** `botflow ready`, `claim`, `mv`, `close`: plus an MCP server for MCP-native tools. An `AGENTS.md` one-liner ("run `botflow prime`") teaches any agent the workflow; in testing, a fresh agent given only that operated a board legally on the first try.
- **Workspaces are templates.** `botflow new <repo>[#branch] <dir>` shallow-copies a workspace template: board, playbook, environment batteries: so starting a project means instantiating a proven workflow shape. Branches carry specialty variants.
- **Zero runtime dependencies.** Node ≥ 24 built-ins only. The hosted manager runs on Cloudflare Workers + SQLite-backed Durable Objects under the same rule.

## Quickstart (repo-local)

```sh
botflow init                       # creates .botflow/ with the six canonical lanes
botflow card add "First task" --priority p1
botflow prime                      # workflow context: point agents here
botflow ready                      # unblocked todo work
botflow card claim 001 --actor me
botflow card close 001 --reason "done"
botflow board                      # terminal view · --json for machines
botflow serve                      # read-only web view on 127.0.0.1:4666
botflow setup claude               # wire the playbook into CLAUDE.md/AGENTS.md
```

Run from a checkout with `node src/cli/botflow.ts …` or link the bin (`npm link`).

## Quickstart (template workspace)

```sh
botflow new https://github.com/you/workspace#review-gated my-project --name my-project
cd my-project && botflow prime
```

`templates/basic/` in this repo is a minimal template: a board plus an AGENTS.md playbook. Fork it, reshape the lanes for a specialty workload on a branch, and every future project of that shape is one `botflow new` away: kanban batteries included.

## Hosted manager (Cloudflare)

`worker/` is a self-hosted board manager: **Company → Spaces → Projects (projects own projects; a project is a board)** with a web UI at every level, per-project **agent keys**, and an append-only **audit log**. One SQLite-backed Durable Object per project serializes all writes; boards are stored in the exact same document format the CLI uses.

```sh
npm run dev:manager                # local: http://127.0.0.1:8787
npm run deploy:manager             # deploy to your Cloudflare account
```

The dev server is a **full local instance**: workerd with SQLite Durable Objects persisted
under `.wrangler/state/`, no Cloudflare account or network needed. Keep one running under a
supervisor for local testing (`pm2 start "npm run dev:manager -- --port 4700" --name
botflow-manager --cwd <repo>`); source changes hot-reload. Deleting `.wrangler/` resets the
instance: company, tokens, boards, everything.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kodareef5/botflow)
*(the button needs this repo public on GitHub; `wrangler deploy` works regardless)*

Visitors get a consumer pitch at `/about`, live public share links can sit right on the
login page (admin-controlled), and settings offers a one-click **Scoops Empire** demo
company plus a full **company export** (every space, project, board, and card as one
JSON; the demo source ships in `demo/icecream-empire.json`).

First visit initializes the company and mints the admin token (shown exactly once). From the UI: create spaces and projects, mint scoped agent keys (the key's label becomes the agent's actor identity in the audit trail), watch boards and activity live. Agents drive projects via REST with their key: same verbs as the CLI. Link a repo board and sync snapshots:

```sh
botflow remote add https://manager.example.workers.dev p-abc123
BOTFLOW_TOKEN=bfk_… botflow push   # or pull
```

## Layout

| Path | What |
|---|---|
| `spec/SPEC.md` | The format spec: the real product |
| `test/fixtures/` | Golden boards; the spec's conformance vectors |
| `src/core/` | Engine: parse → model → lint → project → rollup, pure ops |
| `src/cli/` | The `botflow` CLI (incl. push/pull sync) |
| `src/mcp/` | MCP server (stdio JSON-RPC, 13 tools) |
| `src/viewer/` | Read-only local board UI (`botflow serve`, `board --html`) |
| `worker/` | Cloudflare manager: registry DO + project DOs + operator UI |
| `templates/basic/` | Workspace template ("kanban batteries") |
| `.botflow/` | This repo's own board: botflow built itself on botflow |

Verify a checkout with `node --run test` (node:test, no deps) and `node --run typecheck`.

## Prior art

Built on the shoulders of: [Backlog.md](https://github.com/MrLesk/Backlog.md) (md-file-per-task conventions), [beads](https://github.com/steveyegge/beads) (`ready`/`prime`/claim verbs for agents), Jira status categories & Linear status types (canonical projection), [Portfolio Kanban](https://www.nimblework.com/kanban/portfolio-kanban/) (board-of-boards rollup), [AGENTS.md](https://agents.md/) (repo-describes-how-to-act), [degit](https://github.com/Rich-Harris/degit)/cookiecutter (template instantiation), [git-bug](https://github.com/git-bug/git-bug) (what git-as-database can be), [Tokanban](https://tokanban.com/) (agent/operator split on Cloudflare actors). None combine files-in-git truth, canonical projection, recursive boards, an agent-first CLI, template instantiation, and a self-hostable multi-level manager: that composite is botflow.

## License

MIT
