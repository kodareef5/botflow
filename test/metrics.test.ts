// The Log is botflow's event stream. These tests use a fixed clock so every
// duration and reconstructed board state stays deterministic across timezones.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyze, analyzeSingle } from '../src/core/analyze.ts';
import { boardFromDocuments, singleBoardTree } from '../src/core/docs.ts';
import { boardJson } from '../src/core/json.ts';
import { boardFlowMetrics, cardFlowEvents, cardFlowMetrics, metricTime } from '../src/core/metrics.ts';

const CONFIG = `botflow: 0
name: flow history
lanes:
  - id: todo
  - id: doing
  - id: blocked
  - id: done
  - id: archive
`;

function document(
  id: string,
  lane: string,
  created: string,
  log: string[],
  extra: string[] = [],
): { path: string; text: string } {
  return {
    path: `cards/${id}-history.md`,
    text: `---\nid: ${id}\ntitle: history ${id}\nlane: ${lane}\ncreated: ${created}\n${extra.join('\n')}${extra.length > 0 ? '\n' : ''}---\n## Log\n${log.map((line) => `- ${line}`).join('\n')}\n`,
  };
}

test('card flow metrics preserve lane re-entry and do not reset on block activity', () => {
  const board = boardFromDocuments(CONFIG, [document('001', 'done', '2026-08-01', [
    '2026-08-01 agent: created in todo',
    '2026-08-03 agent: moved todo → doing',
    '2026-08-05 agent: moved doing → todo',
    '2026-08-06 agent: moved todo → doing',
    '2026-08-07 agent: blocked: waiting for access',
    '2026-08-09 agent: unblocked',
    '2026-08-12 agent: closed: shipped, moved doing → done',
  ])]);
  assert.equal(board.findings.length, 0);
  const analysis = analyzeSingle(board);
  const card = board.cards[0]!;
  const now = metricTime('2026-08-20')!;

  assert.deepEqual(cardFlowEvents(card, board), [
    { at: metricTime('2026-08-01'), lane: 'todo', state: 'todo' },
    { at: metricTime('2026-08-03'), lane: 'doing', state: 'doing' },
    { at: metricTime('2026-08-05'), lane: 'todo', state: 'todo' },
    { at: metricTime('2026-08-06'), lane: 'doing', state: 'doing' },
    { at: metricTime('2026-08-07'), lane: 'doing', state: 'blocked' },
    { at: metricTime('2026-08-09'), lane: 'doing', state: 'doing' },
    { at: metricTime('2026-08-12'), lane: 'done', state: 'done' },
  ]);
  assert.deepEqual(cardFlowMetrics(card, board, 'done', now), {
    lastActivity: '2026-08-12',
    idleDays: 8,
    currentLaneDays: 8,
    cumulativeLaneDays: 8,
    laneDays: { todo: 3, doing: 8, done: 8 },
    stagnation: { days: 8, dots: 1, tone: 'red' },
    stalled: false,
    agingLevel: 0,
    cycleDays: 9,
    leadDays: 11,
    dueChanges: 0,
    blockedDays: 2,
    blockerDays: { unclassified: 2 },
    completedAt: '2026-08-12T00:00:00.000Z',
    due: null,
  });
});

test('incomplete history stays incomplete instead of inventing transition dates', () => {
  const board = boardFromDocuments(CONFIG, [document('001', 'done', '2026-08-01', [
    '2026-08-08 agent: edited title',
  ])]);
  const card = board.cards[0]!;
  const metrics = cardFlowMetrics(card, board, 'done', metricTime('2026-08-20')!);

  assert.deepEqual(cardFlowEvents(card, board), []);
  assert.equal(metrics.currentLaneDays, null);
  assert.equal(metrics.cumulativeLaneDays, null);
  assert.deepEqual(metrics.laneDays, {});
  assert.equal(metrics.cycleDays, null);
  assert.equal(metrics.leadDays, null);
  assert.equal(metrics.completedAt, null);
});

test('missing activity and an unlogged active block remain unknown, not zero', () => {
  const board = boardFromDocuments(CONFIG, [document('001', 'todo', '2026-08-01', [], ['blocked: imported without history'])]);
  const card = board.cards[0]!;
  const metrics = cardFlowMetrics(card, board, 'blocked', metricTime('2026-08-20')!);

  assert.equal(metrics.lastActivity, null);
  assert.equal(metrics.idleDays, null);
  assert.equal(metrics.currentLaneDays, null);
  assert.equal(metrics.blockedDays, null);
});

test('an explicit block remains active across lane moves until unblocked', () => {
  const board = boardFromDocuments(CONFIG, [document('001', 'todo', '2026-08-01', [
    '2026-08-01 agent: created in todo',
    '2026-08-02 agent: moved todo → doing',
    '2026-08-03 agent: blocked: external dependency',
    '2026-08-05 agent: moved doing → todo',
    '2026-08-07 agent: unblocked',
  ])]);
  const card = board.cards[0]!;
  const events = cardFlowEvents(card, board);

  assert.deepEqual(events.slice(2), [
    { at: metricTime('2026-08-03'), lane: 'doing', state: 'blocked' },
    { at: metricTime('2026-08-05'), lane: 'todo', state: 'blocked' },
    { at: metricTime('2026-08-07'), lane: 'todo', state: 'todo' },
  ]);
  assert.equal(cardFlowMetrics(card, board, 'todo', metricTime('2026-08-10')!).blockedDays, 4);
});

test('stalled and aging signals follow idle time and Evergreen suppresses only signals', () => {
  const docs = [
    document('001', 'doing', '2026-08-01', ['2026-08-01 agent: created in doing']),
    document('002', 'doing', '2026-08-01', ['2026-08-01 agent: created in doing'], ['evergreen: true']),
  ];
  const board = boardFromDocuments(CONFIG, docs);
  const analysis = analyzeSingle(board);
  const now = metricTime('2026-08-20')!;
  const stale = cardFlowMetrics(board.cards[0]!, board, analysis.canonical.get('001')!, now);
  const evergreen = cardFlowMetrics(board.cards[1]!, board, analysis.canonical.get('002')!, now);

  assert.equal(stale.idleDays, 19);
  assert.equal(stale.currentLaneDays, 19);
  assert.equal(stale.cumulativeLaneDays, 19);
  assert.deepEqual(stale.stagnation, { days: 19, dots: 3, tone: 'red' });
  assert.equal(stale.stalled, true);
  assert.equal(stale.agingLevel, 2);
  assert.equal(evergreen.stalled, false);
  assert.equal(evergreen.agingLevel, 0);
  assert.equal(evergreen.currentLaneDays, 19, 'Evergreen does not erase metrics');
});

test('due projections distinguish overdue, today, soon, upcoming, and complete', () => {
  const docs = [
    document('001', 'todo', '2026-08-01', ['2026-08-01 agent: created in todo'], ['due: 2026-08-18']),
    document('002', 'todo', '2026-08-01', ['2026-08-01 agent: created in todo'], ['due: 2026-08-20']),
    document('003', 'todo', '2026-08-01', ['2026-08-01 agent: created in todo'], ['due: 2026-08-22']),
    document('004', 'todo', '2026-08-01', ['2026-08-01 agent: created in todo'], ['due: 2026-09-01']),
    document('005', 'done', '2026-08-01', [
      '2026-08-01 agent: created in todo',
      '2026-08-10 agent: closed: done, moved todo → done',
    ], ['due: 2026-08-05']),
  ];
  const board = boardFromDocuments(CONFIG, docs);
  const analysis = analyzeSingle(board);
  const now = metricTime('2026-08-20')!;
  const due = board.cards.map((card) => cardFlowMetrics(card, board, analysis.canonical.get(card.id)!, now).due);

  assert.deepEqual(due, [
    { status: 'overdue', days: -2 },
    { status: 'today', days: 0 },
    { status: 'soon', days: 2 },
    { status: 'upcoming', days: 12 },
    { status: 'complete', days: 0 },
  ]);
});

test('due-date change count derives only from the exact edited-field log token', () => {
  const board = boardFromDocuments(CONFIG, [document('001', 'todo', '2026-08-01', [
    '2026-08-01 agent: created in todo',
    '2026-08-02 agent: edited due',
    '2026-08-03 agent: edited title, due, reminders',
    '2026-08-04 agent: edited overdue-note',
    '2026-08-05 agent: commented: due',
  ], ['due: 2026-08-20'])]);
  assert.equal(cardFlowMetrics(board.cards[0]!, board, 'todo', metricTime('2026-08-20')!).dueChanges, 2);
});

test('board flow metrics rebuild throughput and end-of-day cumulative flow', () => {
  const board = boardFromDocuments(CONFIG, [
    document('001', 'done', '2026-08-01', [
      '2026-08-01 agent: created in todo',
      '2026-08-03 agent: moved todo → doing',
      '2026-08-05 agent: closed: shipped, moved doing → done',
    ]),
    document('002', 'todo', '2026-08-02', [
      '2026-08-02 agent: created in todo',
      '2026-08-04 agent: blocked: waiting',
    ], ['blocked: waiting']),
  ]);
  const analysis = analyzeSingle(board);
  const metrics = boardFlowMetrics(board, metricTime('2026-08-05T12:00:00Z')!, 5);

  assert.deepEqual(metrics.throughput, [
    { date: '2026-08-01', count: 0 },
    { date: '2026-08-02', count: 0 },
    { date: '2026-08-03', count: 0 },
    { date: '2026-08-04', count: 0 },
    { date: '2026-08-05', count: 1 },
  ]);
  assert.deepEqual(metrics.cumulativeFlow.map((point) => ({ date: point.date, ...point.distribution })), [
    { date: '2026-08-01', wishlist: 0, todo: 1, doing: 0, blocked: 0, done: 0, archive: 0 },
    { date: '2026-08-02', wishlist: 0, todo: 2, doing: 0, blocked: 0, done: 0, archive: 0 },
    { date: '2026-08-03', wishlist: 0, todo: 1, doing: 1, blocked: 0, done: 0, archive: 0 },
    { date: '2026-08-04', wishlist: 0, todo: 0, doing: 1, blocked: 1, done: 0, archive: 0 },
    { date: '2026-08-05', wishlist: 0, todo: 0, doing: 0, blocked: 1, done: 1, archive: 0 },
  ]);
});

test('shared board JSON exposes card metrics, flow history, effort, and lane sums', () => {
  const board = boardFromDocuments(CONFIG, [document('001', 'doing', '2026-08-01', [
    '2026-08-01 agent: created in todo',
    '2026-08-03 agent: moved todo → doing',
  ], ['estimate: 5', 'due: 2026-08-22'])]);
  const tree = singleBoardTree(board);
  const analysis = analyze(tree);
  const json = boardJson(tree, analysis, '.', metricTime('2026-08-20')!) as {
    effort: { total: number; progress: number };
    lanes: { id: string; estimate: number; cards: { metrics: { currentLaneDays: number; due: { status: string } } }[] }[];
    flow: { throughput: unknown[]; cumulativeFlow: unknown[] };
  };

  assert.deepEqual(json.effort, { total: 5, completed: 0, progress: 0 });
  assert.equal(json.lanes.find((lane) => lane.id === 'doing')!.estimate, 5);
  const card = json.lanes.find((lane) => lane.id === 'doing')!.cards[0]!;
  assert.equal(card.metrics.currentLaneDays, 17);
  assert.equal(card.metrics.due.status, 'soon');
  assert.equal(json.flow.throughput.length, 30);
  assert.equal(json.flow.cumulativeFlow.length, 30);
});
