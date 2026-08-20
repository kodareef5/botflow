// Restore-grade configuration for project manager overlays. Operational
// delivery history is intentionally absent: company import remaps project ids,
// so replaying a frozen old-project payload after restore would be incorrect.

import { cleanRecipients } from './email.ts';
import { cleanEventList, cleanIntegrationName, webhookTarget } from './webhooks.ts';

export interface IntegrationWebhookSnapshot {
  id: string;
  name: string;
  url: string;
  secret: string;
  allowEvents: string[];
  denyEvents: string[];
  active: boolean;
  created: string;
  updated: string;
}

export interface IntegrationEmailRouteSnapshot {
  id: string;
  name: string;
  tokenHash: string;
  kind: 'create' | 'comment';
  lane: string | null;
  card: string | null;
  actor: string;
  active: boolean;
  created: string;
  updated: string;
}

export interface IntegrationEmailSubscriptionSnapshot {
  id: string;
  name: string;
  recipients: string[];
  allowEvents: string[];
  denyEvents: string[];
  active: boolean;
  created: string;
  updated: string;
}

export interface IntegrationSnapshot {
  schema: 'botflow.integrations.v1';
  webhooks: IntegrationWebhookSnapshot[];
  emailRoutes: IntegrationEmailRouteSnapshot[];
  emailSubscriptions: IntegrationEmailSubscriptionSnapshot[];
}

export type IntegrationSnapshotResult = { ok: true; value: IntegrationSnapshot } | { ok: false; error: string };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const date = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`${field} must be a timestamp`);
  return value;
};

const text = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
  if (value.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return value;
};

const nullableText = (value: unknown, field: string, max: number): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value === '' || value.length > max) throw new Error(`${field} must be null or a non-empty string`);
  return value;
};

const active = (value: unknown, field: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(`${field} must be boolean`);
  return value;
};

const uniqueId = (value: unknown, field: string, prefix: string, seen: Set<string>): string => {
  const id = text(value, field, 80);
  if (!new RegExp(`^${prefix}_[a-f0-9]{20,64}$`).test(id)) throw new Error(`${field} has an invalid id`);
  if (seen.has(id)) throw new Error(`${field} duplicates ${id}`);
  seen.add(id);
  return id;
};

export function readIntegrationSnapshot(value: unknown, allowPrivate = false): IntegrationSnapshotResult {
  try {
    if (!record(value) || value['schema'] !== 'botflow.integrations.v1') throw new Error('schema must be botflow.integrations.v1');
    if (!Array.isArray(value['webhooks']) || !Array.isArray(value['emailRoutes']) || !Array.isArray(value['emailSubscriptions'])) {
      throw new Error('webhooks, emailRoutes, and emailSubscriptions must be arrays');
    }
    if (value['webhooks'].length > 25 || value['emailRoutes'].length > 25 || value['emailSubscriptions'].length > 25) {
      throw new Error('integration snapshot exceeds the per-project configuration limit');
    }

    const webhookIds = new Set<string>();
    const webhooks = value['webhooks'].map((raw, index): IntegrationWebhookSnapshot => {
      if (!record(raw)) throw new Error(`webhooks[${index}] must be an object`);
      const field = `webhooks[${index}]`;
      const endpoint = webhookTarget(raw['url'], allowPrivate);
      if (!endpoint.ok) throw new Error(`${field}.url: ${endpoint.error}`);
      if (typeof raw['secret'] !== 'string' || !/^bfwhsec_[a-f0-9]{64}$/.test(raw['secret'])) throw new Error(`${field}.secret is invalid`);
      return {
        id: uniqueId(raw['id'], `${field}.id`, 'wh', webhookIds),
        name: cleanIntegrationName(text(raw['name'], `${field}.name`, 120), 'Webhook'),
        url: endpoint.url,
        secret: raw['secret'],
        allowEvents: cleanEventList(raw['allowEvents'], `${field}.allowEvents`),
        denyEvents: cleanEventList(raw['denyEvents'], `${field}.denyEvents`),
        active: active(raw['active'], `${field}.active`),
        created: date(raw['created'], `${field}.created`),
        updated: date(raw['updated'], `${field}.updated`),
      };
    });

    const routeIds = new Set<string>();
    const routeTokenHashes = new Set<string>();
    const emailRoutes = value['emailRoutes'].map((raw, index): IntegrationEmailRouteSnapshot => {
      if (!record(raw)) throw new Error(`emailRoutes[${index}] must be an object`);
      const field = `emailRoutes[${index}]`;
      const kind = raw['kind'];
      if (kind !== 'create' && kind !== 'comment') throw new Error(`${field}.kind must be create or comment`);
      if (typeof raw['tokenHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(raw['tokenHash'])) throw new Error(`${field}.tokenHash is invalid`);
      if (routeTokenHashes.has(raw['tokenHash'])) throw new Error(`${field}.tokenHash is duplicated`);
      routeTokenHashes.add(raw['tokenHash']);
      if (typeof raw['actor'] !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(raw['actor'])) throw new Error(`${field}.actor is invalid`);
      const lane = nullableText(raw['lane'], `${field}.lane`, 200);
      const card = nullableText(raw['card'], `${field}.card`, 200);
      if (kind === 'create' && card !== null) throw new Error(`${field}: create route cannot name a card`);
      if (kind === 'comment' && (card === null || lane !== null)) throw new Error(`${field}: comment route needs one card and no lane`);
      return {
        id: uniqueId(raw['id'], `${field}.id`, 'emr', routeIds),
        name: cleanIntegrationName(text(raw['name'], `${field}.name`, 120), kind === 'create' ? 'Email to board' : 'Email to card'),
        tokenHash: raw['tokenHash'], kind, lane, card, actor: raw['actor'],
        active: active(raw['active'], `${field}.active`),
        created: date(raw['created'], `${field}.created`),
        updated: date(raw['updated'], `${field}.updated`),
      };
    });

    const subscriptionIds = new Set<string>();
    const emailSubscriptions = value['emailSubscriptions'].map((raw, index): IntegrationEmailSubscriptionSnapshot => {
      if (!record(raw)) throw new Error(`emailSubscriptions[${index}] must be an object`);
      const field = `emailSubscriptions[${index}]`;
      return {
        id: uniqueId(raw['id'], `${field}.id`, 'ems', subscriptionIds),
        name: cleanIntegrationName(text(raw['name'], `${field}.name`, 120), 'Email notifications'),
        recipients: cleanRecipients(raw['recipients']),
        allowEvents: cleanEventList(raw['allowEvents'], `${field}.allowEvents`),
        denyEvents: cleanEventList(raw['denyEvents'], `${field}.denyEvents`),
        active: active(raw['active'], `${field}.active`),
        created: date(raw['created'], `${field}.created`),
        updated: date(raw['updated'], `${field}.updated`),
      };
    });
    return { ok: true, value: { schema: 'botflow.integrations.v1', webhooks, emailRoutes, emailSubscriptions } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'malformed integration snapshot' };
  }
}
