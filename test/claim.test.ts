// Claim is a coordination primitive (SPEC §12): succeed only on ready,
// unassigned cards; everything else is a structured conflict. These tests pin
// the pure-core semantics every surface (CLI, MCP, DO, REST) inherits.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boardFromDocuments } from '../src/core/docs.ts';
import { ClaimConflict, claimability, opClaim } from '../src/core/ops.ts';
import type { LoadedBoard } from '../src/core/model.ts';

function card(id: string, front: Record<string, string>, body = ''): { path: string; text: string } {
  const lines = Object.entries({ id, title: `card ${id}`, ...front })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return { path: `cards/${id}-card.md`, text: `---\n${lines}\n---\n${body}` };
}

function board(cards: { path: string; text: string }[], configExtra = ''): LoadedBoard {
  const config = `botflow: 0
name: claims
lanes:
  - id: wishlist
  - id: todo
  - id: doing
  - id: blocked
  - id: done
  - id: archive
${configExtra}`;
  const b = boardFromDocuments(config, cards);
  assert.equal(b.findings.length, 0, b.findings.map((f) => f.message).join('; '));
  return b;
}

function conflictOf(b: LoadedBoard, id: string, actor: string): ClaimConflict {
  const check = claimability(b, b.cards.find((c) => c.id === id)!, actor);
  assert.equal(check.ok, false);
  return (check as { ok: false; conflict: ClaimConflict }).conflict;
}

test('claim succeeds on a ready unassigned card and moves it to doing', () => {
  const b = board([card('001', { lane: 'todo' })]);
  const res = opClaim(b, b.cards[0]!, 'agent-a');
  assert.equal(res.card.assignee, 'agent-a');
  assert.equal(res.card.laneId, 'doing');
  assert.equal(res.from, 'todo');
  assert.equal(res.to, 'doing');
  assert.match(res.card.body, /claimed/);
});

test('second claim by another actor is an "assigned" conflict and mutates nothing', () => {
  const b = board([card('001', { lane: 'todo' })]);
  opClaim(b, b.cards[0]!, 'agent-a');
  const before = { lane: b.cards[0]!.laneId, assignee: b.cards[0]!.assignee, body: b.cards[0]!.body };
  assert.throws(
    () => opClaim(b, b.cards[0]!, 'agent-b'),
    (err: unknown) => err instanceof ClaimConflict && err.reason === 'assigned' && err.holder === 'agent-a',
  );
  assert.deepEqual({ lane: b.cards[0]!.laneId, assignee: b.cards[0]!.assignee, body: b.cards[0]!.body }, before);
});

test('re-claim by the holder is an idempotent no-op', () => {
  const b = board([card('001', { lane: 'todo' })]);
  opClaim(b, b.cards[0]!, 'agent-a');
  const logBefore = b.cards[0]!.body;
  const res = opClaim(b, b.cards[0]!, 'agent-a');
  assert.equal(res.alreadyYours, true);
  assert.equal(res.from, res.to);
  assert.equal(b.cards[0]!.body, logBefore, 'no duplicate log line');
});

test('a todo card pre-assigned to the actor is claimable by them, by nobody else', () => {
  const b = board([card('001', { lane: 'todo', assignee: 'agent-a' })]);
  assert.equal(conflictOf(b, '001', 'agent-b').reason, 'assigned');
  const res = opClaim(b, b.cards[0]!, 'agent-a');
  assert.equal(res.card.laneId, 'doing');
});

test('delegate claim preserves the accountable assignee and has its own race', () => {
  const b = board([card('001', { lane: 'todo', assignee: 'human-owner' })]);
  const res = opClaim(b, b.cards[0]!, 'agent-a', false, 'delegate');
  assert.equal(res.card.assignee, 'human-owner');
  assert.equal(res.card.delegate, 'agent-a');
  assert.equal(res.card.laneId, 'doing');
  assert.match(res.card.body, /delegated, moved todo → doing/);
  assert.equal(claimability(b, b.cards[0]!, 'agent-a', 'delegate').ok, true, 'delegate re-claim is idempotent');
  const conflict = claimability(b, b.cards[0]!, 'agent-b', 'delegate');
  assert.equal(conflict.ok, false);
  assert.equal((conflict as { ok: false; conflict: ClaimConflict }).conflict.holder, 'agent-a');
});

test('forced human claim clears execution delegation while forced delegation keeps ownership', () => {
  const b = board([card('001', { lane: 'doing', assignee: 'human-a', delegate: 'agent-a' })]);
  opClaim(b, b.cards[0]!, 'agent-b', true, 'delegate');
  assert.equal(b.cards[0]!.assignee, 'human-a');
  assert.equal(b.cards[0]!.delegate, 'agent-b');
  assert.match(b.cards[0]!.body, /delegated \(forced\)/);

  opClaim(b, b.cards[0]!, 'human-b', true, 'assign');
  assert.equal(b.cards[0]!.assignee, 'human-b');
  assert.equal(b.cards[0]!.delegate, null);
});

test('an existing assignee can force-take execution back from a delegate', () => {
  const b = board([card('001', { lane: 'doing', assignee: 'human-a', delegate: 'agent-a' })]);
  const res = opClaim(b, b.cards[0]!, 'human-a', true, 'assign');
  assert.equal(res.alreadyYours, undefined);
  assert.equal(res.card.assignee, 'human-a');
  assert.equal(res.card.delegate, null);
  assert.match(res.card.body, /claimed \(forced\)/);
});

test('wishlist and done cards are "not-ready" conflicts', () => {
  const b = board([card('001', { lane: 'wishlist' }), card('002', { lane: 'done' })]);
  assert.equal(conflictOf(b, '001', 'a').reason, 'not-ready');
  assert.equal(conflictOf(b, '002', 'a').reason, 'not-ready');
});

test('a blocked flag makes the card a "blocked" conflict', () => {
  const b = board([card('001', { lane: 'todo', blocked: 'waiting on key' })]);
  const c = conflictOf(b, '001', 'a');
  assert.equal(c.reason, 'blocked');
  assert.match(c.message, /waiting on key/);
});

test('unsatisfied and dangling deps are "deps" conflicts; done deps clear', () => {
  const b = board([
    card('001', { lane: 'todo', deps: '[002, 003]' }),
    card('002', { lane: 'doing' }),
    card('003', { lane: 'done' }),
  ]);
  const c = conflictOf(b, '001', 'a');
  assert.equal(c.reason, 'deps');
  assert.match(c.message, /002/);
  assert.doesNotMatch(c.message, /003/);

  const dangling = board([card('001', { lane: 'todo', deps: '[999]' })]);
  assert.equal(conflictOf(dangling, '001', 'a').reason, 'deps');

  const clear = board([card('001', { lane: 'todo', deps: '[002]' }), card('002', { lane: 'archive' })]);
  const res = opClaim(clear, clear.cards.find((c2) => c2.id === '001')!, 'a');
  assert.equal(res.card.laneId, 'doing');
});

test('board-cards stay out of the ready queue and the pure claim primitive has a lane fallback', async () => {
  const { analyzeSingle } = await import('../src/core/analyze.ts');
  const b = boardFromDocuments(
    `botflow: 0
name: containers
lanes:
  - id: todo
  - id: doing
  - id: done
`,
    [
      card('001', { lane: 'todo' }),
      { path: 'cards/002-sub.md', text: '---\nid: 002\ntitle: sub project\nlane: todo\ntype: board\nboard: ./sub\n---\n' },
    ],
  );
  const analysis = analyzeSingle(b);
  assert.deepEqual(analysis.ready, ['001'], 'only the task card is ready');
  // Without a loaded child analysis, the pure primitive falls back to the
  // container lane; filesystem/hosted wrappers pass effective rollup state.
  const res = opClaim(b, b.cards.find((c) => c.id === '002')!, 'a');
  assert.equal(res.card.laneId, 'doing');
});

test('force overrides any conflict and the log says so', () => {
  const b = board([card('001', { lane: 'wishlist', assignee: 'agent-a' })]);
  const res = opClaim(b, b.cards[0]!, 'agent-b', true);
  assert.equal(res.card.assignee, 'agent-b');
  assert.equal(res.card.laneId, 'doing');
  assert.match(res.card.body, /claimed \(forced\)/);
});

test('claim enters a substated doing lane at its first substate', () => {
  const config = `botflow: 0
name: claims
lanes:
  - id: todo
  - id: doing
    substates: [design, implement, review]
  - id: done
`;
  const b = boardFromDocuments(config, [card('001', { lane: 'todo' })]);
  const res = opClaim(b, b.cards[0]!, 'a');
  assert.equal(res.to, 'doing.design');
});

test('two racing claims through the fs wrapper produce exactly one winner', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { addCard, claimCard, initBoard } = await import('../src/core/mutate.ts');

  const dir = mkdtempSync(join(tmpdir(), 'botflow-claim-'));
  try {
    const root = initBoard(dir);
    addCard(root, { title: 'race me', lane: 'todo', actor: 'setup' });
    const results = ['agent-a', 'agent-b'].map((actor) => {
      try {
        return { actor, res: claimCard(root, '001', actor) };
      } catch (err) {
        if (err instanceof ClaimConflict) return { actor, conflict: err };
        throw err;
      }
    });
    const winners = results.filter((r) => 'res' in r);
    const losers = results.filter((r) => 'conflict' in r);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal((losers[0] as { conflict: ClaimConflict }).conflict.holder, winners[0]!.actor);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
