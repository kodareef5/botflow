// Deterministic projections over the append-only card Log (SPEC §6a). Nothing
// here writes format data; callers inject `now` in tests and use the clock in
// views. Historic date-only entries deliberately yield whole-day precision.

import { parseBody, type BodyEntry } from './body.ts';
import type { Canonical, Card, Distribution, LoadedBoard } from './model.ts';
import { emptyDistribution } from './model.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const POSITION = '([^\\s,;]+)';
const DIRECT_MOVE_RE = new RegExp(`^(?:moved|migrated|swept)\\s+${POSITION}\\s+→\\s+${POSITION}`);
const LEGACY_TRANSFER_RE = new RegExp(`^moved\\s+to\\s+[^,]+,\\s*${POSITION}\\s+→\\s+${POSITION}`);
const EMBEDDED_MOVE_RE = new RegExp(`(?:^|,\\s*)moved\\s+${POSITION}\\s+→\\s+${POSITION}`, 'g');
const CREATED_RE = /^created in\s+([^\s,;]+)/;

type TimedEntry = BodyEntry & { at: number; order: number };

export interface FlowEvent {
  at: number;
  state: Canonical;
  lane: string;
}

export interface StagnationSignal {
  days: number;
  dots: number;
  tone: 'none' | 'grey' | 'yellow' | 'red';
}

export interface CardFlowMetrics {
  lastActivity: string | null;
  idleDays: number | null;
  currentLaneDays: number | null;
  cumulativeLaneDays: number | null;
  laneDays: Record<string, number>;
  stagnation: StagnationSignal;
  stalled: boolean;
  agingLevel: 0 | 1 | 2 | 3;
  cycleDays: number | null;
  leadDays: number | null;
  dueChanges: number;
  blockedDays: number | null;
  blockerDays: Record<string, number>;
  completedAt: string | null;
  due: null | { status: 'complete' | 'overdue' | 'today' | 'soon' | 'upcoming'; days: number };
}

export interface BoardFlowMetrics {
  throughput: { date: string; count: number }[];
  cumulativeFlow: { date: string; distribution: Distribution }[];
  blockerDays: Record<string, number>;
}

/** Parse the date forms the format writes. A date-only value is midnight UTC. */
export function metricTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T00:00:00Z`
    : /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(value)
      ? `${value.replace(' ', 'T')}Z`
      : value;
  const at = Date.parse(normalized);
  return Number.isNaN(at) ? null : at;
}

const wholeDays = (from: number, to: number): number => Math.max(0, Math.floor((to - from) / DAY_MS));
const laneOf = (position: string): string => position.split('.')[0] ?? position;

function laneState(board: LoadedBoard, lane: string): Canonical {
  return board.config.lanes.find((item) => item.id === lane)?.canonical ?? 'todo';
}

function timedLog(card: Card): TimedEntry[] {
  return parseBody(card.body).log
    .map((entry, order) => ({ ...entry, at: metricTime(entry.when) ?? Number.NaN, order }))
    .filter((entry) => !Number.isNaN(entry.at))
    .sort((a, b) => a.at - b.at || a.order - b.order);
}

function initialPosition(entries: TimedEntry[]): { lane: string; at: number } | null {
  for (const entry of entries) {
    const created = CREATED_RE.exec(entry.text);
    if (created) return { lane: laneOf(created[1]!), at: entry.at };
  }
  return null;
}

/** Read only transition clauses emitted by botflow mutation verbs. Closing
 * reasons are user text and may themselves contain an arrow-shaped phrase, so
 * embedded close/claim transitions use the final tool-appended clause. */
function transition(text: string): { from: string; to: string } | null {
  const direct = DIRECT_MOVE_RE.exec(text) ?? LEGACY_TRANSFER_RE.exec(text);
  if (direct) return { from: direct[1]!, to: direct[2]! };
  if (!/^(?:claimed|delegated|closed)\b/.test(text)) return null;
  let found: RegExpExecArray | null = null;
  EMBEDDED_MOVE_RE.lastIndex = 0;
  for (let match = EMBEDDED_MOVE_RE.exec(text); match !== null; match = EMBEDDED_MOVE_RE.exec(text)) found = match;
  return found === null ? null : { from: found[1]!, to: found[2]! };
}

/** Replay only states and lane positions the Log proves. Current frontmatter
 *  is intentionally not spliced into an incomplete historic tail: doing so
 *  would manufacture transition dates and violate SPEC §6a's null rule. */
export function cardFlowEvents(card: Card, board: LoadedBoard): FlowEvent[] {
  const entries = timedLog(card);
  const initial = initialPosition(entries);
  const out: FlowEvent[] = [];
  let lane = initial?.lane ?? card.laneId;
  let state = laneState(board, lane);
  let flagBlocked = false;
  const push = (event: FlowEvent): void => {
    const previous = out.at(-1);
    if (previous?.at === event.at && previous.lane === event.lane && previous.state === event.state) return;
    out.push(event);
  };
  if (initial) push({ at: initial.at, lane, state });

  for (const entry of entries) {
    const move = transition(entry.text);
    if (move) {
      lane = laneOf(move.to);
      const laneCanonical = laneState(board, lane);
      state = flagBlocked && laneCanonical !== 'done' && laneCanonical !== 'archive' ? 'blocked' : laneCanonical;
      push({ at: entry.at, lane, state });
    }
    if (/^blocked(?: \[[a-z0-9][a-z0-9-]*\])?:/.test(entry.text) && state !== 'done' && state !== 'archive') {
      flagBlocked = true;
      state = 'blocked';
      push({ at: entry.at, lane, state });
    } else if (/^unblocked\b/.test(entry.text)) {
      flagBlocked = false;
      state = laneState(board, lane);
      push({ at: entry.at, lane, state });
    }
    if (/^closed\b/.test(entry.text)) {
      // v0 close entries did not include a move. The operation contract still
      // proves entry into the board's first done lane at this timestamp.
      if (state !== 'done') lane = board.config.lanes.find((item) => item.canonical === 'done')?.id ?? lane;
      flagBlocked = false;
      state = 'done';
      push({ at: entry.at, lane, state });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

function stagnation(days: number | null): StagnationSignal {
  if (days === null || days < 1) return { days: days ?? 0, dots: 0, tone: 'none' };
  if (days < 3) return { days, dots: 1, tone: 'grey' };
  if (days < 5) return { days, dots: 1, tone: 'yellow' };
  return { days, dots: Math.min(4, Math.max(1, Math.floor(days / 5))), tone: 'red' };
}

function dueMetric(card: Card, state: Canonical, now: number): CardFlowMetrics['due'] {
  if (card.due === null) return null;
  const at = metricTime(card.due);
  if (at === null) return null;
  if (state === 'done' || state === 'archive') return { status: 'complete', days: 0 };
  let days: number;
  if (/^\d{4}-\d{2}-\d{2}$/.test(card.due)) {
    days = Math.floor(at / DAY_MS) - Math.floor(now / DAY_MS);
  } else {
    const delta = at - now;
    days = delta < 0 ? -Math.ceil(Math.abs(delta) / DAY_MS) : Math.ceil(delta / DAY_MS);
  }
  return { status: days < 0 ? 'overdue' : days === 0 ? 'today' : days <= 3 ? 'soon' : 'upcoming', days };
}

export function cardFlowMetrics(card: Card, board: LoadedBoard, current: Canonical, nowValue: number | Date = Date.now()): CardFlowMetrics {
  const now = typeof nowValue === 'number' ? nowValue : nowValue.getTime();
  const entries = timedLog(card);
  const events = cardFlowEvents(card, board);
  const last = entries.filter((entry) => !(entry.actor === 'botflow' && (/^reminder \d+m for due /.test(entry.text) || entry.text === 'snooze expired'))).at(-1);
  const lastAt = last?.at ?? null;
  const idleDays = lastAt === null ? null : wholeDays(lastAt, now);

  const laneMs = new Map<string, number>();
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const end = events[i + 1]?.at ?? now;
    if (end > event.at) laneMs.set(event.lane, (laneMs.get(event.lane) ?? 0) + end - event.at);
  }
  const laneDays = Object.fromEntries([...laneMs].map(([lane, ms]) => [lane, Math.floor(ms / DAY_MS)]));
  // State-only events (blocked/unblocked) split an interval for blocked-time
  // accounting, but they are not a lane entry. Only a changed lane resets the
  // local clock; returning to a lane later deliberately does.
  let previousLane: string | null = null;
  let currentLaneAt: number | null = null;
  for (const event of events) {
    if (event.lane === previousLane) continue;
    previousLane = event.lane;
    if (event.lane === card.laneId) currentLaneAt = event.at;
  }
  const currentLaneDays = currentLaneAt === null ? null : wholeDays(currentLaneAt, now);
  const cumulativeLaneDays = laneMs.has(card.laneId) ? Math.floor(laneMs.get(card.laneId)! / DAY_MS) : null;

  const firstDoing = events.find((event) => event.state === 'doing')?.at ?? null;
  const firstDone = events.find((event) => event.state === 'done')?.at ?? null;
  const createdAt = metricTime(card.created) ?? initialPosition(entries)?.at ?? null;
  let blockedMs = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.state !== 'blocked') continue;
    const end = events[i + 1]?.at ?? now;
    if (end > events[i]!.at) blockedMs += end - events[i]!.at;
  }
  const blockerMs = new Map<string, number>();
  let activeBlocker: { id: string; at: number } | null = null;
  const closeBlocker = (at: number): void => {
    if (activeBlocker !== null && at > activeBlocker.at) {
      blockerMs.set(activeBlocker.id, (blockerMs.get(activeBlocker.id) ?? 0) + at - activeBlocker.at);
    }
    activeBlocker = null;
  };
  for (const entry of entries) {
    const match = /^blocked(?: \[([a-z0-9][a-z0-9-]*)\])?:/.exec(entry.text);
    if (match) {
      closeBlocker(entry.at);
      activeBlocker = { id: match[1] ?? 'unclassified', at: entry.at };
    } else if (/^(?:unblocked|closed)\b/.test(entry.text)) {
      closeBlocker(entry.at);
    }
  }
  closeBlocker(now);
  const blockerDays = Object.fromEntries([...blockerMs]
    .map(([id, milliseconds]) => [id, Math.floor(milliseconds / DAY_MS)] as const)
    .filter(([, days]) => days > 0));

  const agingLevel: 0 | 1 | 2 | 3 = card.evergreen || (current !== 'doing' && current !== 'blocked') || idleDays === null
    ? 0
    : idleDays >= 28 ? 3 : idleDays >= 14 ? 2 : idleDays >= 7 ? 1 : 0;
  return {
    lastActivity: last?.when ?? null,
    idleDays,
    currentLaneDays,
    cumulativeLaneDays,
    laneDays,
    stagnation: stagnation(cumulativeLaneDays),
    stalled: !card.evergreen && current === 'doing' && idleDays !== null && idleDays >= 3,
    agingLevel,
    cycleDays: firstDoing !== null && firstDone !== null && firstDone >= firstDoing ? wholeDays(firstDoing, firstDone) : null,
    leadDays: createdAt !== null && firstDone !== null && firstDone >= createdAt ? wholeDays(createdAt, firstDone) : null,
    dueChanges: entries.filter((entry) => {
      const edited = /^edited (.+)$/.exec(entry.text.replace(/ \(woke snooze\)$/, ''));
      return edited !== null && edited[1]!.split(', ').includes('due');
    }).length,
    blockedDays: current === 'blocked' && events.at(-1)?.state !== 'blocked' ? null : Math.floor(blockedMs / DAY_MS),
    blockerDays,
    completedAt: firstDone === null ? null : new Date(firstDone).toISOString(),
    due: dueMetric(card, current, now),
  };
}

function stateAt(events: FlowEvent[], cutoff: number): Canonical | null {
  let state: Canonical | null = null;
  for (const event of events) {
    if (event.at > cutoff) break;
    state = event.state;
  }
  return state;
}

export function boardFlowMetrics(
  board: LoadedBoard,
  nowValue: number | Date = Date.now(),
  days = 30,
): BoardFlowMetrics {
  const now = typeof nowValue === 'number' ? nowValue : nowValue.getTime();
  const count = Math.max(1, Math.min(366, Math.trunc(days) || 30));
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const histories = board.cards.map((card) => ({ card, events: cardFlowEvents(card, board) }));
  const blockerDays: Record<string, number> = {};
  for (const card of board.cards) {
    const laneState = board.config.lanes.find((lane) => lane.id === card.laneId)?.canonical ?? 'todo';
    const state = card.blocked !== null && laneState !== 'done' && laneState !== 'archive' ? 'blocked' : laneState;
    for (const [id, value] of Object.entries(cardFlowMetrics(card, board, state, now).blockerDays)) {
      blockerDays[id] = (blockerDays[id] ?? 0) + value;
    }
  }
  const throughputByDay = new Map<string, number>();
  for (const { events } of histories) {
    const done = events.find((event) => event.state === 'done');
    if (!done) continue;
    const date = new Date(done.at).toISOString().slice(0, 10);
    throughputByDay.set(date, (throughputByDay.get(date) ?? 0) + 1);
  }

  const throughput: BoardFlowMetrics['throughput'] = [];
  const cumulativeFlow: BoardFlowMetrics['cumulativeFlow'] = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const start = today - offset * DAY_MS;
    const cutoff = offset === 0 ? now : start + DAY_MS - 1;
    const date = new Date(start).toISOString().slice(0, 10);
    const distribution = emptyDistribution();
    for (const { events } of histories) {
      const state = stateAt(events, cutoff);
      if (state !== null) distribution[state]++;
    }
    throughput.push({ date, count: throughputByDay.get(date) ?? 0 });
    cumulativeFlow.push({ date, distribution });
  }
  return { throughput, cumulativeFlow, blockerDays };
}
