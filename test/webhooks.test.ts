import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  cleanEventList,
  eventSelected,
  postWebhook,
  webhookPayload,
  webhookSignature,
  webhookTarget,
} from '../worker/src/webhooks.ts';

test('webhook filters are exact, deduplicated allow/deny lists', () => {
  assert.deepEqual(cleanEventList(['move', 'add', 'move'], 'events'), ['add', 'move']);
  assert.equal(eventSelected('move', [], []), true);
  assert.equal(eventSelected('move', ['move'], []), true);
  assert.equal(eventSelected('add', ['move'], []), false);
  assert.equal(eventSelected('move', ['move'], ['move']), false);
  assert.throws(() => cleanEventList(['move', 'BAD EVENT'], 'events'), /invalid event/);
});

test('webhook payload and HMAC contract are deterministic', async () => {
  const body = webhookPayload('project-1', { seq: 7, ts: '2026-08-20T12:00:00.000Z', actor: 'sam', action: 'move', cardId: '012', detail: 'todo → doing' });
  assert.deepEqual(JSON.parse(body), {
    schema: 'botflow.webhook.v1', id: 'evt_project-1_7', project: { id: 'project-1' },
    event: { sequence: 7, occurred_at: '2026-08-20T12:00:00.000Z', actor: 'sam', action: 'move', card_id: '012', detail: 'todo → doing' },
  });
  const expected = createHmac('sha256', 'secret').update('1724155200.' + body).digest('hex');
  assert.equal(await webhookSignature('secret', '1724155200', body), `sha256=${expected}`);
});

test('webhook endpoint validation reuses the SSRF denylist', () => {
  assert.equal(webhookTarget('https://hooks.example.com/botflow').ok, true);
  for (const url of ['http://public.example.com/x', 'http://127.0.0.1/x', 'http://169.254.169.254/x', 'file:///tmp/x', 'https://user@example.com/x']) {
    assert.equal(webhookTarget(url).ok, false, url);
  }
});

test('webhook attempts validate redirects and never turn the signed POST into GET', async () => {
  const calls: string[] = [];
  const redirectPrivate = async (input: string | URL | Request): Promise<Response> => {
    calls.push(String(input));
    return new Response(null, { status: 307, headers: { location: 'http://127.0.0.1/private' } });
  };
  const blocked = await postWebhook('https://hooks.example.com/start', 'secret', 'del_1', 'move', '{}', false, redirectPrivate as typeof fetch);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error ?? '', /blocked target/);
  assert.deepEqual(calls, ['https://hooks.example.com/start']);

  const changed = await postWebhook('https://hooks.example.com/start', 'secret', 'del_2', 'move', '{}', false,
    (async () => new Response(null, { status: 302, headers: { location: 'https://hooks.example.com/next' } })) as typeof fetch);
  assert.equal(changed.retryable, false);
  assert.match(changed.error ?? '', /change the signed POST method/);

  const publicCalls: string[] = [];
  const followed = await postWebhook('https://hooks.example.com/start', 'secret', 'del_3', 'move', '{}', false, (async (input) => {
    publicCalls.push(String(input));
    return publicCalls.length === 1
      ? new Response(null, { status: 308, headers: { location: '/next' } })
      : new Response(null, { status: 204 });
  }) as typeof fetch);
  assert.equal(followed.ok, true);
  assert.deepEqual(publicCalls, ['https://hooks.example.com/start', 'https://hooks.example.com/next']);
});

test('retryable responses expose a bounded Retry-After delay', async () => {
  const attempted = await postWebhook('https://hooks.example.com/start', 'secret', 'del_4', 'move', '{}', false,
    (async () => new Response(null, { status: 429, headers: { 'retry-after': '120' } })) as typeof fetch);
  assert.deepEqual({ ok: attempted.ok, status: attempted.status, retryable: attempted.retryable, wait: attempted.retryAfterMs },
    { ok: false, status: 429, retryable: true, wait: 120_000 });
});
