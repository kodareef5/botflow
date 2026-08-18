// Same-tree concurrency (SPEC §12): the board lock serializes whole
// load-mutate-write cycles across real processes, seq ids never collide,
// writes are temp+rename, and stale locks are reaped not respected.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const ENTRY = join(import.meta.dirname, '..', 'src', 'cli', 'botflow.ts');

function run(cwd: string, actor: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [ENTRY, ...args], {
      cwd,
      env: { ...process.env, BOTFLOW_ACTOR: actor, BOTFLOW_DIR: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

function runSync(cwd: string, actor: string, env: Record<string, string>, ...args: string[]) {
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, BOTFLOW_ACTOR: actor, BOTFLOW_DIR: '', ...env },
  });
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

function freshBoard(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-atomic-'));
  const init = runSync(dir, 'setup', {}, 'init', '--name', 'race');
  assert.equal(init.code, 0, init.stderr);
  return dir;
}

test('eight concurrent adds mint eight distinct seq ids', async () => {
  const dir = freshBoard();
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => run(dir, `agent-${i}`, 'card', 'add', `task ${i}`)),
    );
    for (const r of results) assert.equal(r.code, 0, r.stderr);

    const board = JSON.parse(runSync(dir, 'check', {}, 'board', '--json').stdout) as {
      lanes: { cards: { id: string }[] }[];
    };
    const ids = board.lanes.flatMap((l) => l.cards.map((c) => c.id)).sort();
    assert.deepEqual(ids, ['001', '002', '003', '004', '005', '006', '007', '008']);

    const lint = runSync(dir, 'check', {}, 'lint');
    assert.equal(lint.code, 0, lint.stdout + lint.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('six racing claims produce exactly one winner and it matches the card', async () => {
  const dir = freshBoard();
  try {
    assert.equal((await run(dir, 'setup', 'card', 'add', 'contested')).code, 0);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => run(dir, `racer-${i}`, 'card', 'claim', '001')),
    );
    const winners = results.filter((r) => r.code === 0);
    const losers = results.filter((r) => r.code !== 0);
    assert.equal(winners.length, 1, results.map((r) => `${r.code}:${r.stderr.trim()}`).join(' | '));
    assert.equal(losers.length, 5);
    for (const l of losers) assert.match(l.stderr, /cannot claim/);

    const file = readdirSync(join(dir, '.botflow', 'cards')).find((f) => f.endsWith('.md'))!;
    const text = readFileSync(join(dir, '.botflow', 'cards', file), 'utf8');
    const winnerActor = winners[0]!.stdout.match(/@([\w-]+)/)?.[1] ?? '';
    assert.ok(winnerActor.startsWith('racer-'), winners[0]!.stdout);
    assert.match(text, new RegExp(`assignee: ${winnerActor}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no temp files survive a burst of mutations', async () => {
  const dir = freshBoard();
  try {
    await Promise.all(Array.from({ length: 5 }, (_, i) => run(dir, `a${i}`, 'card', 'add', `t${i}`)));
    await Promise.all(Array.from({ length: 5 }, (_, i) => run(dir, `a${i}`, 'log', '001', `note ${i}`)));
    const leftovers = readdirSync(join(dir, '.botflow', 'cards')).filter((f) => !f.endsWith('.md'));
    assert.deepEqual(leftovers, []);
    const rootLeftovers = readdirSync(join(dir, '.botflow')).filter((f) => f.endsWith('.tmp') || f === 'board.lock');
    assert.deepEqual(rootLeftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock owned by a dead process is reaped, not respected', () => {
  const dir = freshBoard();
  try {
    // A just-exited child's pid is definitely not alive.
    const ghost = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    writeFileSync(join(dir, '.botflow', 'board.lock'), `${ghost.pid} ${new Date().toISOString()}\n`);
    const res = runSync(dir, 'reaper', {}, 'card', 'add', 'gets through');
    assert.equal(res.code, 0, res.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock held by a live process makes mutations fail fast and clean', () => {
  const dir = freshBoard();
  try {
    const lock = join(dir, '.botflow', 'board.lock');
    writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`);
    const res = runSync(dir, 'waiter', { BOTFLOW_LOCK_TIMEOUT_MS: '250' }, 'card', 'add', 'blocked out');
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /locked/);
    const cards = readdirSync(join(dir, '.botflow', 'cards'));
    assert.deepEqual(cards, [], 'refused mutation wrote nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a LIVE owner is never age-reaped, however old the lock looks', () => {
  const dir = freshBoard();
  try {
    const lock = join(dir, '.botflow', 'board.lock');
    // Our own (alive) pid with an ancient mtime: liveness must win over age,
    // or a long legitimate hold gets its lock stolen mid-critical-section.
    writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`);
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lock, old, old);
    const res = runSync(dir, 'thief', { BOTFLOW_LOCK_STALE_MS: '1000', BOTFLOW_LOCK_TIMEOUT_MS: '300' }, 'card', 'add', 'must not enter');
    assert.notEqual(res.code, 0, 'mutation must wait, not steal');
    assert.match(res.stderr, /locked/);
    assert.deepEqual(readdirSync(join(dir, '.botflow', 'cards')), [], 'nothing written past a live lock');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock with unreadable pid content falls back to mtime aging', () => {
  const dir = freshBoard();
  try {
    const lock = join(dir, '.botflow', 'board.lock');
    writeFileSync(lock, 'not-a-pid at all\n');
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lock, old, old);
    const res = runSync(dir, 'reaper', { BOTFLOW_LOCK_STALE_MS: '5000' }, 'card', 'add', 'aged out');
    assert.equal(res.code, 0, res.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
