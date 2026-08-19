// Security regressions for src/cli/remote.ts and src/core/template.ts:
// pull through a symlinked cards/, token sent to a plaintext URL, a dirty
// guard that used to fail open on git errors, unquoted remote.yaml scalars,
// fetches without a timeout, and `botflow new` option injection / dest-file
// crashes. Harness idiom follows test/pull.test.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initBoard, addCard } from '../src/core/mutate.ts';
import { UsageError } from '../src/core/ops.ts';
import { instantiate } from '../src/core/template.ts';
import { loadRemote, pull, push, remoteAdd } from '../src/cli/remote.ts';

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

/** A board with one local card and a remote.yaml aimed at url. */
function boardDir(url: string): { dir: string; root: string } {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-sec-'));
  const root = initBoard(dir, 'sectest');
  addCard(root, { title: 'local only', actor: 'setup' });
  writeFileSync(join(root, 'remote.yaml'), `url: ${url}\nproject: p-test\n`);
  return { dir, root };
}

const GOOD_CONFIG = 'botflow: 0\nname: pulled\nlanes:\n  - id: todo\n  - id: doing\n  - id: done\n';
const GOOD_CARD = { path: 'cards/001-remote.md', text: '---\nid: 001\ntitle: Remote card\nlane: todo\n---\n' };
const GOOD_SNAPSHOT = { config: GOOD_CONFIG, cards: [GOOD_CARD] };

test('pull: a symlinked cards/ directory refuses before writing or deleting anything', async () => {
  const { server, url } = await serveExport(GOOD_SNAPSHOT);
  const { dir, root } = boardDir(url);
  const outside = mkdtempSync(join(tmpdir(), 'botflow-outside-'));
  try {
    const victim = join(outside, 'victim.md');
    writeFileSync(victim, 'precious\n');
    rmSync(join(root, 'cards'), { recursive: true });
    symlinkSync(outside, join(root, 'cards'));
    const boardBefore = readFileSync(join(root, 'board.yaml'), 'utf8');

    await assert.rejects(
      pull(root, 'bfk_test'),
      (err: unknown) => err instanceof UsageError && /symlink/.test(err.message),
    );
    assert.equal(readFileSync(victim, 'utf8'), 'precious\n', 'outside file not deleted');
    assert.ok(!existsSync(join(outside, '001-remote.md')), 'nothing written through the link');
    assert.equal(readFileSync(join(root, 'board.yaml'), 'utf8'), boardBefore, 'board.yaml not written');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('pull: a symlinked subdirectory of cards/ refuses', async () => {
  const nested = { path: 'cards/sub/002-nested.md', text: '---\nid: 002\ntitle: Nested\nlane: todo\n---\n' };
  const { server, url } = await serveExport({ config: GOOD_CONFIG, cards: [nested] });
  const { dir, root } = boardDir(url);
  const outside = mkdtempSync(join(tmpdir(), 'botflow-outside-'));
  try {
    symlinkSync(outside, join(root, 'cards', 'sub'));
    await assert.rejects(
      pull(root, 'bfk_test'),
      (err: unknown) => err instanceof UsageError && /symlink/.test(err.message),
    );
    assert.deepEqual(readdirSync(outside), [], 'nothing written through the link');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('pull: a symlinked board root refuses', async () => {
  const { server, url } = await serveExport(GOOD_SNAPSHOT);
  const { dir, root: realRoot } = boardDir(url);
  const linkDir = mkdtempSync(join(tmpdir(), 'botflow-linkroot-'));
  try {
    const linkRoot = join(linkDir, '.botflow');
    symlinkSync(realRoot, linkRoot);
    const cardsBefore = readdirSync(join(realRoot, 'cards'));
    await assert.rejects(
      pull(linkRoot, 'bfk_test'),
      (err: unknown) => err instanceof UsageError && /symlink/.test(err.message),
    );
    assert.deepEqual(readdirSync(join(realRoot, 'cards')), cardsBefore, 'cards untouched');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(linkDir, { recursive: true, force: true });
  }
});

test('remote add: plaintext http URLs are rejected, loopback http stays allowed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-sec-'));
  const root = initBoard(dir, 'sectest');
  try {
    assert.throws(
      () => remoteAdd(root, 'http://attacker.example', 'p'),
      (err: unknown) => err instanceof UsageError && /https/.test(err.message),
    );
    assert.throws(
      () => remoteAdd(root, 'not a url', 'p'),
      (err: unknown) => err instanceof UsageError && /not a valid URL/.test(err.message),
    );
    for (const ok of ['https://manager.example', 'http://localhost:4321', 'http://127.0.0.1:4321', 'http://[::1]:4321']) {
      remoteAdd(root, ok, 'p');
      assert.equal(loadRemote(root).url, ok);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push/pull: a hand-edited plaintext remote.yaml never gets the token', async () => {
  const { dir, root } = boardDir('http://127.0.0.1:1');
  try {
    writeFileSync(join(root, 'remote.yaml'), 'url: http://attacker.example\nproject: p-test\n');
    for (const attempt of [() => pull(root, 'bfk_test'), () => push(root, 'bfk_test', 'tester')]) {
      await assert.rejects(attempt, (err: unknown) => err instanceof UsageError && /https/.test(err.message));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('remote add: url and project are quoted so hostile scalars round-trip as strings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-sec-'));
  const root = initBoard(dir, 'sectest');
  try {
    for (const project of ['123456', 'true', 'with space', 'a #b']) {
      remoteAdd(root, 'https://manager.example', project);
      const loaded = loadRemote(root);
      assert.equal(loaded.project, project);
      assert.equal(loaded.url, 'https://manager.example');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fake `git` on PATH that fails the way real git failures do. */
function makeFakeGit(stderr: string, code: number): string {
  const bin = mkdtempSync(join(tmpdir(), 'botflow-fakegit-'));
  const path = join(bin, 'git');
  writeFileSync(path, `#!/bin/sh\necho '${stderr}' >&2\nexit ${code}\n`);
  chmodSync(path, 0o755);
  return bin;
}

test('pull: a git failure other than not-a-repo refuses closed; --force overrides', async () => {
  const { server, url } = await serveExport(GOOD_SNAPSHOT);
  const { dir, root } = boardDir(url);
  const fakebin = makeFakeGit('fatal: detected dubious ownership in repository at /x', 128);
  const pathBefore = process.env['PATH'];
  process.env['PATH'] = `${fakebin}:${pathBefore}`;
  try {
    const boardBefore = readFileSync(join(root, 'board.yaml'), 'utf8');
    await assert.rejects(
      pull(root, 'bfk_test'),
      (err: unknown) => err instanceof UsageError && /refusing pull/.test(err.message) && /dubious ownership/.test(err.message),
    );
    assert.equal(readFileSync(join(root, 'board.yaml'), 'utf8'), boardBefore, 'nothing applied');
    assert.equal(readdirSync(join(root, 'cards')).length, 1, 'local card untouched');

    const forced = await pull(root, 'bfk_test', true);
    assert.deepEqual(forced, { written: 1, removed: 1 });
    assert.deepEqual(readdirSync(join(root, 'cards')), ['001-remote.md']);
  } finally {
    process.env['PATH'] = pathBefore;
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakebin, { recursive: true, force: true });
  }
});

test('pull: not-a-git-repo stays tolerated', async () => {
  const { server, url } = await serveExport(GOOD_SNAPSHOT);
  const { dir, root } = boardDir(url);
  const fakebin = makeFakeGit('fatal: not a git repository (or any of the parent directories): .git', 128);
  const pathBefore = process.env['PATH'];
  process.env['PATH'] = `${fakebin}:${pathBefore}`;
  try {
    const res = await pull(root, 'bfk_test');
    assert.deepEqual(res, { written: 1, removed: 1 });
  } finally {
    process.env['PATH'] = pathBefore;
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakebin, { recursive: true, force: true });
  }
});

test('pull: a manager that never responds times out instead of hanging forever', async () => {
  const server = createServer(() => {
    // Never respond.
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const addr = server.address() as { port: number };
  const { dir, root } = boardDir(`http://127.0.0.1:${addr.port}`);
  try {
    await assert.rejects(
      pull(root, 'bfk_test', false, 100),
      (err: unknown) => err instanceof UsageError && /timed out/.test(err.message),
    );
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('template: a dest that exists as a file is a usage error, not an ENOTDIR crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-sec-'));
  try {
    const src = join(dir, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'README.md'), 'x\n');
    const dest = join(dir, 'dest-file');
    writeFileSync(dest, 'occupied\n');
    assert.throws(
      () => instantiate(src, dest),
      (err: unknown) => err instanceof UsageError && /not a directory/.test(err.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('template: sources starting with - are rejected before git sees them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-sec-'));
  try {
    assert.throws(
      () => instantiate('-u/tmp/evil.sh', join(dir, 'dest')),
      (err: unknown) => err instanceof UsageError && /start with/.test(err.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
