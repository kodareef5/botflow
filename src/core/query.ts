// Pure, rebuildable card search (SPEC §5b). The parser deliberately stays
// small: implicit AND, quoted values, one-term negation, and explicit fields.

import type { Analysis, BoardAnalysis } from './analyze.ts';
import { parseBody } from './body.ts';
import { cardFlowMetrics } from './metrics.ts';
import { CANONICAL_STATES, type BoardNode, type Card, type LoadedBoard, type Tree } from './model.ts';

export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryError';
  }
}

interface QueryTerm {
  negated: boolean;
  qualifier: string | null;
  value: string;
}

export interface QueryOptions {
  actor?: string | null | undefined;
  now?: number | Date | undefined;
}

export interface QueryMatch {
  board: string;
  boardName: string;
  card: Card;
  state: string;
  ready: boolean;
}

const QUALIFIERS = new Set([
  'id', 'title', 'board', 'lane', 'state', 'label', 'assignee', 'delegate', 'watcher',
  'voter', 'mention', 'priority', 'type', 'is', 'due',
]);
const IS_VALUES = new Set(['ready', 'blocked', 'overdue', 'stalled', 'evergreen', 'unassigned', 'watched']);
const DUE_VALUES = new Set(['none', 'overdue', 'today', 'future']);

function words(query: string): string[] {
  const out: string[] = [];
  let word = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  const push = (): void => {
    if (word !== '') out.push(word);
    word = '';
  };
  for (const char of query) {
    if (escaped) {
      word += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      else word += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) push();
    else word += char;
  }
  if (escaped) word += '\\';
  if (quote !== null) throw new QueryError(`unterminated ${quote} quote`);
  push();
  return out;
}

function parseTerms(query: string, fieldIds: ReadonlySet<string>): QueryTerm[] {
  return words(query).map((raw) => {
    const negated = raw.startsWith('-') && raw.length > 1;
    const text = negated ? raw.slice(1) : raw;
    const colon = text.indexOf(':');
    if (colon === -1) return { negated, qualifier: null, value: text };
    const qualifier = text.slice(0, colon).toLowerCase();
    const value = text.slice(colon + 1);
    if (value === '') throw new QueryError(`${qualifier}: needs a value`);
    if (qualifier.startsWith('field.')) {
      const id = qualifier.slice('field.'.length);
      if (id === '' || !fieldIds.has(id)) throw new QueryError(`unknown custom field "${id}"`);
    } else if (!QUALIFIERS.has(qualifier)) {
      throw new QueryError(`unknown query qualifier "${qualifier}"`);
    }
    const lower = value.toLowerCase();
    if (qualifier === 'is' && !IS_VALUES.has(lower)) throw new QueryError(`unknown is: predicate "${value}"`);
    if (qualifier === 'due' && !DUE_VALUES.has(lower)) throw new QueryError(`unknown due: predicate "${value}"`);
    if (qualifier === 'state' && !(CANONICAL_STATES as readonly string[]).includes(lower)) {
      throw new QueryError(`unknown state "${value}"`);
    }
    if (qualifier === 'type' && lower !== 'task' && lower !== 'board') throw new QueryError(`unknown card type "${value}"`);
    return { negated, qualifier, value };
  });
}

const includes = (source: unknown, wanted: string): boolean => String(source ?? '').toLowerCase().includes(wanted.toLowerCase());

function fieldText(value: unknown): string {
  if (Array.isArray(value)) return value.map(fieldText).join(' ');
  if (value !== null && typeof value === 'object') return Object.values(value as Record<string, unknown>).map(fieldText).join(' ');
  return String(value ?? '');
}

/** The people currently following a card, including derived roles/mentions
 *  and the subscription on its current lane. Order is stable and duplicate-free. */
export function collaborationAudience(card: Card, board: LoadedBoard): string[] {
  const parsed = parseBody(card.body);
  const candidates = [
    card.assignee,
    card.delegate,
    ...card.watchers,
    ...parsed.mentions,
    ...board.config.subscriptions.filter((item) => item.lane === card.laneId).map((item) => item.watcher),
  ];
  const out: string[] = [];
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== '' && !out.includes(candidate)) out.push(candidate);
  }
  return out;
}

function termMatches(
  term: QueryTerm,
  card: Card,
  node: BoardNode,
  analysis: BoardAnalysis,
  boardKey: string,
  actor: string | null,
  now: number | Date,
): boolean {
  const parsed = parseBody(card.body);
  const state = analysis.canonical.get(card.id) ?? 'todo';
  const ready = analysis.ready.includes(card.id);
  const qualifier = term.qualifier;
  let wanted = term.value;
  if (['assignee', 'delegate', 'watcher', 'voter', 'mention'].includes(qualifier ?? '') && wanted.toLowerCase() === '@me') {
    if (actor === null) return false;
    wanted = actor;
  }
  if (qualifier === null) {
    const custom = node.board.config.customFields.map((field) => fieldText(card.extra[field.id]));
    return includes([
      card.id, card.title, card.body, ...card.labels, card.assignee ?? '', card.delegate ?? '',
      ...card.watchers, ...card.votes, ...custom,
    ].join('\n'), wanted);
  }
  switch (qualifier) {
    case 'id': return includes(card.id, wanted);
    case 'title': return includes(card.title, wanted);
    case 'board': return includes(`${boardKey}\n${node.board.config.name}`, wanted);
    case 'lane': return includes(card.substate === null ? card.laneId : `${card.laneId}.${card.substate}`, wanted);
    case 'state': return state === wanted.toLowerCase();
    case 'label': return card.labels.some((value) => includes(value, wanted));
    case 'assignee': return includes(card.assignee, wanted);
    case 'delegate': return includes(card.delegate, wanted);
    case 'watcher': return card.watchers.some((value) => includes(value, wanted));
    case 'voter': return card.votes.some((value) => includes(value, wanted));
    case 'mention': return parsed.mentions.some((value) => includes(value, wanted));
    case 'priority': return includes(card.priority, wanted);
    case 'type': return card.type === wanted.toLowerCase();
    case 'due': {
      if (wanted.toLowerCase() === 'none') return card.due === null;
      const due = cardFlowMetrics(card, node.board, state, now).due;
      if (due === null || due.status === 'complete') return false;
      if (wanted.toLowerCase() === 'future') return due.status === 'soon' || due.status === 'upcoming';
      return due.status === wanted.toLowerCase();
    }
    case 'is': {
      switch (wanted.toLowerCase()) {
        case 'ready': return ready;
        case 'blocked': return state === 'blocked';
        case 'overdue': return cardFlowMetrics(card, node.board, state, now).due?.status === 'overdue';
        case 'stalled': return cardFlowMetrics(card, node.board, state, now).stalled;
        case 'evergreen': return card.evergreen;
        case 'unassigned': return card.assignee === null;
        case 'watched': return actor !== null && collaborationAudience(card, node.board).some((name) => name.toLowerCase() === actor.toLowerCase());
      }
    }
    default:
      if (qualifier.startsWith('field.')) return includes(fieldText(card.extra[qualifier.slice('field.'.length)]), wanted);
      return false;
  }
}

export function queryCards(tree: Tree, analysis: Analysis, query: string, options: QueryOptions = {}): QueryMatch[] {
  const fieldIds = new Set([...tree.boards.values()].flatMap((node) => node.board.config.customFields.map((field) => field.id)));
  const terms = parseTerms(query, fieldIds);
  const actor = options.actor ?? null;
  const now = options.now ?? Date.now();
  const out: QueryMatch[] = [];
  for (const [boardKey, node] of tree.boards) {
    const boardAnalysis = analysis.boards.get(boardKey);
    if (boardAnalysis === undefined) continue;
    for (const card of node.board.cards) {
      const matches = terms.every((term) => {
        const hit = termMatches(term, card, node, boardAnalysis, boardKey, actor, now);
        return term.negated ? !hit : hit;
      });
      if (matches) out.push({
        board: boardKey,
        boardName: node.board.config.name,
        card,
        state: boardAnalysis.canonical.get(card.id) ?? 'todo',
        ready: boardAnalysis.ready.includes(card.id),
      });
    }
  }
  return out;
}

/** Validate a persisted query without evaluating it. */
export function validateQuery(query: string, fieldIds: ReadonlySet<string>): void {
  parseTerms(query, fieldIds);
}
