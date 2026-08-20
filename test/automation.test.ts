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
  applyAutomationRules,
  claimability,
  opAutomationPass,
  opBlock,
  opBulk,
  opButton,
  opClaim,
  opClose,
  opComment,
  opMove,
  opRemoveFilter,
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
  const beforeReplay = source.body;
  const beforeLane = source.laneId;
  const replay = opClose(board, source, 'sam', 'replay', undefined, false, NOW);
  assert.equal(replay.created, undefined);
  assert.equal(replay.alreadyClosed, true);
  assert.equal(source.body, beforeReplay, 'close replay does not append another log or rule');
  assert.equal(source.laneId, beforeLane, 'close replay does not move an already-closed card');
  assert.deepEqual(opBulk(board, ['001'], { kind: 'close' }, 'sam').cards, [], 'bulk close also treats an already-closed card as unchanged');
});

test('missing automation filters are inert and referenced filters cannot be removed', () => {
  const missing = boardFromDocuments(`botflow: 0
name: inert rules
features: [automation]
lanes:
  - id: todo
  - id: done
  - id: archive
rules:
  - id: scoped-close
    event: close
    filter: no-longer-there
    action: label
    value: should-not-appear
`, [doc('001', ['lane: todo'])]);
  assert.match(missing.findings.map((finding) => finding.message).join('\n'), /filter must name a saved filter/);
  opClose(missing, missing.cards[0]!, 'sam', undefined, undefined, false, NOW);
  assert.deepEqual(missing.cards[0]!.labels, [], 'an invalid declared filter never becomes match-all');
  assert.equal(missing.config.rules[0]!.filter, 'no-longer-there', 'the stale reference remains available for repair');

  const referenced = boardFromDocuments(`botflow: 0
name: referenced rules
features: [automation]
filters:
  - id: bugs
    query: label:bug
rules:
  - id: scoped-close
    event: close
    filter: bugs
    action: label
    value: reviewed
`, [doc('001', ['lane: todo'])]);
  assert.throws(() => opRemoveFilter(referenced.config, 'bugs'), /referenced by rule "scoped-close"/);
});

test('filtered rules share one immutable analysis and one query per saved filter', () => {
  const repeated = Array.from({ length: 8 }, (_, index) => `
  - id: todo-${index}
    event: close
    filter: todo
    action: label
    value: todo-${index}`).join('');
  const board = boardFromDocuments(`botflow: 0
name: cached rules
features: [automation]
filters:
  - id: todo
    query: state:todo
  - id: newly-labelled
    query: label:first-rule
rules:
  - id: first
    event: close
    action: label
    value: first-rule
${repeated}
  - id: snapshot-proof
    event: close
    filter: newly-labelled
    action: label
    value: must-not-appear
`, [doc('001', ['lane: todo'])]);
  const stats = { analyses: 0, queries: 0 };
  const applied = applyAutomationRules(board, board.cards[0]!, 'close', 'sam', NOW, stats);
  assert.equal(stats.analyses, 1, 'all filtered rules share one analyzed snapshot');
  assert.equal(stats.queries, 2, 'each distinct saved filter is queried once');
  assert.equal(applied.length, 9);
  assert.equal(board.cards[0]!.labels.includes('must-not-appear'), false,
    'an earlier action cannot alter a later filter snapshot');
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

test('archive policy without an archive lane stays readable and never schedules an impossible sweep', () => {
  const board = boardFromDocuments(`botflow: 0
name: no archive
features: [automation]
lanes:
  - id: todo
  - id: doing
  - id: done
automation:
  archive_done_after: 1
`, [doc('001', ['lane: done'], `## Log
- 2026-08-01 sam: created in todo
- 2026-08-02 sam: closed, moved todo → done
`)]);
  assert.match(board.findings.map((finding) => finding.message).join('\n'), /archive_done_after requires an archive-canonical lane/);
  assert.deepEqual(opAutomationPass(board, NOW).actions, []);
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
