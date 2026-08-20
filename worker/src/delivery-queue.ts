// Pure SQLite queue primitives shared by ProjectDO and Node's built-in SQLite
// tests. SQL identifiers are selected from fixed variants; callers provide
// only value bindings.

export type SqlBinding = string | number;
export type RunSql = (query: string, ...bindings: SqlBinding[]) => Record<string, unknown>[];

export interface ClaimedWebhookDelivery {
  id: string;
  webhookId: string;
  eventAction: string;
  payload: string;
  attempts: number;
  url: string;
  secret: string;
  failureCount: number;
}

/** Claim every row in the selected batch before returning control to code
 * that may await the network. `transaction` must be synchronous. */
export function claimWebhookDeliveries(
  run: RunSql,
  transaction: <T>(body: () => T) => T,
  selectedAt: string,
  leaseUntil: string,
  maxAttempts: number,
  limit: number,
): ClaimedWebhookDelivery[] {
  return transaction(() => {
    const rows = run(
      `SELECT d.seq, d.id, d.webhook_id, d.event_action, d.payload, d.attempts,
              w.url, w.secret, w.failure_count
         FROM webhook_deliveries d
         JOIN webhooks w ON w.id = d.webhook_id
        WHERE w.active = 1
          AND (w.circuit_until IS NULL OR w.circuit_until <= ?)
          AND ((d.status IN ('pending', 'retry') AND d.attempts < ?)
            OR d.status = 'sending')
          AND d.next_attempt <= ?
        ORDER BY d.next_attempt, d.seq
        LIMIT ?`,
      selectedAt, maxAttempts, selectedAt, limit,
    );
    for (const row of rows) {
      run(
        "UPDATE webhook_deliveries SET status = 'sending', attempts = attempts + 1, last_attempt = ?, next_attempt = ? WHERE id = ?",
        selectedAt, leaseUntil, String(row['id']),
      );
    }
    return rows.map((row) => ({
      id: String(row['id']),
      webhookId: String(row['webhook_id']),
      eventAction: String(row['event_action']),
      payload: String(row['payload']),
      attempts: Number(row['attempts']) + 1,
      url: String(row['url']),
      secret: String(row['secret']),
      failureCount: Number(row['failure_count']),
    }));
  });
}

export type TerminalHistoryKind = 'webhook' | 'email';

/** Keep the newest `limit` terminal rows for one integration while leaving
 * queued/retrying/sending rows untouched. The explicit cutoff avoids the
 * same-table DELETE/NOT-IN/subquery form whose support varied across SQLite
 * embeddings. */
export function pruneTerminalHistory(
  run: RunSql,
  kind: TerminalHistoryKind,
  ownerId: string,
  limit: number,
): void {
  const webhook = kind === 'webhook';
  const table = webhook ? 'webhook_deliveries' : 'email_outbox';
  const owner = webhook ? 'webhook_id' : 'subscription_id';
  const terminal = webhook ? "('delivered', 'failed')" : "('sent', 'failed')";
  const cutoff = run(
    `SELECT seq FROM ${table} WHERE ${owner} = ? AND status IN ${terminal} ORDER BY seq DESC LIMIT 1 OFFSET ?`,
    ownerId, limit - 1,
  )[0]?.['seq'];
  if (typeof cutoff !== 'number') return;
  run(
    `DELETE FROM ${table} WHERE ${owner} = ? AND status IN ${terminal} AND seq < ?`,
    ownerId, cutoff,
  );
}
