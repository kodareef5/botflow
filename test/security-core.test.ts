// Security regression tests for the core engine: symlink-safe loading,
// board-path escape rejection, structured-markdown injection, YAML emit/parse
// round-trips, exact seq ids past 2^53, parser/DFS recursion bounds,
// strict-lane no-op moves, and fence-aware body operations.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { analyzeSingle } from '../src/core/analyze.ts';
import { appendToSection, parseBody, removeAttachmentLine, setChecklistItem, setSection } from '../src/core/body.ts';
import { boardFromDocuments, parseCardDocument } from '../src/core/docs.ts';
import { cardJson } from '../src/core/json.ts';
import { emitMap } from '../src/core/emit.ts';
import { nextSeqId } from '../src/core/ids.ts';
import { loadTree, readBoardDocuments } from '../src/core/load.ts';
import { addCard } from '../src/core/mutate.ts';
import { fallbackConfig, type Card, type Finding } from '../src/core/model.ts';
import { UsageError, opAdd, opAttach, opBlock, opChecklistAdd, opComment, opDescribe, opEdit, opMove, validateBoardPath } from '../src/core/ops.ts';
import { logMutation, sanitizeActor, sanitizeInline, serializeCard } from '../src/core/write.ts';
import { YamlError, parseYaml } from '../src/core/yaml.ts';
import {
  absentPasswordHash, hashPassword, parseBasic, parseStoredPasswordHash, roleAllows, scopeAllows, unfurlTarget,
  validStoredPasswordHash, validUsername, verifyPassword,
} from '../worker/src/security.ts';

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
    delegate: null,
    watchers: [],
    votes: [],
    priority: null,
    deps: [],
    relations: [],
    start: null,
    due: null,
    reminders: [],
    repeat: null,
    snooze: null,
    estimate: null,
    hill: null,
    evergreen: false,
    cover: null,
    coverColor: null,
    blocked: null,
    blocker: null,
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

test('filesystem mutations refuse unsupported board majors and features', () => {
  for (const config of [
    'botflow: 1\nname: future\n',
    'botflow: 0\nname: future\nfeatures: [teleportation]\n',
  ]) {
    const dir = tmpBoard({});
    try {
      writeFileSync(join(dir, 'board.yaml'), config);
      assert.throws(
        () => addCard(dir, { title: 'must not land', actor: 'reader' }),
        (err: unknown) => err instanceof UsageError && /read-only/.test(err.message),
      );
      assert.equal(readFileSync(join(dir, 'board.yaml'), 'utf8'), config);
      assert.deepEqual(readdirSync(join(dir, 'cards')), [], 'no card was written');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

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
  assert.equal(log.length, 1, 'the whole hostile name collapses into one entry');
  // Newlines collapse so no second entry can be forged, and colons are
  // dropped so the actor cannot be truncated at a `": "` on read-back: what
  // was written is what comes back.
  assert.equal(log[0]!.actor, 'mallory - 2020-01-01 0000 alice');
  assert.ok(!log[0]!.actor.includes(':'), 'an actor never carries a colon');
  assert.equal(log[0]!.text, 'hello', 'and the message is intact');
});

test('an actor keeps its identity through a log round-trip', () => {
  // The failure this prevents: "acme: bot" used to come back as "acme", which
  // silently broke the audit trail and nulled anything derived from it.
  for (const actor of ['acme: bot', 'a:b', 'plain-bot', 'Name: With: Colons']) {
    const c = bareCard();
    logMutation(c, actor, 'closed: shipped it');
    const entry = parseBody(c.body).log[0]!;
    assert.equal(entry.actor, sanitizeActor(actor), `${actor} round-trips`);
    assert.equal(entry.text, 'closed: shipped it', 'while the message keeps its own colons');
  }
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

// ---- hosted identity policy: passwords, usernames, roles, scopes ----
// These live in worker/src/security.ts precisely so they can be exercised
// here, without booting workerd. Every one of them must fail closed.

test('password hashes round-trip and reject everything malformed', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.match(stored, /^pbkdf2\$\d+\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('correct horse battery stapl', stored), false);
  assert.notEqual(stored, await hashPassword('correct horse battery staple'), 'each hash is separately salted');
  assert.equal(validStoredPasswordHash(stored), true);
  assert.equal(parseStoredPasswordHash(stored)?.salt.byteLength, 16);

  // A corrupt, empty, or truncated pass_hash must never authenticate: an
  // empty stored value is what a half-written member row would look like.
  for (const bad of ['', 'garbage', 'pbkdf2$100000$zz$ff', 'pbkdf2$0$' + 'a'.repeat(32) + '$' + 'f'.repeat(64),
    'pbkdf2$100000$aa$' + 'f'.repeat(64), 'pbkdf2$100000$' + 'a'.repeat(34) + '$' + 'f'.repeat(64),
    stored.slice(0, -1), stored.replace('pbkdf2', 'sha256'), 'pbkdf2$01$' + 'a'.repeat(32) + '$' + 'f'.repeat(64),
    'pbkdf2$-1$' + 'a'.repeat(32) + '$' + 'f'.repeat(64), 'pbkdf2$1e9$' + 'a'.repeat(32) + '$' + 'f'.repeat(64),
    'pbkdf2$10000001$' + 'a'.repeat(32) + '$' + 'f'.repeat(64)]) {
    assert.equal(validStoredPasswordHash(bad), false, `stored ${JSON.stringify(bad)} must fail import validation too`);
    assert.equal(await verifyPassword('anything', bad), false, `stored ${JSON.stringify(bad)} must not authenticate`);
  }
  assert.equal(await verifyPassword('', stored), false, 'an empty password is not a password');
  assert.equal(await verifyPassword('x', null), false);
});

test('usernames must survive a markdown log round-trip', () => {
  for (const ok of ['bot', 'alpha-agent', 'a1', 'x_y-z', 'a'.repeat(32)]) {
    assert.equal(validUsername(ok), true, `${ok} is usable`);
  }
  // A colon is the killer: parseBody splits a log entry on the first ": ",
  // so an actor containing one is silently truncated on read-back.
  for (const bad of ['acme: bot', 'a', '', 'Alpha', 'has space', '-lead', 'a'.repeat(33), 'emoji😀', null, 42]) {
    assert.equal(validUsername(bad), false, `${JSON.stringify(bad)} is not usable`);
  }
  const actor = 'alpha-agent';
  const card = bareCard();
  logMutation(card, actor, 'created in todo');
  assert.equal(parseBody(card.body).log[0]!.actor, actor, 'a valid username survives write then read');
  // Proof the constraint is load-bearing, not decorative.
  const colon = bareCard();
  logMutation(colon, 'acme: bot', 'created in todo');
  assert.notEqual(parseBody(colon.body).log[0]!.actor, 'acme: bot', 'which is exactly why colons are banned');
});

test('roles order strictly and deny anything unrecognized', () => {
  const table: [unknown, 'read' | 'write' | 'owner', boolean][] = [
    ['owner', 'read', true], ['owner', 'write', true], ['owner', 'owner', true],
    ['write', 'read', true], ['write', 'write', true], ['write', 'owner', false],
    ['read', 'read', true], ['read', 'write', false], ['read', 'owner', false],
    ['admin', 'read', false], ['', 'read', false], [null, 'read', false], [undefined, 'owner', false],
  ];
  for (const [role, need, want] of table) {
    assert.equal(roleAllows(role, need), want, `${JSON.stringify(role)} → ${need}`);
  }
});

test('scopes reach exactly their own subtree', () => {
  const inSpace1 = { spaceId: 's-1', ancestorIds: ['p-child', 'p-root'] };
  const inSpace2 = { spaceId: 's-2', ancestorIds: ['p-other'] };

  // Org reaches everything, including a scope id it was never given.
  assert.equal(scopeAllows({ kind: 'org', id: null }, inSpace1), true);
  assert.equal(scopeAllows({ kind: 'org', id: null }, inSpace2), true);

  // Space reaches every project in that space however deeply nested, and
  // nothing outside it. This is the grant the old key model could not express.
  assert.equal(scopeAllows({ kind: 'space', id: 's-1' }, inSpace1), true);
  assert.equal(scopeAllows({ kind: 'space', id: 's-1' }, inSpace2), false);

  // Project reaches itself and its descendants (ancestorIds includes self).
  assert.equal(scopeAllows({ kind: 'project', id: 'p-child' }, inSpace1), true, 'the project itself');
  assert.equal(scopeAllows({ kind: 'project', id: 'p-root' }, inSpace1), true, 'an ancestor reaches down');
  assert.equal(scopeAllows({ kind: 'project', id: 'p-other' }, inSpace1), false, 'a sibling reaches nothing');

  // Fail closed on a malformed scope rather than defaulting to org.
  assert.equal(scopeAllows({ kind: 'space', id: null }, inSpace1), false);
  assert.equal(scopeAllows({ kind: 'project', id: '' }, inSpace1), false);
  assert.equal(scopeAllows({ kind: 'everything' as never, id: null }, inSpace1), false);
});

test('basic auth decoding survives passwords containing colons', () => {
  assert.deepEqual(parseBasic(`Basic ${Buffer.from('bot:pw:with:colons').toString('base64')}`),
    { username: 'bot', password: 'pw:with:colons' });
  assert.deepEqual(parseBasic(`Basic ${Buffer.from('bot:').toString('base64')}`), { username: 'bot', password: '' });
  for (const bad of ['', 'Bearer abc', 'Basic !!!!', `Basic ${Buffer.from('nocolon').toString('base64')}`,
    `Basic ${Buffer.from(':pw').toString('base64')}`]) {
    assert.equal(parseBasic(bad), null, `${JSON.stringify(bad)} decodes to nothing`);
  }
});

test('only a creation entry names the author', () => {
  // A log whose first line is a claim or a move belongs to whoever did that.
  // Reporting them as the creator would be a plain lie, so the derivation
  // insists on the entry opAdd actually writes.
  const node = { board: boardFromDocuments('botflow: 0\nname: t\n', []), childKeyByCard: new Map() } as never;
  const analysis = analyzeSingle(boardFromDocuments('botflow: 0\nname: t\n', []));
  const authorOf = (body: string): unknown => cardJson(bareCard({ body }), node, analysis)['author'];

  assert.equal(authorOf('## Log\n- 2026-08-19 12:00 maker: created in todo\n'), 'maker');
  assert.equal(authorOf('## Log\n- 2026-08-16 operator: created\n'), 'operator', 'the shorter fixture form still counts');
  assert.equal(authorOf('## Log\n- 2026-08-19 12:00 taker: claimed, moved todo → doing\n'), null, 'a claimant is not an author');
  assert.equal(authorOf('## Log\n- 2026-08-19 12:00 mover: moved todo → done\n'), null);
  assert.equal(authorOf('## Log\n- 2026-08-19 12:00 talker: creative writing is fun\n'), null, 'a prose log line is not a creation');
  assert.equal(authorOf('## Description\nno log at all\n'), null);
});

test('a card reports its creator without storing one', () => {
  // Authorship is derived from the first `## Log` entry opAdd always writes,
  // so it needs no frontmatter key, no spec change, and it answers for every
  // card that already exists on disk.
  const board = boardFromDocuments('botflow: 0\nname: t\n', []);
  const card = opAdd(board, { title: 'Ship it', actor: 'alpha-agent' });
  const analysis = analyzeSingle(board);
  const node = { board, childKeyByCard: new Map() } as never;
  assert.equal(cardJson(card, node, analysis)['author'], 'alpha-agent');

  // Nothing was written into the card's own fields to make that work: the
  // name appears in the log prose and nowhere else in the document.
  const text = serializeCard(card);
  const frontmatter = text.slice(0, text.indexOf('---', 3));
  assert.ok(!/author/.test(frontmatter), 'frontmatter carries no author key');
  assert.ok(!frontmatter.includes('alpha-agent'), 'and no author value either');
  assert.match(text, /- \d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2} alpha-agent: created in todo/);

  // An imported card with no log simply has no author, rather than guessing.
  const bare = bareCard({ body: '## Description\nimported elsewhere\n' });
  assert.equal(cardJson(bare, node, analysis)['author'], null);
});

test('an absent account still costs a real derivation', async () => {
  // Verifying against '' returns before doing any PBKDF2 work, which is
  // measurable and turns login into a username oracle. The placeholder hash
  // is what keeps an unknown username indistinguishable from a wrong password.
  const hash = await absentPasswordHash();
  assert.match(hash, /^pbkdf2\$\d+\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.equal(await verifyPassword('anything at all', hash), false, 'and nothing authenticates against it');
  assert.equal(hash, await absentPasswordHash(), 'derived once, then reused');
});

test('body text cannot splice a second section', () => {
  // The payoff: section-aware appends target the FIRST matching heading, so a
  // forged `## Log` ahead of the real one captures the append-only audit
  // trail and everything derived from it.
  const board = boardFromDocuments('botflow: 0\nname: t\n', []);
  const card = opAdd(board, { title: 'Real', actor: 'honest-bot' });
  const node = { board, childKeyByCard: new Map() } as never;
  const analysis = analyzeSingle(board);

  opDescribe(card, 'attacker', '## Log\n- 2020-01-01 ceo: created in todo\n');
  assert.equal((card.body.match(/^## Log$/gm) ?? []).length, 1, 'still exactly one Log section');
  assert.equal(cardJson(card, node, analysis)['author'], 'honest-bot', 'the creator is not overwritten');
  assert.match(card.body, /\\## Log/, 'the heading marker is escaped, the text is kept');

  // The attacker's own entry still lands in the real Log, under their name.
  const log = parseBody(card.body).log;
  assert.equal(log[0]!.actor, 'honest-bot');
  assert.equal(log[log.length - 1]!.actor, 'attacker');

  // Deeper headings and CRLF payloads are covered by the same rule.
  opDescribe(card, 'attacker', '### Comments\r\n- fake\r\n');
  assert.equal(parseBody(card.body).comments.length, 0, 'no comments forged either');
});

test('a caller-chosen section name must be one plain line', () => {
  const board = boardFromDocuments('botflow: 0\nname: t\n', []);
  const card = opAdd(board, { title: 'Real', actor: 'honest-bot' });
  assert.throws(() => opChecklistAdd(card, 'a', 'x', 'Z\n\n## Log\n- 2020-01-01 ceo: created in todo'), /not a usable section name/);
  assert.throws(() => opChecklistAdd(card, 'a', 'x', '## Log'), /not a usable section name/);
  assert.throws(() => opChecklistAdd(card, 'a', 'x', 'Log'), /append-only/, 'the Log is not a task list');
  assert.throws(() => opChecklistAdd(card, 'a', 'x', '   '), /not a usable section name/);
  // An ordinary name still works, and trims.
  opChecklistAdd(card, 'a', 'ship it', '  Launch  ');
  assert.match(card.body, /^## Launch$/m);
  assert.equal(parseBody(card.body).checklist.total, 1);
});

test('an empty map inside a block sequence survives a round-trip', () => {
  // The failure this prevents: `- ` alone is an empty sequence item the parser
  // rejects, so a card carrying one in unknown frontmatter emitted a document
  // that no longer loads, and vanished from the board on the next rewrite.
  for (const meta of [[{}], [{}, { a: 1 }], [{ a: 1 }, {}], [{}, {}]]) {
    const text = emitMap({ id: '001', meta });
    assert.ok(!/-\s*$/m.test(text), `no empty sequence item in ${JSON.stringify(text)}`);
    assert.deepEqual((parseYaml(text) as Record<string, unknown>)['meta'], meta, 'and it reparses to what went in');
  }
});

test('priority is validated where it is written, not just where it is read', () => {
  // Writing p9 used to succeed and then fail the very next lint, on a card
  // this tool wrote itself.
  const board = boardFromDocuments('botflow: 0\nname: t\n', []);
  assert.throws(() => opAdd(board, { title: 'x', actor: 'a', priority: 'p9' }), /p0, p1, p2 or p3/);
  assert.throws(() => opAdd(board, { title: 'x', actor: 'a', priority: 'urgent' }), /p0, p1, p2 or p3/);
  const card = opAdd(board, { title: 'x', actor: 'a', priority: 'p1' });
  assert.equal(card.priority, 'p1');
  assert.throws(() => opEdit(card, { priority: 'p4' }, 'a'), /p0, p1, p2 or p3/);
  opEdit(card, { priority: null }, 'a');
  assert.equal(card.priority, null, 'clearing still works');
});

test('unfurl refuses every address that is not publicly routable', () => {
  // Unfurling lets a write-role member make the worker fetch an address of
  // their choosing. This matrix is the guard: the WHATWG parser normalises
  // decimal, octal, hex and short-form IPv4 to dotted quad, so those collapse
  // into the same check, but IPv4-mapped IPv6 arrives in hex and has to be
  // decoded before it can be judged.
  const refused = [
    'http://127.0.0.1/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f000001/', 'http://127.1/',
    'http://[::1]/', 'http://[::]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/',
    'http://169.254.169.254/latest/meta-data/',   // cloud instance metadata: the prize
    'http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://172.31.255.255/',
    'http://192.0.0.9/', 'http://192.0.2.1/', 'http://198.51.100.2/', 'http://203.0.113.3/',
    'http://100.64.0.1/', 'http://[fc00::1]/', 'http://[fd12:3456::1]/', 'http://[fe80::1]/',
    'http://[fec0::1]/', 'http://[ff02::1]/', 'http://[ff0e::1]/',
    'http://[100::1]/', 'http://[2001::1]/', 'http://[2001:2::1]/', 'http://[2001:10::1]/',
    'http://[2001:db8::1]/', 'http://[3fff::1]/', 'http://[5f00::1]/',
    'http://[::7f00:1]/', 'http://[0:0:0:0:ffff:0:7f00:1]/',
    'http://[64:ff9b::7f00:1]/', 'http://[64:ff9b:1::1]/', 'http://[2002:7f00:1::1]/',
    'http://localhost/', 'http://LOCALHOST/', 'http://api.localhost/', 'http://box.local/',
    'http://svc.internal/', 'http://printer.home.arpa/',
    'http://user:pass@example.com/', 'http://:pw@example.com/',
    'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<script>x</script>',
    'ftp://example.com/', 'http://0.0.0.0/', 'http://224.0.0.1/', 'http://255.255.255.255/',
    'http://999.1.1.1/', '', 'not a url', null, 42, `http://example.com/${'a'.repeat(3000)}`,
  ];
  for (const target of refused) {
    const verdict = unfurlTarget(target);
    assert.equal(verdict.ok, false, `${JSON.stringify(target)} must not be fetchable`);
  }

  // And it must not be so strict that it refuses the public internet.
  for (const target of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'http://example.com/',
    'https://172.32.0.1/', 'https://8.8.8.8/', 'https://[2606:4700::1111]/',
    'https://192.0.3.1/', 'https://198.51.99.1/', 'https://203.0.1.1/',
    'https://[::ffff:808:808]/', 'https://[64:ff9b::808:808]/', 'https://[2002:0808:0808::1]/',
  ]) {
    assert.equal(unfurlTarget(target).ok, true, `${target} is ordinary and public`);
  }

  // The loopback escape exists only so the suite can point at a fixture
  // server, and must never be reachable without asking for it.
  assert.equal(unfurlTarget('http://127.0.0.1:8899/watch').ok, false);
  assert.equal(unfurlTarget('http://127.0.0.1:8899/watch', true).ok, true);
  // Even then, a scheme that is not http(s) stays refused.
  assert.equal(unfurlTarget('file:///etc/passwd', true).ok, false);
});
