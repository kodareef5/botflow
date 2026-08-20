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

  // Only 001 is ready: 002 waits on it.
  const ready1 = JSON.parse(ok(dir, 'ready', '--json')) as { id: string }[];
  assert.deepEqual(ready1.map((c) => c.id), ['001']);

  ok(dir, 'card', 'claim', '001');
  ok(dir, 'log', '001', 'halfway there');
  ok(dir, 'card', 'describe', '001', 'What', 'and', 'why.');
  ok(dir, 'card', 'item', '001', 'part one');
  ok(dir, 'card', 'item', '001', 'part two', '--section', 'QA');
  const authored = JSON.parse(ok(dir, 'card', 'show', '001', '--json')) as { parsed: { description: string; checklists: { section: string }[] } };
  assert.equal(authored.parsed.description, 'What and why.');
  assert.deepEqual(authored.parsed.checklists.map((c) => c.section), ['Checklist', 'QA']);
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

test('cli: structured scheduling, effort, Evergreen, and delegation fields round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-fields-'));
  ok(dir, 'init', '--name', 'fields');
  ok(
    dir,
    'card', 'add', 'Scheduled work',
    '--assignee', 'human-owner',
    '--delegate', 'agent-a',
    '--start', '2026-08-20T13:00Z',
    '--due', '2026-08-24',
    '--reminders', '1440,60',
    '--repeat', '2:week:due',
    '--snooze', '2099-01-01T00:00:00Z',
    '--estimate', '8',
    '--hill', '0',
    '--evergreen',
  );
  let shown = JSON.parse(ok(dir, 'card', 'show', '001', '--json')) as Record<string, unknown>;
  assert.equal(shown['assignee'], 'human-owner');
  assert.equal(shown['delegate'], 'agent-a');
  assert.equal(shown['start'], '2026-08-20T13:00Z');
  assert.equal(shown['due'], '2026-08-24');
  assert.deepEqual(shown['reminders'], [1440, 60]);
  assert.deepEqual(shown['repeat'], { every: 2, unit: 'week', from: 'due' });
  assert.equal(shown['snooze'], '2099-01-01T00:00:00Z');
  assert.equal(shown['estimate'], 8);
  assert.equal(shown['hill'], 0);
  assert.equal(shown['evergreen'], true);

  ok(
    dir,
    'card', 'edit', '001',
    '--delegate', 'none',
    '--start', 'none',
    '--due', '2026-08-30T18:30:00Z',
    '--reminders', 'none',
    '--repeat', 'none',
    '--snooze', 'none',
    '--estimate', 'none',
    '--hill', '76',
    '--evergreen', 'false',
  );
  shown = JSON.parse(ok(dir, 'card', 'show', '001', '--json')) as Record<string, unknown>;
  assert.equal(shown['delegate'], null);
  assert.equal(shown['start'], null);
  assert.equal(shown['due'], '2026-08-30T18:30:00Z');
  assert.deepEqual(shown['reminders'], []);
  assert.equal(shown['repeat'], null);
  assert.equal(shown['snooze'], null);
  assert.equal(shown['estimate'], null);
  assert.equal(shown['hill'], 76);
  assert.equal(shown['evergreen'], false);

  assert.equal(bf(dir, 'card', 'add', 'Bad date', '--due', 'tomorrow').code, 1);
  assert.equal(bf(dir, 'card', 'add', 'Bad estimate', '--estimate', '1.5').code, 1);
  assert.equal(bf(dir, 'card', 'add', 'Bad hill', '--hill', '101').code, 1);

  ok(dir, 'card', 'add', 'Delegate me');
  const claimed = JSON.parse(ok(dir, 'card', 'claim', '002', '--delegate', '--json')) as Record<string, unknown>;
  assert.equal(claimed['assignee'], null);
  assert.equal(claimed['delegate'], 'test-agent');
});

test('cli: scheduling automation, WIP modes, named blockers, rules, and buttons compose', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-automation-cli-'));
  ok(dir, 'init', '--name', 'automation-cli');
  writeFileSync(join(dir, '.botflow', 'board.yaml'), `botflow: 0
name: automation-cli
features: [automation, named-blockers]
filters:
  - id: todo-work
    name: Todo work
    query: "lane:todo"
blockers:
  - id: external-review
    name: External review
    color: "#b42318"
buttons:
  - id: reviewed
    name: Mark reviewed
    scope: card
    action: label
    value: reviewed
  - id: triage
    name: Triage todo
    scope: board
    filter: todo-work
    action: label
    value: triaged
rules:
  - id: doing-label
    event: enter
    lane: doing
    action: label
    value: started
lanes:
  - id: todo
  - id: doing
    wip: 1
    wip_mode: justify
  - id: gate
    canonical: doing
    wip: 1
    wip_mode: deny
  - id: done
  - id: archive
`);

  ok(dir, 'card', 'add', 'Doing occupant', '--lane', 'doing'); // 001
  ok(dir, 'card', 'add', 'Needs capacity'); // 002
  assert.match(bf(dir, 'card', 'mv', '002', 'doing').stderr, /WIP justification/);
  ok(dir, 'card', 'mv', '002', 'doing', '--wip-reason', 'customer incident');
  let shown = JSON.parse(ok(dir, 'card', 'show', '002', '--json')) as Record<string, unknown>;
  assert.ok((shown['labels'] as string[]).includes('started'));
  assert.match(String(shown['body']), /wip justification for doing: customer incident/);

  ok(dir, 'card', 'block', '002', '--reason', 'approval pending', '--blocker', 'external-review');
  assert.equal(bf(dir, 'card', 'mv', '002', 'todo').code, 1, 'a named blocker prevents ordinary movement');
  ok(dir, 'card', 'unblock', '002');
  ok(dir, 'button', 'run', 'reviewed', '--card', '002');
  shown = JSON.parse(ok(dir, 'card', 'show', '002', '--json')) as Record<string, unknown>;
  assert.ok((shown['labels'] as string[]).includes('reviewed'));
  assert.equal((JSON.parse(ok(dir, 'button', 'list', '--json')) as unknown[]).length, 2);

  ok(dir, 'card', 'add', 'Snoozed work', '--snooze', '2099-01-01T00:00:00Z'); // 003
  assert.ok(!(JSON.parse(ok(dir, 'ready', '--json')) as { id: string }[]).some((card) => card.id === '003'));
  ok(dir, 'card', 'snooze', '003', '--off');
  assert.ok((JSON.parse(ok(dir, 'ready', '--json')) as { id: string }[]).some((card) => card.id === '003'));
  ok(dir, 'button', 'run', 'triage');
  shown = JSON.parse(ok(dir, 'card', 'show', '003', '--json')) as Record<string, unknown>;
  assert.ok((shown['labels'] as string[]).includes('triaged'));

  const reminderDue = new Date(Date.now() + 30 * 60_000).toISOString();
  ok(dir, 'card', 'add', 'Due reminder', '--due', reminderDue, '--reminders', '60'); // 004
  ok(dir, 'automate', '--json');
  const reminded = JSON.parse(ok(dir, 'card', 'show', '004', '--json')) as { parsed: { log: { actor: string; text: string }[] } };
  assert.equal(reminded.parsed.log.filter((entry) => entry.actor === 'botflow' && entry.text === `reminder 60m for due ${reminderDue}`).length, 1);
  ok(dir, 'automate', '--json');

  ok(dir, 'card', 'add', 'Recurring audit', '--due', '2099-02-01', '--repeat', '1:week:due'); // 005
  const closed = JSON.parse(ok(dir, 'card', 'close', '005', '--json')) as { created: string | null };
  assert.equal(closed.created, '006');
  const closedPath = join(dir, '.botflow', 'cards', '005-recurring-audit.md');
  const closedOnce = readFileSync(closedPath, 'utf8');
  const replay = JSON.parse(ok(dir, 'card', 'close', '005', '--json')) as { alreadyClosed: boolean; created: string | null };
  assert.deepEqual(replay, { id: '005', from: 'done', to: 'done', alreadyClosed: true, created: null, warnings: [] });
  assert.equal(readFileSync(closedPath, 'utf8'), closedOnce, 'replayed close does not rewrite the source card');
  const successor = JSON.parse(ok(dir, 'card', 'show', '006', '--json')) as Record<string, unknown>;
  assert.deepEqual(successor['repeat'], { every: 1, unit: 'week', from: 'due' });
  assert.equal(bf(dir, 'filter', 'rm', 'todo-work').code, 1, 'a filter referenced by a board button cannot be removed');
});

test('cli: every lazy-automation read stays usable when an archive policy has no archive lane', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-no-archive-'));
  ok(dir, 'init', '--name', 'no archive');
  writeFileSync(join(dir, '.botflow', 'board.yaml'), `botflow: 0
name: no archive
features: [automation]
lanes:
  - id: todo
  - id: doing
  - id: done
automation:
  archive_done_after: 1
`);
  writeFileSync(join(dir, '.botflow', 'cards', '001-old-done.md'), `---
id: 001
title: Old completion
lane: done
---
## Log
- 2020-01-01 12:00 test-agent: closed, moved doing → done
`);
  for (const args of [['board', '--json'], ['prime', '--json'], ['ready', '--json'], ['query', 'state:done', '--json']]) {
    assert.equal(bf(dir, ...args).code, 0, `botflow ${args.join(' ')} remains a total read`);
  }
  const lintResult = bf(dir, 'lint', '--json');
  assert.equal(lintResult.code, 1, 'the invalid configuration remains visible to lint');
  const lint = JSON.parse(lintResult.stdout) as { message: string }[];
  assert.ok(lint.some((finding) => finding.message.includes('archive_done_after requires an archive-canonical lane')));
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
    ['---', 'id: 001', 'title: Custom card', 'lane: todo', 'due: tomorrow', 'estimate: 0', 'vendor_estimate: 3d', '---', '## Description', 'Hand-written body.', ''].join('\n'),
  );
  ok(dir, 'card', 'edit', '001', '--title', 'Custom card v2', '--priority', 'p2');
  let rewritten = readFileSync(cardPath, 'utf8');
  assert.ok(rewritten.includes('vendor_estimate: 3d'), 'unknown key preserved');
  assert.ok(rewritten.includes('due: tomorrow'), 'invalid known date preserved');
  assert.ok(rewritten.includes('estimate: 0'), 'invalid known estimate preserved');
  assert.ok(rewritten.includes('Hand-written body.'), 'body preserved');
  assert.ok(rewritten.includes('title: Custom card v2'));
  assert.ok(rewritten.includes('priority: p2'));

  ok(dir, 'card', 'edit', '001', '--due', '2026-08-22', '--estimate', '3');
  rewritten = readFileSync(cardPath, 'utf8');
  assert.ok(rewritten.includes('due: 2026-08-22'), 'explicit repair replaces invalid date');
  assert.ok(rewritten.includes('estimate: 3'), 'explicit repair replaces invalid estimate');

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

test('cli: scoped labels, cover color, and typed custom fields round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-'));
  ok(dir, 'init', '--name', 'presentation');
  writeFileSync(join(dir, '.botflow', 'board.yaml'), `botflow: 0
name: presentation
features: [scoped-labels, custom-fields, cover-colors]
labels:
  - id: Type/Bug
    color: "#d03b3b"
fields:
  - id: sprint
    name: Sprint
    type: number
    face: true
  - id: risk
    name: Risk
    type: select
    options: [low, high]
lanes:
  - id: todo
  - id: doing
  - id: done
`);
  ok(dir, 'card', 'add', 'Visible card', '--labels', 'Type/Bug', '--cover-color', '#F0C040', '--field', 'sprint=14', '--field', 'risk=high');
  let shown = JSON.parse(ok(dir, 'card', 'show', '001', '--json')) as {
    coverColor: string | null; labelDetails: { group: string; value: string; color: string }[];
    fields: { id: string; value: unknown }[]; faceFields: { id: string }[];
  };
  assert.equal(shown.coverColor, '#f0c040');
  assert.deepEqual(shown.labelDetails, [{ id: 'Type/Bug', group: 'Type', value: 'Bug', color: '#d03b3b' }]);
  assert.deepEqual(Object.fromEntries(shown.fields.map((field) => [field.id, field.value])), { sprint: 14, risk: 'high' });
  assert.deepEqual(shown.faceFields.map((field) => field.id), ['sprint']);
  ok(dir, 'card', 'edit', '001', '--cover-color', 'none', '--field', 'sprint=15', '--field', 'risk=');
  shown = JSON.parse(ok(dir, 'card', 'show', '001', '--json')) as typeof shown;
  assert.equal(shown.coverColor, null);
  assert.deepEqual(Object.fromEntries(shown.fields.map((field) => [field.id, field.value])), { sprint: 15 });
  assert.match(readFileSync(join(dir, '.botflow', 'cards', '001-visible-card.md'), 'utf8'), /sprint: 15/);
});

test('cli: templates, relations, promotion, quick add, bulk actions, merge, and transfer compose', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-relations-cli-'));
  const child = join(dir, '.botflow', 'child');
  ok(dir, 'init', '--name', 'relations');
  ok(dir, 'init', '--name', 'child', '--dir', child);
  writeFileSync(join(dir, '.botflow', 'board.yaml'), `botflow: 0
name: relations
features: [relations, templates]
templates:
  - id: bug
    name: Bug report
    lane: todo
    labels: [Type/Bug]
    priority: p1
    estimate: 3
    body: "## Checklist\\n- [ ] verify {{title}}\\n"
lanes:
  - id: wishlist
  - id: todo
  - id: doing
  - id: blocked
  - id: done
  - id: archive
`);

  ok(dir, 'card', 'add', 'Login crash', '--template', 'bug'); // 001
  let shown = JSON.parse(ok(dir, 'card', 'show', '001', '--json')) as Record<string, unknown>;
  assert.equal(shown['priority'], 'p1');
  assert.equal(shown['estimate'], 3);
  assert.deepEqual(shown['labels'], ['Type/Bug']);
  assert.match(String(shown['body']), /verify Login crash/);

  ok(dir, 'card', 'add', 'Parent'); // 002
  ok(dir, 'card', 'item', '002', 'Investigate logs');
  const promoted = JSON.parse(ok(dir, 'card', 'promote', '002', '1', '--json')) as { promoted: string };
  assert.equal(promoted.promoted, '003');
  shown = JSON.parse(ok(dir, 'card', 'show', '003', '--json')) as Record<string, unknown>;
  assert.deepEqual(shown['relations'], [{ type: 'parent', target: '002' }]);

  ok(dir, 'card', 'link', '001', '003', '--type', 'relates');
  shown = JSON.parse(ok(dir, 'card', 'show', '003', '--json')) as Record<string, unknown>;
  assert.ok((shown['relations'] as { type: string; target: string }[]).some((r) => r.type === 'relates' && r.target === '001'));
  ok(dir, 'card', 'unlink', '001', '003', '--type', 'relates');

  const quick = JSON.parse(ok(dir, 'card', 'quick', 'Batch one *ops\n  Batch child !p2', '--json')) as { id: string }[];
  assert.deepEqual(quick.map((card) => card.id), ['004', '005']);
  ok(dir, 'card', 'bulk', '004,005', 'label', '--add-labels', 'batched');
  for (const id of ['004', '005']) {
    shown = JSON.parse(ok(dir, 'card', 'show', id, '--json')) as Record<string, unknown>;
    assert.ok((shown['labels'] as string[]).includes('batched'));
  }

  ok(dir, 'card', 'add', 'Canonical'); // 006
  ok(dir, 'card', 'add', 'Duplicate'); // 007
  ok(dir, 'card', 'attach', '007', 'https://example.com/evidence.png');
  const merged = JSON.parse(ok(dir, 'card', 'merge', '007', '006', '--json')) as { attachmentsMoved: number };
  assert.equal(merged.attachmentsMoved, 1);
  shown = JSON.parse(ok(dir, 'card', 'show', '007', '--json')) as Record<string, unknown>;
  assert.equal(shown['state'], 'archive');

  const copied = JSON.parse(ok(dir, 'card', 'copy', '001', '--to-board', '.botflow/child', '--json')) as { target: string; reused: boolean };
  assert.equal(copied.target, '001');
  assert.equal(copied.reused, false);
  const replay = JSON.parse(ok(dir, 'card', 'copy', '001', '--to-board', '.botflow/child', '--json')) as { source: string; target: string; targetBoard: string; moved: boolean; reused: boolean };
  assert.equal(replay.source, '001');
  assert.equal(replay.target, '001');
  assert.ok(replay.targetBoard.endsWith('/child/.botflow'));
  assert.equal(replay.moved, false);
  assert.equal(replay.reused, true);
  const moved = JSON.parse(ok(dir, 'card', 'move-to', '002', '--to-board', '.botflow/child', '--json')) as { target: string; moved: boolean };
  assert.equal(moved.target, '002');
  assert.equal(moved.moved, true);
  shown = JSON.parse(ok(dir, 'card', 'show', '002', '--json')) as Record<string, unknown>;
  assert.equal(shown['state'], 'archive', 'move-to retires the source only after the target write succeeds');
  const rootLint = bf(dir, 'lint');
  assert.equal(rootLint.code, 0, rootLint.stderr || rootLint.stdout);
});

test('cli: search, saved filters, watching, voting, boosts, and lane subscriptions compose', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-collab-cli-'));
  ok(dir, 'init', '--name', 'collab');
  ok(dir, 'card', 'add', 'Repair API', '--labels', 'Type/Bug');
  ok(dir, 'card', 'add', 'Write guide', '--labels', 'Type/Docs');

  ok(dir, 'card', 'watch', '001');
  ok(dir, 'card', 'vote', '001');
  ok(dir, 'card', 'boost', '001', 'ship it 🚀');
  ok(dir, 'lane', 'subscribe', 'doing');
  ok(dir, 'filter', 'save', 'mine', 'watcher:@me', '--name', 'Watching');

  const matches = JSON.parse(ok(dir, 'query', '--saved', 'mine', '--json')) as { id: string }[];
  assert.deepEqual(matches.map((card) => card.id), ['001']);
  const docs = JSON.parse(ok(dir, 'query', 'label:Type/Docs', '--json')) as { id: string }[];
  assert.deepEqual(docs.map((card) => card.id), ['002']);
  const shown = JSON.parse(ok(dir, 'card', 'show', '001', '--json')) as {
    watchers: string[]; votes: string[]; boostCount: number; parsed: { boosts: { text: string }[] };
  };
  assert.deepEqual(shown.watchers, ['test-agent']);
  assert.deepEqual(shown.votes, ['test-agent']);
  assert.equal(shown.boostCount, 1);
  assert.equal(shown.parsed.boosts[0]?.text, 'ship it 🚀');

  ok(dir, 'card', 'watch', '001', '--off');
  ok(dir, 'card', 'vote', '001', '--off');
  ok(dir, 'lane', 'subscribe', 'doing', '--off');
  ok(dir, 'filter', 'rm', 'mine');
  const board = JSON.parse(ok(dir, 'board', '--json')) as { filters: unknown[]; subscriptions: unknown[] };
  assert.deepEqual(board.filters, []);
  assert.deepEqual(board.subscriptions, []);
  const tooLong = bf(dir, 'card', 'boost', '001', 'this is much too long');
  assert.equal(tooLong.code, 1);
  assert.match(tooLong.stderr, /at most 12/);
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
