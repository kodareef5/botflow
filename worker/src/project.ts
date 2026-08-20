// ProjectDO: one SQLite-backed Durable Object per project. A project IS a
// board: the DO stores the exact botflow document format (board.yaml text +
// card file texts), applies the same pure ops the CLI uses, serializes every
// mutation (single writer), and keeps an append-only audit log.
//
// Nesting: a card with `board: project:<id>` is a project card. This DO asks
// the referenced sibling DO for its distribution (rollupInfo) so hosted
// boards roll up exactly like the file engine: a visited-set breaks cycles.

import { DurableObject } from 'cloudflare:workers';

import { analyzeSingle, type ExternalChild, type ExternalReference } from '../../src/core/analyze.ts';
import { boardFromDocuments, validateBoardDocuments, type BoardDocument } from '../../src/core/docs.ts';
import { boardJson, cardDetailJson, cardJson } from '../../src/core/json.ts';
import { parseBody, type BodyEntry } from '../../src/core/body.ts';
import type { BoardAnalysis } from '../../src/core/analyze.ts';
import type { BoardNode, Canonical, Card, Finding, Lane, LoadedBoard } from '../../src/core/model.ts';
import { RELATION_TYPES, SLUG_RE, defaultRollup, isCanonical } from '../../src/core/model.ts';
import {
  emitBoardYaml,
  parseAutomation,
  parseBlockers,
  parseButtons,
  parseCustomFields,
  parseLabelDefinitions,
  parseRules,
  parseSavedFilters,
  parseSubscriptions,
  parseTemplates,
} from '../../src/core/config.ts';
import type { YamlValue } from '../../src/core/yaml.ts';
import { validCustomFieldValue } from '../../src/core/presentation.ts';
import { parseCardReference, relationInverse } from '../../src/core/refs.ts';
import {
  ClaimConflict,
  UsageError,
  defaultBoardYaml,
  getCard,
  opAdd,
  opAttach,
  opBlock,
  opBoost,
  opCheck,
  opChecklistAdd,
  opClaim,
  opClose,
  opComment,
  opDescribe,
  opDetach,
  opEdit,
  opLog,
  opLink,
  opLinkHalf,
  opUnlink,
  opUnlinkHalf,
  opPromote,
  opMergeDuplicates,
  opQuickAdd,
  opRemoveFilter,
  opSaveFilter,
  opSubscribeLane,
  opSnooze,
  opBulk,
  opButton,
  opAutomationPass,
  opTransferCard,
  opMove,
  opUnblock,
  opVote,
  opWatch,
  type AddOptions,
  type EditPatch,
} from '../../src/core/ops.ts';
import { newHashId, nextSeqId, slugify } from '../../src/core/ids.ts';
import { logMutation, sanitizeBlock, serializeCard } from '../../src/core/write.ts';
import { queryCards } from '../../src/core/query.ts';
import { nextAutomationAt } from '../../src/core/scheduling.ts';
import { youtubeVideoId } from './youtube.ts';
import {
  EMAIL_BACKOFF_MS,
  EMAIL_INBOUND_HOURLY_CAP,
  EMAIL_LEASE_MS,
  EMAIL_MAX_ATTEMPTS,
  EMAIL_MAX_SUBJECT,
  cleanRecipients,
  emailTokenHash,
  normalizeInboundEmail,
  outboundEmailPayload,
  randomEmailToken,
} from './email.ts';
import {
  readIntegrationSnapshot,
  type IntegrationSnapshot,
} from './integration-snapshot.ts';
import {
  WEBHOOK_BACKOFF_MS,
  WEBHOOK_CIRCUIT_FAILURES,
  WEBHOOK_CIRCUIT_MS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_TIMEOUT_MS,
  cleanEventList,
  cleanIntegrationName,
  eventSelected,
  postWebhook,
  randomIntegrationId,
  randomSigningSecret,
  webhookPayload,
  webhookTarget,
  type WebhookEvent,
} from './webhooks.ts';
import { claimWebhookDeliveries, pruneTerminalHistory, type RunSql } from './delivery-queue.ts';

export interface AuditEvent {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  card_id: string | null;
  detail: string;
}

export interface CardHistoryItem extends BodyEntry {
  /** Stable 1-based position in the append-only markdown section. */
  sequence: number;
}

export interface CardHistoryPage {
  items: CardHistoryItem[];
  /** Exclusive upper bound for the next page toward older entries. */
  next: number | null;
  total: number;
}

interface HostedReferenceUse {
  cardId: string;
  target: string;
  kind: 'board' | 'dependency' | 'relation';
  copiedFrom: boolean;
}

export type ActionResult = Record<string, unknown> | { error: string };

import type { RegistryDO } from './registry.ts';

interface ProjectEnv {
  PROJECT: DurableObjectNamespace<ProjectDO>;
  REGISTRY: DurableObjectNamespace<RegistryDO>;
  /** Test-only loopback allowance shared with the unfurl integration suite. */
  UNFURL_ALLOW_PRIVATE?: string;
}

const PROJECT_REF = 'project:';

export type ImportValidation =
  | { docs: BoardDocument[]; board: LoadedBoard }
  | { error: string };

/** Snapshot validation lives in core (docs.ts) so hosted import and CLI pull
 *  share one gate; this alias keeps the worker-side name. */
export const validateImportDocuments = validateBoardDocuments;

/** Card text is permanent: the Log is append-only by spec and there is no
 *  delete verb to reclaim the space. Unbounded single-line entries let one
 *  write member grow a card without limit, and every board read re-parses the
 *  whole document. These caps are generous for real use and finite. */
const MAX_LINE_TEXT = 4_000;
const MAX_BODY_TEXT = 100_000;
const MAX_WEBHOOKS = 25;
const WEBHOOK_DELIVERY_BATCH = 10;
const MAX_EMAIL_ROUTES = 25;
const MAX_EMAIL_SUBSCRIPTIONS = 25;
const EMAIL_OUTBOX_CLAIM_MAX = 25;
const MAX_INTEGRATION_HISTORY = 1_000;
const EMAIL_DEDUPE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const ALARM_FAILURE_BACKOFF_MS = 60_000;
const ALARM_BACKOFF_KEY = 'alarm_backoff_until';

const clampLine = (value: unknown, fallback: string): string => {
  const text = value === undefined || value === null ? fallback : String(value);
  return text.slice(0, MAX_LINE_TEXT);
};

const eventList = (value: unknown): string[] => {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
};

const DDL = `
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY, file TEXT NOT NULL, text TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, card_id TEXT, detail TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS unfurls(url TEXT PRIMARY KEY, image TEXT, image_hash TEXT, title TEXT, site TEXT, status TEXT NOT NULL, fetched TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS webhooks(id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL, allow_events TEXT NOT NULL, deny_events TEXT NOT NULL, active INTEGER NOT NULL, failure_count INTEGER NOT NULL, circuit_until TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS webhook_deliveries(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, webhook_id TEXT NOT NULL, event_seq INTEGER NOT NULL, event_action TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt TEXT NOT NULL, last_attempt TEXT, response_status INTEGER, error TEXT, delivered TEXT, replay_of TEXT, created TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(status, next_attempt);
  CREATE INDEX IF NOT EXISTS webhook_deliveries_hook ON webhook_deliveries(webhook_id, seq DESC);
  CREATE TABLE IF NOT EXISTS email_routes(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, lane_id TEXT, card_id TEXT, actor TEXT NOT NULL, active INTEGER NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS email_inbound_messages(route_id TEXT NOT NULL, message_id TEXT NOT NULL, outcome TEXT NOT NULL, received TEXT NOT NULL, PRIMARY KEY(route_id, message_id));
  CREATE INDEX IF NOT EXISTS email_inbound_received ON email_inbound_messages(route_id, received);
  CREATE TABLE IF NOT EXISTS email_subscriptions(id TEXT PRIMARY KEY, name TEXT NOT NULL, recipients TEXT NOT NULL, allow_events TEXT NOT NULL, deny_events TEXT NOT NULL, active INTEGER NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS email_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, subscription_id TEXT NOT NULL, event_seq INTEGER NOT NULL, event_action TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt TEXT NOT NULL, lease_token TEXT, lease_until TEXT, leased_by TEXT, error TEXT, sent TEXT, created TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox(status, next_attempt, lease_until);
  CREATE INDEX IF NOT EXISTS email_outbox_subscription ON email_outbox(subscription_id, seq DESC);
`;

export class ProjectDO extends DurableObject<ProjectEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: ProjectEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(DDL);
  }

  // ---- storage helpers ----

  private selfId(): string {
    return this.ctx.id.name ?? '';
  }

  private configText(): string | null {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = 'config'").toArray()[0];
    return row ? (row['value'] as string) : null;
  }

  private loadBoardDocs(): LoadedBoard {
    const docs = this.sql
      .exec('SELECT file, text FROM cards ORDER BY file')
      .toArray()
      .map((r): BoardDocument => ({ path: r['file'] as string, text: r['text'] as string }));
    return boardFromDocuments(this.configText(), docs, 'project');
  }

  private persistCard(card: Card): void {
    this.sql.exec(
      'INSERT INTO cards(id, file, text, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET file = excluded.file, text = excluded.text, updated_at = excluded.updated_at',
      card.id,
      card.file,
      serializeCard(card),
      new Date().toISOString(),
    );
  }

  private event(actor: string, action: string, cardId: string | null, detail: string): void {
    const ts = new Date().toISOString();
    const cleanDetail = detail.slice(0, MAX_LINE_TEXT);
    this.sql.exec('INSERT INTO events(ts, actor, action, card_id, detail) VALUES (?, ?, ?, ?, ?)', ts, actor, action, cardId, cleanDetail);
    const row = this.sql.exec('SELECT last_insert_rowid() AS seq').toArray()[0];
    const event = { seq: Number(row?.['seq'] ?? 0), ts, actor, action, cardId, detail: cleanDetail };
    this.enqueueWebhookEvent(event);
    this.enqueueEmailEvent(event);
  }

  private enqueueWebhookEvent(event: WebhookEvent): void {
    const now = new Date().toISOString();
    let queued = false;
    const hooks = this.sql.exec(
      'SELECT id, allow_events, deny_events, circuit_until FROM webhooks WHERE active = 1',
    ).toArray();
    for (const hook of hooks) {
      if (!eventSelected(event.action, eventList(hook['allow_events']), eventList(hook['deny_events']))) continue;
      const circuitUntil = typeof hook['circuit_until'] === 'string' && hook['circuit_until'] > now
        ? hook['circuit_until']
        : now;
      this.sql.exec(
        'INSERT INTO webhook_deliveries(id, webhook_id, event_seq, event_action, payload, status, attempts, next_attempt, created) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
        randomIntegrationId('whd'), String(hook['id']), event.seq, event.action, webhookPayload(this.selfId(), event), 'pending', circuitUntil, now,
      );
      this.pruneWebhookHistory(String(hook['id']));
      queued = true;
    }
    // An immediate alarm is safe even for an open circuit: the alarm will
    // observe the deferred next_attempt and consolidate it with automation.
    if (queued) this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + 1));
  }

  private enqueueEmailEvent(event: WebhookEvent): void {
    const now = new Date().toISOString();
    const subscriptions = this.sql.exec(
      'SELECT id, recipients, allow_events, deny_events FROM email_subscriptions WHERE active = 1',
    ).toArray();
    for (const subscription of subscriptions) {
      if (!eventSelected(event.action, eventList(subscription['allow_events']), eventList(subscription['deny_events']))) continue;
      const id = String(subscription['id']);
      const recipients = eventList(subscription['recipients']);
      this.sql.exec(
        'INSERT INTO email_outbox(id, subscription_id, event_seq, event_action, payload, status, attempts, next_attempt, created) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
        randomIntegrationId('eml'), id, event.seq, event.action, outboundEmailPayload(this.selfId(), id, recipients, event), 'queued', now, now,
      );
      this.pruneEmailHistory(id);
    }
  }

  private pruneWebhookHistory(webhookId: string): void {
    pruneTerminalHistory(this.runSql, 'webhook', webhookId, MAX_INTEGRATION_HISTORY);
  }

  private pruneEmailHistory(subscriptionId: string): void {
    pruneTerminalHistory(this.runSql, 'email', subscriptionId, MAX_INTEGRATION_HISTORY);
  }

  private readonly runSql: RunSql = (query, ...bindings) =>
    this.sql.exec(query, ...bindings).toArray() as unknown as Record<string, unknown>[];

  private nextWebhookAt(): number | null {
    const row = this.sql.exec(
      `SELECT MIN(CASE
                    WHEN w.circuit_until IS NOT NULL AND w.circuit_until > d.next_attempt THEN w.circuit_until
                    ELSE d.next_attempt
                  END) AS next_attempt
         FROM webhook_deliveries d
         JOIN webhooks w ON w.id = d.webhook_id
        WHERE w.active = 1 AND d.status IN ('pending', 'retry', 'sending')`,
    ).toArray()[0];
    if (typeof row?.['next_attempt'] !== 'string') return null;
    const parsed = Date.parse(row['next_attempt']);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }

  private rescheduleAlarm(board = this.loadBoardDocs()): void {
    const automation = board.config.mutationBlocked === null ? nextAutomationAt(board) : null;
    const webhook = this.nextWebhookAt();
    const candidates = [automation, webhook].filter((value): value is number => value !== null);
    let next = candidates.length === 0 ? null : Math.min(...candidates);
    const backoffRow = this.sql.exec('SELECT value FROM meta WHERE key = ?', ALARM_BACKOFF_KEY).toArray()[0];
    const backoff = typeof backoffRow?.['value'] === 'string' ? Date.parse(backoffRow['value']) : Number.NaN;
    if (next !== null && !Number.isNaN(backoff) && backoff > Date.now()) next = Math.max(next, backoff);
    const pending = next === null
      ? this.ctx.storage.deleteAlarm()
      : this.ctx.storage.setAlarm(Math.max(Date.now() + 1, next));
    this.ctx.waitUntil(pending);
  }

  private deferAlarmAfterFailure(error: unknown): void {
    const until = new Date(Date.now() + ALARM_FAILURE_BACKOFF_MS).toISOString();
    this.sql.exec(
      'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ALARM_BACKOFF_KEY, until,
    );
    console.error('project alarm work failed; retry deferred:', error);
  }

  /** Select and lease a whole delivery batch without yielding. Durable Object
   * turns may interleave after an await; pre-leasing every selected row means
   * a second turn cannot retain a stale copy of the tail of this batch. */
  private claimDueWebhooks() {
    const selectedAt = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + WEBHOOK_TIMEOUT_MS + 2 * 60_000).toISOString();
    return claimWebhookDeliveries(
      this.runSql,
      (body) => this.ctx.storage.transactionSync(body),
      selectedAt,
      leaseUntil,
      WEBHOOK_MAX_ATTEMPTS,
      WEBHOOK_DELIVERY_BATCH,
    );
  }

  private async deliverDueWebhooks(): Promise<void> {
    const rows = this.claimDueWebhooks();
    const openedCircuits = new Set<string>();
    const failureCounts = new Map<string, number>();
    for (const row of rows) {
      const deliveryId = row.id;
      const webhookId = row.webhookId;
      if (openedCircuits.has(webhookId)) continue;
      const attempts = row.attempts;

      let result: Awaited<ReturnType<typeof postWebhook>>;
      try {
        result = await postWebhook(
          row.url, row.secret, deliveryId, row.eventAction, row.payload,
          this.env.UNFURL_ALLOW_PRIVATE === 'on',
        );
      } catch (error) {
        result = {
          ok: false,
          status: null,
          retryable: true,
          retryAfterMs: null,
          error: error instanceof Error ? error.message.slice(0, 300) : 'delivery failed',
        };
      }

      if (result.ok) {
        const deliveredAt = new Date().toISOString();
        this.sql.exec(
          "UPDATE webhook_deliveries SET status = 'delivered', next_attempt = ?, response_status = ?, error = NULL, delivered = ? WHERE id = ?",
          deliveredAt, result.status, deliveredAt, deliveryId,
        );
        this.sql.exec('UPDATE webhooks SET failure_count = 0, circuit_until = NULL, updated = ? WHERE id = ?', deliveredAt, webhookId);
        failureCounts.set(webhookId, 0);
        this.pruneWebhookHistory(webhookId);
        continue;
      }

      const failureCount = (failureCounts.get(webhookId) ?? row.failureCount) + 1;
      failureCounts.set(webhookId, failureCount);
      const circuitUntil = failureCount >= WEBHOOK_CIRCUIT_FAILURES
        ? new Date(Date.now() + WEBHOOK_CIRCUIT_MS).toISOString()
        : null;
      this.sql.exec(
        'UPDATE webhooks SET failure_count = ?, circuit_until = ?, updated = ? WHERE id = ?',
        failureCount, circuitUntil, new Date().toISOString(), webhookId,
      );
      const canRetry = result.retryable && attempts < WEBHOOK_MAX_ATTEMPTS;
      if (canRetry) {
        const backoff = WEBHOOK_BACKOFF_MS[Math.min(attempts - 1, WEBHOOK_BACKOFF_MS.length - 1)]!;
        const delay = Math.max(backoff, result.retryAfterMs ?? 0, circuitUntil === null ? 0 : WEBHOOK_CIRCUIT_MS);
        const nextAttempt = new Date(Date.now() + delay).toISOString();
        this.sql.exec(
          "UPDATE webhook_deliveries SET status = 'retry', next_attempt = ?, response_status = ?, error = ? WHERE id = ?",
          nextAttempt, result.status, (result.error ?? 'delivery failed').slice(0, 300), deliveryId,
        );
      } else {
        const failedAt = new Date().toISOString();
        this.sql.exec(
          "UPDATE webhook_deliveries SET status = 'failed', next_attempt = ?, response_status = ?, error = ? WHERE id = ?",
          failedAt, result.status, (result.error ?? 'delivery failed').slice(0, 300), deliveryId,
        );
        this.pruneWebhookHistory(webhookId);
      }
      if (circuitUntil !== null) {
        openedCircuits.add(webhookId);
        this.sql.exec(
          "UPDATE webhook_deliveries SET status = 'retry', next_attempt = ? WHERE webhook_id = ? AND id <> ? AND status IN ('pending', 'retry', 'sending') AND next_attempt < ?",
          circuitUntil, webhookId, deliveryId, circuitUntil,
        );
      }
    }
  }

  createWebhook(input: Record<string, unknown>): ActionResult {
    try {
      const count = Number(this.sql.exec('SELECT COUNT(*) AS count FROM webhooks WHERE active = 1').toArray()[0]?.['count'] ?? 0);
      if (count >= MAX_WEBHOOKS) throw new UsageError(`a project may have at most ${MAX_WEBHOOKS} active webhooks`);
      const target = webhookTarget(input['url'], this.env.UNFURL_ALLOW_PRIVATE === 'on');
      if (!target.ok) throw new UsageError(`invalid webhook url: ${target.error}`);
      const allowEvents = cleanEventList(input['allowEvents'], 'allowEvents');
      const denyEvents = cleanEventList(input['denyEvents'], 'denyEvents');
      const id = randomIntegrationId('wh');
      const secret = randomSigningSecret();
      const name = cleanIntegrationName(input['name'], 'Webhook');
      const now = new Date().toISOString();
      this.sql.exec(
        'INSERT INTO webhooks(id, name, url, secret, allow_events, deny_events, active, failure_count, created, updated) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)',
        id, name, target.url, secret, JSON.stringify(allowEvents), JSON.stringify(denyEvents), now, now,
      );
      return { webhook: { id, name, url: target.url, allowEvents, denyEvents, active: true, failureCount: 0, circuitUntil: null, created: now, updated: now }, secret };
    } catch (error) {
      if (error instanceof UsageError) return { error: error.message };
      console.error('create webhook failed:', error);
      return { error: 'could not create webhook' };
    }
  }

  listWebhooks(): { webhooks: Record<string, unknown>[] } {
    const webhooks = this.sql.exec(
      'SELECT id, name, url, allow_events, deny_events, active, failure_count, circuit_until, created, updated FROM webhooks ORDER BY active DESC, created DESC',
    ).toArray().map((row) => ({
      id: String(row['id']),
      name: String(row['name']),
      url: String(row['url']),
      allowEvents: eventList(row['allow_events']),
      denyEvents: eventList(row['deny_events']),
      active: Number(row['active']) === 1,
      failureCount: Number(row['failure_count']),
      circuitUntil: typeof row['circuit_until'] === 'string' ? row['circuit_until'] : null,
      created: String(row['created']),
      updated: String(row['updated']),
    }));
    return { webhooks };
  }

  rotateWebhook(id: string): ActionResult {
    const row = this.sql.exec('SELECT id FROM webhooks WHERE id = ? AND active = 1', id).toArray()[0];
    if (row === undefined) return { error: 'webhook not found' };
    const secret = randomSigningSecret();
    const now = new Date().toISOString();
    this.sql.exec('UPDATE webhooks SET secret = ?, failure_count = 0, circuit_until = NULL, updated = ? WHERE id = ?', secret, now, id);
    return { id, secret, rotated: now };
  }

  revokeWebhook(id: string): ActionResult {
    const row = this.sql.exec('SELECT id FROM webhooks WHERE id = ? AND active = 1', id).toArray()[0];
    if (row === undefined) return { error: 'webhook not found' };
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('UPDATE webhooks SET active = 0, circuit_until = NULL, updated = ? WHERE id = ?', now, id);
      this.sql.exec(
        "UPDATE webhook_deliveries SET status = 'failed', next_attempt = ?, error = 'webhook revoked' WHERE webhook_id = ? AND status IN ('pending', 'retry', 'sending')",
        now, id,
      );
    });
    this.rescheduleAlarm();
    return { id, revoked: now };
  }

  listWebhookDeliveries(webhookId: string, requestedLimit: number, before: number | null): ActionResult {
    if (this.sql.exec('SELECT id FROM webhooks WHERE id = ?', webhookId).toArray()[0] === undefined) return { error: 'webhook not found' };
    const limit = Math.max(1, Math.min(100, Number.isInteger(requestedLimit) ? requestedLimit : 25));
    const rows = before !== null && Number.isInteger(before) && before > 0
      ? this.sql.exec(
          'SELECT seq, id, event_seq, event_action, payload, status, attempts, next_attempt, last_attempt, response_status, error, delivered, replay_of, created FROM webhook_deliveries WHERE webhook_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
          webhookId, before, limit + 1,
        ).toArray()
      : this.sql.exec(
          'SELECT seq, id, event_seq, event_action, payload, status, attempts, next_attempt, last_attempt, response_status, error, delivered, replay_of, created FROM webhook_deliveries WHERE webhook_id = ? ORDER BY seq DESC LIMIT ?',
          webhookId, limit + 1,
        ).toArray();
    const page = rows.slice(0, limit);
    return {
      deliveries: page.map((row) => ({
        sequence: Number(row['seq']),
        id: String(row['id']),
        eventSequence: Number(row['event_seq']),
        event: String(row['event_action']),
        payload: String(row['payload']),
        status: String(row['status']),
        attempts: Number(row['attempts']),
        nextAttempt: String(row['next_attempt']),
        lastAttempt: typeof row['last_attempt'] === 'string' ? row['last_attempt'] : null,
        responseStatus: typeof row['response_status'] === 'number' ? row['response_status'] : null,
        error: typeof row['error'] === 'string' ? row['error'] : null,
        delivered: typeof row['delivered'] === 'string' ? row['delivered'] : null,
        replayOf: typeof row['replay_of'] === 'string' ? row['replay_of'] : null,
        created: String(row['created']),
      })),
      next: rows.length > limit ? Number(page.at(-1)?.['seq']) : null,
    };
  }

  replayWebhookDelivery(webhookId: string, deliveryId: string): ActionResult {
    const hook = this.sql.exec('SELECT id FROM webhooks WHERE id = ? AND active = 1', webhookId).toArray()[0];
    if (hook === undefined) return { error: 'webhook not found' };
    const original = this.sql.exec(
      'SELECT event_seq, event_action, payload FROM webhook_deliveries WHERE webhook_id = ? AND id = ?', webhookId, deliveryId,
    ).toArray()[0];
    if (original === undefined) return { error: 'delivery not found' };
    const id = randomIntegrationId('whd');
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      // An operator replay is the circuit's single half-open probe. Other
      // deferred deliveries stay deferred until this one succeeds.
      this.sql.exec('UPDATE webhooks SET failure_count = 0, circuit_until = NULL, updated = ? WHERE id = ?', now, webhookId);
      this.sql.exec(
        'INSERT INTO webhook_deliveries(id, webhook_id, event_seq, event_action, payload, status, attempts, next_attempt, replay_of, created) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
        id, webhookId, Number(original['event_seq']), String(original['event_action']), String(original['payload']), 'pending', now, deliveryId, now,
      );
    });
    this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + 1));
    return { id, replayOf: deliveryId, queued: now };
  }

  async createEmailRoute(input: Record<string, unknown>, actor: string): Promise<ActionResult> {
    try {
      const count = Number(this.sql.exec('SELECT COUNT(*) AS count FROM email_routes WHERE active = 1').toArray()[0]?.['count'] ?? 0);
      if (count >= MAX_EMAIL_ROUTES) throw new UsageError(`a project may have at most ${MAX_EMAIL_ROUTES} active inbound email routes`);
      const kind = input['kind'];
      if (kind !== 'create' && kind !== 'comment') throw new UsageError('kind must be create or comment');
      const board = this.loadBoardDocs();
      const lane = typeof input['lane'] === 'string' && input['lane'].trim() !== '' ? input['lane'].trim() : null;
      const card = typeof input['card'] === 'string' && input['card'].trim() !== '' ? input['card'].trim() : null;
      if (kind === 'create' && card !== null) throw new UsageError('create routes cannot name a card');
      if (kind === 'comment' && lane !== null) throw new UsageError('comment routes cannot name a lane');
      if (kind === 'comment' && (card === null || !board.cards.some((candidate) => candidate.id === card))) {
        throw new UsageError('comment routes require an existing card');
      }
      if (kind === 'create' && lane !== null) {
        const valid = board.config.lanes.some((candidate) => candidate.id === lane || candidate.substates.some((substate) => `${candidate.id}.${substate}` === lane));
        if (!valid) throw new UsageError(`no lane or substate "${lane}"`);
      }
      const id = randomIntegrationId('emr');
      const token = randomEmailToken();
      const hash = await emailTokenHash(token);
      const name = cleanIntegrationName(input['name'], kind === 'create' ? 'Email to board' : `Email to card ${card}`);
      const now = new Date().toISOString();
      this.sql.exec(
        'INSERT INTO email_routes(id, name, token_hash, kind, lane_id, card_id, actor, active, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)',
        id, name, hash, kind, lane, card, actor, now, now,
      );
      return { route: { id, name, kind, lane, card, actor, active: true, created: now, updated: now }, token };
    } catch (error) {
      if (error instanceof UsageError) return { error: error.message };
      console.error('create email route failed:', error);
      return { error: 'could not create email route' };
    }
  }

  listEmailRoutes(): { routes: Record<string, unknown>[] } {
    return {
      routes: this.sql.exec(
        'SELECT id, name, kind, lane_id, card_id, actor, active, created, updated FROM email_routes ORDER BY active DESC, created DESC',
      ).toArray().map((row) => ({
        id: String(row['id']), name: String(row['name']), kind: String(row['kind']),
        lane: typeof row['lane_id'] === 'string' ? row['lane_id'] : null,
        card: typeof row['card_id'] === 'string' ? row['card_id'] : null,
        actor: String(row['actor']), active: Number(row['active']) === 1,
        created: String(row['created']), updated: String(row['updated']),
      })),
    };
  }

  revokeEmailRoute(id: string): ActionResult {
    if (this.sql.exec('SELECT id FROM email_routes WHERE id = ? AND active = 1', id).toArray()[0] === undefined) return { error: 'email route not found' };
    const now = new Date().toISOString();
    this.sql.exec('UPDATE email_routes SET active = 0, updated = ? WHERE id = ?', now, id);
    return { id, revoked: now };
  }

  async processInboundEmail(token: string, input: unknown): Promise<ActionResult> {
    try {
      const mail = normalizeInboundEmail(input);
      const hash = await emailTokenHash(token);
      const route = this.sql.exec(
        'SELECT id, kind, lane_id, card_id, actor FROM email_routes WHERE token_hash = ? AND active = 1', hash,
      ).toArray()[0];
      if (route === undefined) return { error: 'email route not found' };
      const routeId = String(route['id']);
      this.sql.exec(
        'DELETE FROM email_inbound_messages WHERE route_id = ? AND received < ?',
        routeId, new Date(Date.now() - EMAIL_DEDUPE_RETENTION_MS).toISOString(),
      );
      const prior = this.sql.exec(
        'SELECT outcome FROM email_inbound_messages WHERE route_id = ? AND message_id = ?', routeId, mail.messageId,
      ).toArray()[0];
      if (typeof prior?.['outcome'] === 'string') {
        return { ...(JSON.parse(prior['outcome']) as Record<string, unknown>), duplicate: true };
      }
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const recent = Number(this.sql.exec(
        'SELECT COUNT(*) AS count FROM email_inbound_messages WHERE route_id = ? AND received >= ?', routeId, since,
      ).toArray()[0]?.['count'] ?? 0);
      if (recent >= EMAIL_INBOUND_HOURLY_CAP) return { error: 'inbound email rate limit exceeded', retryAfter: 3600 };

      const board = this.loadBoardDocs();
      if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
      const emailActor = `email-${String(route['actor'])}`;
      let outcome: Record<string, unknown> = {};
      this.ctx.storage.transactionSync(() => {
        // The provider may retry while a prior request is completing. The DO
        // is single-writer, but the second check keeps the transaction itself
        // the source of truth for exactly-once mutation.
        const duplicate = this.sql.exec(
          'SELECT outcome FROM email_inbound_messages WHERE route_id = ? AND message_id = ?', routeId, mail.messageId,
        ).toArray()[0];
        if (typeof duplicate?.['outcome'] === 'string') {
          outcome = { ...(JSON.parse(duplicate['outcome']) as Record<string, unknown>), duplicate: true };
          return;
        }
        if (route['kind'] === 'create') {
          const title = (mail.subject || (mail.from ? `Email from ${mail.from}` : 'Untitled email')).slice(0, EMAIL_MAX_SUBJECT);
          const description = [mail.from ? `From: ${mail.from}` : '', mail.text].filter(Boolean).join('\n\n');
          const card = opAdd(board, {
            title,
            lane: typeof route['lane_id'] === 'string' ? route['lane_id'] : undefined,
            body: description === '' ? '' : `## Description\n\n${sanitizeBlock(description)}`,
            actor: emailActor,
          });
          this.persistCard(card);
          this.event(emailActor, 'add', card.id, `inbound email ${mail.messageId}${mail.from ? ` from ${mail.from}` : ''}`.slice(0, 300));
          outcome = { accepted: true, duplicate: false, kind: 'create', cardId: card.id };
        } else {
          const cardId = String(route['card_id']);
          const card = getCard(board, cardId);
          const comment = [mail.from ? `From ${mail.from}` : '', mail.subject, mail.text].filter(Boolean).join(' — ').slice(0, MAX_LINE_TEXT);
          opComment(card, emailActor, comment);
          this.persistCard(card);
          this.event(emailActor, 'comment', card.id, `inbound email ${mail.messageId}${mail.from ? ` from ${mail.from}` : ''}`.slice(0, 300));
          outcome = { accepted: true, duplicate: false, kind: 'comment', cardId: card.id };
        }
        this.sql.exec(
          'INSERT INTO email_inbound_messages(route_id, message_id, outcome, received) VALUES (?, ?, ?, ?)',
          routeId, mail.messageId, JSON.stringify(outcome), new Date().toISOString(),
        );
      });
      this.rescheduleAlarm();
      return outcome;
    } catch (error) {
      console.error('process inbound email failed:', error);
      return { error: 'could not process inbound email' };
    }
  }

  createEmailSubscription(input: Record<string, unknown>): ActionResult {
    try {
      const count = Number(this.sql.exec('SELECT COUNT(*) AS count FROM email_subscriptions WHERE active = 1').toArray()[0]?.['count'] ?? 0);
      if (count >= MAX_EMAIL_SUBSCRIPTIONS) throw new UsageError(`a project may have at most ${MAX_EMAIL_SUBSCRIPTIONS} active email subscriptions`);
      const recipients = cleanRecipients(input['recipients']);
      const allowEvents = cleanEventList(input['allowEvents'], 'allowEvents');
      const denyEvents = cleanEventList(input['denyEvents'], 'denyEvents');
      const id = randomIntegrationId('ems');
      const name = cleanIntegrationName(input['name'], 'Email notifications');
      const now = new Date().toISOString();
      this.sql.exec(
        'INSERT INTO email_subscriptions(id, name, recipients, allow_events, deny_events, active, created, updated) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
        id, name, JSON.stringify(recipients), JSON.stringify(allowEvents), JSON.stringify(denyEvents), now, now,
      );
      return { subscription: { id, name, recipients, allowEvents, denyEvents, active: true, created: now, updated: now } };
    } catch (error) {
      if (error instanceof UsageError) return { error: error.message };
      console.error('create email subscription failed:', error);
      return { error: 'could not create email subscription' };
    }
  }

  listEmailSubscriptions(): { subscriptions: Record<string, unknown>[] } {
    return {
      subscriptions: this.sql.exec(
        'SELECT id, name, recipients, allow_events, deny_events, active, created, updated FROM email_subscriptions ORDER BY active DESC, created DESC',
      ).toArray().map((row) => ({
        id: String(row['id']), name: String(row['name']), recipients: eventList(row['recipients']),
        allowEvents: eventList(row['allow_events']), denyEvents: eventList(row['deny_events']),
        active: Number(row['active']) === 1, created: String(row['created']), updated: String(row['updated']),
      })),
    };
  }

  revokeEmailSubscription(id: string): ActionResult {
    if (this.sql.exec('SELECT id FROM email_subscriptions WHERE id = ? AND active = 1', id).toArray()[0] === undefined) return { error: 'email subscription not found' };
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('UPDATE email_subscriptions SET active = 0, updated = ? WHERE id = ?', now, id);
      this.sql.exec(
        "UPDATE email_outbox SET status = 'failed', next_attempt = ?, lease_token = NULL, lease_until = NULL, error = 'subscription revoked' WHERE subscription_id = ? AND status IN ('queued', 'retry', 'sending')",
        now, id,
      );
      this.pruneEmailHistory(id);
    });
    return { id, revoked: now };
  }

  claimEmailOutbox(requestedLimit: number, bridgeActor: string): { messages: Record<string, unknown>[] } {
    const limit = Math.max(1, Math.min(EMAIL_OUTBOX_CLAIM_MAX, Number.isInteger(requestedLimit) ? requestedLimit : 10));
    const now = new Date().toISOString();
    this.sql.exec(
      "UPDATE email_outbox SET status = 'failed', next_attempt = ?, lease_token = NULL, lease_until = NULL, error = 'retry budget exhausted' WHERE attempts >= ? AND ((status = 'sending' AND lease_until IS NOT NULL AND lease_until <= ?) OR status IN ('queued', 'retry'))",
      now, EMAIL_MAX_ATTEMPTS, now,
    );
    const rows = this.sql.exec(
      `SELECT id, payload, attempts
         FROM email_outbox
        WHERE attempts < ?
          AND ((status IN ('queued', 'retry') AND next_attempt <= ?)
           OR (status = 'sending' AND lease_until IS NOT NULL AND lease_until <= ?))
        ORDER BY next_attempt, seq
        LIMIT ?`,
      EMAIL_MAX_ATTEMPTS, now, now, limit,
    ).toArray();
    const messages: Record<string, unknown>[] = [];
    for (const row of rows) {
      const id = String(row['id']);
      const leaseToken = randomIntegrationId('lease');
      const leaseUntil = new Date(Date.now() + EMAIL_LEASE_MS).toISOString();
      const attempt = Number(row['attempts']) + 1;
      this.sql.exec(
        "UPDATE email_outbox SET status = 'sending', attempts = ?, lease_token = ?, lease_until = ?, leased_by = ?, error = NULL WHERE id = ?",
        attempt, leaseToken, leaseUntil, bridgeActor, id,
      );
      messages.push({ id, leaseToken, leaseUntil, attempt, payload: JSON.parse(String(row['payload'])) as unknown });
    }
    return { messages };
  }

  acknowledgeEmailOutbox(id: string, input: Record<string, unknown>): ActionResult {
    const leaseToken = typeof input['leaseToken'] === 'string' ? input['leaseToken'] : '';
    const outcome = input['status'];
    if (leaseToken === '' || (outcome !== 'sent' && outcome !== 'retry' && outcome !== 'failed')) {
      return { error: 'leaseToken and status (sent, retry, or failed) are required' };
    }
    const row = this.sql.exec(
      "SELECT attempts, subscription_id FROM email_outbox WHERE id = ? AND status = 'sending' AND lease_token = ?", id, leaseToken,
    ).toArray()[0];
    if (row === undefined) return { error: 'email lease not found or no longer current', conflict: true };
    const now = new Date().toISOString();
    const error = typeof input['error'] === 'string' ? input['error'].slice(0, 300) : null;
    if (outcome === 'sent') {
      this.sql.exec(
        "UPDATE email_outbox SET status = 'sent', next_attempt = ?, lease_token = NULL, lease_until = NULL, error = NULL, sent = ? WHERE id = ?",
        now, now, id,
      );
      this.pruneEmailHistory(String(row['subscription_id']));
      return { id, status: 'sent', sent: now };
    }
    const attempts = Number(row['attempts']);
    if (outcome === 'failed' || attempts >= EMAIL_MAX_ATTEMPTS) {
      this.sql.exec(
        "UPDATE email_outbox SET status = 'failed', next_attempt = ?, lease_token = NULL, lease_until = NULL, error = ? WHERE id = ?",
        now, error ?? (attempts >= EMAIL_MAX_ATTEMPTS ? 'retry budget exhausted' : 'bridge reported permanent failure'), id,
      );
      this.pruneEmailHistory(String(row['subscription_id']));
      return { id, status: 'failed' };
    }
    const requested = typeof input['retryAfterSeconds'] === 'number' && Number.isFinite(input['retryAfterSeconds'])
      ? Math.max(1, Math.min(86_400, Math.round(input['retryAfterSeconds']))) * 1000
      : 0;
    const backoff = EMAIL_BACKOFF_MS[Math.min(attempts - 1, EMAIL_BACKOFF_MS.length - 1)]!;
    const next = new Date(Date.now() + Math.max(requested, backoff)).toISOString();
    this.sql.exec(
      "UPDATE email_outbox SET status = 'retry', next_attempt = ?, lease_token = NULL, lease_until = NULL, error = ? WHERE id = ?",
      next, error ?? 'bridge requested retry', id,
    );
    return { id, status: 'retry', nextAttempt: next };
  }

  listEmailOutbox(requestedLimit: number, before: number | null, subscriptionId: string | null): ActionResult {
    const limit = Math.max(1, Math.min(100, Number.isInteger(requestedLimit) ? requestedLimit : 25));
    let rows;
    if (subscriptionId !== null && before !== null) {
      rows = this.sql.exec(
        'SELECT seq, id, subscription_id, event_seq, event_action, status, attempts, next_attempt, lease_until, leased_by, error, sent, created FROM email_outbox WHERE subscription_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
        subscriptionId, before, limit + 1,
      ).toArray();
    } else if (subscriptionId !== null) {
      rows = this.sql.exec(
        'SELECT seq, id, subscription_id, event_seq, event_action, status, attempts, next_attempt, lease_until, leased_by, error, sent, created FROM email_outbox WHERE subscription_id = ? ORDER BY seq DESC LIMIT ?',
        subscriptionId, limit + 1,
      ).toArray();
    } else if (before !== null) {
      rows = this.sql.exec(
        'SELECT seq, id, subscription_id, event_seq, event_action, status, attempts, next_attempt, lease_until, leased_by, error, sent, created FROM email_outbox WHERE seq < ? ORDER BY seq DESC LIMIT ?',
        before, limit + 1,
      ).toArray();
    } else {
      rows = this.sql.exec(
        'SELECT seq, id, subscription_id, event_seq, event_action, status, attempts, next_attempt, lease_until, leased_by, error, sent, created FROM email_outbox ORDER BY seq DESC LIMIT ?',
        limit + 1,
      ).toArray();
    }
    const page = rows.slice(0, limit);
    return {
      messages: page.map((row) => ({
        sequence: Number(row['seq']), id: String(row['id']), subscriptionId: String(row['subscription_id']),
        eventSequence: Number(row['event_seq']), event: String(row['event_action']), status: String(row['status']),
        attempts: Number(row['attempts']), nextAttempt: String(row['next_attempt']),
        leaseUntil: typeof row['lease_until'] === 'string' ? row['lease_until'] : null,
        leasedBy: typeof row['leased_by'] === 'string' ? row['leased_by'] : null,
        error: typeof row['error'] === 'string' ? row['error'] : null,
        sent: typeof row['sent'] === 'string' ? row['sent'] : null, created: String(row['created']),
      })),
      next: rows.length > limit ? Number(page.at(-1)?.['seq']) : null,
    };
  }

  /** Restore-grade configuration only. Delivery/audit state is deliberately
   * excluded because company import remaps project ids; an old frozen event
   * body must never be delivered as though it belonged to the new project. */
  exportIntegrations(): IntegrationSnapshot {
    const webhooks = this.sql.exec(
      'SELECT id, name, url, secret, allow_events, deny_events, active, created, updated FROM webhooks WHERE active = 1 ORDER BY created',
    ).toArray().map((row) => ({
      id: String(row['id']), name: String(row['name']), url: String(row['url']), secret: String(row['secret']),
      allowEvents: eventList(row['allow_events']), denyEvents: eventList(row['deny_events']), active: Number(row['active']) === 1,
      created: String(row['created']), updated: String(row['updated']),
    }));
    const emailRoutes = this.sql.exec(
      'SELECT id, name, token_hash, kind, lane_id, card_id, actor, active, created, updated FROM email_routes WHERE active = 1 ORDER BY created',
    ).toArray().map((row) => ({
      id: String(row['id']), name: String(row['name']), tokenHash: String(row['token_hash']),
      kind: row['kind'] === 'comment' ? 'comment' as const : 'create' as const,
      lane: typeof row['lane_id'] === 'string' ? row['lane_id'] : null,
      card: typeof row['card_id'] === 'string' ? row['card_id'] : null,
      actor: String(row['actor']), active: Number(row['active']) === 1,
      created: String(row['created']), updated: String(row['updated']),
    }));
    const emailSubscriptions = this.sql.exec(
      'SELECT id, name, recipients, allow_events, deny_events, active, created, updated FROM email_subscriptions WHERE active = 1 ORDER BY created',
    ).toArray().map((row) => ({
      id: String(row['id']), name: String(row['name']), recipients: eventList(row['recipients']),
      allowEvents: eventList(row['allow_events']), denyEvents: eventList(row['deny_events']), active: Number(row['active']) === 1,
      created: String(row['created']), updated: String(row['updated']),
    }));
    return { schema: 'botflow.integrations.v1', webhooks, emailRoutes, emailSubscriptions };
  }

  restoreIntegrations(input: unknown): ActionResult {
    const parsed = readIntegrationSnapshot(input, this.env.UNFURL_ALLOW_PRIVATE === 'on');
    if (!parsed.ok) return { error: parsed.error };
    const board = this.loadBoardDocs();
    for (const route of parsed.value.emailRoutes) {
      if (route.kind === 'comment' && !board.cards.some((card) => card.id === route.card)) {
        return { error: `email route ${route.id} names missing card ${route.card}` };
      }
      if (route.kind === 'create' && route.lane !== null) {
        const valid = board.config.lanes.some((lane) => lane.id === route.lane || lane.substates.some((substate) => `${lane.id}.${substate}` === route.lane));
        if (!valid) return { error: `email route ${route.id} names missing lane or substate ${route.lane}` };
      }
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM webhook_deliveries');
      this.sql.exec('DELETE FROM webhooks');
      this.sql.exec('DELETE FROM email_inbound_messages');
      this.sql.exec('DELETE FROM email_outbox');
      this.sql.exec('DELETE FROM email_routes');
      this.sql.exec('DELETE FROM email_subscriptions');
      for (const hook of parsed.value.webhooks) {
        this.sql.exec(
          'INSERT INTO webhooks(id, name, url, secret, allow_events, deny_events, active, failure_count, circuit_until, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)',
          hook.id, hook.name, hook.url, hook.secret, JSON.stringify(hook.allowEvents), JSON.stringify(hook.denyEvents), hook.active ? 1 : 0, hook.created, hook.updated,
        );
      }
      for (const route of parsed.value.emailRoutes) {
        this.sql.exec(
          'INSERT INTO email_routes(id, name, token_hash, kind, lane_id, card_id, actor, active, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          route.id, route.name, route.tokenHash, route.kind, route.lane, route.card, route.actor, route.active ? 1 : 0, route.created, route.updated,
        );
      }
      for (const subscription of parsed.value.emailSubscriptions) {
        this.sql.exec(
          'INSERT INTO email_subscriptions(id, name, recipients, allow_events, deny_events, active, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          subscription.id, subscription.name, JSON.stringify(subscription.recipients), JSON.stringify(subscription.allowEvents), JSON.stringify(subscription.denyEvents), subscription.active ? 1 : 0, subscription.created, subscription.updated,
        );
      }
    });
    this.rescheduleAlarm();
    return {
      webhooks: parsed.value.webhooks.length,
      emailRoutes: parsed.value.emailRoutes.length,
      emailSubscriptions: parsed.value.emailSubscriptions.length,
      operationalStateReset: true,
    };
  }

  private runAutomationPass(nowValue: number | Date = Date.now()): ReturnType<typeof opAutomationPass> {
    const board = this.loadBoardDocs();
    if (board.config.mutationBlocked !== null) return { cards: [], actions: [], remaining: false, nextAt: null };
    const result = opAutomationPass(board, nowValue);
    if (result.cards.length > 0) {
      const byId = new Map(result.cards.map((card) => [card.id, card]));
      this.ctx.storage.transactionSync(() => {
        for (const card of result.cards) this.persistCard(card);
        for (const action of result.actions) {
          const card = byId.get(action.cardId);
          if (card === undefined) continue;
          const detail = action.kind === 'reminder' ? `${action.offset}m before ${card.due}`
            : action.kind === 'sweep' ? `auto-archived after ${board.config.automation.archiveDoneAfter} days`
              : 'snooze expired';
          this.event('botflow', action.kind, action.cardId, detail);
        }
      });
    }
    this.rescheduleAlarm({ ...board, cards: board.cards.map((card) => result.cards.find((changed) => changed.id === card.id) ?? card) });
    return result;
  }

  async alarm(): Promise<void> {
    const failures: unknown[] = [];
    try {
      this.runAutomationPass();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.deliverDueWebhooks();
    } catch (error) {
      failures.push(error);
    } finally {
      if (failures.length === 0) this.sql.exec('DELETE FROM meta WHERE key = ?', ALARM_BACKOFF_KEY);
      else this.deferAlarmAfterFailure(failures[0]);
      this.rescheduleAlarm();
    }
  }

  /** Resolve project-card children by asking sibling DOs. Cycle-safe, and
   *  scope-enforcing: a board may only roll up projects nested beneath it in
   *  the registry, so a smuggled `project:` ref cannot leak an unrelated
   *  project's distribution. */
  private async resolveChildren(board: LoadedBoard, visited: string[]): Promise<Map<string, ExternalChild | null>> {
    const children = new Map<string, ExternalChild | null>();
    const chain = [...visited, this.selfId()];
    const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName('main'));
    await Promise.all(
      board.cards
        .filter((c) => c.type === 'board')
        .map(async (card) => {
          const ref = card.boardPath ?? '';
          if (!ref.startsWith(PROJECT_REF)) {
            children.set(card.id, null);
            return;
          }
          const pid = ref.slice(PROJECT_REF.length);
          if (chain.includes(pid) || !(await registry.isWithin(pid, this.selfId()))) {
            children.set(card.id, null); // cycle or out-of-scope → lane fallback
            return;
          }
          const stub = this.env.PROJECT.get(this.env.PROJECT.idFromName(pid));
          children.set(card.id, await stub.rollupInfo(chain));
        }),
    );
    return children;
  }

  /** Resolve hosted dependency/relation refs without exposing arbitrary
   * projects through a board visible to a narrower identity. State-bearing
   * refs may point only down the hierarchy. An inverse relation written on a
   * descendant may retain its ancestor as an opaque endpoint, but we
   * deliberately do not ask that ancestor whether the card exists. */
  private async resolveReferences(board: LoadedBoard, visited: string[]): Promise<Map<string, ExternalReference | null>> {
    const references = new Map<string, ExternalReference | null>();
    const chain = [...visited, this.selfId()];
    const wanted = new Map<string, { dependency: boolean; relation: boolean }>();
    for (const card of board.cards) {
      for (const dep of card.deps) {
        if (!dep.startsWith(PROJECT_REF)) continue;
        const use = wanted.get(dep) ?? { dependency: false, relation: false };
        use.dependency = true;
        wanted.set(dep, use);
      }
      for (const relation of card.relations) {
        if (!relation.target.startsWith(PROJECT_REF)) continue;
        const use = wanted.get(relation.target) ?? { dependency: false, relation: false };
        use.relation = true;
        wanted.set(relation.target, use);
      }
    }
    const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName('main'));
    await Promise.all([...wanted].map(async ([value, use]) => {
      const parsed = parseCardReference(value);
      const boardRef = parsed?.boardRef ?? '';
      const pid = boardRef.startsWith(PROJECT_REF) ? boardRef.slice(PROJECT_REF.length) : '';
      if (parsed === null || pid === '' || pid === this.selfId()) {
        references.set(value, null);
        return;
      }
      if (await registry.isWithin(pid, this.selfId())) {
        const stub = this.env.PROJECT.get(this.env.PROJECT.idFromName(pid));
        references.set(value, await stub.referenceState(parsed.cardId, chain));
        return;
      }
      // A relation-only ancestor ref is displayable but never resolved. If
      // the same ref is also a dependency it remains state-bearing and fails
      // closed, regardless of relation type.
      if (!use.dependency && use.relation && await registry.isWithin(this.selfId(), pid)) {
        references.set(value, { state: null });
      } else {
        references.set(value, null);
      }
    }));
    return references;
  }

  private async hostedReferenceError(uses: HostedReferenceUse[]): Promise<string | null> {
    const parsedUses = uses.flatMap((use) => {
      const projectId = use.kind === 'board'
        ? (use.target.startsWith(PROJECT_REF) ? use.target.slice(PROJECT_REF.length) : null)
        : (() => {
            const parsed = parseCardReference(use.target);
            return parsed?.boardRef?.startsWith(PROJECT_REF) ? parsed.boardRef.slice(PROJECT_REF.length) : null;
          })();
      return projectId === null ? [] : [{ ...use, projectId }];
    });
    const projectIds = [...new Set(parsedUses.map((use) => use.projectId))];
    const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName('main'));
    const direction = new Map<string, { descendant: boolean; ancestor: boolean }>();
    await Promise.all(projectIds.map(async (projectId) => {
      const [descendant, ancestor] = await Promise.all([
        registry.isWithin(projectId, this.selfId()),
        registry.isWithin(this.selfId(), projectId),
      ]);
      direction.set(projectId, { descendant: descendant && projectId !== this.selfId(), ancestor: ancestor && projectId !== this.selfId() });
    }));
    for (const use of parsedUses) {
      const related = direction.get(use.projectId) ?? { descendant: false, ancestor: false };
      const allowed = use.kind === 'relation' && use.copiedFrom
        ? related.descendant || related.ancestor
        : related.descendant;
      if (!allowed) {
        const label = use.kind === 'board' ? 'project card' : use.kind;
        return `card ${use.cardId}: ${label} project reference is outside this project's descendant scope`;
      }
    }
    return null;
  }

  /** Friendly preflight for API add/edit calls. Snapshot import deliberately
   * preserves hand-authored invalid refs so they can be rendered inertly and
   * repaired without data loss. */
  async validateReferenceChanges(input: { cardId?: string; deps?: string[] }): Promise<{ ok: true } | { error: string }> {
    const uses = (input.deps ?? []).map((target) => ({
      cardId: input.cardId ?? 'new', target, kind: 'dependency' as const, copiedFrom: false,
    }));
    const error = await this.hostedReferenceError(uses);
    return error === null ? { ok: true } : { error };
  }

  private async analyzed(visited: string[] = []): Promise<{
    board: LoadedBoard;
    ba: BoardAnalysis;
    node: BoardNode;
    children: Map<string, ExternalChild | null>;
  }> {
    const board = this.loadBoardDocs();
    const [children, references] = await Promise.all([this.resolveChildren(board, visited), this.resolveReferences(board, visited)]);
    const ba = analyzeSingle(board, children, references);
    const childKeyByCard = new Map<string, string | null>();
    for (const card of board.cards) {
      if (card.type === 'board') {
        const ref = card.boardPath ?? '';
        childKeyByCard.set(card.id, ref.startsWith(PROJECT_REF) ? ref.slice(PROJECT_REF.length) : null);
      }
    }
    return { board, ba, node: { key: '.', board, childKeyByCard }, children };
  }

  // ---- RPC surface ----

  ensureInit(name: string): { initialized: boolean } {
    if (this.configText() === null) {
      this.sql.exec("INSERT INTO meta(key, value) VALUES ('config', ?)", defaultBoardYaml(name));
      this.event('system', 'init', null, `project "${name}" created`);
      return { initialized: true };
    }
    return { initialized: false };
  }

  /** Distribution + progress for a parent's rollup; null when `visited`
   *  already contains this project (cycle). */
  async rollupInfo(visited: string[]): Promise<ExternalChild | null> {
    if (visited.includes(this.selfId())) return null;
    const { ba } = await this.analyzed(visited);
    return { distribution: ba.distribution, progress: ba.progress };
  }

  /** Canonical state only: cross-board dependency resolution does not need
   * card content, and omitting refs here prevents dependency cycles from
   * recursively calling one another just to learn lane state. */
  async referenceState(id: string, visited: string[] = []): Promise<ExternalReference | null> {
    const board = this.loadBoardDocs();
    const children = await this.resolveChildren(board, visited);
    const ba = analyzeSingle(board, children);
    return ba.canonical.has(id) ? { state: ba.canonical.get(id)! } : null;
  }

  transferSource(id: string): { card: Card; canonical: Canonical } | { error: string } {
    const board = this.loadBoardDocs();
    if (board.config.mutationBlocked !== null) return { error: `board is read-only: ${board.config.mutationBlocked}` };
    const card = board.cards.find((candidate) => candidate.id === id);
    if (card === undefined) return { error: `no card "${id}"` };
    const lane = board.config.lanes.find((candidate) => candidate.id === card.laneId);
    return { card, canonical: lane?.canonical ?? 'todo' };
  }

  /** Source preflight before a remote target half is touched. Cards are not
   * ordinarily deleted, so a successful check plus target-first idempotent
   * writes gives a retryable cross-DO relation operation. */
  relationSource(id: string): { ok: true } | { error: string } {
    const board = this.loadBoardDocs();
    if (board.config.mutationBlocked !== null) return { error: `board is read-only: ${board.config.mutationBlocked}` };
    return board.cards.some((card) => card.id === id) ? { ok: true } : { error: `no card "${id}"` };
  }

  /** Target half of a cross-project relation. It is deliberately independent
   * of the source DO so a timeout after commit can be replayed safely. */
  receiveRelation(
    sourceProject: string,
    sourceId: string,
    targetId: string,
    type: Card['relations'][number]['type'],
    actor: string,
    unlink: boolean,
  ): ActionResult {
    try {
      if (!(RELATION_TYPES as readonly string[]).includes(type)) throw new UsageError(`unknown relation type "${type}"`);
      const board = this.loadBoardDocs();
      if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
      const target = getCard(board, targetId);
      const inverse = relationInverse(type);
      const sourceRef = `project:${sourceProject}#${sourceId}`;
      const changed = unlink
        ? opUnlinkHalf(target, inverse, sourceRef, actor)
        : opLinkHalf(target, inverse, sourceRef, actor);
      if (changed) {
        this.persistCard(target);
        this.event(actor, unlink ? 'unlink' : 'link', targetId, `${inverse} ${sourceRef}`);
      }
      return { id: targetId, changed };
    } catch (err) {
      if (err instanceof UsageError) return { error: err.message };
      throw err;
    }
  }

  /** Source half, called only after receiveRelation committed or confirmed
   * its target half. */
  completeRelation(
    id: string,
    targetProject: string,
    targetId: string,
    type: Card['relations'][number]['type'],
    actor: string,
    unlink: boolean,
  ): ActionResult {
    try {
      const board = this.loadBoardDocs();
      if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
      const source = getCard(board, id);
      const targetRef = `project:${targetProject}#${targetId}`;
      const changed = unlink
        ? opUnlinkHalf(source, type, targetRef, actor)
        : opLinkHalf(source, type, targetRef, actor);
      if (changed) {
        this.persistCard(source);
        this.event(actor, unlink ? 'unlink' : 'link', id, `${type} ${targetRef}`);
      }
      return { id, target: targetId, changed };
    } catch (err) {
      if (err instanceof UsageError) return { error: err.message };
      throw err;
    }
  }

  /** Idempotent target half of a cross-DO transfer. */
  receiveTransfer(
    sourceProject: string,
    payload: { card: Card; canonical: Canonical },
    actor: string,
    lane: string | null,
    move: boolean,
  ): ActionResult {
    try {
      const board = this.loadBoardDocs();
      if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
      const sourceRef = `project:${sourceProject}#${payload.card.id}`;
      const existing = board.cards.find((card) => card.relations.some((relation) => relation.type === 'copied-from' && relation.target === sourceRef));
      if (existing !== undefined) {
        // A retry can be the first request to reach an instance after the
        // target write committed but before its alarm did. Re-establish the
        // destination schedule even when the transfer half is already there.
        this.rescheduleAlarm();
        return { id: existing.id, reused: true };
      }
      const sourceLane: Lane = {
        id: payload.card.laneId,
        name: payload.card.laneId,
        canonical: payload.canonical,
        substates: payload.card.substate === null ? [] : [payload.card.substate],
        order: 'free',
        wip: null,
        wipMode: 'allow',
        extra: {},
      };
      const synthetic: LoadedBoard = {
        ...board,
        rootAbs: `project:${sourceProject}`,
        cards: [payload.card],
        config: { ...board.config, lanes: [sourceLane, ...(sourceLane.canonical === 'archive' ? [] : [{ ...sourceLane, id: 'transfer-archive', name: 'archive', canonical: 'archive' as const, substates: [] }])] },
      };
      const result = opTransferCard(synthetic, board, payload.card, actor, {
        sourceRef,
        targetRef: (targetId) => `project:${this.selfId()}#${targetId}`,
        rewriteReference: (reference) => reference.includes('#') ? reference : `project:${sourceProject}#${reference}`,
        rewriteBoardPath: (boardPath) => boardPath,
        lane: lane ?? undefined,
        move,
      });
      this.persistCard(result.target);
      this.event(actor, move ? 'receive-move' : 'receive-copy', result.target.id, `from ${sourceRef}`);
      this.rescheduleAlarm();
      return { id: result.target.id, reused: false };
    } catch (err) {
      if (err instanceof UsageError) return { error: err.message };
      throw err;
    }
  }

  /** Idempotent source half. Called only after receiveTransfer succeeded. */
  completeTransfer(id: string, targetProject: string, targetId: string, move: boolean, actor: string): ActionResult {
    try {
      const board = this.loadBoardDocs();
      if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
      const card = getCard(board, id);
      const targetRef = `project:${targetProject}#${targetId}`;
      let changed = false;
      let relationAdded = false;
      if (!card.relations.some((relation) => relation.type === 'copied-to' && relation.target === targetRef)) {
        card.relations.push({ type: 'copied-to', target: targetRef, extra: {} });
        changed = true;
        relationAdded = true;
      }
      if (move) {
        const archive = board.config.lanes.find((lane) => lane.canonical === 'archive');
        if (archive === undefined) throw new UsageError('source board has no archive-canonical lane');
        const moved = opMove(board, card, archive.id, actor, true);
        changed ||= moved.from !== moved.to;
        if (relationAdded && moved.from === moved.to) logMutation(card, actor, `moved to ${targetRef}`);
      }
      if (changed) {
        if (!move) logMutation(card, actor, `copied to ${targetRef}`);
        this.persistCard(card);
        this.event(actor, move ? 'complete-move' : 'complete-copy', id, `to ${targetRef}`);
      }
      this.rescheduleAlarm();
      return { id, target: targetId, changed };
    } catch (err) {
      if (err instanceof UsageError) return { error: err.message };
      throw err;
    }
  }

  /** Compact state for org-tree aggregation. The task* fields exclude
   *  project-ref cards entirely: in tree sums those children are counted by
   *  their own summaries, so including their rolled-up card here would count
   *  the same work twice. */
  async summary(): Promise<Record<string, unknown>> {
    const { board, ba } = await this.analyzed();
    const taskDistribution = { wishlist: 0, todo: 0, doing: 0, blocked: 0, done: 0, archive: 0 } as Record<string, number>;
    let taskUnits = 0;
    let taskDoneWeight = 0;
    for (const card of board.cards) {
      if (card.type === 'board' && (card.boardPath ?? '').startsWith(PROJECT_REF)) continue;
      const state = ba.canonical.get(card.id)!;
      taskDistribution[state]!++;
      if (state === 'archive') continue;
      taskUnits++;
      if (state === 'done') taskDoneWeight++;
    }
    return {
      name: board.config.name,
      cards: board.cards.length,
      distribution: ba.distribution,
      progress: ba.progress,
      taskDistribution,
      taskUnits,
      taskDoneWeight,
      errors: [...board.findings, ...ba.findings].filter((f) => f.severity === 'error').length,
    };
  }

  /** Build the full viewer shape without running mutable automation. */
  private async boardProjection(includeFlow = true): Promise<Record<string, unknown>> {
    const { ba, node, children } = await this.analyzed();
    const tree = { rootAbs: '.', boards: new Map([['.', node]]) };
    const analysis = { boards: new Map([['.', ba]]) };
    // Board polling needs card-face summaries, not every raw body and parsed
    // history. Modal detail and its paginated history are separate reads.
    const json = boardJson(tree, analysis, '.', Date.now(), { includeFlow }) as Record<string, unknown>;
    const previewCache = this.unfurlImages();
    const sourceById = new Map(node.board.cards.map((card) => [card.id, card]));
    const lanes = json['lanes'] as { cards: Record<string, unknown>[] }[];
    json['lanes'] = lanes.map((lane) => ({
      ...lane,
      cards: lane.cards.map((card) => this.withPreviews(
        { ...card, childProgress: children.get(String(card['id']))?.progress ?? null },
        previewCache,
        sourceById.get(String(card['id'])),
      )),
    }));
    return json;
  }

  /** Authenticated board reads are one of the hosted lazy-automation
   * boundaries. A broken hand-authored board must remain inspectable: defer
   * the failed pass and still return its projection. */
  async board(includeFlow = true): Promise<Record<string, unknown>> {
    try {
      this.runAutomationPass();
    } catch (error) {
      this.deferAlarmAfterFailure(error);
      this.rescheduleAlarm();
    }
    return this.boardProjection(includeFlow);
  }

  /** Public page capabilities are observational. Polling one may touch coarse
   * share-access metadata in RegistryDO, but cannot mutate cards, events, or
   * integration queues in this project. */
  async publicBoard(includeFlow = true): Promise<Record<string, unknown>> {
    return this.boardProjection(includeFlow);
  }

  async card(id: string, compact = false): Promise<Record<string, unknown> | null> {
    const { board, ba, node } = await this.analyzed();
    const found = board.cards.find((c) => c.id === id);
    if (!found) return null;
    const detail = this.withPreviews(cardDetailJson(found, node, ba));
    if (!compact) return detail;

    // The manager has dedicated bounded endpoints for the two append-only
    // histories. Do not quietly transfer those sections (or the raw body that
    // contains them) with every modal read as well.
    const parsed = { ...(detail['parsed'] as Record<string, unknown>) };
    delete parsed['log'];
    delete parsed['comments'];
    const out: Record<string, unknown> = { ...detail, parsed };
    delete out['body'];
    return out;
  }

  cardHistory(
    id: string,
    kind: 'activity' | 'comments',
    requestedLimit: number,
    before: number | null = null,
  ): CardHistoryPage | { error: string } | null {
    const card = this.loadBoardDocs().cards.find((candidate) => candidate.id === id);
    if (card === undefined) return null;
    const parsed = parseBody(card.body);
    const entries = kind === 'activity' ? parsed.log : parsed.comments;
    if (before !== null && before > entries.length) return { error: 'before exceeds card history' };
    const limit = Math.max(1, Math.min(100, Number.isInteger(requestedLimit) ? requestedLimit : 25));
    // `before` is an entry sequence, not an offset. Convert its exclusive
    // 1-based bound to the zero-based slice end. Appending newer entries does
    // not renumber this old prefix.
    const upper = before === null ? entries.length : before - 1;
    const start = Math.max(0, upper - limit);
    const items = entries
      .slice(start, upper)
      .map((entry, index): CardHistoryItem => ({ ...entry, sequence: start + index + 1 }))
      .reverse();
    return { items, next: start > 0 ? start + 1 : null, total: entries.length };
  }

  async search(query: string, actor: string): Promise<Record<string, unknown>[] | { error: string }> {
    try {
      const { ba, node } = await this.analyzed();
      const tree = { rootAbs: '.', boards: new Map([['.', node]]) };
      const analysis = { boards: new Map([['.', ba]]) };
      return queryCards(tree, analysis, query, { actor }).map((match) => this.withPreviews(
        cardJson(match.card, node, ba),
        undefined,
        match.card,
      ));
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  async feedSnapshot(
    scope: { cardId: string | null; laneId: string | null; filterId: string | null },
    actor: string,
  ): Promise<{
    projectId: string;
    title: string;
    events: AuditEvent[];
    cards: { id: string; title: string; due: string; lane: string; state: string; updated: string | null }[];
  } | { error: string }> {
    try {
      const { board, ba, node } = await this.analyzed();
      let selected = board.cards;
      let suffix = '';
      if (scope.cardId !== null) {
        const card = board.cards.find((candidate) => candidate.id === scope.cardId);
        if (card === undefined) return { error: `no card ${scope.cardId}` };
        selected = [card];
        suffix = ` · ${card.title}`;
      } else if (scope.laneId !== null) {
        const lane = board.config.lanes.find((candidate) => candidate.id === scope.laneId);
        if (lane === undefined) return { error: `no lane ${scope.laneId}` };
        selected = board.cards.filter((card) => card.laneId === lane.id);
        suffix = ` · ${lane.name}`;
      } else if (scope.filterId !== null) {
        const filter = board.config.savedFilters.find((candidate) => candidate.id === scope.filterId);
        if (filter === undefined) return { error: `no saved filter ${scope.filterId}` };
        const tree = { rootAbs: '.', boards: new Map([['.', node]]) };
        const analysis = { boards: new Map([['.', ba]]) };
        selected = queryCards(tree, analysis, filter.query, { actor }).map((match) => match.card);
        suffix = ` · ${filter.name}`;
      }
      const ids = new Set(selected.map((card) => card.id));
      const scoped = scope.cardId !== null || scope.laneId !== null || scope.filterId !== null;
      const events = scoped ? this.listEventsForCards(ids, 100) : this.listEvents(100);
      return {
        projectId: this.selfId(),
        title: `${board.config.name}${suffix}`,
        events,
        cards: selected.filter((card) => card.due !== null).map((card) => ({
          id: card.id,
          title: card.title,
          due: card.due!,
          lane: card.substate === null ? card.laneId : `${card.laneId}.${card.substate}`,
          state: ba.canonical.get(card.id) ?? 'todo',
          updated: card.updated,
        })),
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---- link previews ----
  // Derived, hosted-only state: an attachment url is not an image, but the
  // page behind it may advertise one. Dropping this table costs a re-fetch and
  // nothing else, so it is a cache, not a record.

  /** Every cached picture, keyed by the url that advertised it. */
  private unfurlImages(): Map<string, string> {
    const out = new Map<string, string>();
    for (const row of this.sql.exec("SELECT url, image_hash FROM unfurls WHERE status = 'ok' AND image_hash IS NOT NULL").toArray()) {
      out.set(row['url'] as string, `/og/${row['image_hash'] as string}?p=${this.selfId()}`);
    }
    return out;
  }

  /** Attach previews in attachment order, so the first previewable attachment
   *  is the one a viewer falls back to for cover art. */
  private withPreviews(card: Record<string, unknown>, cached?: Map<string, string>, source?: Card): Record<string, unknown> {
    const images = cached ?? this.unfurlImages();
    const parsed = card['parsed'] as { attachments?: { url: string }[] } | undefined;
    const attachments = source === undefined ? (parsed?.attachments ?? []) : parseBody(source.body).attachments;
    const previews = attachments
      .map((a) => ({ url: a.url, image: images.get(a.url) }))
      .filter((p): p is { url: string; image: string } => p.image !== undefined);
    return previews.length > 0 ? { ...card, previews } : card;
  }

  /** Attachment urls with no verdict yet, for the caller to go and fetch. */
  pendingUnfurls(limit: number): string[] {
    const known = new Set<string>();
    for (const row of this.sql.exec('SELECT url, status FROM unfurls').toArray()) {
      const url = row['url'] as string;
      // Old deployments may have cached a failed/empty YouTube watch page.
      // Let the deterministic resolver replace that verdict exactly once.
      if (row['status'] !== 'ok' && youtubeVideoId(url) !== null) continue;
      known.add(url);
    }
    const youtube: string[] = [];
    const other: string[] = [];
    for (const row of this.sql.exec('SELECT text FROM cards').toArray()) {
      for (const a of parseBody(row['text'] as string).attachments) {
        // Uploads are already ours and self-describing; only foreign urls have
        // anything to unfurl.
        if (a.url.startsWith('/') || known.has(a.url)) continue;
        known.add(a.url);
        (youtubeVideoId(a.url) === null ? other : youtube).push(a.url);
      }
    }
    // Imported boards can contain a large link backlog. Resolve deterministic
    // video art first so it is not starved behind arbitrary pages.
    return youtube.concat(other).slice(0, limit);
  }

  /** Record a verdict, including "nothing there": an absent og:image is an
   *  answer, and re-asking every board load would hammer the far end. */
  saveUnfurl(
    url: string,
    result: { image: string | null; title: string | null; site: string | null } | null,
    imageHash: string | null = null,
  ): { ok: true } {
    this.sql.exec(
      `INSERT INTO unfurls(url, image, image_hash, title, site, status, fetched) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET image = excluded.image, image_hash = excluded.image_hash,
         title = excluded.title, site = excluded.site, status = excluded.status, fetched = excluded.fetched`,
      url, result?.image ?? null, imageHash, result?.title ?? null, result?.site ?? null,
      result === null ? 'error' : result.image === null ? 'none' : 'ok', new Date().toISOString(),
    );
    return { ok: true };
  }

  /** The url a proxied preview hash stands for. Only urls this worker chose to
   *  fetch are resolvable, so the proxy cannot be pointed anywhere else. */
  unfurlImageFor(hash: string): string | null {
    const row = this.sql.exec("SELECT image FROM unfurls WHERE status = 'ok' AND image_hash = ?", hash).toArray()[0];
    return row ? (row['image'] as string) : null;
  }

  /** How many unfurls this project has recorded today, so one member cannot
   *  turn the worker into a fetch amplifier by attaching a thousand links. */
  unfurlsToday(): number {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return this.sql.exec('SELECT COUNT(*) AS n FROM unfurls WHERE fetched > ?', since).one()['n'] as number;
  }

  /** Structured board.yaml view for the editor UI. */
  boardConfig(): Record<string, unknown> {
    const c = this.loadBoardDocs().config;
    return {
      version: c.version,
      name: c.name,
      ids: c.ids,
      features: c.features,
      readOnlyReason: c.mutationBlocked,
      lanes: c.lanes.map((l) => ({ id: l.id, name: l.name, canonical: l.canonical, substates: l.substates, order: l.order, wip: l.wip, wipMode: l.wipMode })),
      labels: c.labelDefinitions.map(({ id, color }) => ({ id, color })),
      fields: c.customFields.map(({ id, name, type, options, face }) => ({ id, name, type, options, face })),
      templates: c.templates.map(({ id, name, lane, labels, priority, assignee, delegate, start, due, estimate, evergreen, coverColor, fields, body }) => ({
        id, name, lane, labels, priority, assignee, delegate, start, due, estimate, evergreen, cover_color: coverColor, fields, body,
      })),
      filters: c.savedFilters.map(({ id, name, query }) => ({ id, name, query })),
      subscriptions: c.subscriptions.map(({ lane, watcher }) => ({ lane, watcher })),
      blockers: c.blockers.map(({ id, name, color }) => ({ id, name, color })),
      buttons: c.buttons.map(({ id, name, scope, filter, action, value }) => ({ id, name, scope, filter, action, value })),
      rules: c.rules.map(({ id, event, lane, filter, action, value }) => ({ id, event, lane, filter, action, value })),
      automation: { archiveDoneAfter: c.automation.archiveDoneAfter },
      rollup: { blockedWhen: c.rollup.blockedWhen, doneWhen: c.rollup.doneWhen, doingWhen: c.rollup.doingWhen, elseState: c.rollup.elseState },
    };
  }

  /** Reshape the board: lanes (canonical mapping required), rollup policy,
   *  name. Cards stranded by a removed lane or substate migrate per the
   *  caller's plan (or to a same-canonical lane), each move logged on the
   *  card. Validates everything, then commits all-or-nothing. */
  editBoardConfig(payload: unknown, actor: string): ActionResult {
    const board = this.loadBoardDocs();
    if (board.config.mutationBlocked !== null) return { error: `board is read-only: ${board.config.mutationBlocked}` };
    if (payload === null || typeof payload !== 'object') return { error: 'malformed config' };
    const p = payload as {
      name?: unknown; lanes?: unknown; labels?: unknown; fields?: unknown; templates?: unknown;
      filters?: unknown; subscriptions?: unknown; blockers?: unknown; buttons?: unknown;
      rules?: unknown; automation?: unknown; rollup?: unknown; migrations?: unknown;
    };
    const name = typeof p.name === 'string' && p.name.trim() !== '' ? p.name.trim().replace(/[\r\n]+/g, ' ') : null;
    if (name === null) return { error: 'board name required' };
    if (!Array.isArray(p.lanes) || p.lanes.length === 0) return { error: 'at least one lane required' };

    const lanes: Lane[] = [];
    const seen = new Set<string>();
    for (const raw of p.lanes) {
      if (raw === null || typeof raw !== 'object') return { error: 'each lane must be an object' };
      const l = raw as Record<string, unknown>;
      const id = typeof l['id'] === 'string' ? l['id'].trim() : '';
      if (!SLUG_RE.test(id)) return { error: `lane id must be a lowercase slug, got "${id}"` };
      if (seen.has(id)) return { error: `duplicate lane id "${id}"` };
      seen.add(id);
      let canonical: Canonical;
      if (isCanonical(id)) canonical = id;
      else if (typeof l['canonical'] === 'string' && isCanonical(l['canonical'])) canonical = l['canonical'];
      else return { error: `lane "${id}" needs a canonical state (wishlist, todo, doing, blocked, done, archive)` };
      const substates: string[] = [];
      if (l['substates'] !== undefined && l['substates'] !== null) {
        if (!Array.isArray(l['substates'])) return { error: `lane "${id}": substates must be a list` };
        for (const s of l['substates']) {
          if (typeof s !== 'string' || !SLUG_RE.test(s)) return { error: `lane "${id}": substates must be lowercase slugs` };
          if (!substates.includes(s)) substates.push(s);
        }
      }
      const order = l['order'] === 'strict' ? 'strict' : 'free';
      let wip: number | null = null;
      if (l['wip'] !== undefined && l['wip'] !== null && l['wip'] !== '') {
        const n = Number(l['wip']);
        if (!Number.isInteger(n) || n <= 0) return { error: `lane "${id}": wip must be a positive integer` };
        wip = n;
      }
      const wipMode = l['wipMode'] === undefined || l['wipMode'] === 'allow' ? 'allow'
        : l['wipMode'] === 'justify' || l['wipMode'] === 'deny' ? l['wipMode'] : null;
      if (wipMode === null) return { error: `lane "${id}": wipMode must be allow, justify, or deny` };
      if (wipMode !== 'allow' && wip === null) return { error: `lane "${id}": wipMode requires wip` };
      lanes.push({
        id,
        name: typeof l['name'] === 'string' && l['name'].trim() !== '' ? l['name'].trim() : id,
        canonical,
        substates,
        order,
        wip,
        wipMode,
        extra: { ...(board.config.lanes.find((old) => old.id === id)?.extra ?? {}) },
      });
    }

    const rollup = defaultRollup();
    rollup.extra = { ...board.config.rollup.extra };
    if (p.rollup !== undefined && p.rollup !== null) {
      if (typeof p.rollup !== 'object') return { error: 'rollup must be an object' };
      const r = p.rollup as Record<string, unknown>;
      if (r['blockedWhen'] !== undefined) {
        if (r['blockedWhen'] !== 'any-blocked' && r['blockedWhen'] !== 'never') return { error: 'rollup.blockedWhen must be any-blocked or never' };
        rollup.blockedWhen = r['blockedWhen'];
      }
      if (r['doingWhen'] !== undefined) {
        if (r['doingWhen'] !== 'any-started' && r['doingWhen'] !== 'any-doing') return { error: 'rollup.doingWhen must be any-started or any-doing' };
        rollup.doingWhen = r['doingWhen'];
      }
      if (r['elseState'] !== undefined) {
        if (r['elseState'] !== 'todo' && r['elseState'] !== 'wishlist') return { error: 'rollup.elseState must be todo or wishlist' };
        rollup.elseState = r['elseState'];
      }
    }

    const presentationFindings: Finding[] = [];
    const parsedLabels = p.labels === undefined
      ? board.config.labelDefinitions
      : parseLabelDefinitions(p.labels as YamlValue, presentationFindings);
    const parsedFields = p.fields === undefined
      ? board.config.customFields
      : parseCustomFields(p.fields as YamlValue, presentationFindings);
    const presentationError = presentationFindings.find((finding) => finding.severity === 'error');
    if (presentationError !== undefined) return { error: presentationError.message };
    const labelDefinitions = parsedLabels.map((definition) => ({
      ...definition,
      extra: { ...(board.config.labelDefinitions.find((old) => old.id === definition.id)?.extra ?? {}), ...definition.extra },
    }));
    const customFields = parsedFields.map((definition) => ({
      ...definition,
      extra: { ...(board.config.customFields.find((old) => old.id === definition.id)?.extra ?? {}), ...definition.extra },
    }));
    const parsedTemplates = p.templates === undefined
      ? board.config.templates
      : parseTemplates(p.templates as YamlValue, presentationFindings, lanes, customFields);
    const templateError = presentationFindings.find((finding) => finding.severity === 'error');
    if (templateError !== undefined) return { error: templateError.message };
    const templates = parsedTemplates.map((template) => ({
      ...template,
      extra: { ...(board.config.templates.find((old) => old.id === template.id)?.extra ?? {}), ...template.extra },
    }));
    const parsedFilters = p.filters === undefined
      ? board.config.savedFilters
      : parseSavedFilters(p.filters as YamlValue, presentationFindings, customFields);
    const filterError = presentationFindings.find((finding) => finding.severity === 'error');
    if (filterError !== undefined) return { error: filterError.message };
    const savedFilters = parsedFilters.map((filter) => ({
      ...filter,
      extra: { ...(board.config.savedFilters.find((old) => old.id === filter.id)?.extra ?? {}), ...filter.extra },
    }));
    const parsedSubscriptions = p.subscriptions === undefined
      ? board.config.subscriptions.filter((subscription) => lanes.some((lane) => lane.id === subscription.lane))
      : parseSubscriptions(p.subscriptions as YamlValue, presentationFindings, lanes);
    const subscriptionError = presentationFindings.find((finding) => finding.severity === 'error');
    if (subscriptionError !== undefined) return { error: subscriptionError.message };
    const subscriptions = parsedSubscriptions.map((subscription) => ({
      ...subscription,
      extra: {
        ...(board.config.subscriptions.find((old) => old.lane === subscription.lane && old.watcher === subscription.watcher)?.extra ?? {}),
        ...subscription.extra,
      },
    }));
    const parsedBlockers = p.blockers === undefined
      ? board.config.blockers
      : parseBlockers(p.blockers as YamlValue, presentationFindings);
    const blockerError = presentationFindings.find((finding) => finding.severity === 'error');
    if (blockerError !== undefined) return { error: blockerError.message };
    const blockers = parsedBlockers.map((blocker) => ({
      ...blocker,
      extra: { ...(board.config.blockers.find((old) => old.id === blocker.id)?.extra ?? {}), ...blocker.extra },
    }));
    const parsedButtons = p.buttons === undefined
      ? board.config.buttons
      : parseButtons(p.buttons as YamlValue, presentationFindings, lanes, savedFilters);
    const buttonError = presentationFindings.find((finding) => finding.severity === 'error');
    if (buttonError !== undefined) return { error: buttonError.message };
    const buttons = parsedButtons.map((button) => ({
      ...button,
      extra: { ...(board.config.buttons.find((old) => old.id === button.id)?.extra ?? {}), ...button.extra },
    }));
    const parsedRules = p.rules === undefined
      ? board.config.rules
      : parseRules(p.rules as YamlValue, presentationFindings, lanes, savedFilters);
    const ruleError = presentationFindings.find((finding) => finding.severity === 'error');
    if (ruleError !== undefined) return { error: ruleError.message };
    const rules = parsedRules.map((rule) => ({
      ...rule,
      extra: { ...(board.config.rules.find((old) => old.id === rule.id)?.extra ?? {}), ...rule.extra },
    }));
    let automation = board.config.automation;
    if (p.automation !== undefined) {
      if (p.automation === null || typeof p.automation !== 'object' || Array.isArray(p.automation)) return { error: 'automation must be an object' };
      const raw = p.automation as Record<string, unknown>;
      automation = parseAutomation({
        ...(raw['archiveDoneAfter'] === undefined || raw['archiveDoneAfter'] === null ? {} : { archive_done_after: raw['archiveDoneAfter'] as YamlValue }),
      }, presentationFindings);
      const automationError = presentationFindings.find((finding) => finding.severity === 'error');
      if (automationError !== undefined) return { error: automationError.message };
      automation.extra = { ...board.config.automation.extra, ...automation.extra };
    }
    if (automation.archiveDoneAfter !== null && !lanes.some((lane) => lane.canonical === 'archive')) {
      return { error: 'automation.archive_done_after requires an archive-canonical lane' };
    }
    for (const card of board.cards) {
      if (card.blocker !== null && !blockers.some((blocker) => blocker.id === card.blocker)) {
        return { error: `card ${card.id}: active blocker "${card.blocker}" is absent from the new blocker registry` };
      }
      for (const definition of customFields) {
        const value = card.extra[definition.id];
        if (value !== undefined && !validCustomFieldValue(definition, value)) {
          return { error: `card ${card.id}: existing value for custom field "${definition.id}" is not valid for the new ${definition.type} definition` };
        }
      }
    }

    const migrations = new Map<string, string>();
    if (p.migrations !== undefined && p.migrations !== null) {
      if (typeof p.migrations !== 'object' || Array.isArray(p.migrations)) return { error: 'migrations must be an object of oldLane: newLane' };
      for (const [from, to] of Object.entries(p.migrations as Record<string, unknown>)) {
        if (typeof to !== 'string' || !seen.has(to)) return { error: `migration target for lane "${from}" must be one of the new lanes` };
        migrations.set(from, to);
      }
    }

    const laneById = new Map(lanes.map((l) => [l.id, l]));
    const oldLaneById = new Map(board.config.lanes.map((l) => [l.id, l]));
    const fallbackFor = (oldLaneId: string): Lane => {
      const oldCanonical = oldLaneById.get(oldLaneId)?.canonical ?? 'todo';
      return laneById.get(migrations.get(oldLaneId) ?? '') ?? lanes.find((l) => l.canonical === oldCanonical) ?? lanes.find((l) => l.canonical === 'todo') ?? lanes[0]!;
    };
    const moved: Card[] = [];
    for (const card of board.cards) {
      const lane = laneById.get(card.laneId) ?? fallbackFor(card.laneId);
      let substate = card.substate;
      if (lane.substates.length === 0) substate = null;
      else if (substate === null || !lane.substates.includes(substate)) substate = lane.substates[0]!;
      if (lane.id === card.laneId && substate === card.substate) continue;
      const from = card.substate ? `${card.laneId}.${card.substate}` : card.laneId;
      card.laneId = lane.id;
      card.substate = substate;
      const to = substate ? `${lane.id}.${substate}` : lane.id;
      logMutation(card, actor, `migrated ${from} → ${to} (board edit)`);
      moved.push(card);
    }

    const configYaml = emitBoardYaml({
      ...board.config, name, lanes, labelDefinitions, customFields, templates,
      savedFilters, subscriptions, blockers, buttons, rules, automation, rollup,
    });
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO meta(key, value) VALUES ('config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", configYaml);
      for (const card of moved) this.persistCard(card);
      this.event(actor, 'board-edit', null, `lanes: ${lanes.map((l) => l.id).join(', ')}${moved.length > 0 ? `; migrated ${moved.length} card(s)` : ''}`);
    });
    this.rescheduleAlarm();
    return { ok: true, migrated: moved.length };
  }

  exportDocs(): { config: string | null; cards: BoardDocument[] } {
    return {
      config: this.configText(),
      cards: this.sql
        .exec('SELECT file, text FROM cards ORDER BY file')
        .toArray()
        .map((r) => ({ path: r['file'] as string, text: r['text'] as string })),
    };
  }

  /** Snapshot import (push): replace the board's documents: but preserve
   *  manager-native project cards (`board: project:…`) the snapshot doesn't
   *  carry, so a repo push can't sever hosted sub-projects. */
  async importDocs(config: string, cards: BoardDocument[], actor: string, canReshape: boolean): Promise<Record<string, unknown>> {
    const validation = validateImportDocuments(config, cards);
    if ('error' in validation) return validation;
    const configChanged = this.configText() !== config;
    if (configChanged && !canReshape) {
      return { error: 'admin or owner required to reshape this board', forbidden: true };
    }
    const docs = validation.docs;
    const current = this.loadBoardDocs();
    if (this.configText() !== null && current.config.mutationBlocked !== null) {
      return { error: `board is read-only: ${current.config.mutationBlocked}` };
    }
    const parsed = validation.board;
    // Preserve manager-native project cards whose referenced project the
    // snapshot doesn't itself carry (matched by ref, not card id: a snapshot
    // representing the same child under any id already covers it). When a
    // file card claims a preserved card's id, re-id it instead of letting the
    // push sever a hosted sub-project.
    const incomingRefs = new Set(
      parsed.cards.filter((c) => c.type === 'board' && c.boardPath !== null).map((c) => c.boardPath as string),
    );
    const preserved = current.cards.filter(
      (c) => c.type === 'board' && (c.boardPath ?? '').startsWith(PROJECT_REF) && !incomingRefs.has(c.boardPath as string),
    );
    const takenIds = new Set(parsed.cards.map((c) => c.id));
    const reIds: string[] = [];
    for (const card of preserved) {
      if (takenIds.has(card.id)) {
        const newId = parsed.config.ids === 'hash' ? newHashId([...takenIds]) : nextSeqId([...takenIds]);
        reIds.push(`${card.id}→${newId}`);
        card.id = newId;
        card.file = `cards/${newId}-${slugify(card.title)}.md`;
      }
      takenIds.add(card.id);
    }

    const now = new Date().toISOString();
    const byPath = new Map(docs.map((doc) => [doc.path, doc.text]));
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO meta(key, value) VALUES ('config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", config);
      this.sql.exec('DELETE FROM cards');
      for (const card of parsed.cards) {
        this.sql.exec(
          'INSERT INTO cards(id, file, text, updated_at) VALUES (?, ?, ?, ?)',
          card.id, card.file, byPath.get(card.file) ?? serializeCard(card), now,
        );
      }
      for (const card of preserved) {
        this.sql.exec('INSERT INTO cards(id, file, text, updated_at) VALUES (?, ?, ?, ?)', card.id, card.file, serializeCard(card), now);
      }
      this.event(
        actor,
        'import',
        null,
        `imported ${parsed.cards.length} cards (snapshot, last-write-wins)` +
          (configChanged ? '; board config changed' : '') +
          (preserved.length > 0 ? `; preserved ${preserved.length} project card(s)` : '') +
          (reIds.length > 0 ? `; re-id on collision: ${reIds.join(', ')}` : ''),
      );
    });
    this.rescheduleAlarm();
    return { imported: parsed.cards.length, preserved: preserved.length, reIds, findings: parsed.findings.length, configChanged };
  }

  addCard(opts: Omit<AddOptions, 'actor'>, actor: string): ActionResult {
    try {
      const board = this.loadBoardDocs();
      if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
      const card = opAdd(board, { ...opts, actor });
      this.persistCard(card);
      this.event(actor, 'add', card.id, `created "${card.title}" in ${card.laneId}`);
      this.rescheduleAlarm();
      return { id: card.id, file: card.file, lane: card.laneId };
    } catch (err) {
      if (err instanceof UsageError) return { error: err.message };
      throw err;
    }
  }

  quickAdd(text: string, actor: string): ActionResult {
    try {
      if (text.length > MAX_BODY_TEXT) throw new UsageError(`quick-add text exceeds ${MAX_BODY_TEXT} characters`);
      const board = this.loadBoardDocs();
      if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
      const cards = opQuickAdd(board, text, actor);
      this.ctx.storage.transactionSync(() => {
        for (const card of cards) {
          this.persistCard(card);
          this.event(actor, 'quick-add', card.id, `created "${card.title}" in ${card.laneId}`);
        }
      });
      this.rescheduleAlarm();
      return { cards: cards.map((card) => ({ id: card.id, title: card.title, file: card.file })) };
    } catch (err) {
      if (err instanceof UsageError) return { error: err.message };
      throw err;
    }
  }

  bulkAction(ids: string[], action: Record<string, unknown>, actor: string): ActionResult {
    try {
      const board = this.loadBoardDocs();
      if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
      const kind = String(action['kind'] ?? '');
      const operation = kind === 'move'
        ? { kind: 'move' as const, to: String(action['to'] ?? ''), force: action['force'] === true, wipJustification: typeof action['wipReason'] === 'string' ? action['wipReason'] : undefined }
        : kind === 'close'
          ? { kind: 'close' as const, reason: typeof action['reason'] === 'string' ? action['reason'] : undefined, force: action['force'] === true, wipJustification: typeof action['wipReason'] === 'string' ? action['wipReason'] : undefined }
          : kind === 'label'
            ? {
                kind: 'label' as const,
                add: Array.isArray(action['add']) ? action['add'].map(String) : undefined,
                remove: Array.isArray(action['remove']) ? action['remove'].map(String) : undefined,
              }
            : (() => { throw new UsageError('bulk kind must be move, close, or label'); })();
      const result = opBulk(board, ids, operation, actor);
      this.ctx.storage.transactionSync(() => {
        for (const card of result.cards) {
          this.persistCard(card);
          this.event(actor, `bulk-${kind}`, card.id, kind);
        }
      });
      this.rescheduleAlarm();
      return { changed: result.cards.map((card) => card.id), warnings: result.warnings };
    } catch (err) {
      if (err instanceof UsageError) return { error: err.message };
      throw err;
    }
  }

  automate(): ActionResult {
    const result = this.runAutomationPass();
    return { actions: result.actions, changed: result.cards.map((card) => card.id), remaining: result.remaining, nextAt: result.nextAt };
  }

  runButton(id: string, cardId: string | null, args: Record<string, unknown>, actor: string): ActionResult {
    try {
      const board = this.loadBoardDocs();
      if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
      const result = opButton(board, id, actor, {
        cardId: cardId ?? undefined,
        force: args['force'] === true,
        wipJustification: typeof args['wipReason'] === 'string' ? args['wipReason'] : undefined,
      });
      this.ctx.storage.transactionSync(() => {
        for (const card of result.cards) {
          this.persistCard(card);
          this.event(actor, 'button', card.id, id);
        }
      });
      this.rescheduleAlarm();
      return { button: id, changed: result.cards.map((card) => card.id), warnings: result.warnings };
    } catch (err) {
      if (err instanceof UsageError) return { error: err.message };
      throw err;
    }
  }

  saveFilter(id: string, query: string, name: string | null, actor: string): ActionResult {
    try {
      const board = this.loadBoardDocs();
      if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
      const filter = opSaveFilter(board.config, id, query, name ?? undefined);
      this.sql.exec("INSERT INTO meta(key, value) VALUES ('config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", emitBoardYaml(board.config));
      this.event(actor, 'filter-save', null, `${filter.id}: ${filter.query}`.slice(0, 300));
      return { id: filter.id, name: filter.name, query: filter.query };
    } catch (err) {
      if (err instanceof UsageError) return { error: err.message };
      throw err;
    }
  }

  removeFilter(id: string, actor: string): ActionResult {
    try {
      const board = this.loadBoardDocs();
      if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
      const filter = opRemoveFilter(board.config, id);
      this.sql.exec("INSERT INTO meta(key, value) VALUES ('config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", emitBoardYaml(board.config));
      this.event(actor, 'filter-remove', null, filter.id);
      return { id: filter.id, removed: true };
    } catch (err) {
      if (err instanceof UsageError) return { error: err.message };
      throw err;
    }
  }

  subscribeLane(lane: string, actor: string, active: boolean): ActionResult {
    try {
      const board = this.loadBoardDocs();
      if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
      const result = opSubscribeLane(board.config, lane, actor, active);
      if (result.changed) {
        this.sql.exec("INSERT INTO meta(key, value) VALUES ('config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", emitBoardYaml(board.config));
        this.event(actor, result.active ? 'lane-subscribe' : 'lane-unsubscribe', null, lane);
      }
      return { lane, watcher: actor, subscribed: result.active, changed: result.changed };
    } catch (err) {
      if (err instanceof UsageError) return { error: err.message };
      throw err;
    }
  }

  async action(kind: string, id: string, args: Record<string, unknown>, actor: string): Promise<ActionResult> {
    try {
      const analyzed = kind === 'claim' ? await this.analyzed() : null;
      const board = analyzed?.board ?? this.loadBoardDocs();
      if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
      const card = getCard(board, id);
      switch (kind) {
        case 'move': {
          const res = opMove(board, card, String(args['to']), actor, args['force'] === true, typeof args['wipReason'] === 'string' ? args['wipReason'] : undefined);
          this.persistCard(card);
          this.event(actor, 'move', id, `${res.from} → ${res.to}${args['force'] === true ? ' (forced)' : ''}`);
          return { id, from: res.from, to: res.to, warnings: res.warnings };
        }
        case 'claim': {
          const mode = args['delegate'] === true ? 'delegate' : 'assign';
          const external = analyzed?.ba.dependencyStates.get(id) as Map<string, string | null> | undefined;
          const res = opClaim(
            board, card, actor, args['force'] === true, mode, external,
            typeof args['wipReason'] === 'string' ? args['wipReason'] : undefined,
            Date.now(), analyzed?.ba.cycleMembers, analyzed?.ba.canonical.get(id),
          );
          if (res.alreadyYours) return { id, at: res.to, assignee: card.assignee, delegate: card.delegate, alreadyYours: true };
          this.persistCard(card);
          this.event(actor, 'claim', id, `${res.from} → ${res.to}${args['force'] === true ? ' (forced)' : ''}`);
          return { id, from: res.from, to: res.to, assignee: card.assignee, delegate: card.delegate, warnings: res.warnings };
        }
        case 'close': {
          const reason = typeof args['reason'] === 'string' ? (args['reason'] as string) : undefined;
          const res = opClose(
            board, card, actor, reason,
            typeof args['wipReason'] === 'string' ? args['wipReason'] : undefined,
            args['force'] === true,
          );
          if (res.alreadyClosed) return { id, at: res.to, created: null, alreadyClosed: true };
          this.ctx.storage.transactionSync(() => {
            if (res.created !== undefined) this.persistCard(res.created);
            this.persistCard(card);
            this.event(actor, 'close', id, reason ?? 'closed');
            if (res.created !== undefined) this.event(actor, 'recur', res.created.id, `from ${id}`);
          });
          return { id, from: res.from, to: res.to, created: res.created?.id ?? null };
        }
        case 'block': {
          const reason = clampLine(args['reason'], 'blocked');
          opBlock(card, actor, reason, board, typeof args['blocker'] === 'string' ? args['blocker'] : undefined);
          this.persistCard(card);
          this.event(actor, 'block', id, reason.slice(0, 200));
          return { id, blocked: card.blocked, blocker: card.blocker };
        }
        case 'unblock': {
          opUnblock(card, actor);
          this.persistCard(card);
          this.event(actor, 'unblock', id, '');
          return { id, blocked: null };
        }
        case 'snooze': {
          if (args['until'] !== null && typeof args['until'] !== 'string') throw new UsageError('until must be a UTC date/datetime or null');
          opSnooze(card, actor, args['until'] as string | null);
          this.persistCard(card);
          this.event(actor, card.snooze === null ? 'wake' : 'snooze', id, card.snooze ?? 'awake');
          return { id, snooze: card.snooze };
        }
        case 'comment': {
          const text = clampLine(args['message'], '').trim();
          if (text === '') return { error: 'message required' };
          opComment(card, actor, text);
          this.persistCard(card);
          this.event(actor, 'comment', id, text.slice(0, 200));
          return { id, commented: true };
        }
        case 'watch': {
          const result = opWatch(card, actor, args['active'] !== false);
          if (result.changed) {
            this.persistCard(card);
            this.event(actor, result.active ? 'watch' : 'unwatch', id, '');
          }
          return { id, watching: result.active, changed: result.changed };
        }
        case 'vote': {
          const result = opVote(card, actor, args['active'] !== false);
          if (result.changed) {
            this.persistCard(card);
            this.event(actor, result.active ? 'vote' : 'unvote', id, '');
          }
          return { id, voted: result.active, changed: result.changed };
        }
        case 'boost': {
          const text = clampLine(args['text'], '').trim();
          opBoost(card, actor, text);
          this.persistCard(card);
          this.event(actor, 'boost', id, text);
          return { id, boosted: true };
        }
        case 'check': {
          const index = Number(args['index']);
          const checked = args['checked'] !== false;
          opCheck(card, actor, index, checked);
          this.persistCard(card);
          this.event(actor, checked ? 'check' : 'uncheck', id, `item ${index}`);
          return { id, index, checked };
        }
        case 'attach': {
          const url = String(args['url'] ?? '').trim();
          if (url === '') return { error: 'url required' };
          opAttach(card, actor, url, typeof args['label'] === 'string' ? (args['label'] as string) : undefined);
          this.persistCard(card);
          this.event(actor, 'attach', id, url.slice(0, 200));
          return { id, attached: url };
        }
        case 'detach': {
          const index = Number(args['index']);
          opDetach(card, actor, index);
          this.persistCard(card);
          this.event(actor, 'detach', id, `attachment ${index}`);
          return { id, detached: index };
        }
        case 'edit': {
          const patch: EditPatch = {};
          if ('title' in args) patch.title = String(args['title']);
          if ('labels' in args && Array.isArray(args['labels'])) patch.labels = (args['labels'] as unknown[]).map(String);
          if ('priority' in args) patch.priority = args['priority'] === null ? null : String(args['priority']);
          if ('assignee' in args) patch.assignee = args['assignee'] === null ? null : String(args['assignee']);
          if ('delegate' in args) patch.delegate = args['delegate'] === null ? null : String(args['delegate']);
          if ('deps' in args && Array.isArray(args['deps'])) patch.deps = (args['deps'] as unknown[]).map(String);
          if ('start' in args) {
            if (args['start'] !== null && typeof args['start'] !== 'string') throw new UsageError('start must be a string or null');
            patch.start = args['start'];
          }
          if ('due' in args) {
            if (args['due'] !== null && typeof args['due'] !== 'string') throw new UsageError('due must be a string or null');
            patch.due = args['due'];
          }
          if ('reminders' in args) {
            if (args['reminders'] !== null && (!Array.isArray(args['reminders']) || !(args['reminders'] as unknown[]).every((value) => typeof value === 'number'))) {
              throw new UsageError('reminders must be a list of integer offsets or null');
            }
            patch.reminders = args['reminders'] === null ? [] : args['reminders'] as number[];
          }
          if ('repeat' in args) {
            if (args['repeat'] !== null && (typeof args['repeat'] !== 'object' || Array.isArray(args['repeat']))) throw new UsageError('repeat must be an object or null');
            if (args['repeat'] === null) patch.repeat = null;
            else {
              const repeat = args['repeat'] as Record<string, unknown>;
              patch.repeat = {
                every: Number(repeat['every']),
                unit: String(repeat['unit']) as NonNullable<EditPatch['repeat']>['unit'],
                from: String(repeat['from'] ?? 'due') as NonNullable<EditPatch['repeat']>['from'],
                extra: {},
              };
            }
          }
          if ('snooze' in args) {
            if (args['snooze'] !== null && typeof args['snooze'] !== 'string') throw new UsageError('snooze must be a UTC date/datetime or null');
            patch.snooze = args['snooze'];
          }
          if ('estimate' in args) {
            if (args['estimate'] !== null && typeof args['estimate'] !== 'number') throw new UsageError('estimate must be a number or null');
            patch.estimate = args['estimate'];
          }
          if ('hill' in args) {
            if (args['hill'] !== null && typeof args['hill'] !== 'number') throw new UsageError('hill must be a number or null');
            patch.hill = args['hill'];
          }
          if ('evergreen' in args) {
            if (typeof args['evergreen'] !== 'boolean') throw new UsageError('evergreen must be a boolean');
            patch.evergreen = args['evergreen'];
          }
          if ('cover' in args) patch.cover = args['cover'] === null ? null : String(args['cover']);
          if ('cover_color' in args) {
            if (args['cover_color'] !== null && typeof args['cover_color'] !== 'string') throw new UsageError('cover_color must be a string or null');
            patch.coverColor = args['cover_color'];
          }
          if ('fields' in args) {
            if (args['fields'] === null || typeof args['fields'] !== 'object' || Array.isArray(args['fields'])) throw new UsageError('fields must be an object');
            patch.fields = args['fields'] as Record<string, unknown>;
          }
          opEdit(card, patch, actor, board);
          this.persistCard(card);
          this.event(actor, 'edit', id, Object.keys(patch).join(', '));
          return { id, edited: Object.keys(patch) };
        }
        case 'link':
        case 'unlink': {
          const targetId = String(args['target'] ?? '');
          const type = String(args['type'] ?? '') as Card['relations'][number]['type'];
          const result = kind === 'link'
            ? opLink(board, id, targetId, type, actor)
            : opUnlink(board, id, targetId, type, actor);
          if (result.changed) {
            this.ctx.storage.transactionSync(() => {
              this.persistCard(result.source);
              this.persistCard(result.target);
              this.event(actor, kind, id, `${type} ${targetId}`);
            });
          }
          return { id, target: targetId, type, changed: result.changed };
        }
        case 'promote': {
          const index = Number(args['index']);
          if (!Number.isInteger(index) || index < 0) throw new UsageError('index must be a non-negative integer');
          const result = opPromote(board, card, index, actor, {
            title: typeof args['title'] === 'string' ? args['title'] : undefined,
            template: typeof args['template'] === 'string' ? args['template'] : undefined,
            lane: typeof args['lane'] === 'string' ? args['lane'] : undefined,
          });
          this.ctx.storage.transactionSync(() => {
            this.persistCard(result.promoted);
            this.persistCard(result.source);
            this.event(actor, 'promote', id, `item ${index} → ${result.promoted.id}`);
          });
          return { id, promoted: result.promoted.id, index };
        }
        case 'merge': {
          const canonical = String(args['canonical'] ?? '');
          const result = opMergeDuplicates(board, id, canonical, actor);
          this.ctx.storage.transactionSync(() => {
            for (const changed of result.changed) this.persistCard(changed);
            this.event(actor, 'merge', id, `merged into ${canonical}`);
          });
          return { duplicate: id, canonical, attachmentsMoved: result.attachmentsMoved, referencesRewired: result.referencesRewired };
        }
        case 'log': {
          const message = clampLine(args['message'], '');
          opLog(card, actor, message);
          this.persistCard(card);
          this.event(actor, 'log', id, message.slice(0, 200));
          return { id, logged: true };
        }
        case 'describe': {
          const text = String(args['text'] ?? '').slice(0, MAX_BODY_TEXT);
          opDescribe(card, actor, text);
          this.persistCard(card);
          this.event(actor, 'describe', id, text.slice(0, 160));
          return { id, described: true };
        }
        case 'checkadd': {
          const section = typeof args['section'] === 'string' && args['section'].trim() !== '' ? (args['section'] as string) : undefined;
          const item = clampLine(args['text'], '');
          opChecklistAdd(card, actor, item, section);
          this.persistCard(card);
          this.event(actor, 'checkadd', id, item.slice(0, 160));
          return { id, added: true };
        }
        default:
          return { error: `unknown action "${kind}"` };
      }
    } catch (err) {
      if (err instanceof ClaimConflict) {
        return { error: err.message, conflict: { reason: err.reason, holder: err.holder, position: err.position } };
      }
      if (err instanceof UsageError) return { error: err.message };
      throw err;
    } finally {
      this.rescheduleAlarm();
    }
  }

  /** Wipe this project's entire storage (board, events). Registry rows and
   *  the parent's project card are the caller's job. No undo. */
  async destroy(): Promise<{ ok: boolean }> {
    await this.ctx.storage.deleteAll();
    this.sql.exec(DDL); // leave the instance usable if ever touched again
    return { ok: true };
  }

  /** Remove project cards pointing at a given ref (used when the referenced
   *  project is deleted). Not a general card-delete: archive is the verb for
   *  ordinary cards. */
  removeCardsByRef(ref: string, actor: string): { removed: number } {
    const board = this.loadBoardDocs();
    if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
    const doomed = board.cards.filter((c) => c.type === 'board' && c.boardPath === ref);
    for (const card of doomed) {
      this.sql.exec('DELETE FROM cards WHERE id = ?', card.id);
      this.event(actor, 'remove', card.id, `project card removed ("${card.title}": target deleted)`);
    }
    return { removed: doomed.length };
  }

  listEvents(limit: number, before: number | null = null): AuditEvent[] {
    return (before === null
      ? this.sql.exec('SELECT seq, ts, actor, action, card_id, detail FROM events ORDER BY seq DESC LIMIT ?', limit)
      : this.sql.exec('SELECT seq, ts, actor, action, card_id, detail FROM events WHERE seq < ? ORDER BY seq DESC LIMIT ?', before, limit)
    ).toArray() as unknown as AuditEvent[];
  }

  /** Apply capability scope in SQLite before LIMIT. Filtering a newest-first
   * project page in memory makes an older matching event disappear whenever
   * 100 unrelated events happen after it. */
  private listEventsForCards(ids: ReadonlySet<string>, limit: number): AuditEvent[] {
    if (ids.size === 0) return [];
    const cardIds = [...ids];
    const placeholders = cardIds.map(() => '?').join(', ');
    return this.sql
      .exec(
        `SELECT seq, ts, actor, action, card_id, detail
           FROM events
          WHERE card_id IN (${placeholders})
          ORDER BY seq DESC
          LIMIT ?`,
        ...cardIds, limit,
      )
      .toArray() as unknown as AuditEvent[];
  }
}
