import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyzeSingle } from '../src/core/analyze.ts';
import { parseBody } from '../src/core/body.ts';
import { boardFromDocuments } from '../src/core/docs.ts';
import { loadBoard } from '../src/core/load.ts';
import { cardFlowMetrics, metricTime } from '../src/core/metrics.ts';
import {
  ClaimConflict,
  UsageError,
  claimability,
  opAutomationPass,
  opBlock,
  opButton,
  opClaim,
  opClose,
  opComment,
  opMove,
} from '../src/core/ops.ts';

const NOW = new Date('2026-08-20T12:00:00Z');

function doc(id: string, fields: string[], body = ''): { path: string; text: string } {
  return {
    path: `cards/${id}-task.md`,
    text: `---\nid: ${id}\ntitle: task ${id}\n${fields.join('\n')}\n---\n${body}`,
  };
}

test('active snooze suppresses readiness and claim until genuine activity wakes it', () => {
  const board = boardFromDocuments('botflow: 0\nname: snooze\nfeatures: [automation]\n', [
    doc('001', ['lane: todo', 'snooze: 2026-08-22T00:00:00Z'], '## Log\n- 2026-08-19 sam: created in todo\n'),
  ]);
  const card = board.cards[0]!;
  assert.deepEqual(analyzeSingle(board, undefined, undefined, NOW).ready, []);
  const check = claimability(board, card, 'sam', 'assign', undefined, NOW);
  assert.equal(check.ok, false);
  if (!check.ok) assert.equal(check.conflict.reason, 'snoozed');
  assert.throws(() => opClaim(board, card, 'sam', false, 'assign', undefined, undefined, NOW), ClaimConflict);

  opComment(card, 'lee', 'There is new information.');
  assert.equal(card.snooze, null);
  assert.match(card.body, /comment activity \(woke snooze\)/);
});

test('WIP justify and deny modes validate before lane mutation and audit overrides', () => {
  const justify = boardFromDocuments(`botflow: 0
name: wip
features: [automation]
lanes:
  - id: todo
  - id: doing
    wip: 1
    wip_mode: justify
  - id: done
  - id: archive
`, [doc('001', ['lane: doing']), doc('002', ['lane: todo'])]);
  const card = justify.cards[1]!;
  assert.throws(() => opMove(justify, card, 'doing', 'sam'), /requires a WIP justification/);
  assert.equal(card.laneId, 'todo');
  const moved = opMove(justify, card, 'doing', 'sam', false, 'pairing during incident');
  assert.equal(moved.warnings.length, 1);
  assert.match(card.body, /wip justification for doing: pairing during incident/);

  const deny = boardFromDocuments(`botflow: 0
name: deny
features: [automation]
lanes:
  - id: todo
  - id: review
    canonical: doing
    wip: 1
    wip_mode: deny
  - id: done
  - id: archive
`, [doc('001', ['lane: review']), doc('002', ['lane: todo'])]);
  assert.throws(() => opMove(deny, deny.cards[1]!, 'review', 'sam'), /denies WIP overflow/);
  assert.throws(() => opMove(deny, deny.cards[1]!, 'review', 'sam', true), /requires a justification/);
  opMove(deny, deny.cards[1]!, 'review', 'sam', true, 'incident commander approved');
  assert.match(deny.cards[1]!.body, /wip override for review: incident commander approved/);
});

test('named blockers are controlled, immobile, rule-aware, and measured by reason', () => {
  const board = loadBoard(new URL('./fixtures/automation', import.meta.url).pathname);
  const card = board.cards.find((candidate) => candidate.id === '002')!;
  assert.throws(() => opBlock(card, 'sam', 'waiting', board, 'missing'), /unknown blocker/);
  opBlock(card, 'sam', 'waiting for review', board, 'external-review');
  assert.equal(card.blocker, 'external-review');
  assert.match(card.body, /blocked \[external-review\]: waiting for review/);
  assert.equal(parseBody(card.body).comments.at(-1)?.text, 'Waiting on the named dependency.');
  assert.throws(() => opMove(board, card, 'doing', 'sam'), /unblock it before moving/);

  const historical = board.cards.find((candidate) => candidate.id === '003')!;
  assert.deepEqual(cardFlowMetrics(historical, board, 'blocked', NOW).blockerDays, { 'external-review': 8 });
});

test('closing recurring work creates exactly one clean, cadence-linked successor', () => {
  const board = boardFromDocuments(`botflow: 0
name: recurrence
features: [automation]
lanes:
  - id: todo
  - id: doing
  - id: done
  - id: archive
`, [doc('001', [
    'lane: doing',
    'assignee: sam',
    'delegate: bot',
    'watchers: [lee]',
    'votes: [pat]',
    'start: 2026-07-31',
    'due: 2026-08-01',
    'reminders: [60]',
    'repeat:',
    '  every: 1',
    '  unit: week',
    '  from: due',
  ], `## Description
Repeat this work.

## Checklist
- [x] prepare
- [ ] ship

## Comments
- 2026-08-10 sam: prior discussion

## Boosts
- 2026-08-10 lee: go

## Log
- 2026-07-31 sam: created in todo
- 2026-08-01 sam: moved todo → doing
`)]);
  const source = board.cards[0]!;
  const result = opClose(board, source, 'sam', 'complete', undefined, false, NOW);
  const next = result.created!;
  assert.equal(next.due, '2026-08-22');
  assert.equal(next.start, '2026-08-21');
  assert.equal(next.laneId, 'todo');
  assert.equal(next.delegate, null);
  assert.deepEqual(next.votes, []);
  assert.deepEqual(next.watchers, ['lee']);
  assert.deepEqual(parseBody(next.body).checklist, { done: 0, total: 2 });
  assert.equal(parseBody(next.body).comments.length, 0);
  assert.equal(parseBody(next.body).boosts.length, 0);
  assert.deepEqual(next.relations.map(({ type, target }) => ({ type, target })), [{ type: 'recurs-from', target: '001' }]);
  assert.equal(source.relations.some((relation) => relation.type === 'recurs-to' && relation.target === next.id), true);

  board.cards.push(next);
  const replay = opClose(board, source, 'sam', 'replay', undefined, false, NOW);
  assert.equal(replay.created, undefined);
});

test('automation pass applies due reminders, snooze expiry, and lazy sweeps once', () => {
  const board = loadBoard(new URL('./fixtures/automation', import.meta.url).pathname);
  const pass = opAutomationPass(board, NOW);
  assert.deepEqual(pass.actions.map((action) => [action.kind, action.cardId]), [
    ['sweep', '004'],
    ['snooze-expired', '006'],
    ['reminder', '001'],
  ]);
  const byId = new Map(pass.cards.map((card) => [card.id, card]));
  assert.equal(byId.get('004')!.laneId, 'archive');
  assert.equal(byId.get('006')!.snooze, null);
  assert.equal(byId.get('001')!.snooze, '2026-08-22T00:00:00Z', 'system reminders do not wake snooze');

  const applied = { ...board, cards: board.cards.map((card) => byId.get(card.id) ?? card) };
  assert.deepEqual(opAutomationPass(applied, NOW).actions, []);
});

test('card and board buttons stay declarative, filtered, and atomic', () => {
  const board = loadBoard(new URL('./fixtures/automation', import.meta.url).pathname);
  const result = opButton(board, 'review-open', 'sam', { now: NOW });
  assert.deepEqual(result.cards.map((card) => card.id), ['001', '002']);
  assert.equal(result.cards.every((card) => card.labels.includes('reviewed')), true);
  assert.equal(board.cards.find((card) => card.id === '001')!.labels.includes('reviewed'), false, 'pure bulk op leaves input untouched');

  const finish = opButton(board, 'finish', 'sam', { cardId: '002' });
  assert.equal(finish.cards[0]!.laneId, 'done');
  assert.throws(() => opButton(board, 'finish', 'sam'), UsageError);
});
