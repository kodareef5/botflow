// Template instantiation: plain-dir copy, git repo with branch variants
// (the "branches carry specialty workloads" story), and playbook wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { instantiate, parseSource, setupAgentFiles } from '../src/core/template.ts';
import { loadBoard, resolveBoardRoot } from '../src/core/index.ts';

const TEMPLATE = join(import.meta.dirname, '..', 'templates', 'basic');

function sh(cwd: string, cmd: string, ...args: string[]): void {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `${cmd} ${args.join(' ')}: ${res.stderr}`);
}

test('template: parseSource splits branch specs', () => {
  assert.deepEqual(parseSource('https://x/y.git#special'), { src: 'https://x/y.git', branch: 'special' });
  assert.deepEqual(parseSource('../ws'), { src: '../ws', branch: null });
});

test('template: instantiate from a plain directory', () => {
  const dest = join(mkdtempSync(join(tmpdir(), 'botflow-new-')), 'proj');
  const res = instantiate(TEMPLATE, dest, 'my-project');
  assert.ok(res.boardRoot, res.warnings.join('; '));
  assert.ok(existsSync(join(dest, 'AGENTS.md')));
  assert.ok(existsSync(join(dest, '.git')), 'fresh repo initialized');
  const board = loadBoard(res.boardRoot!);
  assert.equal(board.config.name, 'my-project'); // --name rewrote board.yaml
  assert.equal(board.cards.length, 2);
  assert.equal(board.findings.filter((f) => f.severity === 'error').length, 0);
});

test('template: branch selects a specialty workflow variant', () => {
  const src = mkdtempSync(join(tmpdir(), 'botflow-tpl-'));
  const git = (...args: string[]) => sh(src, 'git', '-c', 'user.name=t', '-c', 'user.email=t@local', ...args);
  // main: copy of templates/basic
  instantiateInto(src);
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'basic');
  // specialty branch: review-gated doing lane
  git('checkout', '-qb', 'review-gated');
  writeFileSync(
    join(src, '.botflow', 'board.yaml'),
    [
      'botflow: 0', 'name: review-gated', 'lanes:', '  - id: wishlist', '  - id: todo',
      '  - id: doing', '    substates: [build, review]', '    order: strict',
      '  - id: blocked', '  - id: done', '  - id: archive',
    ].join('\n') + '\n',
  );
  git('add', '-A');
  git('commit', '-qm', 'review gated variant');
  git('checkout', '-q', 'main');

  const base = join(mkdtempSync(join(tmpdir(), 'botflow-new-')), 'a');
  const variant = join(mkdtempSync(join(tmpdir(), 'botflow-new-')), 'b');
  const r1 = instantiate(src, base);
  const r2 = instantiate(`${src}#review-gated`, variant);
  assert.equal(loadBoard(r1.boardRoot!).config.name, 'basic');
  const variantBoard = loadBoard(r2.boardRoot!);
  assert.equal(variantBoard.config.name, 'review-gated');
  const doing = variantBoard.config.lanes.find((l) => l.id === 'doing')!;
  assert.deepEqual(doing.substates, ['build', 'review']);
  assert.equal(doing.order, 'strict');
  assert.ok(!existsSync(join(variant, '.git', 'refs', 'heads', 'review-gated')), 'no template history carried over');

  function instantiateInto(dir: string): void {
    const res = spawnSync(process.execPath, ['-e', `require('fs').cpSync(${JSON.stringify(TEMPLATE)}, ${JSON.stringify(dir)}, {recursive: true})`]);
    assert.equal(res.status, 0);
  }
});

test('template: setupAgentFiles is idempotent and target-aware', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-setup-'));
  writeFileSync(join(dir, 'AGENTS.md'), '# AGENTS.md\n\nexisting content\n');
  const first = setupAgentFiles(dir, 'claude');
  assert.deepEqual(first.sort(), ['AGENTS.md', 'CLAUDE.md']);
  const again = setupAgentFiles(dir, 'claude');
  assert.deepEqual(again, []);
  const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes('existing content'), 'append, not overwrite');
  assert.equal(agents.split('botflow prime').length, 2, 'exactly one snippet');
});

test('template: instantiated workspace is immediately operable', () => {
  const dest = join(mkdtempSync(join(tmpdir(), 'botflow-new-')), 'proj');
  instantiate(TEMPLATE, dest);
  const entry = join(import.meta.dirname, '..', 'src', 'cli', 'botflow.ts');
  const ready = spawnSync(process.execPath, [entry, 'ready', '--json'], { cwd: dest, encoding: 'utf8' });
  assert.equal(ready.status, 0, ready.stderr);
  const ids = (JSON.parse(ready.stdout) as { id: string }[]).map((c) => c.id);
  assert.deepEqual(ids, ['001']); // 002 depends on 001
  assert.equal(resolveBoardRoot(dest), join(dest, '.botflow'));
});
