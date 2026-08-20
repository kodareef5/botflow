// Outbound webhook protocol and network boundary. ProjectDO owns durable
// queues/retries; this module owns validation, signing, redirect policy, and a
// single bounded attempt. Keeping it pure-ish makes the threat model testable
// without starting workerd.

import { MAX_REDIRECTS, unfurlTarget } from './security.ts';

export const WEBHOOK_TIMEOUT_MS = 8_000;
export const WEBHOOK_MAX_ATTEMPTS = 6;
export const WEBHOOK_CIRCUIT_FAILURES = 5;
export const WEBHOOK_CIRCUIT_MS = 15 * 60 * 1000;
export const WEBHOOK_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000] as const;
export const WEBHOOK_MAX_RESPONSE_RETRY_MS = 24 * 60 * 60 * 1000;

const EVENT_RE = /^[a-z][a-z0-9-]{0,63}$/;
const NAME_RE = /[\r\n\t]/g;
const MAX_EVENT_FILTERS = 64;

export interface WebhookEvent {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  cardId: string | null;
  detail: string;
}

export interface WebhookAttempt {
  ok: boolean;
  status: number | null;
  retryable: boolean;
  retryAfterMs: number | null;
  error: string | null;
}

export function cleanIntegrationName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(NAME_RE, ' ').trim().slice(0, 120);
  return clean || fallback;
}

export function cleanEventList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of event names`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !EVENT_RE.test(item)) throw new Error(`${field} contains an invalid event name`);
    if (!out.includes(item)) out.push(item);
    if (out.length > MAX_EVENT_FILTERS) throw new Error(`${field} may contain at most ${MAX_EVENT_FILTERS} event names`);
  }
  return out.sort();
}

export function eventSelected(action: string, allow: readonly string[], deny: readonly string[]): boolean {
  return (allow.length === 0 || allow.includes(action)) && !deny.includes(action);
}

export function webhookTarget(value: unknown, allowPrivate = false): { ok: true; url: string } | { ok: false; error: string } {
  const checked = unfurlTarget(value, allowPrivate);
  if (!checked.ok) return { ok: false, error: checked.reason };
  if (!allowPrivate && checked.url.protocol !== 'https:') return { ok: false, error: 'webhook endpoints must use HTTPS' };
  return { ok: true, url: checked.url.toString() };
}

export function randomIntegrationId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function randomSigningSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `bfwhsec_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** Receivers verify HMAC-SHA256 over `<unix-seconds>.<exact-body>`, reject a
 * timestamp outside their tolerance, and dedupe X-Botflow-Delivery. */
export async function webhookSignature(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  return `sha256=${hex(new Uint8Array(signature))}`;
}

export function webhookPayload(projectId: string, event: WebhookEvent): string {
  return JSON.stringify({
    schema: 'botflow.webhook.v1',
    id: `evt_${projectId}_${event.seq}`,
    project: { id: projectId },
    event: {
      sequence: event.seq,
      occurred_at: event.ts,
      actor: event.actor,
      action: event.action,
      card_id: event.cardId,
      detail: event.detail,
    },
  });
}

function retryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  let milliseconds: number;
  if (Number.isFinite(seconds) && seconds >= 0) milliseconds = seconds * 1000;
  else {
    const date = Date.parse(value);
    if (Number.isNaN(date)) return null;
    milliseconds = Math.max(0, date - now);
  }
  return Math.min(WEBHOOK_MAX_RESPONSE_RETRY_MS, Math.round(milliseconds));
}

/** One signed POST attempt. Redirects are manual: only 307/308 preserve the
 * signed method/body, and every hop is revalidated before a request is sent. */
export async function postWebhook(
  endpoint: string,
  secret: string,
  deliveryId: string,
  eventName: string,
  body: string,
  allowPrivate = false,
  fetcher: typeof fetch = fetch,
): Promise<WebhookAttempt> {
  let current = endpoint;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await webhookSignature(secret, timestamp, body);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = webhookTarget(current, allowPrivate);
    if (!target.ok) return { ok: false, status: null, retryable: false, retryAfterMs: null, error: `blocked target: ${target.error}` };
    let response: Response;
    try {
      response = await fetcher(target.url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'botflow-webhooks/1',
          'x-botflow-delivery': deliveryId,
          'x-botflow-event': eventName,
          'x-botflow-timestamp': timestamp,
          'x-botflow-signature-256': signature,
        },
        body,
      });
    } catch (error) {
      return { ok: false, status: null, retryable: true, retryAfterMs: null, error: error instanceof Error ? error.message.slice(0, 300) : 'network error' };
    }
    if (response.status >= 300 && response.status <= 399) {
      await response.body?.cancel().catch(() => {});
      if (response.status !== 307 && response.status !== 308) {
        return { ok: false, status: response.status, retryable: false, retryAfterMs: null, error: 'redirect would change the signed POST method' };
      }
      const location = response.headers.get('location');
      if (location === null) return { ok: false, status: response.status, retryable: false, retryAfterMs: null, error: 'redirect has no location' };
      try {
        current = new URL(location, target.url).toString();
      } catch {
        return { ok: false, status: response.status, retryable: false, retryAfterMs: null, error: 'redirect location is not a URL' };
      }
      if (hop === MAX_REDIRECTS) return { ok: false, status: response.status, retryable: false, retryAfterMs: null, error: 'too many redirects' };
      continue;
    }
    const status = response.status;
    const wait = retryAfter(response.headers.get('retry-after'), Date.now());
    await response.body?.cancel().catch(() => {});
    if (status >= 200 && status <= 299) return { ok: true, status, retryable: false, retryAfterMs: null, error: null };
    const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
    return { ok: false, status, retryable, retryAfterMs: retryable ? wait : null, error: `HTTP ${status}` };
  }
  return { ok: false, status: null, retryable: false, retryAfterMs: null, error: 'too many redirects' };
}
