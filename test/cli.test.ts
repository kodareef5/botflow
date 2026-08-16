// End-to-end CLI smoke tests: spawn the real entry in throwaway dirs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const ENTRY = join(import.meta.dirname, '..', 'src', 'cli', 'botflow.ts');
const BIN = join(import.meta.dirname, '..', 'bin', 'botflow.js');

function bf(cwd: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, BOTFLOW_ACTOR: 'test-agent', BOTFLOW_DIR: '' },
  });
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

function ok(cwd: string, ...args: string[]): string {
  const res = bf(cwd, ...args);
  assert.equal(res.code, 0, `botflow ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  return res.stdout;
}

test('cli: full card lifecycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-'));
  ok(dir, 'init', '--name', 'smoke');

  ok(dir, 'card', 'add', 'Build the thing', '--labels', 'core,alpha', '--priority', 'p1');
  ok(dir, 'card', 'add', 'Polish the thing', '--deps', '001');

  // Only 001 is ready — 002 waits on it.
  const ready1 = JSON.parse(ok(dir, 'ready', '--json')) as { id: string }[];
  assert.deepEqual(ready1.map((c) => c.id), ['001']);

  ok(dir, 'card', 'claim', '001');
  ok(dir, 'log', '001', 'halfway there');
  ok(dir, 'card', 'block', '001', '--reason', 'waiting on review');
  const shown = JSON.parse(ok(dir, 'card', 'show', '001', '--json')) as Record<string, unknown>;
  assert.equal(shown['state'], 'blocked');
  assert.equal(shown['assignee'], 'test-agent');
  ok(dir, 'card', 'unblock', '001');
  ok(dir, 'card', 'close', '001', '--reason', 'shipped');

  const ready2 = JSON.parse(ok(dir, 'ready', '--json')) as { id: string }[];
  assert.deepEqual(ready2.map((c) => c.id), ['002']);
  ok(dir, 'card', 'mv', '002', 'doing');
  ok(dir, 'card', 'close', '002');

  const board = JSON.parse(ok(dir, 'board', '--json')) as { progress: number; distribution: Record<string, number> };
  assert.equal(board.progress, 1);
  assert.equal(board.distribution['done'], 2);

  assert.equal(bf(dir, 'lint').code, 0);

  // The card file carries the whole story in its Log.
  const file = readFileSync(join(dir, '.botflow', 'cards', '001-build-the-thing.md'), 'utf8');
  for (const needle of ['created in todo', 'claimed', 'halfway there', 'blocked: waiting on review', 'unblocked', 'closed: shipped']) {
    assert.ok(file.includes(needle), `log should contain "${needle}"`);
  }
  assert.ok(!file.includes('\nblocked:'), 'blocked flag cleared on close');
});

test('cli: strict substates enforce one step at a time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-'));
  ok(dir, 'init', '--name', 'strict');
  writeFileSync(
    join(dir, '.botflow', 'board.yaml'),
    ['botflow: 0', 'name: strict', 'lanes:', '  - id: todo', '  - id: doing', '    substates: [design, implement, review]', '    order: strict', '  - id: done'].join('\n') + '\n',
  );
  ok(dir, 'card', 'add', 'Feature');
  ok(dir, 'card', 'claim', '001'); // enters doing.design

  const skip = bf(dir, 'card', 'mv', '001', 'doing.review');
  assert.equal(skip.code, 1);
  assert.match(skip.stderr, /strict/);

  ok(dir, 'card', 'mv', '001', 'doing.implement');
  ok(dir, 'card', 'mv', '001', 'doing.review');
  ok(dir, 'card', 'mv', '001', 'done');

  const forced = ok(dir, 'card', 'add', 'Rush job');
  assert.ok(forced.includes('002'));
  ok(dir, 'card', 'mv', '002', 'doing.review', '--force');
});

test('cli: rewrites preserve unknown frontmatter keys and body', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-'));
  ok(dir, 'init', '--name', 'preserve');
  const cardPath = join(dir, '.botflow', 'cards', '001-custom.md');
  writeFileSync(
    cardPath,
    ['---', 'id: 001', 'title: Custom card', 'lane: todo', 'estimate: 3d', '---', '## Description', 'Hand-written body.', ''].join('\n'),
  );
  ok(dir, 'card', 'edit', '001', '--title', 'Custom card v2', '--priority', 'p2');
  const rewritten = readFileSync(cardPath, 'utf8');
  assert.ok(rewritten.includes('estimate: 3d'), 'unknown key preserved');
  assert.ok(rewritten.includes('Hand-written body.'), 'body preserved');
  assert.ok(rewritten.includes('title: Custom card v2'));
  assert.ok(rewritten.includes('priority: p2'));

  // The unknown key still lints as info, not error.
  const lint = JSON.parse(ok(dir, 'lint', '--json')) as { rule: string; severity: string }[];
  assert.deepEqual(lint.map((f) => f.rule), ['unknown-key']);
});

test('cli: comments, checklists, attachments, cover', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-'));
  ok(dir, 'init', '--name', 'cardstuff');
  ok(dir, 'card', 'add', 'Rich card');
  const cardPath = join(dir, '.botflow', 'cards', '001-rich-card.md');
  writeFileSync(
    cardPath,
    readFileSync(cardPath, 'utf8') + '\n## Checklist\n- [ ] alpha\n- [ ] beta\n',
  );
  ok(dir, 'card', 'check', '001', '2');
  ok(dir, 'card', 'comment', '001', 'first comment here');
  ok(dir, 'card', 'attach', '001', 'https://example.com/mock.png', '--label', 'mock');
  ok(dir, 'card', 'attach', '001', 'https://example.com/doc');
  ok(dir, 'card', 'detach', '001', '2');
  const shown = JSON.parse(ok(dir, 'card', 'show', '001', '--json')) as {
    checklist: { done: number; total: number };
    comments: number;
    attachments: number;
    cover: string | null;
    parsed: { attachments: { label: string }[] };
  };
  assert.deepEqual(shown.checklist, { done: 1, total: 2 });
  assert.equal(shown.comments, 1);
  assert.equal(shown.attachments, 1);
  assert.equal(shown.cover, 'https://example.com/mock.png', 'first image is the auto cover');
  ok(dir, 'card', 'edit', '001', '--cover', 'none');
  const suppressed = JSON.parse(ok(dir, 'card', 'show', '001', '--json')) as { cover: string | null };
  assert.equal(suppressed.cover, null);
  const file = readFileSync(cardPath, 'utf8');
  assert.ok(file.includes('- [x] beta'));
  assert.ok(file.includes('first comment here'));
  assert.ok(file.includes('cover: none'));
  assert.equal(bf(dir, 'lint').code, 0);
});

test('cli: bin shim runs (js importing native ts)', () => {
  const res = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^\d+\.\d+\.\d+/);
});

test('cli: nested board rollup through the fixture tree', () => {
  const fixture = join(import.meta.dirname, 'fixtures', 'nested');
  const rollup = JSON.parse(ok(fixture, 'board', '--rollup', '--json')) as {
    progress: number;
    boards: { id: string; state: string; child: { progress: number } | null }[];
  };
  assert.equal(rollup.progress, 0.75);
  const api = rollup.boards.find((b) => b.id === '003')!;
  assert.equal(api.state, 'blocked');
  assert.equal(api.child?.progress, 0.25);
});
