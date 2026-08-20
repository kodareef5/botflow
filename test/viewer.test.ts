// Viewer smoke tests: live server endpoints and the static HTML export.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { serveBoard } from '../src/viewer/serve.ts';
import { viewerData, viewerHtml } from '../src/viewer/page.ts';
import { analyze, loadTree } from '../src/core/index.ts';

const NESTED = join(import.meta.dirname, 'fixtures', 'nested');
const PRESENTATION = join(import.meta.dirname, 'fixtures', 'presentation');
const RELATIONS = join(import.meta.dirname, 'fixtures', 'relations');
const COLLABORATION = join(import.meta.dirname, 'fixtures', 'collaboration');
const CARD_FEATURES = join(import.meta.dirname, 'fixtures', 'card-features');

test('viewer: serve exposes page and live data', async () => {
  const { server, url } = await serveBoard(NESTED, 0);
  try {
    assert.match(new URL(url).pathname, /^\/[a-f0-9]{48}\/$/, 'viewer URL carries a per-process capability');
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('cache-control'), 'no-store');
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
    assert.equal((await fetch(url + 'api/data', { method: 'POST' })).status, 405);
    const head = await fetch(url + 'api/data', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
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
  for (const needle of [
    '__THEMES__', 'applyTheme', 'data-style=harbor', 'data-style=blockparty', 'id="tstyle"', '--st-doing',
    'id="taglimit"', 'bfv_card_tag_limit', 'cardTagBadges', "hidden.length+' more</span>'",
  ]) {
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
  for (const needle of ['checklistPreview.slice(0,2)', 'c.faceFields||[]', 'c.labelDetails||[]', 'metrics.agingLevel', 'metrics.dueChanges', 'lane.estimate']) {
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

test('viewer: collaboration signals have card-face and detail parity', () => {
  const tree = loadTree(COLLABORATION);
  const data = viewerData(tree, analyze(tree));
  const board = data.boards['.'] as { lanes: { cards: Record<string, unknown>[] }[] };
  const card = board.lanes.flatMap((lane) => lane.cards).find((candidate) => candidate['id'] === '001')!;
  assert.deepEqual(card['watchers'], ['lea', 'sam']);
  assert.deepEqual(card['votes'], ['lea', 'bob']);
  assert.deepEqual(card['mentions'], ['ops-lead', 'sam']);
  assert.equal(card['boostCount'], 1);
  const html = viewerHtml(data, { live: false });
  for (const needle of ['title="watchers"', 'title="votes"', 'title="boosts"', "['mentions',", "['boosts',c.boostCount"])
    assert.ok(html.includes(needle), `local viewer collaboration surface missing: ${needle}`);
});

test('viewer: every manager layout has a read-only local projection, including Hill uncertainty', () => {
  const tree = loadTree(CARD_FEATURES);
  const data = viewerData(tree, analyze(tree));
  const board = data.boards['.'] as { lanes: { cards: Record<string, unknown>[] }[] };
  assert.equal(board.lanes.flatMap((lane) => lane.cards)[0]!['hill'], 38);
  const html = viewerHtml(data, { live: false });
  for (const hook of [
    'id="layout"', 'function tableHtml(', 'function groupedHtml(', 'function swimlaneHtml(',
    'function calendarHtml(', 'function timelineHtml(', 'function metricsHtml(', 'function hillHtml(',
    'Manual uncertainty', "['hill',c.hill]", 'cumulative flow',
  ]) assert.ok(html.includes(hook), `local viewer missing ${hook}`);
});

test('viewer: card activators and the detail drawer have complete keyboard semantics', () => {
  const html = viewerHtml(null, { live: true });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
  const app = scripts.at(-1)!;
  for (const needle of [
    'tabindex="0" role="button"',
    'role="dialog" aria-modal="true" aria-hidden="true"',
    'function closeDrawer()',
    'd._restoreFocus=opener||document.activeElement',
    'el.inert=true',
    "if(e.key==='Escape')",
    'role="img" aria-label=',
  ]) assert.ok(html.includes(needle), `viewer accessibility surface missing: ${needle}`);

  const start = app.indexOf('function trapDrawerTab');
  const end = app.indexOf('function closeDrawer', start);
  assert.ok(start !== -1 && end > start, 'viewer dialog focus trap found');
  const focused: string[] = [];
  const first = { disabled: false, focus: () => focused.push('first') };
  const last = { disabled: false, focus: () => focused.push('last') };
  const document = { activeElement: last };
  const context: Record<string, unknown> = { document };
  runInNewContext(`${app.slice(start, end)};trap=trapDrawerTab`, context);
  const trap = context['trap'] as (event: Record<string, unknown>, drawer: Record<string, unknown>) => void;
  const drawer = { querySelectorAll: () => [first, last], contains: (node: unknown) => node === first || node === last };
  let prevented = 0;
  trap({ key: 'Tab', shiftKey: false, preventDefault: () => prevented++ }, drawer);
  document.activeElement = first;
  trap({ key: 'Tab', shiftKey: true, preventDefault: () => prevented++ }, drawer);
  assert.deepEqual(focused, ['first', 'last']);
  assert.equal(prevented, 2);
});

test('viewer: emitted calendar and timeline render structured dates', () => {
  const tree = loadTree(CARD_FEATURES);
  const data = viewerData(tree, analyze(tree));
  const board = data.boards['.'];
  const html = viewerHtml(data, { live: false });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
  const app = scripts.at(-1)!;
  const start = app.indexOf('function isoDay(');
  const end = app.indexOf('function avg(', start);
  assert.ok(start !== -1 && end > start, 'dated layout renderers found');
  const context: Record<string, unknown> = {
    CAL_MONTH: '2026-08',
    flatCards: (value: { lanes: { cards: unknown[] }[] }) => value.lanes.flatMap((lane) => lane.cards),
    esc: (value: unknown) => String(value ?? ''),
    stateColor: () => '#369',
  };
  const rendered = runInNewContext(`(()=>{${app.slice(start, end)};return {calendar:calendarHtml(board),timeline:timelineHtml(board)}})()`, { ...context, board }) as { calendar: string; timeline: string };
  assert.match(rendered.calendar, /data-card="001"/);
  assert.match(rendered.timeline, /data-open-card="001"/);
  assert.match(rendered.timeline, /2026-08-02 through 2026-08-20/);
});

test('viewer: serve requires its capability and answers only loopback Host headers', async () => {
  const { server, port, url } = await serveBoard(NESTED, 0);
  const dataPath = `${new URL(url).pathname}api/data`;
  // node:http lets us set Host arbitrarily; fetch (undici) forbids it.
  const status = (host?: string, path = dataPath): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = get({ host: '127.0.0.1', port, path, headers: host === undefined ? {} : { host } }, (res) => {
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
    assert.equal(await status('LOCALHOST'), 200);
    assert.equal(await status(`127.0.0.1:${port}`, '/api/data'), 404, 'the bare local port does not expose board data');
    assert.equal(await status('evil.com'), 403);
    assert.equal(await status('127.0.0.1.evil.com'), 403);
    assert.equal(await status('localhost.evil.com:4666'), 403);
    assert.equal(await status('[::1].evil'), 403);
    assert.equal(await status('localhost:evil'), 403);
  } finally {
    server.close();
  }
});

test('viewer: board key is escaped in the findings heading', () => {
  // A hostile board directory name lands in CUR; it must go through esc().
  const html = viewerHtml(null, { live: true });
  assert.ok(html.includes(`'<h3>findings: '+esc(CUR)+'</h3>'`), 'findings heading must escape CUR');
});

test('viewer: custom-field labels are escaped and remote images are not fetched', () => {
  const html = viewerHtml(null, { live: true });
  assert.ok(html.includes("rows.map(r=>'<tr><td>'+esc(r[0])"), 'drawer labels pass through the HTML escaper');
  assert.ok(html.includes("img-src 'self' data: blob:"), 'CSP blocks attacker-controlled third-party image fetches');
  assert.ok(html.includes('c.cover&&imageOk(c.cover)'), 'card markup omits non-local covers');
});
