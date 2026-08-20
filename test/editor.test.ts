// Board-editor and card-authoring primitives: section surgery on card
// bodies, and board.yaml emission that round-trips through the parser.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseBody, setSection } from '../src/core/body.ts';
import { emitBoardYaml, parseBoardConfig } from '../src/core/config.ts';
import { boardFromDocuments } from '../src/core/docs.ts';
import type { Finding } from '../src/core/model.ts';
import { opChecklistAdd, opDescribe } from '../src/core/ops.ts';
import { parseYaml } from '../src/core/yaml.ts';

function card(body: string) {
  const b = boardFromDocuments('botflow: 0\nname: t\n', [
    { path: 'cards/001-a.md', text: `---\nid: 001\ntitle: a\nlane: todo\n---\n${body}` },
  ]);
  return b.cards[0]!;
}

test('setSection: create, replace, and clear a Description ahead of the Log', () => {
  let body = '## Log\n- 2026-08-17 x: created in todo\n';
  body = setSection(body, 'Description', 'First take.', 'start');
  assert.equal(body, '## Description\nFirst take.\n\n## Log\n- 2026-08-17 x: created in todo\n');
  body = setSection(body, 'Description', 'Second take.\nTwo lines.', 'start');
  assert.match(body, /## Description\nSecond take\.\nTwo lines\.\n\n## Log/);
  body = setSection(body, 'Description', '', 'start');
  assert.equal(body, '## Log\n- 2026-08-17 x: created in todo\n');
});

test('opDescribe parses back and logs; opChecklistAdd lands before the Log', () => {
  const c = card('## Log\n- 2026-08-17 x: created in todo\n');
  opDescribe(c, 'editor', 'A real description with `code`.');
  opChecklistAdd(c, 'editor', 'first task');
  opChecklistAdd(c, 'editor', 'second task');
  opChecklistAdd(c, 'editor', 'design step', 'Design review');
  const p = parseBody(c.body);
  assert.equal(p.description, 'A real description with `code`.');
  assert.deepEqual(p.checklists.map((cl) => cl.section), ['Checklist', 'Design review']);
  assert.equal(p.checklist.total, 3);
  assert.equal(p.checklist.done, 0);
  assert.ok(c.body.indexOf('## Checklist') < c.body.indexOf('## Log'), 'checklist sits before the Log');
  assert.ok((c.body.match(/: edited description/g) ?? []).length === 1);
  assert.ok((c.body.match(/: added task/g) ?? []).length === 3);
});

test('emitBoardYaml round-trips a specialty board through the parser', () => {
  const findings: Finding[] = [];
  const config = parseBoardConfig(
    parseYaml(`botflow: 0
name: "security: audits"
lanes:
  - id: candidates
    canonical: wishlist
  - id: todo
  - id: doing
    substates: [reproduce, validate, disclose]
    order: strict
    wip: 3
  - id: needs-qa
    name: Needs QA
    canonical: doing
  - id: done
rollup:
  blocked_when: never
  doing_when: any-doing
  else: wishlist
`),
    findings,
  );
  assert.equal(findings.length, 0, findings.map((f) => f.message).join('; '));

  const emitted = emitBoardYaml(config);
  const findings2: Finding[] = [];
  const reparsed = parseBoardConfig(parseYaml(emitted), findings2);
  assert.equal(findings2.length, 0, `${emitted}\n${findings2.map((f) => f.message).join('; ')}`);
  assert.deepEqual(reparsed, config);
});

test('emitBoardYaml omits every default: a plain board stays tiny', () => {
  const findings: Finding[] = [];
  const config = parseBoardConfig(parseYaml('botflow: 0\nname: plain\n'), findings);
  const emitted = emitBoardYaml(config);
  assert.doesNotMatch(emitted, /rollup|order|wip|canonical|ids/);
  const reparsed = parseBoardConfig(parseYaml(emitted), []);
  assert.deepEqual({ ...reparsed, lanesDefaulted: true }, config);
});

test('board.yaml rewrites preserve unknown top-level and nested registry data', () => {
  const findings: Finding[] = [];
  const config = parseBoardConfig(parseYaml(`botflow: 0
name: future-safe
lanes:
  - id: todo
    visual:
      color: blue
labels:
  - id: Type/Bug
    color: "#d03b3b"
    icon: bug
fields:
  - id: risk
    name: Risk
    type: select
    options: [low, high]
    face: true
    width: compact
rollup:
  future_mode: weighted
vendor:
  flags: [alpha, beta]
  nested:
    enabled: true
`), findings);
  assert.deepEqual(findings.map((f) => f.rule), ['unknown-key', 'unknown-key', 'unknown-key', 'unknown-key', 'unknown-key']);
  assert.deepEqual(config.lanes[0]!.extra, { visual: { color: 'blue' } });
  assert.deepEqual(config.labelDefinitions[0]!.extra, { icon: 'bug' });
  assert.deepEqual(config.customFields[0]!.extra, { width: 'compact' });
  assert.deepEqual(config.rollup.extra, { future_mode: 'weighted' });
  assert.deepEqual(config.extra, { vendor: { flags: ['alpha', 'beta'], nested: { enabled: true } } });

  const emitted = emitBoardYaml(config);
  const reparsed = parseBoardConfig(parseYaml(emitted), []);
  assert.deepEqual(reparsed, config);
});

test('unsupported majors and features stay visible but make the board read-only', () => {
  const majorFindings: Finding[] = [];
  const future = parseBoardConfig(parseYaml('botflow: 7\nname: future\n'), majorFindings);
  assert.equal(future.version, 7, 'the parser never silently downgrades an unknown major');
  assert.match(future.mutationBlocked ?? '', /major 7/);
  assert.match(emitBoardYaml(future), /^botflow: 7\n/, 'even a semantic re-emission cannot write version 0');

  const featureFindings: Finding[] = [];
  const feature = parseBoardConfig(parseYaml('botflow: 0\nname: future\nfeatures: [teleportation]\n'), featureFindings);
  assert.deepEqual(feature.unsupportedFeatures, ['teleportation']);
  assert.equal(featureFindings.some((f) => f.rule === 'unsupported-feature'), true);
  assert.match(feature.mutationBlocked ?? '', /teleportation/);
});
