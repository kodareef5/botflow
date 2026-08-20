import assert from 'node:assert/strict';
import test from 'node:test';

import { readIntegrationSnapshot } from '../worker/src/integration-snapshot.ts';

const NOW = '2026-08-20T12:00:00.000Z';
const valid = () => ({
  schema: 'botflow.integrations.v1',
  webhooks: [{
    id: `wh_${'a'.repeat(32)}`, name: 'build hook', url: 'https://hooks.example.com/botflow',
    secret: `bfwhsec_${'b'.repeat(64)}`, allowEvents: ['add'], denyEvents: ['edit'], active: true, created: NOW, updated: NOW,
  }],
  emailRoutes: [{
    id: `emr_${'c'.repeat(32)}`, name: 'inbox', tokenHash: 'd'.repeat(64), kind: 'create', lane: 'todo', card: null,
    actor: 'root', active: true, created: NOW, updated: NOW,
  }],
  emailSubscriptions: [{
    id: `ems_${'e'.repeat(32)}`, name: 'ops', recipients: ['ops@example.com'], allowEvents: [], denyEvents: ['boost'],
    active: true, created: NOW, updated: NOW,
  }],
});

test('integration snapshots validate and normalize every secret-bearing overlay', () => {
  const parsed = readIntegrationSnapshot(valid());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.webhooks[0]!.url, 'https://hooks.example.com/botflow');
  assert.deepEqual(parsed.value.emailSubscriptions[0]!.recipients, ['ops@example.com']);
});

test('integration snapshots fail closed on SSRF targets, bad secrets, and incoherent routes', () => {
  const privateTarget = valid();
  privateTarget.webhooks[0]!.url = 'http://127.0.0.1/hook';
  const privateResult = readIntegrationSnapshot(privateTarget);
  assert.equal(privateResult.ok, false);
  if (!privateResult.ok) assert.match(privateResult.error, /publicly routable/);

  const badSecret = valid();
  badSecret.webhooks[0]!.secret = 'plaintext';
  assert.equal(readIntegrationSnapshot(badSecret).ok, false);

  const badRoute = valid();
  badRoute.emailRoutes[0]!.kind = 'comment';
  const routeResult = readIntegrationSnapshot(badRoute);
  assert.equal(routeResult.ok, false);
  if (!routeResult.ok) assert.match(routeResult.error, /comment route/);

  const duplicateHash = valid();
  duplicateHash.emailRoutes.push({
    ...duplicateHash.emailRoutes[0]!, id: `emr_${'f'.repeat(32)}`, name: 'duplicate token hash',
  });
  const duplicateResult = readIntegrationSnapshot(duplicateHash);
  assert.equal(duplicateResult.ok, false);
  if (!duplicateResult.ok) assert.match(duplicateResult.error, /tokenHash is duplicated/);
});

test('integration snapshot private allowance is explicit and intended for local tests only', () => {
  const local = valid();
  local.webhooks[0]!.url = 'http://127.0.0.1:9000/hook';
  assert.equal(readIntegrationSnapshot(local, true).ok, true);
});
