// Security regression tests for the core engine: symlink-safe loading,
// board-path escape rejection, structured-markdown injection, YAML emit/parse
// round-trips, exact seq ids past 2^53, parser/DFS recursion bounds,
// strict-lane no-op moves, and fence-aware body operations.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { analyzeSingle } from '../src/core/analyze.ts';
import { appendToSection, parseBody, removeAttachmentLine, setChecklistItem, setSection } from '../src/core/body.ts';
import { boardFromDocuments, parseCardDocument } from '../src/core/docs.ts';
import { emitMap } from '../src/core/emit.ts';
import { nextSeqId } from '../src/core/ids.ts';
import { loadTree, readBoardDocuments } from '../src/core/load.ts';
import { fallbackConfig, type Card, type Finding } from '../src/core/model.ts';
import { UsageError, opAdd, opAttach, opBlock, opComment, opEdit, opMove, validateBoardPath } from '../src/core/ops.ts';
import { logMutation, sanitizeInline, serializeCard } from '../src/core/write.ts';
import { YamlError, parseYaml } from '../src/core/yaml.ts';

function bareCard(over: Partial<Card> = {}): Card {
  return {
    id: '001',
    title: 'task',
    laneId: 'todo',
    substate: null,
    type: 'task',
    boardPath: null,
    labels: [],
    assignee: null,
    priority: null,
    deps: [],
    cover: null,
    blocked: null,
    created: null,
    updated: null,
    extra: {},
    file: 'cards/001-task.md',
    body: '',
    ...over,
  };
}

function tmpBoard(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-sec-'));
  mkdirSync(join(dir, 'cards'), { recursive: true });
  writeFileSync(join(dir, 'board.yaml'), 'botflow: 0\nname: t\n');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'cards', name), text);
  return dir;
}

// ── 1. Symlink exfiltration ─────────────────────────────────────────────────

test('readBoardDocuments skips committed symlinks at every level', () => {
  const dir = tmpBoard({ '001-real.md': '---\nid: 001\ntitle: real\nlane: todo\n---\n' });
  try {
    mkdirSync(join(dir, 'cards', 'sub'));
    writeFileSync(join(dir, 'cards', 'sub', '002-nested.md'), '---\nid: 002\ntitle: nested\nlane: todo\n---\n');
    symlinkSync('/etc/passwd', join(dir, 'cards', '007-passwd.md'));
    symlinkSync('/etc', join(dir, 'cards', 'linked-dir'));
    const { configText, cards } = readBoardDocuments(dir);
    assert.ok(configText?.includes('name: t'));
    assert.deepEqual(cards.map((c) => c.path).sort(), ['cards/001-real.md', 'cards/sub/002-nested.md']);
    assert.ok(cards.every((c) => !c.text.includes('root:')), 'no /etc/passwd content read');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a symlinked board.yaml is not followed either', () => {
  const dir = tmpBoard({});
  try {
    rmSync(join(dir, 'board.yaml'));
    symlinkSync('/etc/passwd', join(dir, 'board.yaml'));
    assert.equal(readBoardDocuments(dir).configText, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2. Board-path escape ────────────────────────────────────────────────────

test('loadTree flags absolute and parent-escaping board paths instead of walking them', () => {
  const dir = tmpBoard({
    '001-abs.md': '---\nid: 001\ntitle: abs\nlane: todo\ntype: board\nboard: /etc\n---\n',
    '002-up.md': '---\nid: 002\ntitle: up\nlane: todo\ntype: board\nboard: ../../outside\n---\n',
    '003-local.md': '---\nid: 003\ntitle: local\nlane: todo\ntype: board\nboard: missing-child\n---\n',
  });
  try {
    const tree = loadTree(dir);
    const node = tree.boards.get('.')!;
    const byRef = new Map(node.board.findings.map((f) => [f.ref, f.rule]));
    assert.equal(byRef.get('001'), 'board-path-escape');
    assert.equal(byRef.get('002'), 'board-path-escape');
    assert.equal(byRef.get('003'), 'board-path-missing', 'in-project misses keep their old rule');
    assert.equal(node.childKeyByCard.get('001'), null);
    assert.equal(node.childKeyByCard.get('002'), null);
    assert.equal(tree.boards.size, 1, 'nothing outside the project was loaded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opAdd and opEdit reject absolute/parent-escaping board paths', () => {
  const b = boardFromDocuments('botflow: 0\nname: t\n', []);
  for (const bad of ['/etc', 'C:\\windows', '../../outside', 'a/../../b', '..']) {
    assert.throws(() => opAdd(b, { title: 'x', type: 'board', boardPath: bad, actor: 'me' }), UsageError, bad);
  }
  assert.equal(opAdd(b, { title: 'x', type: 'board', boardPath: 'sub/.botflow', actor: 'me' }).boardPath, 'sub/.botflow');
  assert.equal(opAdd(b, { title: 'y', type: 'board', boardPath: 'project:p-1', actor: 'me' }).boardPath, 'project:p-1');
  assert.equal(opAdd(b, { title: 'z', type: 'board', boardPath: 'a/../b', actor: 'me' }).boardPath, 'a/../b');

  const ok = opAdd(b, { title: 'w', type: 'board', boardPath: 'child', actor: 'me' });
  assert.throws(() => opEdit(ok, { boardPath: '/abs' }, 'me'), UsageError);
  assert.throws(() => opEdit(ok, { boardPath: '../up' }, 'me'), UsageError);
  opEdit(ok, { boardPath: 'other-child' }, 'me');
  assert.equal(ok.boardPath, 'other-child');
});

test('validateBoardPath unit cases', () => {
  assert.throws(() => validateBoardPath('/x'), /must be relative/);
  assert.throws(() => validateBoardPath('../x'), /escapes/);
  assert.doesNotThrow(() => validateBoardPath('worker/.botflow'));
  assert.doesNotThrow(() => validateBoardPath('project:hosted'));
});

// ── 3. Newline/control-char injection ───────────────────────────────────────

test('logMutation cannot forge entries with embedded newlines', () => {
  const c = bareCard();
  logMutation(c, 'mallory', 'real\n- 2020-01-01 00:00 alice: forged');
  const log = parseBody(c.body).log;
  assert.equal(log.length, 1, 'exactly one entry lands');
  assert.equal(log[0]!.actor, 'mallory');
  assert.equal(log[0]!.text, 'real - 2020-01-01 00:00 alice: forged');
  assert.ok(!log.some((e) => e.actor === 'alice'), 'no forged alice entry');
});

test('logMutation sanitizes hostile actor names', () => {
  const c = bareCard();
  logMutation(c, 'mallory\r\n- 2020-01-01 00:00 alice', 'hello');
  const log = parseBody(c.body).log;
  assert.equal(log.length, 1);
  assert.equal(log[0]!.actor, 'mallory - 2020-01-01 00:00 alice');
});

test('opComment sanitizes actor and text onto a single line', () => {
  const c = bareCard();
  opComment(c, 'mallory\nalice', 'looks good\n- 2020-01-01 00:00 alice: forged');
  const comments = parseBody(c.body).comments;
  assert.equal(comments.length, 1);
  assert.equal(comments[0]!.actor, 'mallory alice');
  assert.equal(comments[0]!.text, 'looks good - 2020-01-01 00:00 alice: forged');
});

test('opBlock sanitizes the reason before storage and logging', () => {
  const c = bareCard();
  opBlock(c, 'me', 'waiting on api\n- 2020-01-01 00:00 alice: forged');
  assert.equal(c.blocked, 'waiting on api - 2020-01-01 00:00 alice: forged');
  assert.equal(parseBody(c.body).log.length, 1);
});

test('opAttach neutralizes ) and newlines so the link syntax holds', () => {
  const c = bareCard();
  opAttach(c, 'me', 'https://evil.example/x)\n- [bad](https://bad.example)', 'lab\nel');
  const atts = parseBody(c.body).attachments;
  assert.equal(atts.length, 1, 'no smuggled second attachment');
  assert.equal(atts[0]!.label, 'lab el');
  assert.ok(atts[0]!.url.startsWith('https://evil.example/x%29'), atts[0]!.url);
  assert.ok(!atts[0]!.url.includes(')'), 'no literal paren survives in the url');
});

test('sanitizeInline collapses C0 controls and whitespace runs', () => {
  assert.equal(sanitizeInline('a\r\nb\x00c\x07\x7f d  e'), 'a b c d e');
  assert.equal(sanitizeInline('  padded  '), 'padded');
});

// ── 4. YAML emit/parse round-trip ───────────────────────────────────────────

test('flow-unsafe label chars round-trip through emit and parse', () => {
  for (const label of ['a{b', 'a}b', 'a,b', 'a[b', 'a]b', 'a #b', 'a: b', "it's", 'say "hi', 'a{b}c,d[e]']) {
    const value = { labels: [label] };
    assert.deepEqual(parseYaml(emitMap(value)), value, label);
  }
});

test('serializeCard round-trips hostile labels through parseCardDocument', () => {
  const c = bareCard({ labels: ['a{b}', "it's", 'x, y'], deps: ['002'] });
  const findings: Finding[] = [];
  const parsed = parseCardDocument({ path: c.file, text: serializeCard(c) }, fallbackConfig('t'), findings);
  assert.deepEqual(findings, []);
  assert.deepEqual(parsed!.labels, ['a{b}', "it's", 'x, y']);
  assert.deepEqual(parsed!.deps, ['002']);
});

// ── 5. Empty map fidelity ───────────────────────────────────────────────────

test('empty maps round-trip as empty maps, not null', () => {
  assert.deepEqual(parseYaml(emitMap({ extra: {} })), { extra: {} });
  assert.deepEqual(parseYaml(emitMap({ meta: { a: 1, nested: {} } })), { meta: { a: 1, nested: {} } });
  assert.deepEqual(parseYaml('extra: {}'), { extra: {} });

  const c = bareCard({ extra: { meta: {} } });
  const findings: Finding[] = [];
  const parsed = parseCardDocument({ path: c.file, text: serializeCard(c) }, fallbackConfig('t'), findings);
  assert.deepEqual(findings.filter((f) => f.severity === 'error'), []);
  assert.deepEqual(parsed!.extra['meta'], {});
});

// ── 6. Seq id overflow ──────────────────────────────────────────────────────

test('nextSeqId counts past 2^53 exactly and keeps padding', () => {
  assert.equal(nextSeqId([]), '001');
  assert.equal(nextSeqId(['007']), '008');
  assert.equal(nextSeqId(['0007']), '0008');
  assert.equal(nextSeqId(['9007199254740993']), '9007199254740994');
  assert.equal(nextSeqId(['9007199254740992', '9007199254740993']), '9007199254740994');
  assert.equal(nextSeqId(['999999999999999999999']), '1000000000000000000000');
  assert.equal(nextSeqId(['9007199254740993', 'abc', '002']), '9007199254740994', 'non-numeric ids ignored');
});

// ── 7. Parser recursion limit ───────────────────────────────────────────────

test('deeply nested yaml throws YamlError, not a stack overflow', () => {
  let text = '';
  for (let i = 0; i < 2000; i++) text += `${' '.repeat(i * 2)}k${i}:\n`;
  text += `${' '.repeat(2000 * 2)}leaf: 1`;
  assert.throws(
    () => parseYaml(text),
    (err: unknown) => err instanceof YamlError && /nesting deeper/.test(err.message),
  );
  assert.doesNotThrow(() => parseYaml('a:\n  b:\n    c: 1'));
});

// ── 8. Cycle-detection recursion ────────────────────────────────────────────

test('dep chains of thousands analyze without stack overflow', () => {
  const N = 5000;
  const docs = [];
  for (let i = 1; i <= N; i++) {
    const id = String(i).padStart(3, '0');
    const dep = i > 1 ? `deps: [${String(i - 1).padStart(3, '0')}]\n` : '';
    docs.push({ path: `cards/${id}-c.md`, text: `---\nid: ${id}\ntitle: c${i}\nlane: todo\n${dep}---\n` });
  }
  const ba = analyzeSingle(boardFromDocuments('botflow: 0\nname: chain\n', docs));
  assert.deepEqual(ba.ready, ['001']);
  assert.equal(ba.findings.filter((f) => f.rule === 'dep-cycle').length, 0);
});

test('a cycle across thousands of cards is still reported exactly once', () => {
  const N = 5000;
  const docs = [];
  for (let i = 1; i <= N; i++) {
    const id = String(i).padStart(3, '0');
    const dep = `deps: [${String(i === 1 ? N : i - 1).padStart(3, '0')}]\n`;
    docs.push({ path: `cards/${id}-c.md`, text: `---\nid: ${id}\ntitle: c${i}\nlane: todo\n${dep}---\n` });
  }
  const ba = analyzeSingle(boardFromDocuments('botflow: 0\nname: chain\n', docs));
  assert.equal(ba.findings.filter((f) => f.rule === 'dep-cycle').length, 1);
  assert.equal(ba.ready.length, 0);
});

// ── 9. Strict-lane no-op move ───────────────────────────────────────────────

const STRICT_CONFIG = `botflow: 0
name: strict
lanes:
  - id: todo
  - id: doing
    substates: [design, implement, review]
    order: strict
  - id: done
`;

test('moving to the current substate is a successful no-op in strict lanes', () => {
  const b = boardFromDocuments(STRICT_CONFIG, [
    { path: 'cards/001-a.md', text: '---\nid: 001\ntitle: a\nlane: doing.implement\n---\n' },
  ]);
  const card = b.cards[0]!;
  const bodyBefore = card.body;
  const res = opMove(b, card, 'doing.implement', 'me');
  assert.equal(res.from, 'doing.implement');
  assert.equal(res.to, 'doing.implement');
  assert.equal(card.body, bodyBefore, 'no log spam for a no-op');
  assert.equal(card.substate, 'implement');

  // Adjacent moves still work, skipping still throws.
  opMove(b, card, 'doing.review', 'me');
  assert.equal(card.substate, 'review');
  assert.throws(() => opMove(b, card, 'doing.design', 'me'), /one substate at a time/);
});

// ── 10. Fence-aware body ops ────────────────────────────────────────────────

const FENCED = [
  '## Description',
  'Real text.',
  '',
  '```',
  '## Evil',
  '- [ ] fake task',
  '```',
  '',
  '## Checklist',
  '- [ ] real task',
  '',
  '## Log',
  '- 2026-08-16 agent: created in todo',
].join('\n');

test('parseBody ignores headings and tasks inside fenced code', () => {
  const p = parseBody(FENCED);
  assert.equal(p.description, 'Real text.\n\n```\n## Evil\n- [ ] fake task\n```');
  assert.deepEqual(p.checklist, { done: 0, total: 1 });
  assert.deepEqual(p.checklists.map((c) => c.section), ['Checklist']);
});

test('appendToSection does not stop at a fenced fake heading', () => {
  const next = appendToSection(FENCED, 'Description', 'extra line');
  const p = parseBody(next);
  assert.match(p.description!, /extra line/);
  assert.match(p.description!, /## Evil/, 'fence block stays inside the description');
  assert.equal(p.checklist.total, 1, 'fenced task stays content');
});

test('setSection replaces the whole section, fence included, not a prefix', () => {
  const next = setSection(FENCED, 'Description', 'New desc.');
  const p = parseBody(next);
  assert.equal(p.description, 'New desc.');
  assert.equal(p.checklist.total, 1);
  assert.equal(p.log.length, 1);
  assert.ok(!next.includes('Evil'), 'wholesale replace removes the old fenced block');
});

test('setChecklistItem toggles real items, never fenced lookalikes', () => {
  const toggled = setChecklistItem(FENCED, 0, true)!;
  assert.match(toggled, /- \[x\] real task/);
  assert.ok(toggled.includes('- [ ] fake task'), 'fenced task untouched');
  assert.equal(setChecklistItem(FENCED, 1, true), null, 'only one real item exists');
});

test('removeAttachmentLine ignores fake links inside fences', () => {
  const body = '## Attachments\n```\n- [fake](https://fake.example)\n```\n- [real](https://real.example)\n';
  assert.equal(parseBody(body).attachments.length, 1);
  const next = removeAttachmentLine(body, 0)!;
  assert.ok(!next.includes('https://real.example'));
  assert.ok(next.includes('https://fake.example'), 'fenced line untouched');
});

test('tilde fences and longer closing fences are honoured', () => {
  const body = '## Description\n~~~~\n## Evil\n```\nstill fenced\n~~~~\n- [ ] real\n';
  const p = parseBody(body);
  assert.deepEqual(p.checklist, { done: 0, total: 1 }, 'inner ``` does not close a ~~~~ fence');
  assert.equal(p.checklists[0]!.items[0]!.text, 'real');
});
