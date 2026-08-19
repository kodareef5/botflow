# botflow

**A workflow protocol your repo can carry.** Different agents, different workflows, one composable state model: every board, however specialized its lanes, projects onto six canonical states, so anything above it can aggregate it without knowing its shape.

```text
   security audit                 software project
   ──────────────                 ────────────────
   candidates                     backlog
   → reproduce                    → design
   → validate                     → implement
   → disclose                     → review
   → paid                         → ship
        │                              │
        ▼ projects onto               ▼ projects onto
   wishlist · todo · doing · blocked · done · archive
        │                              │
        └───────────────┬──────────────┘
                        ▼
                portfolio board
     rolls both up, blind to either one's shape
```

In practice that means **git-native kanban for AI agents**: a file format your repo carries, a CLI agents drive, a board humans read, and an optional self-hosted manager for the whole company.

## The idea

- **Boards are directories.** `board.yaml` (lanes, rules) + `cards/*.md` (one card, one file). Truth is plain files in git: history is your audit log, branches are workflow variants, merges are card merges.
- **Six canonical states**: `wishlist · todo · doing · blocked · done · archive`. Every custom lane declares which canonical state it projects onto (like Jira's status categories, but in a plain-text spec). That projection is what lets *any* two boards be aggregated, no matter how specialized their lanes are.
- **Cards can be boards.** A card with `type: board` contains another board (a subdirectory). Parents roll up children by canonical distribution: portfolio kanban without the parent ever knowing the child's shape. Progress is **structural**: every card is one unit of its board, and a sub-board fills its single unit by its own fraction, however many cards live inside it.
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

`worker/` is a self-hosted board manager: **Company → Spaces → Projects (projects own projects; a project is a board)** with a web UI at every level, **member accounts** for people and bots alike, and an append-only **audit log**. One SQLite-backed Durable Object per project serializes all writes; boards are stored in the exact same document format the CLI uses.

```sh
npm run dev:manager                # local: http://127.0.0.1:8787
npm run deploy:manager             # deploy to your Cloudflare account
npx wrangler secret put SETUP_KEY  # required before public first-run setup
```

The dev server is a **full local instance**: workerd with SQLite Durable Objects persisted
under `.wrangler/state/`, no Cloudflare account or network needed. Keep one running under a
supervisor for local testing (`pm2 start "npm run dev:manager -- --port 4700" --name
botflow-manager --cwd <repo>`); source changes hot-reload. Deleting `.wrangler/` resets the
instance: company, accounts, boards, everything. Loopback setup is intentionally zero-config;
an internet-hosted deployment refuses initialization until `SETUP_KEY` is configured as a
Worker secret. Deploy-button users can add it under **Settings → Variables and Secrets** in
the Cloudflare dashboard. Enter that value once in the setup form; it is not your password.
The same secret is the recovery path: "lost access?" on the login page resets an owner's
password (ending every live session), and anyone can change their own password from settings.
Both are audited.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kodareef5/botflow)
*(the button needs this repo public on GitHub; `wrangler deploy` works regardless)*

Visitors get a consumer pitch at `/about`, live public share links can optionally sit on the
login page (admin-controlled and off by default), and settings offers a one-click **Scoops Empire** demo
company plus a full **company export** (every space, project, board, and card as one
restore-grade JSON, including member records with password hashes, api key hashes, and share
links; store it like a credential, because it is one). The demo source ships in
`demo/icecream-empire.json`.

After the setup key is configured, the first visit names the company and creates the **owner**
account. From the UI: create spaces and projects, add members, watch boards and activity live.

> **Upgrading an existing deployment is a deliberate auth reset.** The admin
> token and every `bfk_` agent key stop working, and a company export taken
> before this change restores its boards but not its keys. Spaces, projects,
> boards, and cards are untouched: the instance reports itself uninitialized,
> you re-run setup behind `SETUP_KEY` to create the owner account, and
> everything is where you left it. Re-issue bot credentials from each member's
> account afterwards.

### Members, scopes, and roles

Everyone on a board is a member with a username and password. Humans and bots use the same
model; a bot is just a member with `kind: bot`.

- **Scope** is where a member can reach: the whole **company**, one **space** (every project
  in it), or one **project** and everything nested beneath it.
- **Role** is what they can do there: **read** (look, cannot touch), **write** (work the
  board), or **owner** (run the company: spaces, board shape, members, sharing, `force`).
- **Username is permanent** because it is the actor string written into every card's `## Log`
  and its `assignee`. **Display name is not**: renaming a member updates every board view at
  once, without rewriting a single card. Card history stays byte-stable and git-diff-clean.

A member holds a password and, optionally, any number of **api keys**. A key carries that
member's identity and scope and can be revoked on its own, which is what makes it the right
credential for CI. A key's label ("laptop", "CI runner") is a note to yourself, not an
identity: unnamed keys name themselves `api key #1`, `#2`, and so on, and renaming one changes
nothing on any board.

So a bot can authenticate three ways, all resolving to the same identity:

```sh
curl -u scout:… https://manager.example.workers.dev/api/whoami   # its own credentials
curl -H 'authorization: Bearer bfk_…' …                          # an api key
curl -H 'authorization: Bearer bfu_…' …                          # a session from /api/login
```

Link a repo board and sync snapshots (`BOTFLOW_TOKEN` takes an api key):

```sh
botflow remote add https://manager.example.workers.dev p-abc123
BOTFLOW_TOKEN=bfk_… botflow push   # or pull
```

Hosted actions are always logged under the authenticated member: a request body cannot name a
different actor, so `botflow push --actor X` is ignored by the manager (it still applies to a
local board).

Binary attachment uploads are opt-in: create an R2 bucket and bind it as `ATTACHMENTS`
(one commented line in `wrangler.jsonc`, or the dashboard). The UI lights up an upload
button; files land in R2, cards record a normal markdown attachment line pointing at
`/files/…`, images join the gallery and cover art, and deleting a project purges its
files. Without the binding everything else works and uploads simply stay hidden.
Note that the company export carries a manifest of uploaded keys but not the bytes:
back the bucket up separately (`wrangler r2 object get`, rclone, or dashboard tools)
before deleting anything whose files you want to keep. Uploaded file URLs are permanent
bearer capabilities (128-bit random keys): anyone holding a URL can fetch that file, and
revoking a share link does not revoke file URLs that were already copied.

The sync contract: your repo's documents are truth, and sync is a whole-board snapshot
(last write wins). The hosted board is that snapshot plus a manager overlay: sub-projects
created in the manager survive a push even though your repo never carried them. Both
directions validate the entire snapshot before writing anything, every write is
crash-safe, and `pull` refuses to overwrite uncommitted board changes unless you pass
`--force`. An interrupted pull leaves only valid files; re-running it converges.

## What it looks like

The manager includes five complete visual worlds: Harbor, Phosphor, Field Notes,
Mochi, and Block Party. Each has four tuned accents, light and dark modes, and
purpose-built compact or relaxed density. The workflow stays familiar while the
character, color, type, shape, and rhythm change together.

<p align="center">
  <img src="docs/shots/board.png" alt="Botflow manager board in the Harbor visual world" width="100%">
</p>
<p align="center">
  <img src="docs/shots/card.png" alt="Botflow card detail with cover art, metadata, tabs, and an attachment" width="49%">
  <img src="docs/shots/themes.png" alt="Botflow settings showing five visual worlds, accents, density, and color mode" width="49%">
</p>
<p align="center">
  <img src="docs/shots/phosphor.png" alt="Botflow manager board in the dark compact Phosphor visual world" width="100%">
</p>

## Layout

| Path | What |
|---|---|
| `spec/SPEC.md` | The format spec: the real product |
| `test/fixtures/` | Golden boards; the spec's conformance vectors |
| `src/core/` | Engine: parse → model → lint → project → rollup, pure ops |
| `src/cli/` | The `botflow` CLI (incl. push/pull sync) |
| `src/mcp/` | MCP server (stdio JSON-RPC, 18 tools) |
| `src/viewer/` | Read-only local board UI (`botflow serve`, `board --html`) |
| `worker/` | Cloudflare manager: registry DO + project DOs + operator UI |
| `templates/basic/` | Workspace template ("kanban batteries") |
| `.botflow/` | This repo's own board: botflow built itself on botflow |

Verify a checkout with `node --run test` (node:test, no deps) and `node --run typecheck`.

## Prior art

Built on the shoulders of: [Backlog.md](https://github.com/MrLesk/Backlog.md) (md-file-per-task conventions), [beads](https://github.com/steveyegge/beads) (`ready`/`prime`/claim verbs for agents), Jira status categories & Linear status types (canonical projection), [Portfolio Kanban](https://www.nimblework.com/kanban/portfolio-kanban/) (board-of-boards rollup), [AGENTS.md](https://agents.md/) (repo-describes-how-to-act), [degit](https://github.com/Rich-Harris/degit)/cookiecutter (template instantiation), [git-bug](https://github.com/git-bug/git-bug) (what git-as-database can be), [Tokanban](https://tokanban.com/) (agent/operator split on Cloudflare actors). None combine files-in-git truth, canonical projection, recursive boards, an agent-first CLI, template instantiation, and a self-hostable multi-level manager: that composite is botflow.

## License

MIT
