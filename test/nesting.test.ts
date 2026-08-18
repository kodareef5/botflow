// Hosted-style nesting: analyzeSingle with injected children (the DO path)
// and project: refs on the filesystem (info finding, graceful fallback).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyze, analyzeSingle, lintBoard, loadTree } from '../src/core/index.ts';
import { boardFromDocuments } from '../src/core/docs.ts';
import type { Distribution } from '../src/core/model.ts';

const dist = (over: Partial<Distribution>): Distribution => ({
  wishlist: 0, todo: 0, doing: 0, blocked: 0, done: 0, archive: 0, ...over,
});

const BOARD = boardFromDocuments('botflow: 0\nname: parent\n', [
  { path: 'cards/001-task.md', text: '---\nid: 001\ntitle: A task\nlane: done\n---\n' },
  { path: 'cards/002-child.md', text: '---\nid: 002\ntitle: Child project\nlane: todo\ntype: board\nboard: project:p-aaa\n---\n' },
  { path: 'cards/003-loop.md', text: '---\nid: 003\ntitle: Cycle child\nlane: todo\ntype: board\nboard: project:p-bbb\n---\n' },
]);

test('analyzeSingle rolls up injected children and leaves cycles alone', () => {
  const ba = analyzeSingle(BOARD, new Map([
    ['002', { distribution: dist({ done: 1, doing: 1, blocked: 1 }), progress: 1 / 3 }],
    ['003', null], // cycle / unresolved → falls back to its lane
  ]));
  assert.equal(ba.canonical.get('002'), 'blocked'); // any-blocked wins
  assert.equal(ba.canonical.get('003'), 'todo');
  assert.deepEqual(ba.distribution, dist({ done: 1, blocked: 1, todo: 1 }));
  // progress: task 1 + child 1/3 + unresolved todo 0 over 3 units
  assert.equal(Math.round(ba.progress! * 1000), Math.round((1 + 1 / 3) / 3 * 1000));
  assert.ok(ba.findings.some((f) => f.rule === 'rollup-drift' && f.ref === '002'));
  // 003 fell back to todo, but board-cards are containers, never claimable
  // work: the ready queue only ever holds task cards (SPEC §5).
  assert.equal(ba.ready.length, 0);
});

test('analyzeSingle without children treats board-cards as unresolved, no drift noise', () => {
  const ba = analyzeSingle(BOARD);
  assert.equal(ba.canonical.get('002'), 'todo');
  assert.equal(ba.findings.filter((f) => f.rule === 'rollup-drift').length, 0);
});

test('file boards lint project: refs as info, not error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-nest-'));
  mkdirSync(join(dir, 'cards'));
  writeFileSync(join(dir, 'board.yaml'), 'botflow: 0\nname: filey\n');
  writeFileSync(join(dir, 'cards', '001-hosted.md'), '---\nid: 001\ntitle: Hosted child\nlane: todo\ntype: board\nboard: project:p-xyz\n---\n');
  const tree = loadTree(dir);
  const analysis = analyze(tree);
  const findings = lintBoard(tree.boards.get('.')!, analysis.boards.get('.')!);
  assert.deepEqual(findings.map((f) => [f.rule, f.severity]), [['hosted-ref', 'info']]);
  assert.equal(analysis.boards.get('.')!.canonical.get('001'), 'todo');
});
