// Viewer smoke tests: live server endpoints and the static HTML export.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { join } from 'node:path';

import { serveBoard } from '../src/viewer/serve.ts';
import { viewerData, viewerHtml } from '../src/viewer/page.ts';
import { analyze, loadTree } from '../src/core/index.ts';

const NESTED = join(import.meta.dirname, 'fixtures', 'nested');
const PRESENTATION = join(import.meta.dirname, 'fixtures', 'presentation');
const RELATIONS = join(import.meta.dirname, 'fixtures', 'relations');

test('viewer: serve exposes page and live data', async () => {
  const { server, url } = await serveBoard(NESTED, 0);
  try {
    const page = await fetch(url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /__LIVE__=true/);
    assert.match(html, /<title>platform<\/title>/);

    const res = await fetch(url + 'api/data');
    assert.equal(res.status, 200);
    const data = (await res.json()) as { boards: Record<string, { progress: number; findings: unknown[] }> };
    assert.deepEqual(Object.keys(data.boards).sort(), ['.', 'api/.botflow', 'web']);
    assert.equal(data.boards['.']!.progress, 0.75);

    const missing = await fetch(url + 'nope');
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test('viewer: static html embeds the full tree snapshot', () => {
  const tree = loadTree(NESTED);
  const html = viewerHtml(viewerData(tree, analyze(tree)), { live: false, title: 'platform' });
  assert.match(html, /__LIVE__=false/);
  assert.match(html, /"api\/\.botflow"/); // child boards embedded
  assert.match(html, /Billing sync/); // card titles present
  assert.match(html, /waiting on upstream schema freeze/); // blocked reason (body/data)
  assert.ok(!html.includes('<script src'), 'no external scripts');
  assert.ok(!html.includes('https://'), 'fully self-contained');
});

test('viewer: shared theme layer ships and its scripts parse', () => {
  const html = viewerHtml(null, { live: true });
  for (const script of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)) {
    new Function(script); // eslint-disable-line no-new-func
  }
  for (const needle of ['__THEMES__', 'applyTheme', 'data-style=harbor', 'data-style=blockparty', 'id="tstyle"', '--st-doing']) {
    assert.ok(html.includes(needle), `viewer page missing: ${needle}`);
  }
});

test('viewer: structured card faces carry parity data without body heuristics', () => {
  const tree = loadTree(PRESENTATION);
  const data = viewerData(tree, analyze(tree));
  const board = data.boards['.'] as {
    labels: { id: string; color: string }[];
    fields: { id: string; face: boolean }[];
    lanes: { estimate: number; cards: Record<string, unknown>[] }[];
  };
  const card = board.lanes.flatMap((lane) => lane.cards)[0]!;
  assert.deepEqual(board.labels, [
    { id: 'Type/Bug', color: '#d03b3b' },
    { id: 'Team/Platform', color: '#2a78d6' },
  ]);
  assert.deepEqual((card['labelDetails'] as { group: string; value: string }[]).map(({ group, value }) => ({ group, value })), [
    { group: 'Type', value: 'Bug' }, { group: 'Team', value: 'Platform' },
  ]);
  assert.equal(card['coverColor'], '#f0c040');
  assert.equal(card['descriptionPresent'], true);
  assert.deepEqual((card['checklistPreview'] as { text: string }[]).map((item) => item.text), ['rendered']);
  assert.deepEqual((card['faceFields'] as { id: string }[]).map((field) => field.id), ['sprint', 'risk']);
  const html = viewerHtml(data, { live: false });
  for (const needle of ['checklistPreview.slice(0,2)', 'c.faceFields||[]', 'c.labelDetails||[]', 'metrics.agingLevel', 'lane.estimate']) {
    assert.ok(html.includes(needle), `local viewer missing ${needle}`);
  }
});

test('viewer: relationships are inspectable and same-board edges draw as SVG connectors', () => {
  const tree = loadTree(RELATIONS);
  const data = viewerData(tree, analyze(tree));
  const board = data.boards['.'] as { lanes: { cards: Record<string, unknown>[] }[] };
  const linked = board.lanes.flatMap((lane) => lane.cards).find((card) => card['id'] === '003')!;
  assert.deepEqual(linked['relationships'], [{ type: 'relates', target: '001', source: 'stored', active: true }]);
  const html = viewerHtml(data, { live: false });
  for (const needle of ['function drawRelations(b)', "marker.setAttribute('id','viewer-rel-arrow')", "rel.source==='text'", '<h3>relationships</h3>']) {
    assert.ok(html.includes(needle), `viewer relationship surface missing: ${needle}`);
  }
});

test('viewer: serve answers only loopback Host headers (DNS-rebinding guard)', async () => {
  const { server, port } = await serveBoard(NESTED, 0);
  // node:http lets us set Host arbitrarily; fetch (undici) forbids it.
  const status = (host?: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = get({ host: '127.0.0.1', port, path: '/api/data', headers: host === undefined ? {} : { host } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
    });
  try {
    assert.equal(await status(`127.0.0.1:${port}`), 200);
    assert.equal(await status('localhost'), 200);
    assert.equal(await status('localhost:4666'), 200);
    assert.equal(await status('[::1]'), 200);
    assert.equal(await status('[::1]:4666'), 200);
    assert.equal(await status('evil.com'), 403);
    assert.equal(await status('127.0.0.1.evil.com'), 403);
    assert.equal(await status('localhost.evil.com:4666'), 403);
  } finally {
    server.close();
  }
});

test('viewer: board key is escaped in the findings heading', () => {
  // A hostile board directory name lands in CUR; it must go through esc().
  const html = viewerHtml(null, { live: true });
  assert.ok(html.includes(`'<h3>findings: '+esc(CUR)+'</h3>'`), 'findings heading must escape CUR');
});
