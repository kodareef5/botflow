import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  claimWebhookDeliveries,
  pruneTerminalHistory,
  type RunSql,
} from '../worker/src/delivery-queue.ts';

function database(): { db: DatabaseSync; run: RunSql } {
  const db = new DatabaseSync(':memory:');
  const run: RunSql = (query, ...bindings) => {
    const statement = db.prepare(query);
    if (/^\s*(?:SELECT|PRAGMA)/i.test(query)) return statement.all(...bindings) as Record<string, unknown>[];
    statement.run(...bindings);
    return [];
  };
  return { db, run };
}

test('webhook batches are fully leased before another claimant can select', () => {
  const { db, run } = database();
  db.exec(`
    CREATE TABLE webhooks(id TEXT PRIMARY KEY, url TEXT, secret TEXT, failure_count INTEGER, circuit_until TEXT, active INTEGER);
    CREATE TABLE webhook_deliveries(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, webhook_id TEXT, event_action TEXT, payload TEXT, status TEXT, attempts INTEGER, next_attempt TEXT, last_attempt TEXT);
    INSERT INTO webhooks VALUES ('hook', 'https://example.test/hook', 'secret', 0, NULL, 1);
  `);
  const due = '2026-08-20T12:00:00.000Z';
  for (let i = 0; i < 12; i++) {
    db.prepare("INSERT INTO webhook_deliveries(id, webhook_id, event_action, payload, status, attempts, next_attempt) VALUES (?, 'hook', 'add', '{}', 'pending', 0, ?)")
      .run(`delivery-${i}`, due);
  }
  const transaction = <T>(body: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const first = claimWebhookDeliveries(run, transaction, due, '2026-08-20T12:03:00.000Z', 6, 10);
  const second = claimWebhookDeliveries(run, transaction, due, '2026-08-20T12:03:00.000Z', 6, 10);
  assert.equal(first.length, 10);
  assert.equal(second.length, 2);
  assert.equal(new Set([...first, ...second].map((row) => row.id)).size, 12, 'claims are disjoint');
  assert.ok([...first, ...second].every((row) => row.attempts === 1));

  const recovered = claimWebhookDeliveries(
    run, transaction, '2026-08-20T12:04:00.000Z', '2026-08-20T12:07:00.000Z', 6, 12,
  );
  assert.deepEqual(recovered.map((row) => row.id), [...first, ...second].map((row) => row.id),
    'an expired sending lease retries the stable delivery ids');
  assert.ok(recovered.every((row) => row.attempts === 2));
  db.close();
});

test('terminal integration pruning keeps the newest cap and every live row', () => {
  const { db, run } = database();
  db.exec(`
    CREATE TABLE webhook_deliveries(seq INTEGER PRIMARY KEY AUTOINCREMENT, webhook_id TEXT, status TEXT);
    CREATE TABLE email_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, subscription_id TEXT, status TEXT);
  `);
  for (let i = 0; i < 1_005; i++) {
    db.prepare("INSERT INTO webhook_deliveries(webhook_id, status) VALUES ('hook', ?)").run(i % 2 === 0 ? 'delivered' : 'failed');
    db.prepare("INSERT INTO email_outbox(subscription_id, status) VALUES ('sub', ?)").run(i % 2 === 0 ? 'sent' : 'failed');
  }
  for (const status of ['pending', 'retry', 'sending']) {
    db.prepare("INSERT INTO webhook_deliveries(webhook_id, status) VALUES ('hook', ?)").run(status);
  }
  for (const status of ['queued', 'retry', 'sending']) {
    db.prepare("INSERT INTO email_outbox(subscription_id, status) VALUES ('sub', ?)").run(status);
  }
  pruneTerminalHistory(run, 'webhook', 'hook', 1_000);
  pruneTerminalHistory(run, 'email', 'sub', 1_000);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status IN ('delivered', 'failed')").get() as { n: number }).n, 1_000);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status IN ('pending', 'retry', 'sending')").get() as { n: number }).n, 3);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE status IN ('sent', 'failed')").get() as { n: number }).n, 1_000);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE status IN ('queued', 'retry', 'sending')").get() as { n: number }).n, 3);
  db.close();
});
