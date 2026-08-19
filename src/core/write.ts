// Card serialization and Log-section handling (SPEC §5, §12). Pure: the
// filesystem write lives in mutate.ts, DO persistence in the worker.

import { appendToSection } from './body.ts';
import { emitMap } from './emit.ts';
import { joinFrontmatter } from './frontmatter.ts';
import type { Card } from './model.ts';

export function serializeCard(card: Card): string {
  const fm: Record<string, unknown> = {
    id: card.id,
    title: card.title,
    lane: card.substate === null ? card.laneId : `${card.laneId}.${card.substate}`,
  };
  if (card.type === 'board') {
    fm['type'] = 'board';
    fm['board'] = card.boardPath;
  }
  if (card.labels.length > 0) fm['labels'] = card.labels;
  if (card.assignee !== null) fm['assignee'] = card.assignee;
  if (card.priority !== null) fm['priority'] = card.priority;
  if (card.deps.length > 0) fm['deps'] = card.deps;
  if (card.cover !== null) fm['cover'] = card.cover;
  if (card.blocked !== null) fm['blocked'] = card.blocked;
  if (card.created !== null) fm['created'] = card.created;
  if (card.updated !== null) fm['updated'] = card.updated;
  for (const [key, value] of Object.entries(card.extra)) fm[key] = value; // preserved unknown keys
  return joinFrontmatter(emitMap(fm), card.body);
}

/** Append an entry to the (append-only) `## Log` section, creating it if needed. */
export function appendLogLine(body: string, entry: string): string {
  return appendToSection(body, 'Log', `- ${entry}`);
}

export function nowDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function nowDateTime(): string {
  return new Date().toISOString().slice(0, 16).replace('T', ' ');
}

/** One-line-ify text interpolated into structured markdown lines (log/comment
 *  entries, blocked reasons): every run of whitespace or C0/DEL control chars
 *  collapses to a single space, so a `\n- 2020-01-01 alice: …` cannot smuggle
 *  a forged entry into the line structure parseBody reads back. */
export function sanitizeInline(text: string): string {
  return text.replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim();
}

/** Make a url safe for the `- [label](url)` attachment line: whitespace and
 *  control chars are stripped (never valid in a url), and `)` is
 *  percent-encoded so the link syntax cannot be closed early. */
export function sanitizeUrl(url: string): string {
  return url.replace(/[\s\x00-\x1f\x7f]+/g, '').replace(/\)/g, '%29');
}

/** Stamp a log entry onto a card and bump `updated` (SPEC §12 discipline). */
export function logMutation(card: Card, actor: string, message: string): void {
  card.body = appendLogLine(card.body, `${nowDateTime()} ${sanitizeInline(actor)}: ${sanitizeInline(message)}`);
  card.updated = nowDate();
}
