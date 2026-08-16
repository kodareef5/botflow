// Sync a file-truth board with a hosted botflow manager project.
// remote.yaml (committable: no secrets) holds the url + project id; the
// token always comes from --token or BOTFLOW_TOKEN. Push/pull are whole-board
// snapshots: last write wins, and every import lands in the audit log.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import type { BoardDocument } from '../core/docs.ts';
import { readBoardDocuments } from '../core/load.ts';
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
  const { configText, cards } = readBoardDocuments(root);
  if (configText === null) throw new UsageError('no board.yaml to push');
  const remote = loadRemote(root);
  return (await call(remote, token, '/import', {
    method: 'PUT',
    body: JSON.stringify({ config: configText, cards, actor }),
  })) as { imported: number; findings: number };
}

/** Card doc paths must stay inside cards/: refuse anything path-traversal-shaped. */
function safeCardPath(path: string): boolean {
  return path.startsWith('cards/') && !path.split('/').some((part) => part === '..' || part === '' || part.includes(sep));
}

export async function pull(root: string, token: string): Promise<{ written: number; removed: number }> {
  const remote = loadRemote(root);
  const data = (await call(remote, token, '/export')) as { config: string | null; cards: BoardDocument[] };
  if (typeof data.config !== 'string' || !Array.isArray(data.cards)) throw new UsageError('malformed export from remote');

  writeFileSync(join(root, 'board.yaml'), data.config);

  // Snapshot semantics: local card files not present remotely are removed.
  const cardsDir = join(root, 'cards');
  let removed = 0;
  const remotePaths = new Set(data.cards.map((c) => c.path));
  if (existsSync(cardsDir) && statSync(cardsDir).isDirectory()) {
    for (const rel of readdirSync(cardsDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.md'))) {
      const path = `cards/${rel.split(sep).join('/')}`;
      if (!remotePaths.has(path)) {
        rmSync(join(root, path));
        removed++;
      }
    }
  }
  let written = 0;
  for (const doc of data.cards) {
    if (!safeCardPath(doc.path) || typeof doc.text !== 'string') continue;
    const target = join(root, doc.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, doc.text);
    written++;
  }
  return { written, removed };
}
