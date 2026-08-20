// Deterministic scheduling projections. Everything here is derived from board
// documents and an injected clock; persistence lives in mutate.ts / ProjectDO.

import { parseBody } from './body.ts';
import { cardFlowMetrics, metricTime } from './metrics.ts';
import type { Card, CardRepeat, LoadedBoard } from './model.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export function dueInstant(value: string | null): number | null {
  const at = metricTime(value);
  if (at === null) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value!) ? at + DAY_MS : at;
}

export function snoozeInstant(value: string | null): number | null {
  return metricTime(value);
}

export function isSnoozed(card: Card, nowValue: number | Date = Date.now()): boolean {
  const now = typeof nowValue === 'number' ? nowValue : nowValue.getTime();
  const at = snoozeInstant(card.snooze);
  return at !== null && at > now;
}

export function reminderText(offset: number, due: string): string {
  return `reminder ${offset}m for due ${due}`;
}

export function reminderWasEmitted(card: Card, offset: number, due: string): boolean {
  const wanted = reminderText(offset, due);
  return parseBody(card.body).log.some((entry) => entry.actor === 'botflow' && entry.text === wanted);
}

export type AutomationPlanItem =
  | { kind: 'reminder'; cardId: string; at: string; offset: number }
  | { kind: 'snooze-expired'; cardId: string; at: string }
  | { kind: 'sweep'; cardId: string; at: string };

function localState(board: LoadedBoard, card: Card): string {
  const canonical = board.config.lanes.find((lane) => lane.id === card.laneId)?.canonical ?? 'todo';
  return card.blocked !== null && canonical !== 'done' && canonical !== 'archive' ? 'blocked' : canonical;
}

/** Every action currently eligible from file truth, sorted by eligibility time
 * then stable card-file order. Applying code takes the bounded first 100. */
export function automationPlan(board: LoadedBoard, nowValue: number | Date = Date.now()): AutomationPlanItem[] {
  const now = typeof nowValue === 'number' ? nowValue : nowValue.getTime();
  const withFile: { item: AutomationPlanItem; file: string; ordinal: number }[] = [];
  for (const card of board.cards) {
    const state = localState(board, card);
    if (state !== 'done' && state !== 'archive' && card.due !== null) {
      const dueAt = dueInstant(card.due);
      if (dueAt !== null) {
        card.reminders.forEach((offset, ordinal) => {
          const at = dueAt - offset * 60_000;
          if (at <= now && !reminderWasEmitted(card, offset, card.due!)) {
            withFile.push({ item: { kind: 'reminder', cardId: card.id, at: new Date(at).toISOString(), offset }, file: card.file, ordinal });
          }
        });
      }
    }
    const snoozeAt = snoozeInstant(card.snooze);
    if (snoozeAt !== null && snoozeAt <= now) {
      withFile.push({ item: { kind: 'snooze-expired', cardId: card.id, at: new Date(snoozeAt).toISOString() }, file: card.file, ordinal: 0 });
    }
    const days = board.config.automation.archiveDoneAfter;
    if (days !== null && state === 'done') {
      const metrics = cardFlowMetrics(card, board, 'done', now);
      const completed = metricTime(metrics.completedAt);
      if (completed !== null) {
        const at = completed + days * DAY_MS;
        if (at <= now) withFile.push({ item: { kind: 'sweep', cardId: card.id, at: new Date(at).toISOString() }, file: card.file, ordinal: 0 });
      }
    }
  }
  const kindOrder = { sweep: 0, 'snooze-expired': 1, reminder: 2 } as const;
  withFile.sort((left, right) => {
    const time = Date.parse(left.item.at) - Date.parse(right.item.at);
    return time || left.file.localeCompare(right.file) || left.ordinal - right.ordinal || kindOrder[left.item.kind] - kindOrder[right.item.kind];
  });
  return withFile.map(({ item }) => item);
}

/** Earliest instant a hosted alarm should revisit this board. Past-due work
 * returns now so the current bounded batch drains promptly. */
export function nextAutomationAt(board: LoadedBoard, nowValue: number | Date = Date.now()): number | null {
  const now = typeof nowValue === 'number' ? nowValue : nowValue.getTime();
  if (automationPlan(board, now).length > 0) return now;
  let next: number | null = null;
  const consider = (at: number | null): void => {
    if (at !== null && at > now && (next === null || at < next)) next = at;
  };
  for (const card of board.cards) {
    const state = localState(board, card);
    if (state !== 'done' && state !== 'archive' && card.due !== null) {
      const dueAt = dueInstant(card.due);
      if (dueAt !== null) {
        for (const offset of card.reminders) {
          if (!reminderWasEmitted(card, offset, card.due)) consider(dueAt - offset * 60_000);
        }
      }
    }
    consider(snoozeInstant(card.snooze));
    const days = board.config.automation.archiveDoneAfter;
    if (days !== null && state === 'done') {
      const completed = metricTime(cardFlowMetrics(card, board, 'done', now).completedAt);
      if (completed !== null) consider(completed + days * DAY_MS);
    }
  }
  return next;
}

function monthShift(date: Date, months: number): Date {
  const out = new Date(date.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

function formatLike(source: string, at: number): string {
  const iso = new Date(at).toISOString();
  return /^\d{4}-\d{2}-\d{2}$/.test(source) ? iso.slice(0, 10) : iso;
}

function addIntervals(source: string, repeat: CardRepeat, count: number): string {
  const at = metricTime(source)!;
  const amount = repeat.every * count;
  if (repeat.unit === 'month') return formatLike(source, monthShift(new Date(at), amount).getTime());
  const days = repeat.unit === 'week' ? amount * 7 : amount;
  return formatLike(source, at + days * DAY_MS);
}

/** Compute the successor's dates at close. `completedAt` is an injected clock
 * instant. The due cadence skips missed slots and start keeps its elapsed
 * offset from due. */
export function nextOccurrenceDates(card: Card, completedAt: number | Date): { start: string | null; due: string } {
  if (card.repeat === null || card.due === null) throw new Error('recurrence requires repeat and due');
  const completed = typeof completedAt === 'number' ? completedAt : completedAt.getTime();
  let due: string;
  if (card.repeat.from === 'completion') {
    const base = formatLike(card.due, completed);
    due = addIntervals(base, card.repeat, 1);
  } else if (card.repeat.unit === 'day' || card.repeat.unit === 'week') {
    const step = card.repeat.every * (card.repeat.unit === 'week' ? 7 : 1) * DAY_MS;
    const oldDeadline = dueInstant(card.due)!;
    const count = Math.max(1, Math.floor((completed - oldDeadline) / step) + 1);
    due = addIntervals(card.due, card.repeat, count);
    while (dueInstant(due)! <= completed) due = addIntervals(due, card.repeat, 1);
  } else {
    const sourceDate = new Date(metricTime(card.due)!);
    const completeDate = new Date(completed);
    const apart = (completeDate.getUTCFullYear() - sourceDate.getUTCFullYear()) * 12 + completeDate.getUTCMonth() - sourceDate.getUTCMonth();
    let count = Math.max(1, Math.floor(apart / card.repeat.every));
    due = addIntervals(card.due, card.repeat, count);
    while (dueInstant(due)! <= completed) {
      count++;
      due = addIntervals(card.due, card.repeat, count);
    }
  }
  let start: string | null = null;
  if (card.start !== null) {
    const gap = metricTime(card.due)! - metricTime(card.start)!;
    start = formatLike(card.start, metricTime(due)! - gap);
  }
  return { start, due };
}
