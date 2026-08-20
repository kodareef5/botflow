// Provider-neutral email contracts. Botflow does not speak SMTP or trust a
// provider-specific webhook: a small bridge verifies its provider, normalizes
// inbound mail into this shape, and leases outbound messages from ProjectDO.

import type { WebhookEvent } from './webhooks.ts';

export const EMAIL_MAX_RECIPIENTS = 25;
export const EMAIL_MAX_SUBJECT = 300;
export const EMAIL_MAX_TEXT = 100_000;
export const EMAIL_MAX_MESSAGE_ID = 512;
export const EMAIL_INBOUND_HOURLY_CAP = 100;
export const EMAIL_LEASE_MS = 5 * 60 * 1000;
export const EMAIL_MAX_ATTEMPTS = 6;
export const EMAIL_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000] as const;

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export interface NormalizedInboundEmail {
  messageId: string;
  from: string;
  subject: string;
  text: string;
}

export function randomEmailToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `bfmail_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export async function emailTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return hex(new Uint8Array(digest));
}

export function cleanRecipients(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('recipients must be an array of email addresses');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('recipients must contain only email addresses');
    const address = item.trim();
    if (address.length > 254 || !EMAIL_RE.test(address)) throw new Error(`invalid recipient address "${address.slice(0, 80)}"`);
    const key = address.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(address);
    }
    if (out.length > EMAIL_MAX_RECIPIENTS) throw new Error(`at most ${EMAIL_MAX_RECIPIENTS} recipients are allowed`);
  }
  if (out.length === 0) throw new Error('at least one recipient is required');
  return out;
}

function boundedLine(value: unknown, field: string, max: number, required: boolean): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const clean = value.replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ').trim();
  if (required && clean === '') throw new Error(`${field} is required`);
  if (clean.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return clean;
}

export function normalizeInboundEmail(value: unknown): NormalizedInboundEmail {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('a normalized email object is required');
  const input = value as Record<string, unknown>;
  const messageId = boundedLine(input['messageId'], 'messageId', EMAIL_MAX_MESSAGE_ID, true);
  const from = input['from'] === undefined ? '' : boundedLine(input['from'], 'from', 320, false);
  const subject = input['subject'] === undefined ? '' : boundedLine(input['subject'], 'subject', EMAIL_MAX_SUBJECT, false);
  if (typeof input['text'] !== 'string') throw new Error('text must be a string');
  const text = input['text'].replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  if (text.length > EMAIL_MAX_TEXT) throw new Error(`text exceeds ${EMAIL_MAX_TEXT} characters`);
  if (subject === '' && text.trim() === '') throw new Error('subject or text is required');
  return { messageId, from, subject, text };
}

export function outboundEmailPayload(
  projectId: string,
  subscriptionId: string,
  recipients: readonly string[],
  event: WebhookEvent,
): string {
  const card = event.cardId === null ? '' : ` card ${event.cardId}`;
  const subject = `[botflow/${projectId}] ${event.action}${card}`;
  const text = [
    `${event.actor} · ${event.action}${card}`,
    event.detail,
    `Occurred: ${event.ts}`,
    `Project: ${projectId}`,
    `Event: evt_${projectId}_${event.seq}`,
  ].filter(Boolean).join('\n');
  return JSON.stringify({
    schema: 'botflow.email.outbound.v1',
    project: { id: projectId },
    subscription: { id: subscriptionId },
    message: { to: [...recipients], subject, text },
    event: {
      id: `evt_${projectId}_${event.seq}`,
      sequence: event.seq,
      occurred_at: event.ts,
      actor: event.actor,
      action: event.action,
      card_id: event.cardId,
      detail: event.detail,
    },
  });
}
