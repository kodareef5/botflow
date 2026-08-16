// Viewer smoke tests: live server endpoints and the static HTML export.

import { test } from 'node:test';
import assert from 'node:assert/strict';
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
