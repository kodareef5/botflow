// Sync a file-truth board with a hosted botflow manager project.
// remote.yaml (committable: no secrets) holds the url + project id; the
// token always comes from --token or BOTFLOW_TOKEN.
//
// The sync contract (SPEC §12): repo documents are truth; hosted state is a
// snapshot of them plus a manager overlay (hosted-native project cards
// survive a push). Push and pull are whole-board snapshots, last write wins,
// and every import lands in the audit log. Push captures its snapshot under
// the board lock (one local instant). Pull is a validated, crash-safe
// snapshot apply: the whole remote snapshot validates before any write, the
// dirty-tree gate and the apply run under the board lock, and every write is
// temp+rename; the set is not atomic, so an interrupted pull leaves valid
// files that a re-run converges.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { validateBoardDocuments } from '../core/docs.ts';
import { readBoardDocuments } from '../core/load.ts';
import { atomicWrite, withBoardLock } from '../core/mutate.ts';
import { UsageError } from '../core/ops.ts';
import { parseYaml } from '../core/yaml.ts';

export interface RemoteConfig {
  url: string;
  project: string;
}

const REMOTE_FILE = 'remote.yaml';

export function remoteAdd(root: string, url: string, project: string): void {
  const clean = url.replace(/\/+$/, '');
  writeFileSync(join(root, REMOTE_FILE), `url: ${clean}\nproject: ${project}\n`);
}

export function loadRemote(root: string): RemoteConfig {
  const path = join(root, REMOTE_FILE);
  if (!existsSync(path)) throw new UsageError('no remote configured: run `botflow remote add <url> <project-id>`');
  const data = parseYaml(readFileSync(path, 'utf8')) as { url?: unknown; project?: unknown };
  if (typeof data.url !== 'string' || typeof data.project !== 'string') {
    throw new UsageError(`${REMOTE_FILE} needs url and project`);
  }
  return { url: data.url.replace(/\/+$/, ''), project: data.project };
}

async function call(remote: RemoteConfig, token: string, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${remote.url}/api/projects/${remote.project}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  }).catch((err: Error) => {
    throw new UsageError(`cannot reach ${remote.url}: ${err.message}`);
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new UsageError(`remote ${res.status}: ${String(body['error'] ?? 'request failed')}`);
  return body;
}

export async function push(root: string, token: string, actor: string): Promise<{ imported: number; findings: number }> {
  // Capture the snapshot under the board lock so it represents one local
  // instant, then release before any network I/O.
  const { configText, cards } = withBoardLock(root, () => readBoardDocuments(root));
  if (configText === null) throw new UsageError('no board.yaml to push');
  const remote = loadRemote(root);
  return (await call(remote, token, '/import', {
    method: 'PUT',
    body: JSON.stringify({ config: configText, cards, actor }),
  })) as { imported: number; findings: number };
}

/** Files pull would replace or delete (board.yaml, cards/**) that git has
 *  uncommitted changes for. Deliberately scoped: remote.yaml and other board
 *  metadata are not pull's blast radius. Outside a git repo, or without git,
 *  there is nothing to guard. */
function dirtyBoardFiles(root: string): string[] {
  const res = spawnSync('git', ['status', '--porcelain', '--', 'board.yaml', 'cards'], { cwd: root, encoding: 'utf8' });
  if (res.error || res.status !== 0) return [];
  return res.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.slice(3));
}

export async function pull(root: string, token: string, force = false): Promise<{ written: number; removed: number }> {
  const remote = loadRemote(root);
  const data = (await call(remote, token, '/export')) as { config: unknown; cards: unknown };

  // Gate 1: the entire snapshot must validate before a single file changes.
  const validation = validateBoardDocuments(data.config, data.cards);
  if ('error' in validation) throw new UsageError(`refusing pull, remote snapshot is invalid: ${validation.error}`);
  const docs = validation.docs;

  // Everything local happens under the board lock, INCLUDING the dirty-tree
  // gate: checking before taking the lock would let another process create
  // work in the gap that the apply then destroys. What follows is a
  // validated, crash-safe snapshot apply: each write is temp+rename, but the
  // set is not atomic; an interrupted pull leaves valid files that a re-run
  // converges.
  return withBoardLock(root, () => {
    // Gate 2: never destroy work git has not seen. Snapshot pull removes
    // local cards missing remotely, so uncommitted changes need --force.
    if (!force) {
      const dirty = dirtyBoardFiles(root);
      if (dirty.length > 0) {
        const shown = dirty.slice(0, 5).map((f) => `  ${f}`).join('\n');
        throw new UsageError(
          `refusing pull: ${dirty.length} board file(s) have uncommitted changes:\n${shown}${dirty.length > 5 ? '\n  …' : ''}\ncommit or stash first, or re-run with --force`,
        );
      }
    }
    atomicWrite(join(root, 'board.yaml'), data.config as string);
    let written = 0;
    for (const doc of docs) {
      const target = join(root, doc.path);
      mkdirSync(dirname(target), { recursive: true });
      atomicWrite(target, doc.text);
      written++;
    }
    const cardsDir = join(root, 'cards');
    let removed = 0;
    const remotePaths = new Set(docs.map((c) => c.path));
    if (existsSync(cardsDir) && statSync(cardsDir).isDirectory()) {
      for (const rel of readdirSync(cardsDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.md'))) {
        const path = `cards/${rel.split(sep).join('/')}`;
        if (!remotePaths.has(path)) {
          rmSync(join(root, path));
          removed++;
        }
      }
    }
    return { written, removed };
  });
}
