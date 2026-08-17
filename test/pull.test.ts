// Transactional pull (SPEC §12): the whole remote snapshot validates before a
// single local file changes, and a dirty git tree refuses without --force.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initBoard, addCard } from '../src/core/mutate.ts';
import { UsageError } from '../src/core/ops.ts';
import { pull } from '../src/cli/remote.ts';

function serveExport(payload: unknown): Promise<{ server: Server; url: string }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolvePromise({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

/** A board with one committed local card and a remote.yaml aimed at url. */
function boardDir(url: string): { dir: string; root: string } {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-pull-'));
  const root = initBoard(dir, 'pulltest');
  addCard(root, { title: 'local only', actor: 'setup' });
  writeFileSync(join(root, 'remote.yaml'), `url: ${url}\nproject: p-test\n`);
  return { dir, root };
}

function snapshotDir(root: string): Map<string, string> {
  const out = new Map<string, string>();
  out.set('board.yaml', readFileSync(join(root, 'board.yaml'), 'utf8'));
  for (const f of readdirSync(join(root, 'cards'))) {
    out.set(`cards/${f}`, readFileSync(join(root, 'cards', f), 'utf8'));
  }
  return out;
}

const GOOD_CONFIG = 'botflow: 0\nname: pulled\nlanes:\n  - id: todo\n  - id: doing\n  - id: done\n';
const GOOD_CARD = { path: 'cards/001-remote.md', text: '---\nid: 001\ntitle: Remote card\nlane: todo\n---\n' };

test('pull: a valid snapshot replaces the board wholesale', async () => {
  const { server, url } = await serveExport({ config: GOOD_CONFIG, cards: [GOOD_CARD] });
  const { dir, root } = boardDir(url);
  try {
    const res = await pull(root, 'bfk_test');
    assert.deepEqual(res, { written: 1, removed: 1 });
    assert.equal(readFileSync(join(root, 'board.yaml'), 'utf8'), GOOD_CONFIG);
    assert.deepEqual(readdirSync(join(root, 'cards')), ['001-remote.md']);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [name, payload] of [
  ['duplicate ids', { config: GOOD_CONFIG, cards: [GOOD_CARD, { ...GOOD_CARD, path: 'cards/002-dup.md' }] }],
  ['unsafe path', { config: GOOD_CONFIG, cards: [{ ...GOOD_CARD, path: 'cards/../../evil.md' }] }],
  ['broken config yaml', { config: 'name: [unclosed', cards: [GOOD_CARD] }],
  ['missing frontmatter', { config: GOOD_CONFIG, cards: [{ path: 'cards/001-x.md', text: 'no frontmatter here' }] }],
  ['non-json response', 'not json at all'],
] as const) {
  test(`pull: ${name} refuses and leaves the checkout untouched`, async () => {
    const { server, url } = await serveExport(payload);
    const { dir, root } = boardDir(url);
    try {
      const before = snapshotDir(root);
      await assert.rejects(pull(root, 'bfk_test'), (err: unknown) => err instanceof UsageError && /refusing pull/.test(err.message));
      assert.deepEqual(snapshotDir(root), before, 'no file changed');
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('pull: uncommitted board changes refuse without --force, apply with it', async () => {
  const { server, url } = await serveExport({ config: GOOD_CONFIG, cards: [GOOD_CARD] });
  const { dir, root } = boardDir(url);
  try {
    const git = (...args: string[]) => {
      const res = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr);
    };
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'board baseline');
    // Dirty the tree: edit a committed card.
    const cardFile = join(root, 'cards', readdirSync(join(root, 'cards'))[0]!);
    writeFileSync(cardFile, readFileSync(cardFile, 'utf8') + '\nedited but not committed\n');

    await assert.rejects(pull(root, 'bfk_test'), (err: unknown) => err instanceof UsageError && /uncommitted/.test(err.message));
    assert.match(readFileSync(cardFile, 'utf8'), /edited but not committed/, 'dirty file untouched');

    const forced = await pull(root, 'bfk_test', true);
    assert.deepEqual(forced, { written: 1, removed: 1 });
    assert.deepEqual(readdirSync(join(root, 'cards')), ['001-remote.md']);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
