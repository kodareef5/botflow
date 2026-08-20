// Conformance harness: every fixture board must reproduce its expected.json
// exactly (SPEC §11). Findings are compared as (rule, ref) sets, sorted;
// progress is compared rounded to 4 decimals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { analyze, lintBoard, loadTree, parseBody, queryCards } from '../src/core/index.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');

interface ExpectedBoard {
  lint: { rule: string; ref: string }[];
  cards: Record<string, string>;
  distribution: Record<string, number>;
  ready: string[];
  progress: number | null;
  effort?: { total: number; completed: number; progress: number | null };
  fields?: Record<string, { assignee: string | null; delegate: string | null; start: string | null; due: string | null; estimate: number | null; evergreen: boolean }>;
  presentation?: {
    labels: { id: string; color: string | null }[];
    fields: { id: string; name: string; type: string; options: string[]; face: boolean }[];
    cards: Record<string, { coverColor: string | null; values: Record<string, unknown> }>;
  };
  structure?: {
    templates: { id: string; name: string; lane: string | null; labels: string[]; priority: string | null; estimate: number | null; fields: Record<string, unknown>; body: string }[];
    relations: Record<string, { deps: string[]; relations: { type: string; target: string }[] }>;
  };
  collaboration?: {
    filters: { id: string; name: string; query: string }[];
    subscriptions: { lane: string; watcher: string }[];
    cards: Record<string, { watchers: string[]; votes: string[]; mentions: string[]; boosts: { when: string; actor: string; text: string }[] }>;
    queries: Record<string, string[]>;
  };
}

const sortFindings = (list: { rule: string; ref: string }[]) =>
  [...list].sort((a, b) => (a.rule + '\u0000' + a.ref).localeCompare(b.rule + '\u0000' + b.ref));

const round4 = (n: number | null) => (n === null ? null : Math.round(n * 10000) / 10000);

for (const name of ['minimal', 'standard', 'substates', 'nested', 'card-features', 'presentation', 'relations', 'collaboration']) {
  test(`fixture: ${name}`, () => {
    const dir = join(FIXTURES, name);
    const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as {
      boards: Record<string, ExpectedBoard>;
    };
    const tree = loadTree(dir);
    const analysis = analyze(tree);

    assert.deepEqual([...tree.boards.keys()].sort(), Object.keys(expected.boards).sort(), 'board keys');

    for (const [key, exp] of Object.entries(expected.boards)) {
      const node = tree.boards.get(key)!;
      const ba = analysis.boards.get(key)!;
      const lint = lintBoard(node, ba).map((f) => ({ rule: f.rule, ref: f.ref }));
      assert.deepEqual(sortFindings(lint), sortFindings(exp.lint), `${key}: lint`);
      assert.deepEqual(Object.fromEntries(ba.canonical), exp.cards, `${key}: canonical states`);
      assert.deepEqual(ba.distribution, exp.distribution, `${key}: distribution`);
      assert.deepEqual(ba.ready, exp.ready, `${key}: ready`);
      assert.equal(round4(ba.progress), exp.progress, `${key}: progress`);
      if (exp.effort) {
        assert.deepEqual({
          total: ba.effort.total,
          completed: ba.effort.completed,
          progress: round4(ba.effort.progress),
        }, exp.effort, `${key}: estimated effort`);
      }
      if (exp.fields) {
        assert.deepEqual(Object.fromEntries(node.board.cards.map((card) => [card.id, {
          assignee: card.assignee,
          delegate: card.delegate,
          start: card.start,
          due: card.due,
          estimate: card.estimate,
          evergreen: card.evergreen,
        }])), exp.fields, `${key}: feature fields`);
      }
      if (exp.presentation) {
        assert.deepEqual(node.board.config.labelDefinitions.map(({ id, color }) => ({ id, color })), exp.presentation.labels, `${key}: label registry`);
        assert.deepEqual(node.board.config.customFields.map(({ id, name, type, options, face }) => ({ id, name, type, options, face })), exp.presentation.fields, `${key}: field registry`);
        assert.deepEqual(Object.fromEntries(node.board.cards.map((card) => [card.id, {
          coverColor: card.coverColor,
          values: Object.fromEntries(node.board.config.customFields
            .filter((field) => card.extra[field.id] !== undefined)
            .map((field) => [field.id, card.extra[field.id]])),
        }])), exp.presentation.cards, `${key}: presentation values`);
      }
      if (exp.structure) {
        assert.deepEqual(node.board.config.templates.map((template) => ({
          id: template.id,
          name: template.name,
          lane: template.lane,
          labels: template.labels,
          priority: template.priority,
          estimate: template.estimate,
          fields: template.fields,
          body: template.body,
        })), exp.structure.templates, `${key}: templates`);
        assert.deepEqual(Object.fromEntries(Object.keys(exp.structure.relations).map((id) => {
          const card = node.board.cards.find((candidate) => candidate.id === id)!;
          return [id, {
            deps: card.deps,
            relations: card.relations.map(({ type, target }) => ({ type, target })),
          }];
        })), exp.structure.relations, `${key}: relations`);
      }
      if (exp.collaboration) {
        assert.deepEqual(node.board.config.savedFilters.map(({ id, name, query }) => ({ id, name, query })), exp.collaboration.filters, `${key}: saved filters`);
        assert.deepEqual(node.board.config.subscriptions.map(({ lane, watcher }) => ({ lane, watcher })), exp.collaboration.subscriptions, `${key}: lane subscriptions`);
        assert.deepEqual(Object.fromEntries(Object.keys(exp.collaboration.cards).map((id) => {
          const card = node.board.cards.find((candidate) => candidate.id === id)!;
          const parsed = parseBody(card.body);
          return [id, { watchers: card.watchers, votes: card.votes, mentions: parsed.mentions, boosts: parsed.boosts }];
        })), exp.collaboration.cards, `${key}: collaboration state`);
        for (const [query, ids] of Object.entries(exp.collaboration.queries)) {
          assert.deepEqual(
            queryCards(tree, analysis, query, { actor: 'sam', now: new Date('2026-08-20T12:00:00Z') }).map((match) => match.card.id),
            ids,
            `${key}: query ${query}`,
          );
        }
      }
    }
  });
}

test('fixture: invalid cases', () => {
  const dir = join(FIXTURES, 'invalid');
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as {
    cases: Record<string, { rule: string; ref: string }[]>;
  };
  const caseDirs = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  assert.deepEqual(caseDirs, Object.keys(expected.cases).sort(), 'every case dir has expectations');

  for (const [name, expFindings] of Object.entries(expected.cases)) {
    const tree = loadTree(join(dir, name));
    const analysis = analyze(tree);
    const all: { rule: string; ref: string }[] = [];
    for (const [key, node] of tree.boards) {
      for (const f of lintBoard(node, analysis.boards.get(key)!)) all.push({ rule: f.rule, ref: f.ref });
    }
    assert.deepEqual(sortFindings(all), sortFindings(expFindings), `case ${name}`);
  }
});
