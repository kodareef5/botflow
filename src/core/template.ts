// Workspace instantiation: `botflow new <src>[#branch] <dir>`: the
// "preplanned environments with kanban batteries" story. A template is any
// repo (or branch of one) carrying a board + agent playbook; instantiating is
// a history-free copy into a fresh repo.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { UsageError } from './mutate.ts';
import { emitScalar } from './emit.ts';
import { resolveBoardRoot } from './load.ts';

export interface InstantiateResult {
  dest: string;
  boardRoot: string | null;
  warnings: string[];
}

function git(args: string[], cwd?: string): { ok: boolean; err: string } {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: res.status === 0, err: (res.stderr || res.stdout || '').trim() };
}

/** Split `src[#branch]`: the branch selects a workflow variant. */
export function parseSource(spec: string): { src: string; branch: string | null } {
  const hash = spec.lastIndexOf('#');
  if (hash <= 0) return { src: spec, branch: null };
  return { src: spec.slice(0, hash), branch: spec.slice(hash + 1) };
}

export function instantiate(spec: string, destDir: string, name?: string): InstantiateResult {
  const { src, branch } = parseSource(spec);
  // A source like "-u/tmp/x.sh" would be consumed by git clone as an option.
  if (src.startsWith('-')) throw new UsageError(`template source must not start with "-": ${spec}`);
  const dest = resolve(destDir);
  const warnings: string[] = [];

  if (existsSync(dest)) {
    if (!statSync(dest).isDirectory()) throw new UsageError(`destination ${dest} exists and is not a directory`);
    if (readdirSync(dest).length > 0) throw new UsageError(`destination ${dest} exists and is not empty`);
  }

  const localPlainDir = existsSync(src) && !existsSync(join(src, '.git'));
  if (localPlainDir) {
    if (branch !== null) throw new UsageError(`"${src}" is not a git repo: #${branch} needs one`);
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true, filter: (p) => !p.split('/').includes('.git') });
  } else {
    // git handles URLs and local repo paths alike; shallow = history-free.
    // `--` keeps a dash-leading source from being parsed as an option.
    const args = ['clone', '--depth', '1', ...(branch !== null ? ['--branch', branch] : []), '--', src, dest];
    const res = git(args);
    if (!res.ok) throw new UsageError(`git clone failed: ${res.err}`);
    rmSync(join(dest, '.git'), { recursive: true, force: true });
  }

  // Fresh history for the new project.
  const init = git(['init', '-q'], dest);
  if (!init.ok) {
    warnings.push(`git init failed (${init.err}): continuing without a repo`);
  } else {
    git(['add', '-A'], dest);
    const commit = git(
      ['-c', 'user.name=botflow', '-c', 'user.email=botflow@local', 'commit', '-qm', `Instantiate from ${spec}`],
      dest,
    );
    if (!commit.ok) warnings.push(`initial commit failed (${commit.err})`);
  }

  const boardRoot = resolveBoardRoot(dest);
  if (boardRoot === null) warnings.push('template has no botflow board: run `botflow init` to add one');
  else if (name !== undefined) {
    const configPath = join(boardRoot, 'board.yaml');
    const text = readFileSync(configPath, 'utf8');
    const safe = emitScalar(name.replace(/[\r\n]+/g, ' ').trim() || 'board');
    writeFileSync(configPath, text.replace(/^name: .*$/m, `name: ${safe}`));
  }

  return { dest, boardRoot, warnings };
}

const MARKER = 'botflow prime';

const SNIPPET = `
## Task tracking (botflow)

This project tracks work on a botflow board (\`.botflow/\`). Start every session with:

\`\`\`
botflow prime
\`\`\`

Workflow: \`botflow ready\` → \`botflow card claim <id> --actor <you>\` → work, narrating with
\`botflow log <id> "<what happened>"\` → \`botflow card mv <id> <lane[.substate]>\` →
\`botflow card close <id> --reason "<summary>"\`. Stuck? \`botflow card block <id> --reason "<why>"\`
instead of stalling silently. Every command accepts \`--json\`.
`;

/** Wire the playbook into agent instruction files. Idempotent. */
export function setupAgentFiles(dir: string, target: 'agents' | 'claude' | 'codex'): string[] {
  const files = target === 'claude' ? ['CLAUDE.md', 'AGENTS.md'] : ['AGENTS.md'];
  const touched: string[] = [];
  for (const file of files) {
    const path = join(dir, file);
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (existing !== null && existing.includes(MARKER)) continue;
    writeFileSync(path, existing === null ? `# ${file === 'CLAUDE.md' ? 'CLAUDE' : 'AGENTS'}.md\n${SNIPPET}` : existing.trimEnd() + '\n' + SNIPPET);
    touched.push(file);
  }
  return touched;
}
