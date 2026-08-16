import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseYaml, YamlError } from '../src/core/yaml.ts';

test('scalars type correctly', () => {
  assert.deepEqual(parseYaml('a: 1\nb: -3\nc: true\nd: false\ne: null\nf: hello world\ng:'), {
    a: 1,
    b: -3,
    c: true,
    d: false,
    e: null,
    f: 'hello world',
    g: null,
  });
});

test('leading-zero digit tokens stay strings (card ids)', () => {
  assert.deepEqual(parseYaml('id: 042\nzero: 0'), { id: '042', zero: 0 });
});

test('date-like scalars stay strings', () => {
  assert.deepEqual(parseYaml('created: 2026-08-16'), { created: '2026-08-16' });
});

test('value may contain colons; first ": " splits', () => {
  assert.deepEqual(parseYaml('title: Hotfix: CSRF rotation'), { title: 'Hotfix: CSRF rotation' });
});

test('quoted strings and escapes', () => {
  assert.deepEqual(parseYaml('a: "x: #notcomment"\nb: \'it\'\'s\'\nc: "line\\nbreak"'), {
    a: 'x: #notcomment',
    b: "it's",
    c: 'line\nbreak',
  });
});

test('comments strip outside quotes only', () => {
  assert.deepEqual(parseYaml('# top\na: 1  # trailing\nb: "keep # this"'), { a: 1, b: 'keep # this' });
});

test('flow lists of scalars', () => {
  assert.deepEqual(parseYaml('tags: [a, b2, "c, d"]\nempty: []'), { tags: ['a', 'b2', 'c, d'], empty: [] });
});

test('block sequences and inline-map items', () => {
  assert.deepEqual(
    parseYaml(['lanes:', '  - id: todo', '  - id: doing', '    substates: [a, b]', '    wip: 3', '  - id: done'].join('\n')),
    { lanes: [{ id: 'todo' }, { id: 'doing', substates: ['a', 'b'], wip: 3 }, { id: 'done' }] },
  );
});

test('nested mappings at exactly two spaces', () => {
  assert.deepEqual(parseYaml('rollup:\n  else: todo\n  done_when: all-done'), {
    rollup: { else: 'todo', done_when: 'all-done' },
  });
});

test('rejects anchors, aliases, tags, block scalars, flow maps', () => {
  for (const doc of ['a: &x v', 'a: *x', 'a: !!str v', 'a: |', 'a: >', 'a: {b: 1}']) {
    assert.throws(() => parseYaml(doc), YamlError, doc);
  }
});

test('rejects tab indentation and bad indent widths', () => {
  assert.throws(() => parseYaml('a:\n\tb: 1'), YamlError);
  assert.throws(() => parseYaml('a:\n   b: 1'), YamlError); // 3 spaces
});

test('rejects duplicate keys and content after quotes', () => {
  assert.throws(() => parseYaml('a: 1\na: 2'), YamlError);
  assert.throws(() => parseYaml('a: "x" y'), YamlError);
});

test('rejects colon without space and stray content', () => {
  assert.throws(() => parseYaml('a:1'), YamlError);
  assert.throws(() => parseYaml('a: 1\n  b: 2'), YamlError);
});

test('empty document is an empty map', () => {
  assert.deepEqual(parseYaml(''), {});
  assert.deepEqual(parseYaml('\n# only comments\n'), {});
});
