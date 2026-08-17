import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addAttachmentLine,
  appendToSection,
  parseBody,
  removeAttachmentLine,
  setChecklistItem,
} from '../src/core/body.ts';

const BODY = [
  '## Description',
  'Build the *thing* end to end.',
  '',
  '## Checklist',
  '- [x] repro',
  '- [ ] fix',
  '',
  '## QA',
  '- [ ] cross-browser pass',
  '',
  '## Attachments',
  '- [Design doc](https://example.com/doc)',
  '- [mock](https://example.com/mock.png)',
  '',
  '## Comments',
  '- 2026-08-16 14:22 operator: looks good so far',
  '',
  '## Log',
  '- 2026-08-16 agent-1: created in todo',
].join('\n');

test('parseBody extracts everything', () => {
  const p = parseBody(BODY);
  assert.equal(p.description, 'Build the *thing* end to end.');
  assert.deepEqual(p.checklist, { done: 1, total: 3 });
  assert.deepEqual(p.checklists.map((c) => c.section), ['Checklist', 'QA']);
  assert.deepEqual(p.checklists[0]!.items.map((i) => [i.index, i.checked]), [[0, true], [1, false]]);
  assert.equal(p.checklists[1]!.items[0]!.index, 2);
  assert.deepEqual(p.attachments.map((a) => a.label), ['Design doc', 'mock']);
  assert.deepEqual(p.images, ['https://example.com/mock.png']);
  assert.equal(p.comments[0]!.actor, 'operator');
  assert.equal(p.log[0]!.text, 'created in todo');
});

test('setChecklistItem toggles by global ordinal', () => {
  const toggled = setChecklistItem(BODY, 2, true)!;
  assert.match(toggled, /- \[x\] cross-browser pass/);
  assert.equal(parseBody(toggled).checklist.done, 2);
  const untoggled = setChecklistItem(toggled, 0, false)!;
  assert.match(untoggled, /- \[ \] repro/);
  assert.equal(setChecklistItem(BODY, 99, true), null);
});

test('attachments add and remove without touching neighbors', () => {
  const added = addAttachmentLine(BODY, 'spec', 'https://example.com/spec.pdf');
  assert.equal(parseBody(added).attachments.length, 3);
  const removed = removeAttachmentLine(added, 0)!;
  const atts = parseBody(removed).attachments;
  assert.deepEqual(atts.map((a) => a.label), ['mock', 'spec']);
  assert.ok(removed.includes('looks good so far'), 'comments untouched');
  assert.equal(removeAttachmentLine(BODY, 9), null);
});

test('emit round-trips unknown keys of any parseable shape', async () => {
  const { emitMap } = await import('../src/core/emit.ts');
  const { parseYaml } = await import('../src/core/yaml.ts');
  const value = {
    id: '001',
    title: 'x',
    lane: 'todo',
    meta: [{ kind: 'link', n: 2 }, { kind: 'note' }, 'plain'],
    tags: ['a', 'b'],
  };
  const text = emitMap(value);
  assert.deepEqual(parseYaml(text), value);
});

test('board names cannot inject yaml keys', async () => {
  const { defaultBoardYaml } = await import('../src/core/ops.ts');
  const { parseYaml } = await import('../src/core/yaml.ts');
  const hostile = 'sneaky\nids: hash';
  const parsed = parseYaml(defaultBoardYaml(hostile)) as { name: string; ids?: string };
  assert.equal(parsed.ids, undefined, 'no smuggled ids key');
  assert.equal(parsed.name, 'sneaky ids: hash');
});

test('appendToSection creates and appends', () => {
  const fresh = appendToSection('', 'Comments', '- 2026-08-16 15:00 admin: hello');
  assert.equal(fresh, '## Comments\n- 2026-08-16 15:00 admin: hello\n');
  const twice = appendToSection(fresh, 'Comments', '- 2026-08-16 15:01 admin: again');
  assert.equal(parseBody(twice).comments.length, 2);
  const other = appendToSection(BODY, 'Comments', '- 2026-08-16 15:02 admin: third');
  const p = parseBody(other);
  assert.equal(p.comments.length, 2);
  assert.equal(p.log.length, 1, 'log untouched');
});
