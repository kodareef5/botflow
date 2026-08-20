import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseBody } from '../src/core/body.ts';
import { analyze, lintBoard } from '../src/core/analyze.ts';
import { boardFromDocuments, singleBoardTree } from '../src/core/docs.ts';
import type { BoardDocument } from '../src/core/docs.ts';
import {
  opAdd,
  opBulk,
  opLink,
  opMergeDuplicates,
  opPromote,
  opQuickAdd,
  opUnlink,
  parseQuickAdd,
  UsageError,
} from '../src/core/ops.ts';
import { parseCardReference, resolveTreeCardReference, textCardReferences } from '../src/core/refs.ts';
import { loadBoard, loadTree } from '../src/core/load.ts';
import { transferCard } from '../src/core/mutate.ts';

const CONFIG = `botflow: 0
name: operations
features: [relations, templates]
labels:
  - id: Type/Bug
fields:
  - id: risk
    name: Risk
    type: select
    options: [low, high]
templates:
  - id: bug
    name: Bug report
    lane: todo
    labels: [Type/Bug]
    priority: p1
    due: 2026-09-01
    estimate: 3
    fields:
      risk: high
    body: "## Checklist\\n- [ ] reproduce {{title}}\\n"
lanes:
  - id: todo
  - id: doing
  - id: done
  - id: archive
`;

function doc(id: string, title: string, lane = 'todo', body = ''): BoardDocument {
  return {
    path: `cards/${id}-${title.toLowerCase().replace(/\W+/g, '-')}.md`,
    text: `---\nid: ${id}\ntitle: ${title}\nlane: ${lane}\n---\n${body || `## Log\n- 2026-08-01 test: created in ${lane}\n`}`,
  };
}

function board(docs: BoardDocument[] = []) {
  return boardFromDocuments(CONFIG, docs, 'test');
}

test('card references parse conservatively and explicit body refs dedupe', () => {
  assert.deepEqual(parseCardReference('001'), { boardRef: null, cardId: '001' });
  assert.deepEqual(parseCardReference('child/.botflow#a3f9k2'), { boardRef: 'child/.botflow', cardId: 'a3f9k2' });
  assert.deepEqual(parseCardReference('project:abc-123#004'), { boardRef: 'project:abc-123', cardId: '004' });
  assert.equal(parseCardReference('bad ref'), null);
  assert.deepEqual(textCardReferences('see [[001]], [[child#002]], then [[001]] and [ordinary](url)'), ['001', 'child#002']);

  const b = board([doc('001', 'One')]);
  const tree = singleBoardTree(b);
  assert.equal(resolveTreeCardReference(tree, '.', '001')?.card.title, 'One');
  assert.equal(resolveTreeCardReference(tree, '.', 'project:x#001'), null);
});

test('card templates copy defaults and explicit create values win', () => {
  const b = board();
  const card = opAdd(b, {
    title: 'Login crash',
    template: 'bug',
    priority: 'p0',
    fields: { risk: 'low' },
    actor: 'dev',
  });
  assert.equal(card.laneId, 'todo');
  assert.deepEqual(card.labels, ['Type/Bug']);
  assert.equal(card.priority, 'p0');
  assert.equal(card.due, '2026-09-01');
  assert.equal(card.estimate, 3);
  assert.equal(card.extra['risk'], 'low');
  assert.match(card.body, /reproduce Login crash/);
  assert.equal(parseBody(card.body).checklist.total, 1);
  assert.equal(parseBody(card.body).log.length, 1);
  assert.throws(() => opAdd(b, { title: 'x', template: 'missing', actor: 'dev' }), /no template/);
});

test('link and unlink maintain natural inverses without duplicate log churn', () => {
  const b = board([doc('001', 'Parent'), doc('002', 'Child')]);
  const linked = opLink(b, '002', '001', 'parent', 'dev');
  assert.equal(linked.changed, true);
  assert.deepEqual(linked.source.relations.map(({ type, target }) => ({ type, target })), [{ type: 'parent', target: '001' }]);
  assert.deepEqual(linked.target.relations.map(({ type, target }) => ({ type, target })), [{ type: 'subtask', target: '002' }]);
  const sourceLog = parseBody(linked.source.body).log.length;
  assert.equal(opLink(b, '002', '001', 'parent', 'dev').changed, false);
  assert.equal(parseBody(linked.source.body).log.length, sourceLog);
  assert.equal(opUnlink(b, '002', '001', 'parent', 'dev').changed, true);
  assert.deepEqual(linked.source.relations, []);
  assert.deepEqual(linked.target.relations, []);
  assert.throws(() => opLink(b, '001', '001', 'relates', 'dev'), /itself/);
});

test('promote checks the item, inherits ownership fields, and creates inverse relations', () => {
  const source = doc('001', 'Parent', 'todo', `## Checklist
- [ ] first child
- [x] already done

## Log
- 2026-08-01 test: created in todo
`);
  source.text = source.text.replace('lane: todo\n', 'lane: todo\nlabels: [Type/Bug]\nassignee: sam\ndelegate: agent-7\ndue: 2026-09-03\nestimate: 5\n');
  const b = board([source]);
  const result = opPromote(b, b.cards[0]!, 0, 'dev');
  assert.equal(result.promoted.title, 'first child');
  assert.equal(result.promoted.assignee, 'sam');
  assert.equal(result.promoted.delegate, 'agent-7');
  assert.equal(result.promoted.due, '2026-09-03');
  assert.equal(result.promoted.estimate, 5);
  assert.equal(parseBody(result.source.body).checklist.done, 2);
  assert.deepEqual(result.source.relations.map(({ type, target }) => ({ type, target })), [{ type: 'subtask', target: '002' }]);
  assert.deepEqual(result.promoted.relations.map(({ type, target }) => ({ type, target })), [{ type: 'parent', target: '001' }]);
  assert.throws(() => opPromote(b, result.source, 1, 'dev'), /already complete/);
});

test('duplicate merge transfers unique attachments, rewires inbound refs, and archives history', () => {
  const canonical = doc('001', 'Canonical', 'todo', `## Attachments
- [shared](https://example.test/shared.png)

## Log
- 2026-08-01 test: created in todo
`);
  canonical.text = canonical.text.replace('lane: todo\n', 'lane: todo\ndeps: [002]\nrelations:\n  - type: relates\n    target: 002\n');
  const duplicate = doc('002', 'Duplicate', 'doing', `## Attachments
- [shared](https://example.test/shared.png)
- [proof](https://example.test/proof.png)

## Log
- 2026-08-01 test: created in doing
`);
  const inbound = doc('003', 'Inbound');
  inbound.text = inbound.text.replace('lane: todo\n', 'lane: todo\ndeps: [002, 001]\nrelations:\n  - type: relates\n    target: 002\n');
  const b = board([canonical, duplicate, inbound]);
  const result = opMergeDuplicates(b, '002', '001', 'dev');
  assert.equal(result.attachmentsMoved, 1);
  assert.equal(result.referencesRewired, 1);
  assert.deepEqual(result.canonical.deps, []);
  assert.equal(parseBody(result.canonical.body).attachments.length, 2);
  assert.deepEqual(b.cards[2]!.deps, ['001']);
  assert.equal(b.cards[2]!.relations[0]!.target, '001');
  assert.equal(result.duplicate.laneId, 'archive');
  assert.deepEqual(result.duplicate.relations.at(-1), { type: 'duplicates', target: '001', extra: {} });
  assert.deepEqual(result.canonical.relations.at(-1), { type: 'supersedes', target: '002', extra: {} });
});

test('quick add parses metadata, quoted literals, templates, and indentation', () => {
  const parsed = parseQuickAdd(`Parent *Type/Bug @sam !p1 tomorrow ^8
  Child ~bug "@literal" today
Sibling "*not-a-label"`, new Date('2026-08-19T18:00:00Z'));
  assert.deepEqual(parsed.map(({ title, parent }) => ({ title, parent })), [
    { title: 'Parent', parent: null },
    { title: 'Child @literal', parent: 0 },
    { title: 'Sibling *not-a-label', parent: null },
  ]);
  assert.equal(parsed[0]!.options.due, '2026-08-20');
  assert.equal(parsed[1]!.options.due, '2026-08-19');
  const cards = opQuickAdd(board(), `Parent @sam
  Child ~bug`, 'dev', new Date('2026-08-19T18:00:00Z'));
  assert.deepEqual(cards.map((card) => card.id), ['001', '002']);
  assert.deepEqual(cards[0]!.relations.map(({ type, target }) => ({ type, target })), [{ type: 'subtask', target: '002' }]);
  assert.deepEqual(cards[1]!.relations.map(({ type, target }) => ({ type, target })), [{ type: 'parent', target: '001' }]);
  assert.deepEqual(cards[1]!.labels, ['Type/Bug']);
});

test('bulk actions validate the whole selection before exposing any mutations', () => {
  const b = board([doc('001', 'One'), doc('002', 'Two')]);
  assert.throws(() => opBulk(b, ['001', 'missing'], { kind: 'move', to: 'doing' }, 'dev'), UsageError);
  assert.deepEqual(b.cards.map((card) => card.laneId), ['todo', 'todo']);
  const moved = opBulk(b, ['001', '002'], { kind: 'move', to: 'doing' }, 'dev');
  assert.deepEqual(moved.cards.map((card) => card.laneId), ['doing', 'doing']);
  assert.deepEqual(b.cards.map((card) => card.laneId), ['todo', 'todo'], 'pure batch leaves source board unchanged');
  const labeled = opBulk(b, ['001', '002'], { kind: 'label', add: ['Type/Bug'] }, 'dev');
  assert.deepEqual(labeled.cards.map((card) => card.labels), [['Type/Bug'], ['Type/Bug']]);
});

test('dependency cycles are detected across discovered boards', () => {
  const root = mkdtempSync(join(tmpdir(), 'botflow-cross-cycle-'));
  const child = join(root, 'child');
  mkdirSync(join(root, 'cards'), { recursive: true });
  mkdirSync(join(child, 'cards'), { recursive: true });
  writeFileSync(join(root, 'board.yaml'), CONFIG);
  writeFileSync(join(child, 'board.yaml'), CONFIG.replace('name: operations', 'name: child'));
  const outer = doc('001', 'Outer');
  outer.text = outer.text.replace('lane: todo\n', 'lane: todo\ndeps: [child#001]\n');
  const inner = doc('001', 'Inner');
  inner.text = inner.text.replace('lane: todo\n', 'lane: todo\ndeps: [..#001]\n');
  writeFileSync(join(root, outer.path), outer.text);
  writeFileSync(join(child, inner.path), inner.text);

  const tree = loadTree(root);
  const result = analyze(tree);
  assert.deepEqual([...tree.boards.keys()], ['.', 'child']);
  assert.deepEqual(result.boards.get('.')!.ready, []);
  assert.deepEqual(result.boards.get('child')!.ready, []);
  const cycles = [...tree.boards].flatMap(([key, node]) => lintBoard(node, result.boards.get(key)!).filter((finding) => finding.rule === 'dep-cycle'));
  assert.equal(cycles.length, 1);
  assert.match(cycles[0]!.message, /001 → child#001 → 001/);
});

test('cross-board copy rebases references and replay converges; move retires source only after target exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'botflow-transfer-'));
  const target = join(root, 'child');
  mkdirSync(join(root, 'cards'), { recursive: true });
  mkdirSync(join(target, 'cards'), { recursive: true });
  writeFileSync(join(root, 'board.yaml'), CONFIG);
  writeFileSync(join(target, 'board.yaml'), CONFIG.replace('name: operations', 'name: target'));
  const source = doc('001', 'Transfer me');
  source.text = source.text.replace('lane: todo\n', 'lane: todo\ndeps: [002]\nrelations:\n  - type: relates\n    target: 002\n');
  writeFileSync(join(root, source.path), source.text);
  writeFileSync(join(root, doc('002', 'Source dependency', 'done').path), doc('002', 'Source dependency', 'done').text);

  const first = transferCard(root, target, '001', 'dev');
  assert.equal(first.reused, false);
  assert.deepEqual(first.target.deps, ['..#002']);
  assert.equal(first.target.relations.some((relation) => relation.type === 'relates' && relation.target === '..#002'), true);
  assert.equal(first.target.relations.some((relation) => relation.type === 'copied-from' && relation.target === '..#001'), true);
  assert.equal(first.source.relations.some((relation) => relation.type === 'copied-to' && relation.target === 'child#001'), true);
  const replay = transferCard(root, target, '001', 'dev');
  assert.equal(replay.reused, true);
  assert.equal(loadBoard(target).cards.length, 1, 'replay does not mint another copy');

  const moved = transferCard(root, target, '001', 'dev', { move: true });
  assert.equal(moved.reused, true);
  assert.equal(loadBoard(root).cards.find((card) => card.id === '001')!.laneId, 'archive');
  const tree = loadTree(root);
  assert.ok(tree.boards.has('child'), 'relation-only target remains discoverable');

  const sibling = mkdtempSync(join(tmpdir(), 'botflow-transfer-sibling-'));
  mkdirSync(join(sibling, 'cards'), { recursive: true });
  writeFileSync(join(sibling, 'board.yaml'), CONFIG);
  assert.throws(() => transferCard(root, sibling, '001', 'dev'), /nested inside the source project tree/);
});
