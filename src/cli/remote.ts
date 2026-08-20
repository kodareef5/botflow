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
// dirty-tree gate and the apply run under the board lock, every write/delete
// target is checked for symlink escapes before the first change, and every
// write is temp+rename; the set is not atomic, so an interrupted pull leaves
// valid files that a re-run converges.

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { validateBoardDocuments } from '../core/docs.ts';
import { emitScalar } from '../core/emit.ts';
import { loadBoard, readBoardDocuments } from '../core/load.ts';
import { atomicWrite, withBoardLock } from '../core/mutate.ts';
import { UsageError } from '../core/ops.ts';
import { parseYaml } from '../core/yaml.ts';

export interface RemoteConfig {
  url: string;
  project: string;
}

const REMOTE_FILE = 'remote.yaml';
const CALL_TIMEOUT_MS = 30_000;
export const MAX_REMOTE_RESPONSE_BYTES = 64 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The token is sent to whatever URL the committed remote.yaml names, so a
 *  plaintext URL would leak BOTFLOW_TOKEN to anyone who can commit. https is
 *  required; http stays allowed for loopback hosts (the local dev manager). */
function assertRemoteUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`remote url "${url}" is not a valid URL`);
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) return;
  throw new UsageError(`remote url must use https:// (http:// is allowed only for loopback hosts): ${url}`);
}

export function remoteAdd(root: string, url: string, project: string): void {
  const clean = url.replace(/\/+$/, '');
  assertRemoteUrl(clean);
  writeFileSync(join(root, REMOTE_FILE), `url: ${emitScalar(clean)}\nproject: ${emitScalar(project)}\n`);
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

export async function readResponseJson(res: Response, maxBytes = MAX_REMOTE_RESPONSE_BYTES): Promise<Record<string, unknown>> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new UsageError(`remote response exceeds the ${maxBytes}-byte limit`);
  }
  if (res.body === null) return {};
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new UsageError(`remote response exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function call(remote: RemoteConfig, token: string, path: string, init?: RequestInit, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
  // Enforced on every request, not just in `remote add`: the committed file
  // may be hand-edited (or committed hostile) afterwards.
  assertRemoteUrl(remote.url);
  const res = await fetch(`${remote.url}/api/projects/${remote.project}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  }).catch((err: Error) => {
    const why = err.name === 'TimeoutError' ? `timed out after ${timeoutMs / 1000}s` : err.message;
    throw new UsageError(`cannot reach ${remote.url}: ${why}`);
  });
  const body = await readResponseJson(res);
  if (!res.ok) throw new UsageError(`remote ${res.status}: ${String(body['error'] ?? 'request failed')}`);
  return body;
}

export async function push(root: string, token: string, actor: string, timeoutMs?: number): Promise<{ imported: number; findings: number }> {
  // Capture the snapshot under the board lock so it represents one local
  // instant, then release before any network I/O.
  const { configText, cards } = withBoardLock(root, () => readBoardDocuments(root));
  if (configText === null) throw new UsageError('no board.yaml to push');
  const remote = loadRemote(root);
  return (await call(remote, token, '/import', {
    method: 'PUT',
    body: JSON.stringify({ config: configText, cards, actor }),
  }, timeoutMs)) as { imported: number; findings: number };
}

/** Files pull would replace or delete (board.yaml, cards/**) that git has
 *  uncommitted changes for. Deliberately scoped: remote.yaml and other board
 *  metadata are not pull's blast radius. Missing git and non-repos are
 *  tolerated (there is nothing to guard with); any OTHER git failure fails
 *  closed, because pulling blind could destroy dirty cards. */
function dirtyBoardFiles(root: string): string[] {
  const res = spawnSync('git', ['status', '--porcelain', '--', 'board.yaml', 'cards'], { cwd: root, encoding: 'utf8' });
  if (res.error) {
    if ((res.error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new UsageError(`refusing pull: cannot check for uncommitted board changes: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim();
    if (/not a git repository/.test(detail)) return [];
    throw new UsageError(
      `refusing pull: cannot check for uncommitted board changes: git status failed: ${detail || `exit ${res.status}`}\nresolve the git problem first, or re-run with --force`,
    );
  }
  return res.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.slice(3));
}

/** Every path pull is about to write or delete must resolve through real
 *  directories and stay inside the real board root: a committed symlink
 *  (e.g. `cards -> ../elsewhere`) must not turn the apply loose on other
 *  directories. Runs before the first write or delete. */
function assertContainedTargets(root: string, relPaths: string[]): void {
  if (lstatSync(root).isSymbolicLink()) throw new UsageError(`refusing pull: board root ${root} is a symlink`);
  const rootReal = realpathSync(root);
  for (const rel of relPaths) {
    const abs = join(root, rel);
    for (let dir = dirname(abs); dir !== root && dir.startsWith(root + sep); dir = dirname(dir)) {
      if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
        throw new UsageError(`refusing pull: ${rel} passes through symlinked directory ${dir}`);
      }
    }
    let anchor = abs;
    while (!existsSync(anchor) && anchor !== root) anchor = dirname(anchor);
    const real = realpathSync(anchor);
    if (real !== rootReal && !real.startsWith(rootReal + sep)) {
      throw new UsageError(`refusing pull: ${rel} resolves outside the board`);
    }
  }
}

export async function pull(root: string, token: string, force = false, timeoutMs?: number): Promise<{ written: number; removed: number }> {
  const remote = loadRemote(root);
  const data = (await call(remote, token, '/export', undefined, timeoutMs)) as { config: unknown; cards: unknown };

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
    // Gate 2: an older reader may inspect a future board, never replace it.
    // `--force` only overrides dirty-worktree protection; it cannot override
    // format compatibility and silently downgrade the documents.
    const current = loadBoard(root);
    if (current.config.mutationBlocked !== null) {
      throw new UsageError(`refusing pull: board is read-only: ${current.config.mutationBlocked}`);
    }
    // Gate 3: never destroy work git has not seen. Snapshot pull removes
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
    // Gate 4: symlink containment. Compute the deletion set up front so every
    // write and delete target is checked before the first change happens.
    const remotePaths = new Set(docs.map((c) => c.path));
    const cardsDir = join(root, 'cards');
    const stale: string[] = [];
    if (existsSync(cardsDir) && statSync(cardsDir).isDirectory()) {
      for (const rel of readdirSync(cardsDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.md'))) {
        const path = `cards/${rel.split(sep).join('/')}`;
        if (!remotePaths.has(path)) stale.push(path);
      }
    }
    assertContainedTargets(root, ['board.yaml', ...remotePaths, ...stale]);

    atomicWrite(join(root, 'board.yaml'), data.config as string);
    let written = 0;
    for (const doc of docs) {
      const target = join(root, doc.path);
      mkdirSync(dirname(target), { recursive: true });
      atomicWrite(target, doc.text);
      written++;
    }
    for (const path of stale) rmSync(join(root, path));
    return { written, removed: stale.length };
  });
}
