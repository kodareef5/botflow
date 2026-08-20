# Verified — Scope 08: Repo hygiene & supply chain

Verifier: Wave 2 adversarial audit, 2026-08-20. Source report: `audit/findings/08-hygiene.md`.
All commands re-run against the live working tree; no source modified, no git mutations.

## F08-1: No `.gitignore` coverage for wrangler `.dev.vars` or `.env*` secret files

- Verdict: CONFIRMED
- Final severity: Low
- Overlaps: none (internally cross-referenced by F08-2)
- Verification:
  - Read `.gitignore` (working tree and `git show HEAD:.gitignore`): 8 patterns — `node_modules/`, `dist/`, `.wrangler/`, `CARD-FEATURES.md` (uncommitted local addition), `.botflow/index.db`, `*.db-journal`, `*.db-wal`, `*.db-shm`. No `.dev.vars`, `.dev.vars.*`, or `.env*` entry, exactly as reported.
  - `git check-ignore -v .dev.vars worker/.dev.vars .env` → no output, exit 1 (none ignored).
  - Wrangler convention confirmed in the pinned dependency itself: `node_modules/wrangler/wrangler-dist/cli.js:255745` — "Add them to .dev.vars, .env, or set as environment variables."
  - Exploit premise is realistic: `README.md:247-249` documents `npm run dev:manager` (wrangler dev) and `wrangler secret put SETUP_KEY`; `README.md:287` documents SETUP_KEY as the re-run-setup recovery path. A developer giving local wrangler a SETUP_KEY via `.dev.vars` is the standard workflow and would get no ignore protection.
  - Negative claims hold: `find . -name '.dev.vars'` (excl. node_modules) empty; `git log --all --full-history -- '**/.dev.vars' '*.env'` empty over all 67 commits.
- Severity rationale: not reachable by any threat-model attacker (hostile repo, MCP agent, browser, internet) — it is a maintainer footgun. Impact if triggered is high (public SETUP_KEY → recovery control of an internet-facing deployment), but the trigger is speculative and no such file exists today. Low is honest, not generous.

## F08-2: `npm publish` ships the entire working tree — no `files` allowlist or `.npmignore`

- Verdict: CONFIRMED
- Final severity: Low
- Overlaps: none (chains with F08-1, as the report itself notes)
- Verification:
  - `package.json` read directly: no `files` field; `ls .npmignore` → not present.
  - `npm pack --dry-run` re-run: **325 total files** (report said 317). The delta is exactly the 8 new untracked `audit/findings/*.md` files — which the pack output shows shipping (`npm notice 10.1kB audit/findings/08-hygiene.md` etc.). This is a live demonstration of the finding: this very security audit, untracked and local-only, would be published to the public registry if the maintainer ran `npm publish` today.
  - Untracked scratch file confirmed in the tarball: `npm notice 10.3kB coverart.patch` (`git status --porcelain` shows `?? coverart.patch`).
  - Both dogfood boards confirmed in the tarball: `.botflow/board.yaml` + all `.botflow/cards/*` (including security-review cards 013/014) and `worker/.botflow/cards/*`.
  - `npm pack --dry-run` created no artifact (`ls *.tgz` → none), so verification left no residue.
- Severity rationale: the trigger is a deliberate maintainer `npm publish`; all *tracked* content is already public. The genuine marginal hazard is real and demonstrated (untracked local-only files — scratch patches, future `.dev.vars`, these audit findings — permanently escape to the public registry), but it is not attacker-controlled and npm shows the file list before publish. Low stands.

## F08-3: `npm pack` tarball artifact (`*.tgz`) is not gitignored

- Verdict: CONFIRMED
- Final severity: Info
- Overlaps: none
- Verification:
  - `git check-ignore -v botflow-0.1.0.tgz` → no match (exit 1 in the combined call).
  - Default artifact name/location confirmed by the dry run itself: `npm notice filename: botflow-0.1.0.tgz` in repo root.
  - No `.tgz` present in the tree today; impact is repository pollution and compounding F08-2 (a committed tarball would itself be packed). Info is the right rating.

## F08-4: devDependency toolchain carries binary postinstall scripts (esbuild, workerd, fsevents)

- Verdict: CONFIRMED
- Final severity: Info
- Overlaps: none
- Verification:
  - `grep -n "hasInstallScript" package-lock.json` → exactly 3 hits (lines 1656, 1698, 1896); context inspection shows they are `node_modules/esbuild`, `node_modules/fsevents`, `node_modules/workerd` — precisely the three named in the report, all transitive deps of the wrangler dev toolchain.
  - `package.json` scripts contain no `preinstall`/`postinstall`/`install`/`prepare` (grep, exit 1).
  - Lockfile re-checked: lockfileVersion 3, 116 package entries, all 115 non-root entries resolve to `https://registry.npmjs.org` with `integrity` hashes (the root `""` entry carries neither, which is normal — the report's "all 116" wording is trivially imprecise here, not wrong in substance).
  - dev-only, pinned, integrity-hashed, and consistent with AGENTS.md's devDependency allowance. "No action required" is the correct disposition; Info stands.

## Checked-clean spot checks (independent re-verification)

- **No committed secrets — one quick grep pass, holds up:**
  - Working tree (`grep -rInE 'AKIA[0-9A-Z]{16}|ghp_…|sk-…|xox[baprs]-|-----BEGIN … PRIVATE KEY'`, excluding node_modules/.git/.wrangler): zero matches.
  - Generic assignment grep (`(api[_-]?key|password|secret)\s*[:=]\s*['"]?[A-Za-z0-9/+_-]{16,}`): only `worker/src/project.ts:434` and `:470`, both `const secret = randomSigningSecret();` — runtime-generated secrets in code, not hardcoded credentials.
  - `git ls-files` sensitive-name grep: no `.env`/`.pem`/`.key`/`.p12`/secret/credential files; `token` matches are exactly 5 `.botflow` card-slug filenames, as the report said.
  - History: 67 commits total (matches report); no `*.pem`/`*.key`/`*.p12`/`**/.dev.vars` path ever committed; `git grep` for `BEGIN … PRIVATE KEY` across all revs → nothing.
- `npm audit` and `npm audit --omit=dev` re-run 2026-08-20: **0 vulnerabilities** both, confirming the report's claim.

## Verification summary

- Verdicts: 4 CONFIRMED, 0 CONFIRMED-ADJUSTED, 0 REJECTED.
- Every checkable claim in this report reproduced exactly — the one numeric delta (317 → 325 pack files) is fully explained by the 8 audit-finding files added since Wave 1, and that delta itself demonstrates F08-2 better than the original evidence did.
- Scope health: this is hygiene, not vulnerability — all four items are maintainer footguns or informational notes, none reachable by the threat model's attackers. The two real gaps (F08-1, F08-2) share one root cause — no secret-file/publish allowlisting — and both fixes are one-line, zero-dependency config changes worth landing together before the next publish.
