# AGENTS.md

botflow is a git-native kanban spec + engine for AI agents. TypeScript, **zero runtime dependencies**, Node ≥ 24.

## Commands

- Test: `node --test` (uses built-in `node:test`; test files live in `test/*.test.ts`)
- Typecheck: `node --run typecheck` (tsc --noEmit)
- Run CLI from source: `node src/cli/main.ts …` (Node 24 strips TS types natively)

## Hard rules

- **Zero runtime dependencies.** Node built-ins only (`node:sqlite`, `node:http`, `node:test`, `util.parseArgs`). Never add a runtime dep. devDependencies are limited to `typescript`, `@types/node`, and (worker only) `wrangler` / `@cloudflare/workers-types`; ask before adding others.
- **Erasable TypeScript only** — code runs via Node's type stripping. No `enum`, no `namespace`, no parameter properties, no `const enum`. Relative imports must include the `.ts` extension.
- **Spec first.** Any behavior change to the format starts in `spec/SPEC.md` and `test/fixtures/` before touching `src/`.
- Fixtures in `test/fixtures/` are conformance vectors — never "fix" a fixture to make code pass without updating the spec.

## Task tracking (botflow — this repo dogfoods itself)

Run `node src/cli/botflow.ts prime` for workflow context and track your work as cards
on `.botflow/` (claim before working, `log` progress, close with a reason). The
Cloudflare manager work lives on the sub-board at `worker/.botflow` (card 008 rolls
it up). Never hand-edit the `## Log` sections — append via the CLI.

- Worker code: typecheck with `tsc --noEmit -p worker`; run locally with `npm run dev:manager`.
- Worker modules may import `src/core/*` **except** `load.ts`/`mutate.ts`/`template.ts` at
  runtime (those touch the filesystem); type-only imports are fine.
