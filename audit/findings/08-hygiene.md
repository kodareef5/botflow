# Scope 08 — Repo hygiene & supply chain

Audited: `package.json`, `package-lock.json`, `.gitignore` (root, `.botflow/`, `worker/.botflow/`, `templates/basic/.botflow/`), `wrangler.jsonc`, `templates/`, `demo/icecream-empire.json`, `docs/`, `spec/SPEC.md`, `README.md`, `bin/botflow.js`, git tracked-file list, working-tree secret grep, and bounded git history (67 commits).

## F08-1: No `.gitignore` coverage for wrangler `.dev.vars` or `.env*` secret files

- Severity: Low
- CWE: 538 (Insertion of Sensitive Information into Externally-Accessible File or Directory)
- Location: `.gitignore:1-8`
- Description: The README documents `npm run dev:manager` (wrangler dev) as the local workflow and `wrangler secret put SETUP_KEY` for deployment. Wrangler's convention for local secret overrides is a `.dev.vars` file in `KEY=VALUE` form (confirmed: `node_modules/wrangler/wrangler-dist/cli.js` references "`.dev.vars` file in the form KEY=VALUE"). The root `.gitignore` covers `node_modules/`, `dist/`, `.wrangler/`, `CARD-FEATURES.md`, and SQLite sidecars — but has no `.dev.vars`, `.dev.vars.*`, or `.env*` entry. A developer who creates `.dev.vars` (the standard way to give `wrangler dev` a local `SETUP_KEY` or `EMAIL_BRIDGE_*` value) receives no protection against `git add -A` committing it.
- Exploit scenario: Developer standing up the manager locally creates `.dev.vars` with a real `SETUP_KEY` (or another Worker secret), commits inadvertently, and pushes to the public GitHub remote. The setup/recovery key — which README documents as the lost-access password-reset path — is now public, giving anyone first-run/recovery control of that deployment. No such file exists today: `find . -name '.dev.vars'` is empty, `git log --all --full-history -- '**/.dev.vars' '*.env'` finds nothing, and `git check-ignore -v .dev.vars worker/.dev.vars .env` matches nothing (which is the problem).
- Evidence:
  ```
  $ git check-ignore -v .dev.vars worker/.dev.vars .env
  (no output — none are ignored)
  $ cat .gitignore
  node_modules/
  dist/
  .wrangler/
  CARD-FEATURES.md
  .botflow/index.db
  *.db-journal
  *.db-wal
  *.db-shm
  ```
- Suggested fix: Add `.dev.vars`, `.dev.vars.*`, and `.env*` (with `!.env.example` if templates are ever wanted) to the root `.gitignore`. No dependency or code change needed.

## F08-2: `npm publish` ships the entire working tree — no `files` allowlist or `.npmignore` — including untracked scratch files

- Severity: Low
- CWE: 538 (Insertion of Sensitive Information into Externally-Accessible File or Directory)
- Location: `package.json` (absence of a `files` field; no `.npmignore` present)
- Description: npm falls back to `.gitignore` for publish exclusion ("npm warn gitignore-fallback No .npmignore file found"). Anything in the working tree that is not gitignored is packaged — including *untracked* files git has never seen. `npm pack --dry-run` today produces a 317-file tarball containing both dogfood boards (`.botflow/cards/*`, `worker/.botflow/cards/*` — internal security-review task cards), `test/`, `docs/`, `spec/`, `demo/`, `wrangler.jsonc`, and the **untracked** `coverart.patch` scratch file. The tracked-content disclosure is mostly moot (the repo is already public per the deploy-button URL), but the untracked-file inclusion is the live hazard: anything a developer leaves in the tree at publish time ships to the registry. Combined with F08-1, a future `.dev.vars` would be published as well as committed.
- Exploit scenario: Maintainer runs `npm publish` with a stray file in the working tree — a scratch patch, a downloaded company export JSON (README: "store it like a credential, because it is one"), or a `.dev.vars` — and the file is permanently published to the public npm registry under the package tarball, where mirrors retain it even after unpublish windows close.
- Evidence:
  ```
  $ npm pack --dry-run
  npm warn gitignore-fallback No .npmignore file found ...
  npm notice 10.3kB coverart.patch          # untracked per `git status --porcelain` (?? coverart.patch)
  npm notice 332B   .botflow/board.yaml     # + all 25 dogfood cards
  npm notice ... worker/.botflow/cards/*    # second dogfood board
  npm notice total files: 317
  ```
- Suggested fix: Add an explicit allowlist to `package.json`, e.g. `"files": ["bin", "src", "templates", "demo", "spec", "worker", "wrangler.jsonc"]` (README/LICENSE/package.json are always included). Optionally also add a `prepublishOnly` check. Zero-dependency compatible.

## F08-3: `npm pack` tarball artifact (`*.tgz`) is not gitignored

- Severity: Info
- CWE: n/a (hygiene)
- Location: `.gitignore:1-8`
- Description: `npm pack` without `--dry-run` drops `botflow-0.1.0.tgz` in the repo root, and no ignore rule matches it. Given F08-2's whole-tree packing, a committed tarball would also be embedded in subsequent publishes.
- Exploit scenario: None beyond repository pollution and compounding F08-2.
- Evidence: `git check-ignore botflow-0.1.0.tgz` matches nothing; the `npm pack` dry run confirms the default output name/location.
- Suggested fix: Add `*.tgz` to `.gitignore`.

## F08-4: devDependency toolchain carries binary postinstall scripts (esbuild, workerd, fsevents)

- Severity: Info
- CWE: n/a (supply-chain note)
- Location: `package-lock.json` (`"hasInstallScript": true` on `node_modules/esbuild`, `node_modules/workerd`, `node_modules/fsevents`)
- Description: Three transitive packages of the wrangler dev toolchain run install scripts (esbuild/workerd fetch or link platform binaries). This is expected and consistent with AGENTS.md's devDependency allowance: they are dev-only, never shipped to consumers of the `botflow` bin, and every entry is version-pinned with a `sha512` integrity hash in `package-lock.json`. No action required; recorded so the constraint is explicit if the toolchain is ever swapped.
- Exploit scenario: A compromised upstream esbuild/workerd release would execute code at `npm ci` time on developer machines — inherent to any binary-shipping devDependency; mitigated here by lockfile pinning + integrity.
- Evidence: `package.json` scripts contain no `preinstall`/`postinstall`/`install`/`prepare`; only the three transitive packages above carry `hasInstallScript`.
- Suggested fix: None. Keep devDependencies minimal per AGENTS.md and review lockfile diffs on upgrades.

## Checked clean

- `package-lock.json` integrity: lockfileVersion 3; all 116 package entries have `https://registry.npmjs.org` resolved URLs and `integrity` hashes; zero git/tarball/external resolutions — verified by script over every entry.
- Vulnerability audit: `npm audit` and `npm audit --omit=dev` both report 0 vulnerabilities (2026-08-20).
- Dependency currency: typescript 7.0.2, @types/node 26.2.0 at latest; wrangler 4.123.0 (latest 4.124.0) and @cloudflare/workers-types 5.20260816.1 (latest 5.20260820.1) are days behind — not findings.
- Working-tree secret grep: no `AKIA…`, `ghp_…`, `sk-…`, `xox*…`, `-----BEGIN … PRIVATE KEY`, `api[_-]?key =`, `password =`, or high-entropy base64 tokens outside lockfile integrity hashes and PNG fixtures in `test/worker.test.ts`.
- Git history (67 commits): `git log -p --all -S` for `password`, `secret`, `api_key`, `apiKey`, `BEGIN ` and full-history path search for `*.env`, `*.pem`, `*.key`, `**/.dev.vars` found no committed secrets; `wrangler.jsonc` history (3 commits) never contained keys/secrets/account ids.
- Tracked sensitive-named files: `git ls-files | grep -iE '\.(env|pem|key|p12)$|secret|credential|token'` matches only `.botflow` task-card filenames containing "token" in the slug — card content, not credentials.
- `wrangler.jsonc`: no `vars` block and no secrets — only DO bindings, a migration tag, and a commented-out R2 example; `SETUP_KEY` is correctly channeled through `wrangler secret put` per README.
- Token storage design: `src/cli/remote.ts:2-3` keeps `remote.yaml` secret-free by contract (url + project id only; token only from `--token`/`BOTFLOW_TOKEN`) and enforces https for non-loopback remotes on every call (`remote.ts:39-49`), so the deliberately-committable remote config leaks nothing.
- SQLite/derived-state ignores: board `index.db`, `index.db-*`, and `board.lock` are ignored per board (`.botflow/.gitignore`, `worker/.botflow/.gitignore`, template board) and `botflow init` writes this `.gitignore` itself (`src/core/mutate.ts:156`); root `*.db-journal/-wal/-shm` patterns are unanchored so they cover nested boards; `.wrangler/` (local DO state) is ignored.
- `templates/basic/`: inert markdown/YAML only; no executable files, no tokens; its `.botflow/.gitignore` omits `remote.yaml` deliberately (see remote.yaml contract above).
- `demo/icecream-empire.json`: pure import data (board configs + card markdown, `version: 1`); no scripts or credentials; only external references are `https://picsum.photos`/`https://example.com` demo image URLs (user-initiated demo load).
- `bin/botflow.js` launch safety: standard `#!/usr/bin/env node` shebang; a single relative import of `../src/cli/botflow.ts`; no shell, PATH, or environment manipulation; Node ≥24 requirement declared in `engines`.
- Docs/spec guidance: README and `docs/integrations.md` never instruct disabling auth or pasting secrets into files; minted secrets are show-once, exports are repeatedly labeled "store it like a credential," and the inbound-email token-in-URL exposure is documented with concrete mitigations (log redaction, TLS, rotation) at `docs/integrations.md:105-107`.
- `docs/shots/*.png`: all four screenshots visually inspected — demo "Scoops Empire" data only; no emails, tokens, session ids, or real URLs visible.
- Documented-but-insecure design decisions in `spec/SPEC.md`: none found; §12/§12a mandate symlink refusal on sync, single-line field sanitization, heading-escape against forged Log sections, a YAML subset with no anchors/aliases/tags (no expansion bombs), and bounded rules/buttons (≤16 rules, ≤100 cards) — all normative hardening, no insecure normative guidance.
