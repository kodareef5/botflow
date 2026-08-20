import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyzeSingle } from '../src/core/analyze.ts';
import { boardFromDocuments } from '../src/core/docs.ts';
import { emptyDistribution } from '../src/core/model.ts';

const CONFIG = `botflow: 0
name: estimates
lanes:
  - id: todo
  - id: doing
  - id: done
`;

const card = (id: string, lane: string, estimate?: number, type = '') => ({
  path: `cards/${id}-work.md`,
  text: `---\nid: ${id}\ntitle: work ${id}\nlane: ${lane}\n${estimate === undefined ? '' : `estimate: ${estimate}\n`}${type}---\n`,
});

test('estimated effort is a separate projection from structural progress', () => {
  const board = boardFromDocuments(CONFIG, [
    card('001', 'done', 2),
    card('002', 'doing', 3),
    card('003', 'done'),
  ]);
  const analysis = analyzeSingle(board);

  assert.equal(analysis.progress, 2 / 3, 'structural progress still counts cards');
  assert.deepEqual(analysis.effort, { total: 5, completed: 2, progress: 2 / 5 });
});

test('estimated board-card effort is scaled by child structural progress', () => {
  const board = boardFromDocuments(CONFIG, [
    card('001', 'doing', 8, 'type: board\nboard: project:child\n'),
    card('002', 'done', 2),
  ]);
  const distribution = emptyDistribution();
  distribution.todo = 1;
  distribution.done = 1;
  const analysis = analyzeSingle(board, new Map([['001', { distribution, progress: 0.5 }]]));

  assert.deepEqual(analysis.effort, { total: 10, completed: 6, progress: 0.6 });
});

test('effort progress is null when no countable card is estimated', () => {
  const board = boardFromDocuments(CONFIG, [card('001', 'done')]);
  assert.deepEqual(analyzeSingle(board).effort, { total: 0, completed: 0, progress: null });
});
