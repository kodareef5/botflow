// Viewer smoke tests: live server endpoints and the static HTML export.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { join } from 'node:path';

import { serveBoard } from '../src/viewer/serve.ts';
import { viewerData, viewerHtml } from '../src/viewer/page.ts';
import { analyze, loadTree } from '../src/core/index.ts';

const NESTED = join(import.meta.dirname, 'fixtures', 'nested');

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
