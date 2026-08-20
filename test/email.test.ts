import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanRecipients,
  emailTokenHash,
  normalizeInboundEmail,
  outboundEmailPayload,
} from '../worker/src/email.ts';

test('email recipients are bounded, validated, and deduplicated case-insensitively', () => {
  assert.deepEqual(cleanRecipients(['Ops@example.com', 'ops@example.com', 'dev@example.net']), ['Ops@example.com', 'dev@example.net']);
  assert.throws(() => cleanRecipients([]), /at least one/);
  assert.throws(() => cleanRecipients(['not-an-address']), /invalid recipient/);
});

test('normalized inbound mail strips structural controls and enforces message ids', () => {
  assert.deepEqual(normalizeInboundEmail({ messageId: ' provider-42\r\n ', from: 'A <a@example.com>', subject: 'Hello\nworld', text: 'one\r\ntwo' }), {
    messageId: 'provider-42', from: 'A <a@example.com>', subject: 'Hello world', text: 'one\ntwo',
  });
  assert.throws(() => normalizeInboundEmail({ messageId: '', text: 'x' }), /messageId is required/);
  assert.throws(() => normalizeInboundEmail({ messageId: 'x', text: '' }), /subject or text/);
});

test('inbound capability hashes are stable and do not expose the token', async () => {
  const hash = await emailTokenHash('bfmail_secret');
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash.includes('secret'), false);
  assert.equal(hash, await emailTokenHash('bfmail_secret'));
});

test('outbound email payload is versioned and frozen from one event', () => {
  const body = outboundEmailPayload('p-one', 'ems_1', ['ops@example.com'], {
    seq: 9, ts: '2026-08-20T12:00:00.000Z', actor: 'bot-1', action: 'close', cardId: '012', detail: 'shipped',
  });
  const parsed = JSON.parse(body);
  assert.equal(parsed.schema, 'botflow.email.outbound.v1');
  assert.deepEqual(parsed.message.to, ['ops@example.com']);
  assert.match(parsed.message.subject, /close card 012/);
  assert.equal(parsed.event.id, 'evt_p-one_9');
});
