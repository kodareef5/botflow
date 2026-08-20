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
  if (card.delegate !== null) fm['delegate'] = card.delegate;
  if (card.watchers.length > 0) fm['watchers'] = card.watchers;
  if (card.votes.length > 0) fm['votes'] = card.votes;
  if (card.priority !== null) fm['priority'] = card.priority;
  if (card.deps.length > 0) fm['deps'] = card.deps;
  if (card.relations.length > 0) fm['relations'] = card.relations.map((relation) => ({ type: relation.type, target: relation.target, ...relation.extra }));
  if (card.start !== null) fm['start'] = card.start;
  if (card.due !== null) fm['due'] = card.due;
  if (card.reminders.length > 0) fm['reminders'] = card.reminders;
  if (card.repeat !== null) fm['repeat'] = {
    every: card.repeat.every,
    unit: card.repeat.unit,
    ...(card.repeat.from === 'completion' ? { from: card.repeat.from } : {}),
    ...card.repeat.extra,
  };
  if (card.snooze !== null) fm['snooze'] = card.snooze;
  if (card.estimate !== null) fm['estimate'] = card.estimate;
  if (card.evergreen) fm['evergreen'] = true;
  if (card.cover !== null) fm['cover'] = card.cover;
  if (card.coverColor !== null) fm['cover_color'] = card.coverColor;
  if (card.blocked !== null) fm['blocked'] = card.blocked;
  if (card.blocker !== null) fm['blocker'] = card.blocker;
  if (card.created !== null) fm['created'] = card.created;
  if (card.updated !== null) fm['updated'] = card.updated;
  for (const [key, value] of Object.entries(card.extra)) fm[key] = value; // preserved unknown keys
  return joinFrontmatter(emitMap(fm), card.body);
}

/** Append an entry to the (append-only) `## Log` section, creating it if needed. */
export function appendLogLine(body: string, entry: string): string {
  return appendToSection(body, 'Log', `- ${entry}`);
}

export function nowDate(nowValue: number | Date = Date.now()): string {
  return new Date(typeof nowValue === 'number' ? nowValue : nowValue.getTime()).toISOString().slice(0, 10);
}

export function nowDateTime(nowValue: number | Date = Date.now()): string {
  return new Date(typeof nowValue === 'number' ? nowValue : nowValue.getTime()).toISOString().slice(0, 16).replace('T', ' ');
}

/** One-line-ify text interpolated into structured markdown lines (log/comment
 *  entries, blocked reasons): every run of whitespace or C0/DEL control chars
 *  collapses to a single space, so a `\n- 2020-01-01 alice: …` cannot smuggle
 *  a forged entry into the line structure parseBody reads back. */
export function sanitizeInline(text: string): string {
  return text.replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim();
}

/** Make free text safe to drop into a body section. Inline fields collapse to
 *  one line (above); multi-line text cannot, so instead every line that would
 *  read as a section heading gets its marker escaped (`## Log` becomes
 *  `\## Log`, which markdown renders as the literal text the writer typed).
 *  Without this a description can splice a second `## Log` ahead of the real
 *  one; appends target the FIRST matching heading, so the forged section then
 *  captures the append-only audit trail and everything derived from it. */
export function sanitizeBlock(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/^(\s{0,3})(#{1,6})(\s)/gm, '$1\\$2$3');
}

/** A caller-chosen section name is interpolated straight into `## <name>`, so
 *  it must be a single plain line. Returns null when it cannot be one. */
export function sanitizeSectionName(name: string): string | null {
  const clean = sanitizeInline(name);
  return clean === '' || /[#\[\]`]/.test(clean) ? null : clean;
}

/** Make a url safe for the `- [label](url)` attachment line: whitespace and
 *  control chars are stripped (never valid in a url), and `)` is
 *  percent-encoded so the link syntax cannot be closed early. */
export function sanitizeUrl(url: string): string {
  return url.replace(/[\s\x00-\x1f\x7f]+/g, '').replace(/\)/g, '%29');
}

/** An actor name additionally drops `:`. The entry parser splits a log line
 *  on the first `": "`, so an actor containing one is silently truncated on
 *  read-back ("acme: bot" comes back as "acme"), which quietly breaks both the
 *  audit trail and anything derived from it. Messages keep their colons: they
 *  sit after the split point. */
export function sanitizeActor(actor: string): string {
  return sanitizeInline(actor).replace(/:/g, '');
}

/** Stamp a log entry onto a card and bump `updated` (SPEC §12 discipline). */
export function logMutation(
  card: Card,
  actor: string,
  message: string,
  nowValue: number | Date = Date.now(),
  wakeSnooze = true,
): void {
  const woke = wakeSnooze && card.snooze !== null;
  if (woke) card.snooze = null;
  const detail = `${message}${woke ? ' (woke snooze)' : ''}`;
  card.body = appendLogLine(card.body, `${nowDateTime(nowValue)} ${sanitizeActor(actor)}: ${sanitizeInline(detail)}`);
  card.updated = nowDate(nowValue);
}
