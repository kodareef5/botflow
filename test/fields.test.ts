import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boardFromDocuments } from '../src/core/docs.ts';
import { validCardDate, validEstimate, validHill } from '../src/core/fields.ts';
import { opAdd, opEdit, UsageError } from '../src/core/ops.ts';

const CONFIG = `botflow: 0
name: fields
lanes:
  - id: todo
  - id: doing
  - id: done
`;

test('card date validation accepts real UTC values and rejects normalized nonsense', () => {
  for (const value of [
    '2024-02-29',
    '2026-08-20',
    '2026-08-20T14:30Z',
    '2026-08-20T14:30:59Z',
    '2026-08-20T14:30:59.123Z',
  ]) assert.equal(validCardDate(value), true, value);

  for (const value of [
    '2026-02-29',
    '2026-13-01',
    '2026-08-20T24:00Z',
    '2026-08-20T12:60Z',
    '2026-08-20T12:00:60Z',
    '2026-08-20T12:00+01:00',
    '2026-08-20 12:00',
  ]) assert.equal(validCardDate(value), false, value);
});

test('estimate validation is positive, integral, and safely representable', () => {
  for (const value of [1, 5, Number.MAX_SAFE_INTEGER]) assert.equal(validEstimate(value), true);
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '5', null]) assert.equal(validEstimate(value), false);
});

test('Hill Chart positions accept every integer endpoint and nothing outside 0–100', () => {
  for (const value of [0, 1, 50, 99, 100]) assert.equal(validHill(value), true);
  for (const value of [-1, 50.5, 101, '50', null]) assert.equal(validHill(value), false);
});

test('card parser reports invalid structured fields without retaining bad values', () => {
  const board = boardFromDocuments(CONFIG, [{
    path: 'cards/001-bad.md',
    text: `---\nid: 001\ntitle: bad\nlane: todo\ndelegate: true\nstart: 2026-02-29\ndue: tomorrow\nestimate: 0\nhill: 101\nevergreen: yes\n---\n`,
  }]);
  assert.deepEqual(board.findings.map((finding) => finding.rule), ['schema', 'schema', 'schema', 'schema', 'schema', 'schema']);
  assert.equal(board.cards[0]!.delegate, null);
  assert.equal(board.cards[0]!.start, null);
  assert.equal(board.cards[0]!.due, null);
  assert.equal(board.cards[0]!.estimate, null);
  assert.equal(board.cards[0]!.hill, null);
  assert.equal(board.cards[0]!.evergreen, false);
});

test('mutation validation refuses bad dates and estimates before writing them', () => {
  const board = boardFromDocuments(CONFIG, []);
  assert.throws(() => opAdd(board, { title: 'bad', due: 'tomorrow', actor: 'test' }), UsageError);
  const card = opAdd(board, { title: 'good', due: '2026-08-20', estimate: 3, hill: 0, actor: 'test' });
  assert.equal(card.due, '2026-08-20');
  assert.equal(card.estimate, 3);
  assert.equal(card.hill, 0);
  assert.throws(() => opEdit(card, { start: '2026-02-29' }, 'test'), UsageError);
  assert.throws(() => opEdit(card, { estimate: 1.5 }, 'test'), UsageError);
  assert.throws(() => opEdit(card, { hill: 101 }, 'test'), UsageError);
  opEdit(card, { hill: 100 }, 'test');
  assert.equal(card.hill, 100);
  opEdit(card, { hill: null }, 'test');
  assert.equal(card.hill, null);
});

test('presentation mutations enforce scoped labels, colors, and typed fields atomically', () => {
  const board = boardFromDocuments(`botflow: 0
name: presentation
labels:
  - id: Type/Bug
    color: "#D03B3B"
fields:
  - id: sprint
    type: number
    face: true
  - id: risk
    type: select
    options: [low, high]
lanes:
  - id: todo
  - id: doing
  - id: done
`, []);
  const card = opAdd(board, {
    title: 'Rendered', labels: ['Type/Bug'], coverColor: '#F0C040', fields: { sprint: 14, risk: 'high' }, actor: 'test',
  });
  assert.equal(card.coverColor, '#f0c040');
  assert.deepEqual(card.extra, { sprint: 14, risk: 'high' });
  assert.throws(() => opAdd(board, { title: 'conflict', labels: ['Type/Bug', 'Type/Feature'], actor: 'test' }), /both belong to group/);
  assert.throws(() => opAdd(board, { title: 'bad field', fields: { risk: 'medium' }, actor: 'test' }), /valid select/);
  assert.throws(() => opEdit(card, { title: 'must not stick', fields: { sprint: 'fourteen' } }, 'test', board), /valid number/);
  assert.equal(card.title, 'Rendered', 'a rejected patch does not partially mutate the card');
  opEdit(card, { coverColor: null, fields: { sprint: 15, risk: null } }, 'test', board);
  assert.equal(card.coverColor, null);
  assert.deepEqual(card.extra, { sprint: 15 });
});
