// Pure workflow operations: validation and card mutation with no filesystem.
// The CLI's mutate.ts and the hosted ProjectDO both apply moves, claims,
// closes, blocks, and edits through these, so the rules exist exactly once.

import type { AutomationButton, AutomationRuleEvent, BoardConfig, Card, CardRelation, CardRepeat, Lane, LaneSubscription, LoadedBoard, SavedFilter } from './model.ts';
import { RELATION_TYPES } from './model.ts';
import { addAttachmentLine, appendToSection, bodyHasSection, parseBody, removeAttachmentLine, removeSection, setChecklistItem, setSection } from './body.ts';
import { analyze } from './analyze.ts';
import { singleBoardTree } from './docs.ts';
import { emitScalar } from './emit.ts';
import { validCardDate, validEstimate } from './fields.ts';
import { newHashId, nextSeqId, slugify } from './ids.ts';
import { labelGroupConflict, validColor, validCustomFieldValue } from './presentation.ts';
import { parseCardReference, relationInverse } from './refs.ts';
import { QueryError, queryCards, validateQuery } from './query.ts';
import { automationPlan, isSnoozed, nextAutomationAt, nextOccurrenceDates, reminderText, type AutomationPlanItem } from './scheduling.ts';
import { logMutation, nowDate, nowDateTime, sanitizeActor, sanitizeBlock, sanitizeInline, sanitizeSectionName, sanitizeUrl } from './write.ts';

/** An error caused by how a tool was invoked: message for the caller, no stack. */
export class UsageError extends Error {}

/** A claim that lost: the card is not claimable by this actor right now.
 *  Extends UsageError so every surface that already reports usage errors
 *  degrades to a clear message; surfaces that know about claims can read the
 *  structured fields (REST returns 409 with them). */
export class ClaimConflict extends UsageError {
  readonly reason: 'assigned' | 'blocked' | 'snoozed' | 'not-ready' | 'deps';
  /** Current assignee when reason is "assigned". */
  readonly holder: string | null;
  /** The card's current lane[.substate]. */
  readonly position: string;
  constructor(message: string, reason: ClaimConflict['reason'], holder: string | null, position: string) {
    super(message);
    this.reason = reason;
    this.holder = holder;
    this.position = position;
  }
}

export function defaultBoardYaml(name: string): string {
  // emitScalar quotes anything that could escape the value position, so a
  // hostile name cannot inject extra yaml keys.
  return `botflow: 0
name: ${emitScalar(name.replace(/[\r\n]+/g, ' ').trim() || 'board')}

# Six canonical lanes by default. Specialty lanes take \`canonical: <state>\`;
# lanes can carry \`substates: [design, implement, review]\`, \`order: strict\`,
# and \`wip: <n>\`. Spec: https://github.com/botflow: spec/SPEC.md
lanes:
  - id: wishlist
  - id: todo
  - id: doing
  - id: blocked
  - id: done
  - id: archive
`;
}

export function getCard(board: LoadedBoard, id: string): Card {
  const card = board.cards.find((c) => c.id === id);
  if (!card) {
    throw new UsageError(`no card "${id}" on board "${board.config.name}" (${board.cards.length} cards)`);
  }
  return card;
}

export function findLane(config: BoardConfig, laneId: string): Lane {
  const lane = config.lanes.find((l) => l.id === laneId);
  if (!lane) {
    throw new UsageError(`no lane "${laneId}": lanes: ${config.lanes.map((l) => l.id).join(', ')}`);
  }
  return lane;
}

export function laneByCanonical(config: BoardConfig, canonical: string, purpose: string): Lane {
  const lane = config.lanes.find((l) => l.canonical === canonical);
  if (!lane) throw new UsageError(`board has no ${canonical}-canonical lane to ${purpose}`);
  return lane;
}

export interface Position {
  laneId: string;
  substate: string | null;
}

/** Parse and validate `lane[.substate]`, normalizing bare substated lanes to
 *  their first substate. */
export function resolvePosition(config: BoardConfig, spec: string): Position {
  const dot = spec.indexOf('.');
  const laneId = dot === -1 ? spec : spec.slice(0, dot);
  const rawSub = dot === -1 ? null : spec.slice(dot + 1);
  const lane = findLane(config, laneId);
  if (rawSub !== null) {
    if (lane.substates.length === 0) throw new UsageError(`lane "${laneId}" has no substates`);
    if (!lane.substates.includes(rawSub)) {
      throw new UsageError(`"${rawSub}" is not a substate of "${laneId}": substates: ${lane.substates.join(', ')}`);
    }
    return { laneId, substate: rawSub };
  }
  return { laneId, substate: lane.substates.length > 0 ? lane.substates[0]! : null };
}

export function positionLabel(p: Position): string {
  return p.substate === null ? p.laneId : `${p.laneId}.${p.substate}`;
}

/** A child-board reference is a RELATIVE path from the referencing board's
 *  root (SPEC §3) that must not escape it: reject absolute paths and any
 *  path that climbs above the board root, so bad values never reach disk.
 *  `project:` refs are hosted-manager handles, not filesystem paths. */
export function validateBoardPath(boardPath: string): void {
  if (boardPath.startsWith('project:')) return;
  if (/^([\\/]|[A-Za-z]:[\\/])/.test(boardPath)) {
    throw new UsageError(`board path "${boardPath}" must be relative, not absolute`);
  }
  let depth = 0;
  for (const seg of boardPath.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg !== '..') {
      depth++;
      continue;
    }
    depth--;
    if (depth < 0) throw new UsageError(`board path "${boardPath}" escapes the board root`);
  }
}

interface WipDecision {
  warnings: string[];
  log: string | null;
}

function wipEntry(
  board: LoadedBoard,
  targetLaneId: string,
  current: Card | null,
  justification?: string,
  force = false,
): WipDecision {
  if (current?.laneId === targetLaneId) return { warnings: [], log: null };
  const lane = board.config.lanes.find((candidate) => candidate.id === targetLaneId);
  if (lane === undefined || lane.wip === null) return { warnings: [], log: null };
  const count = board.cards.filter((card) => card !== current && card.laneId === lane.id).length + 1;
  if (count <= lane.wip) return { warnings: [], log: null };
  const warning = `wip: lane "${lane.id}" now holds ${count} cards (limit ${lane.wip})`;
  const reason = sanitizeInline(justification ?? '');
  if (lane.wipMode === 'allow') return { warnings: [warning], log: null };
  if (lane.wipMode === 'justify') {
    if (reason === '') throw new UsageError(`lane "${lane.id}" requires a WIP justification (${count}/${lane.wip})`);
    return { warnings: [warning], log: `wip justification for ${lane.id}: ${reason}` };
  }
  if (!force) throw new UsageError(`lane "${lane.id}" denies WIP overflow (${count}/${lane.wip})`);
  if (reason === '') throw new UsageError(`forcing WIP overflow in lane "${lane.id}" requires a justification`);
  return { warnings: [warning], log: `wip override for ${lane.id}: ${reason}` };
}

export interface AddOptions {
  title: string;
  template?: string | undefined;
  lane?: string | undefined;
  type?: 'task' | 'board' | undefined;
  boardPath?: string | undefined;
  labels?: string[] | undefined;
  priority?: string | undefined;
  deps?: string[] | undefined;
  relations?: CardRelation[] | undefined;
  assignee?: string | undefined;
  delegate?: string | undefined;
  start?: string | undefined;
  due?: string | undefined;
  reminders?: number[] | undefined;
  repeat?: CardRepeat | undefined;
  snooze?: string | undefined;
  estimate?: number | undefined;
  evergreen?: boolean | undefined;
  coverColor?: string | undefined;
  fields?: Record<string, unknown> | undefined;
  wipJustification?: string | undefined;
  force?: boolean | undefined;
  /** Initial markdown before the tool-created Log. */
  body?: string | undefined;
  actor: string;
}

/** Build a new card (id allocated, Log opened). Does not persist. */
/** p0-p3, matching the parser. Writing anything else means the very next load
 *  reports a schema finding on a card this tool just wrote. */
const PRIORITY_RE = /^p[0-3]$/;

function checkedPriority(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null || value === '') return value === '' ? null : value;
  if (!PRIORITY_RE.test(value)) throw new UsageError(`priority must be p0, p1, p2 or p3 (got "${value}")`);
  return value;
}

function checkedDate(value: string | null | undefined, field: 'start' | 'due' | 'snooze'): string | null | undefined {
  if (value === undefined || value === null || value === '') return value === '' ? null : value;
  if (!validCardDate(value)) throw new UsageError(`${field} must be YYYY-MM-DD or a UTC ISO datetime`);
  return value;
}

function checkedReminders(values: number[] | null | undefined, due: string | null | undefined): number[] | null | undefined {
  if (values === undefined || values === null) return values;
  const out: number[] = [];
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || out.includes(value)) {
      throw new UsageError('reminders must be unique nonnegative minute offsets');
    }
    out.push(value);
  }
  if (out.length > 0 && (due === null || due === undefined || due === '')) throw new UsageError('reminders require due');
  return out;
}

function checkedRepeat(value: CardRepeat | null | undefined, due: string | null | undefined, type: Card['type']): CardRepeat | null | undefined {
  if (value === undefined || value === null) return value;
  if (!Number.isSafeInteger(value.every) || value.every <= 0) throw new UsageError('repeat.every must be a positive integer');
  if (value.unit !== 'day' && value.unit !== 'week' && value.unit !== 'month') throw new UsageError('repeat.unit must be day, week, or month');
  if (value.from !== 'due' && value.from !== 'completion') throw new UsageError('repeat.from must be due or completion');
  if (due === null || due === undefined || due === '') throw new UsageError('repeat requires due');
  if (type === 'board') throw new UsageError('repeat is not allowed on board-cards');
  return { ...value, extra: { ...(value.extra ?? {}) } };
}

function checkedEstimate(value: number | null | undefined): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (!validEstimate(value)) throw new UsageError('estimate must be a positive integer');
  return value;
}

function cleanActorField(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const clean = sanitizeActor(value);
  return clean === '' ? null : clean;
}

function checkedLabels(labels: string[]): string[] {
  const conflict = labelGroupConflict(labels);
  if (conflict !== null) throw new UsageError(conflict);
  return labels;
}

function checkedCoverColor(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (!validColor(value)) throw new UsageError('cover color must be #RGB or #RRGGBB');
  return value.toLowerCase();
}

function checkedCustomFields(
  board: LoadedBoard | undefined,
  values: Record<string, unknown> | undefined,
  allowClear: boolean,
): Record<string, unknown> {
  if (values === undefined) return {};
  if (board === undefined && Object.keys(values).length > 0) throw new UsageError('custom field edits require board context');
  const clean: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(values)) {
    const definition = board!.config.customFields.find((field) => field.id === id);
    if (definition === undefined) throw new UsageError(`unknown custom field "${id}"`);
    if (value === null && allowClear) {
      clean[id] = null;
      continue;
    }
    if (!validCustomFieldValue(definition, value)) {
      throw new UsageError(`custom field "${id}" must be a valid ${definition.type} value`);
    }
    clean[id] = value;
  }
  return clean;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const leftEntries = Object.entries(left as Record<string, unknown>);
    const rightRecord = right as Record<string, unknown>;
    return leftEntries.length === Object.keys(rightRecord).length && leftEntries.every(([key, value]) => sameValue(value, rightRecord[key]));
  }
  return Object.is(left, right);
}

function checkedCardReferences(values: string[], field: string): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (parseCardReference(value) === null) throw new UsageError(`${field} contains invalid card reference "${value}"`);
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function checkedRelations(values: CardRelation[], ownId?: string): CardRelation[] {
  const out: CardRelation[] = [];
  const seen = new Set<string>();
  for (const relation of values) {
    if (!(RELATION_TYPES as readonly string[]).includes(relation.type)) throw new UsageError(`unknown relation type "${relation.type}"`);
    const parsed = parseCardReference(relation.target);
    if (parsed === null) throw new UsageError(`invalid relation target "${relation.target}"`);
    if (ownId !== undefined && parsed.boardRef === null && parsed.cardId === ownId) throw new UsageError('a card cannot relate to itself');
    const key = `${relation.type}\u0000${relation.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: relation.type, target: relation.target, extra: { ...relation.extra } });
  }
  return out;
}

function ruleFilterMatches(board: LoadedBoard, card: Card, filterId: string | null, actor: string, nowValue: number | Date): boolean {
  if (filterId === null) return true;
  const filter = board.config.savedFilters.find((candidate) => candidate.id === filterId);
  if (filter === undefined) throw new UsageError(`automation rule names missing filter "${filterId}"`);
  const shadow = board.cards.includes(card) ? board : { ...board, cards: [...board.cards, card] };
  const tree = singleBoardTree(shadow);
  const analysis = analyze(tree, nowValue);
  return queryCards(tree, analysis, filter.query, { actor, now: nowValue }).some((match) => match.card.id === card.id);
}

/** Apply safe, non-recursive board rules after one primary event. */
export function applyAutomationRules(
  board: LoadedBoard,
  card: Card,
  event: AutomationRuleEvent,
  actor: string,
  nowValue: number | Date = Date.now(),
): string[] {
  const applied: string[] = [];
  for (const rule of board.config.rules) {
    if (rule.event !== event) continue;
    if (event === 'enter' && rule.lane !== card.laneId) continue;
    if (!ruleFilterMatches(board, card, rule.filter, actor, nowValue)) continue;
    if (applied.length >= 16) throw new UsageError('automation event matches more than 16 rules');
    switch (rule.action) {
      case 'label': {
        if (!card.labels.includes(rule.value)) card.labels = checkedLabels([...card.labels, rule.value]);
        break;
      }
      case 'unlabel':
        card.labels = card.labels.filter((label) => label !== rule.value);
        break;
      case 'assign': {
        const value = cleanActorField(rule.value);
        if (value === null || value === undefined) throw new UsageError(`rule "${rule.id}" has no usable assignee`);
        card.assignee = value;
        break;
      }
      case 'delegate': {
        const value = cleanActorField(rule.value);
        if (value === null || value === undefined) throw new UsageError(`rule "${rule.id}" has no usable delegate`);
        card.delegate = value;
        break;
      }
      case 'comment':
        card.body = appendToSection(card.body, 'Comments', `- ${nowDateTime(nowValue)} botflow: ${sanitizeInline(rule.value)}`);
        break;
    }
    logMutation(card, actor, `rule ${rule.id}: ${rule.action}`, nowValue);
    applied.push(rule.id);
  }
  return applied;
}

export function opAdd(board: LoadedBoard, opts: AddOptions): Card {
  const operationNow = Date.now();
  const config = board.config;
  if (opts.title.trim() === '') throw new UsageError('title required');
  const template = opts.template === undefined ? null : config.templates.find((candidate) => candidate.id === opts.template);
  if (opts.template !== undefined && template === undefined) {
    throw new UsageError(`no template "${opts.template}": templates: ${config.templates.map((candidate) => candidate.id).join(', ') || 'none'}`);
  }
  const type = opts.type ?? 'task';
  if (type === 'board') {
    if (!opts.boardPath) throw new UsageError('a board-card needs a board path');
    validateBoardPath(opts.boardPath);
  }

  const spec = opts.lane ?? template?.lane ?? (config.lanes.find((l) => l.canonical === 'todo') ?? config.lanes[0])?.id;
  if (!spec) throw new UsageError('board has no lanes');
  const pos = resolvePosition(config, spec);
  const wip = wipEntry(board, pos.laneId, null, opts.wipJustification, opts.force === true);
  const start = checkedDate(opts.start ?? template?.start, 'start') ?? null;
  const due = checkedDate(opts.due ?? template?.due, 'due') ?? null;
  const reminders = checkedReminders(opts.reminders ?? [], due) ?? [];
  const repeat = checkedRepeat(opts.repeat, due, type) ?? null;
  const snooze = checkedDate(opts.snooze, 'snooze') ?? null;

  const existing = board.cards.map((c) => c.id);
  const id = config.ids === 'seq' ? nextSeqId(existing) : newHashId(existing);
  const fields = checkedCustomFields(board, { ...(template?.fields ?? {}), ...(opts.fields ?? {}) }, false);
  const body = opts.body ?? template?.body ?? '';
  if (bodyHasSection(body, 'Log')) throw new UsageError('initial card body must not contain a Log section');
  const card: Card = {
    id,
    title: opts.title,
    laneId: pos.laneId,
    substate: pos.substate,
    type,
    boardPath: type === 'board' ? opts.boardPath! : null,
    labels: checkedLabels(opts.labels ?? template?.labels ?? []),
    assignee: cleanActorField(opts.assignee ?? template?.assignee) ?? null,
    delegate: cleanActorField(opts.delegate ?? template?.delegate) ?? null,
    watchers: [],
    votes: [],
    priority: checkedPriority(opts.priority ?? template?.priority) ?? null,
    deps: checkedCardReferences(opts.deps ?? [], 'deps'),
    relations: checkedRelations(opts.relations ?? [], id),
    start,
    due,
    reminders,
    repeat,
    snooze,
    estimate: checkedEstimate(opts.estimate ?? template?.estimate) ?? null,
    evergreen: opts.evergreen ?? template?.evergreen ?? false,
    cover: null,
    coverColor: checkedCoverColor(opts.coverColor ?? template?.coverColor) ?? null,
    blocked: null,
    blocker: null,
    created: nowDate(operationNow),
    updated: null,
    extra: fields,
    file: `cards/${id}-${slugify(opts.title)}.md`,
    body: body.replaceAll('{{title}}', opts.title),
  };
  logMutation(card, opts.actor, `created in ${positionLabel(pos)}`, operationNow, false);
  if (wip.log !== null) logMutation(card, opts.actor, wip.log, operationNow, false);
  applyAutomationRules(board, card, 'enter', opts.actor, operationNow);
  return card;
}

export interface MoveResult {
  card: Card;
  from: string;
  to: string;
  warnings: string[];
  /** Claim no-op: the actor already holds this card in doing. */
  alreadyYours?: boolean;
  /** A close may materialize one recurring successor. */
  created?: Card;
}

export function opMove(
  board: LoadedBoard,
  card: Card,
  spec: string,
  actor: string,
  force = false,
  wipJustification?: string,
): MoveResult {
  const target = resolvePosition(board.config, spec);
  const from = positionLabel({ laneId: card.laneId, substate: card.substate });

  // Same-position move: a successful no-op, like a re-claim — no log entry,
  // no rewrite, and strict-lane adjacency does not apply to standing still.
  if (target.laneId === card.laneId && target.substate === card.substate) {
    return { card, from, to: from, warnings: [] };
  }

  if (card.blocker !== null && !force) throw new UsageError(`card "${card.id}" is blocked by ${card.blocker}; unblock it before moving`);

  const lane = findLane(board.config, target.laneId);
  if (lane.order === 'strict' && lane.substates.length > 0 && !force) {
    if (card.laneId !== lane.id) {
      if (target.substate !== lane.substates[0]) {
        throw new UsageError(`lane "${lane.id}" is strict: enter at "${lane.id}.${lane.substates[0]}" (or force)`);
      }
    } else {
      const cur = lane.substates.indexOf(card.substate ?? lane.substates[0]!);
      const next = lane.substates.indexOf(target.substate!);
      if (Math.abs(cur - next) !== 1) {
        throw new UsageError(
          `lane "${lane.id}" is strict: move one substate at a time (at "${card.substate ?? lane.substates[0]}") (or force)`,
        );
      }
    }
  }

  const wip = wipEntry(board, target.laneId, card, wipJustification, force);

  card.laneId = target.laneId;
  card.substate = target.substate;
  const to = positionLabel(target);
  logMutation(card, actor, `moved ${from} → ${to}`);
  if (wip.log !== null) logMutation(card, actor, wip.log);
  applyAutomationRules(board, card, 'enter', actor);
  return { card, from, to, warnings: wip.warnings };
}

/** A card's canonical state seen locally: blocked flag (outside done/archive)
 *  wins, else the lane's canonical; unknown lanes read as todo, matching
 *  analyze. Board-cards use their lane here: rollup needs children ops
 *  cannot see, and claim is a local coordination question. */
function localCanonical(board: LoadedBoard, card: Card): string {
  const lane = board.config.lanes.find((l) => l.id === card.laneId);
  const laneCanonical = lane?.canonical ?? 'todo';
  const closed = laneCanonical === 'done' || laneCanonical === 'archive';
  return card.blocked !== null && !closed ? 'blocked' : laneCanonical;
}

export type ClaimMode = 'assign' | 'delegate';
export type Claimability = { ok: true; alreadyYours: boolean } | { ok: false; conflict: ClaimConflict };

/** Claim is a coordination primitive (SPEC §12): it succeeds only for a card
 *  that is ready (todo, unblocked, deps done) and unassigned, or already
 *  assigned to the claiming actor. Everything else is a conflict. */
export function claimability(
  board: LoadedBoard,
  card: Card,
  actor: string,
  mode: ClaimMode = 'assign',
  externalDependencies?: Map<string, string | null>,
  nowValue: number | Date = Date.now(),
): Claimability {
  const position = positionLabel({ laneId: card.laneId, substate: card.substate });
  const fail = (message: string, reason: ClaimConflict['reason'], holder: string | null = null): Claimability => ({
    ok: false,
    conflict: new ClaimConflict(`cannot claim ${card.id}: ${message}`, reason, holder, position),
  });

  const state = localCanonical(board, card);
  const holder = mode === 'delegate' ? card.delegate : card.assignee;
  const role = mode === 'delegate' ? 'delegated' : 'assigned';
  if (holder !== null && holder !== actor) {
    return fail(`already ${role} to ${holder} (${position})`, 'assigned', holder);
  }
  if (holder === actor && state === 'doing') return { ok: true, alreadyYours: true };
  if (state === 'blocked') return fail(`blocked: ${card.blocked}`, 'blocked');
  if (isSnoozed(card, nowValue)) return fail(`snoozed until ${card.snooze}`, 'snoozed');
  if (state !== 'todo') return fail(`not ready, it sits in ${position}`, 'not-ready');
  const unmet = card.deps.filter((dep) => {
    const parsed = parseCardReference(dep)!;
    if (parsed.boardRef !== null) {
      const depState = externalDependencies?.get(dep) ?? null;
      return depState !== 'done' && depState !== 'archive';
    }
    const depCard = board.cards.find((c) => c.id === parsed.cardId);
    if (!depCard) return true;
    const depState = localCanonical(board, depCard);
    return depState !== 'done' && depState !== 'archive';
  });
  if (unmet.length > 0) return fail(`deps not done: ${unmet.join(', ')}`, 'deps');
  return { ok: true, alreadyYours: false };
}

export function opClaim(
  board: LoadedBoard,
  card: Card,
  actor: string,
  force = false,
  mode: ClaimMode = 'assign',
  externalDependencies?: Map<string, string | null>,
  wipJustification?: string,
  nowValue: number | Date = Date.now(),
): MoveResult {
  const check = claimability(board, card, actor, mode, externalDependencies, nowValue);
  const reclaimExecution = force && mode === 'assign' && card.delegate !== null;
  if (check.ok && check.alreadyYours && !reclaimExecution) {
    const at = positionLabel({ laneId: card.laneId, substate: card.substate });
    return { card, from: at, to: at, warnings: [], alreadyYours: true };
  }
  if (!check.ok && !force) throw check.conflict;
  const forced = !check.ok || reclaimExecution;
  const lane = laneByCanonical(board.config, 'doing', 'claim into');
  const wip = wipEntry(board, lane.id, card, wipJustification, force);
  const from = positionLabel({ laneId: card.laneId, substate: card.substate });
  if (mode === 'delegate') card.delegate = actor;
  else {
    card.assignee = actor;
    if (forced) card.delegate = null;
  }
  card.laneId = lane.id;
  card.substate = lane.substates.length > 0 ? lane.substates[0]! : null;
  const to = positionLabel({ laneId: card.laneId, substate: card.substate });
  const baseVerb = mode === 'delegate' ? 'delegated' : 'claimed';
  const verb = forced ? `${baseVerb} (forced)` : baseVerb;
  logMutation(card, actor, from === to ? verb : `${verb}, moved ${from} → ${to}`, nowValue);
  if (wip.log !== null) logMutation(card, actor, wip.log, nowValue);
  applyAutomationRules(board, card, 'enter', actor, nowValue);
  return { card, from, to, warnings: wip.warnings };
}

function recurringSuccessor(board: LoadedBoard, source: Card, actor: string, nowValue: number | Date): Card | null {
  if (source.repeat === null || source.due === null || source.type !== 'task') return null;
  const linked = source.relations.find((relation) => relation.type === 'recurs-to');
  if (linked !== undefined && board.cards.some((candidate) => candidate.id === linked.target)) return null;
  const recovered = board.cards.find((candidate) => candidate.relations.some((relation) => relation.type === 'recurs-from' && relation.target === source.id));
  if (recovered !== undefined) {
    addRelation(source, 'recurs-to', recovered.id);
    return null;
  }
  const lane = laneByCanonical(board.config, 'todo', 'create recurring instance in');
  const id = board.config.ids === 'seq'
    ? nextSeqId(board.cards.map((candidate) => candidate.id))
    : newHashId(board.cards.map((candidate) => candidate.id));
  const dates = nextOccurrenceDates(source, nowValue);
  let body = removeSection(removeSection(removeSection(source.body, 'Comments'), 'Boosts'), 'Log');
  for (const item of parseBody(body).checklists.flatMap((checklist) => checklist.items).filter((item) => item.checked)) {
    body = setChecklistItem(body, item.index, false) ?? body;
  }
  const target: Card = {
    ...source,
    id,
    laneId: lane.id,
    substate: lane.substates[0] ?? null,
    assignee: source.assignee,
    delegate: null,
    watchers: [...source.watchers],
    votes: [],
    deps: [...source.deps],
    relations: [{ type: 'recurs-from', target: source.id, extra: {} }],
    start: dates.start,
    due: dates.due,
    reminders: [...source.reminders],
    repeat: source.repeat === null ? null : { ...source.repeat, extra: { ...source.repeat.extra } },
    snooze: null,
    blocked: null,
    blocker: null,
    created: nowDate(nowValue),
    updated: null,
    extra: { ...source.extra },
    file: `cards/${id}-${slugify(source.title)}.md`,
    body,
  };
  logMutation(target, actor, `created in ${positionLabel(target)} (recurs from ${source.id})`, nowValue, false);
  addRelation(source, 'recurs-to', target.id);
  return target;
}

export function opClose(
  board: LoadedBoard,
  card: Card,
  actor: string,
  reason?: string,
  wipJustification?: string,
  force = false,
  nowValue: number | Date = Date.now(),
): MoveResult {
  const lane = laneByCanonical(board.config, 'done', 'close into');
  const from = positionLabel({ laneId: card.laneId, substate: card.substate });
  const wasClosed = localCanonical(board, card) === 'done' || localCanonical(board, card) === 'archive';
  const wip = wipEntry(board, lane.id, card, wipJustification, force);
  const created = wasClosed ? null : recurringSuccessor(board, card, actor, nowValue);
  card.laneId = lane.id;
  card.substate = lane.substates.length > 0 ? lane.substates[lane.substates.length - 1]! : null;
  card.blocked = null;
  card.blocker = null;
  const to = positionLabel({ laneId: card.laneId, substate: card.substate });
  logMutation(card, actor, `closed${reason ? `: ${reason}` : ''}, moved ${from} → ${to}`, nowValue);
  if (created !== null) logMutation(card, actor, `materialized recurrence ${created.id}`, nowValue);
  if (wip.log !== null) logMutation(card, actor, wip.log, nowValue);
  applyAutomationRules(board, card, 'close', actor, nowValue);
  return { card, from, to, warnings: wip.warnings, ...(created === null ? {} : { created }) };
}

export function opBlock(card: Card, actor: string, reason: string, board?: LoadedBoard, blocker?: string): Card {
  if (card.blocked !== null) throw new UsageError(`card "${card.id}" is already blocked; unblock it before changing the reason`);
  const clean = sanitizeInline(reason);
  if (clean === '') throw new UsageError('block reason required');
  if (blocker !== undefined) {
    if (board === undefined) throw new UsageError('named blocker requires board context');
    if (!board.config.blockers.some((candidate) => candidate.id === blocker)) throw new UsageError(`unknown blocker "${blocker}"`);
    card.blocker = blocker;
  } else card.blocker = null;
  card.blocked = clean;
  logMutation(card, actor, blocker === undefined ? `blocked: ${clean}` : `blocked [${blocker}]: ${clean}`);
  if (board !== undefined) applyAutomationRules(board, card, 'block', actor);
  return card;
}

export function opUnblock(card: Card, actor: string): Card {
  if (card.blocked === null) throw new UsageError(`card "${card.id}" is not blocked`);
  card.blocked = null;
  card.blocker = null;
  logMutation(card, actor, 'unblocked');
  return card;
}

export interface EditPatch {
  title?: string | undefined;
  labels?: string[] | undefined;
  priority?: string | null | undefined;
  assignee?: string | null | undefined;
  delegate?: string | null | undefined;
  deps?: string[] | undefined;
  relations?: CardRelation[] | undefined;
  start?: string | null | undefined;
  due?: string | null | undefined;
  reminders?: number[] | null | undefined;
  repeat?: CardRepeat | null | undefined;
  snooze?: string | null | undefined;
  estimate?: number | null | undefined;
  evergreen?: boolean | undefined;
  boardPath?: string | undefined;
  /** Image url, 'none' to suppress card art, or null to clear (auto fallback). */
  cover?: string | null | undefined;
  coverColor?: string | null | undefined;
  /** Declared custom-field values; null clears one. */
  fields?: Record<string, unknown> | undefined;
}

export function opEdit(card: Card, patch: EditPatch, actor: string, board?: LoadedBoard): Card {
  if (patch.title !== undefined && patch.title.trim() === '') throw new UsageError('title required');
  const labels = patch.labels === undefined ? undefined : checkedLabels(patch.labels);
  const priority = patch.priority === undefined ? undefined : (checkedPriority(patch.priority) ?? null);
  const assignee = patch.assignee === undefined ? undefined : (cleanActorField(patch.assignee) ?? null);
  const delegate = patch.delegate === undefined ? undefined : (cleanActorField(patch.delegate) ?? null);
  const start = patch.start === undefined ? undefined : (checkedDate(patch.start, 'start') ?? null);
  const due = patch.due === undefined ? undefined : (checkedDate(patch.due, 'due') ?? null);
  const prospectiveDue = patch.due === undefined ? card.due : due;
  const reminders = patch.reminders === undefined ? undefined : (checkedReminders(patch.reminders, prospectiveDue) ?? []);
  const repeat = patch.repeat === undefined ? undefined : (checkedRepeat(patch.repeat, prospectiveDue, card.type) ?? null);
  const snooze = patch.snooze === undefined ? undefined : (checkedDate(patch.snooze, 'snooze') ?? null);
  if (prospectiveDue === null && (reminders === undefined ? card.reminders.length > 0 : reminders.length > 0)) {
    throw new UsageError('cannot clear due while reminders remain');
  }
  if (prospectiveDue === null && (repeat === undefined ? card.repeat !== null : repeat !== null)) {
    throw new UsageError('cannot clear due while repeat remains');
  }
  const estimate = patch.estimate === undefined ? undefined : (checkedEstimate(patch.estimate) ?? null);
  const coverColor = patch.coverColor === undefined ? undefined : (checkedCoverColor(patch.coverColor) ?? null);
  const fields = checkedCustomFields(board, patch.fields, true);
  const deps = patch.deps === undefined ? undefined : checkedCardReferences(patch.deps, 'deps');
  const relations = patch.relations === undefined ? undefined : checkedRelations(patch.relations, card.id);
  if (patch.boardPath !== undefined) {
    if (card.type !== 'board') throw new UsageError('board path only applies to board-cards');
    validateBoardPath(patch.boardPath);
  }

  const changed: string[] = [];
  if (patch.title !== undefined && patch.title !== card.title) {
    card.title = patch.title;
    changed.push('title');
  }
  if (labels !== undefined && !sameValue(labels, card.labels)) {
    card.labels = labels;
    changed.push('labels');
  }
  if (patch.priority !== undefined && priority !== card.priority) {
    card.priority = priority!;
    changed.push('priority');
  }
  if (patch.assignee !== undefined && assignee !== card.assignee) {
    card.assignee = assignee!;
    changed.push('assignee');
  }
  if (patch.delegate !== undefined && delegate !== card.delegate) {
    card.delegate = delegate!;
    changed.push('delegate');
  }
  if (deps !== undefined && !sameValue(deps, card.deps)) {
    card.deps = deps;
    changed.push('deps');
  }
  if (relations !== undefined && !sameValue(relations, card.relations)) {
    card.relations = relations;
    changed.push('relations');
  }
  if (patch.start !== undefined && start !== card.start) {
    card.start = start!;
    changed.push('start');
  }
  if (patch.due !== undefined && due !== card.due) {
    card.due = due!;
    changed.push('due');
  }
  if (reminders !== undefined && !sameValue(reminders, card.reminders)) {
    card.reminders = reminders;
    changed.push('reminders');
  }
  if (repeat !== undefined && !sameValue(repeat, card.repeat)) {
    card.repeat = repeat;
    changed.push('repeat');
  }
  if (snooze !== undefined && snooze !== card.snooze) {
    card.snooze = snooze;
    changed.push('snooze');
  }
  if (patch.estimate !== undefined && estimate !== card.estimate) {
    card.estimate = estimate!;
    changed.push('estimate');
  }
  if (patch.evergreen !== undefined && patch.evergreen !== card.evergreen) {
    card.evergreen = patch.evergreen;
    changed.push('evergreen');
  }
  if (patch.boardPath !== undefined && patch.boardPath !== card.boardPath) {
    card.boardPath = patch.boardPath;
    changed.push('board');
  }
  if (patch.cover !== undefined && patch.cover !== card.cover) {
    card.cover = patch.cover;
    changed.push('cover');
  }
  if (coverColor !== undefined && coverColor !== card.coverColor) {
    card.coverColor = coverColor;
    changed.push('cover_color');
  }
  for (const [id, value] of Object.entries(fields)) {
    if (value === null) {
      if (!Object.hasOwn(card.extra, id)) continue;
      delete card.extra[id];
    } else {
      if (sameValue(card.extra[id], value)) continue;
      card.extra[id] = value;
    }
    changed.push(`field:${id}`);
  }
  if (changed.length === 0) throw new UsageError('nothing to edit');
  logMutation(card, actor, `edited ${changed.join(', ')}`, Date.now(), patch.snooze === undefined);
  return card;
}

export function opSnooze(card: Card, actor: string, until: string | null): Card {
  const value = checkedDate(until, 'snooze') ?? null;
  if (value === card.snooze) throw new UsageError(value === null ? 'card is not snoozed' : `card is already snoozed until ${value}`);
  card.snooze = value;
  logMutation(card, actor, value === null ? 'woke from snooze' : `snoozed until ${value}`, Date.now(), false);
  return card;
}

export function opLog(card: Card, actor: string, message: string): Card {
  logMutation(card, actor, message);
  return card;
}

/** Append to the card's Comments section (discourse; separate from the Log). */
export function opComment(card: Card, actor: string, text: string): Card {
  if (card.snooze !== null) logMutation(card, actor, 'comment activity', Date.now(), true);
  card.body = appendToSection(card.body, 'Comments', `- ${nowDateTime()} ${sanitizeActor(actor)}: ${sanitizeInline(text)}`);
  card.updated = nowDate();
  return card;
}

export interface ToggleResult {
  card: Card;
  active: boolean;
  changed: boolean;
}

/** Explicit card following. Idempotent toggles do not create merge noise. */
export function opWatch(card: Card, actor: string, watching = true): ToggleResult {
  const name = sanitizeActor(actor);
  if (name === '') throw new UsageError('watcher name required');
  const has = card.watchers.includes(name);
  if (has === watching) return { card, active: watching, changed: false };
  if (watching) card.watchers.push(name);
  else card.watchers.splice(card.watchers.indexOf(name), 1);
  logMutation(card, name, watching ? 'watched card' : 'stopped watching card', Date.now(), false);
  return { card, active: watching, changed: true };
}

/** One current vote per actor. The append-only Log retains withdrawn votes. */
export function opVote(card: Card, actor: string, voting = true): ToggleResult {
  const name = sanitizeActor(actor);
  if (name === '') throw new UsageError('voter name required');
  const has = card.votes.includes(name);
  if (has === voting) return { card, active: voting, changed: false };
  if (voting) card.votes.push(name);
  else card.votes.splice(card.votes.indexOf(name), 1);
  logMutation(card, name, voting ? 'voted' : 'withdrew vote', Date.now(), false);
  return { card, active: voting, changed: true };
}

/** A tiny append-only endorsement. Array.from counts Unicode code points, so
 *  an emoji is one character even though UTF-16 represents it with a pair. */
export function opBoost(card: Card, actor: string, text: string): Card {
  const name = sanitizeActor(actor);
  const clean = sanitizeInline(text);
  if (name === '') throw new UsageError('booster name required');
  if (clean === '') throw new UsageError('boost text required');
  if (Array.from(clean).length > 12) throw new UsageError('boost text must be at most 12 characters');
  if (card.snooze !== null) logMutation(card, name, 'boost activity', Date.now(), true);
  card.body = appendToSection(card.body, 'Boosts', `- ${nowDateTime()} ${name}: ${clean}`);
  card.updated = nowDate();
  return card;
}

export function opSaveFilter(config: BoardConfig, id: string, query: string, name?: string): SavedFilter {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new UsageError('filter id must be a lowercase slug');
  try {
    validateQuery(query, new Set(config.customFields.map((field) => field.id)));
  } catch (err) {
    throw new UsageError((err as QueryError).message);
  }
  const title = sanitizeInline(name ?? id);
  if (title === '') throw new UsageError('filter name required');
  const existing = config.savedFilters.find((filter) => filter.id === id);
  if (existing !== undefined) {
    existing.name = title;
    existing.query = query;
    return existing;
  }
  const filter: SavedFilter = { id, name: title, query, extra: {} };
  config.savedFilters.push(filter);
  return filter;
}

export function opRemoveFilter(config: BoardConfig, id: string): SavedFilter {
  const index = config.savedFilters.findIndex((filter) => filter.id === id);
  if (index === -1) throw new UsageError(`no saved filter "${id}"`);
  return config.savedFilters.splice(index, 1)[0]!;
}

export function opSubscribeLane(config: BoardConfig, lane: string, actor: string, subscribing = true): { subscription: LaneSubscription; changed: boolean; active: boolean } {
  if (!config.lanes.some((candidate) => candidate.id === lane)) throw new UsageError(`no lane "${lane}"`);
  const watcher = sanitizeActor(actor);
  if (watcher === '') throw new UsageError('watcher name required');
  const index = config.subscriptions.findIndex((item) => item.lane === lane && item.watcher === watcher);
  if (subscribing) {
    if (index !== -1) return { subscription: config.subscriptions[index]!, changed: false, active: true };
    const subscription: LaneSubscription = { lane, watcher, extra: {} };
    config.subscriptions.push(subscription);
    return { subscription, changed: true, active: true };
  }
  if (index === -1) return { subscription: { lane, watcher, extra: {} }, changed: false, active: false };
  return { subscription: config.subscriptions.splice(index, 1)[0]!, changed: true, active: false };
}

/** Check/uncheck the Nth task item (global 0-based ordinal across the body). */
export function opCheck(card: Card, actor: string, index: number, checked: boolean): Card {
  const items = parseBody(card.body).checklists.flatMap((c) => c.items);
  const item = items.find((i) => i.index === index);
  if (!item) throw new UsageError(`no checklist item ${index} (card has ${items.length})`);
  const next = setChecklistItem(card.body, index, checked);
  if (next === null) throw new UsageError(`no checklist item ${index}`);
  card.body = next;
  logMutation(card, actor, `${checked ? 'checked' : 'unchecked'} "${item.text}"`);
  return card;
}

/** Replace the card's `## Description` (empty text clears it). */
export function opDescribe(card: Card, actor: string, text: string): Card {
  card.body = setSection(card.body, 'Description', sanitizeBlock(text), 'start');
  card.updated = nowDate();
  logMutation(card, actor, text.trim() === '' ? 'cleared description' : 'edited description');
  return card;
}

/** Append an unchecked task line to a checklist section (created before the
 *  Log if missing, so the audit trail stays last). */
export function opChecklistAdd(card: Card, actor: string, text: string, section = 'Checklist'): Card {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean === '') throw new UsageError('checklist item text required');
  // The section name is interpolated straight into `## <name>`, so it has to
  // be a single plain line; and the Log is append-only audit, never a place
  // to file a task.
  const named = sanitizeSectionName(section);
  if (named === null) throw new UsageError(`"${section}" is not a usable section name`);
  if (named.toLowerCase() === 'log') throw new UsageError('the Log is append-only: pick another section');
  section = named;
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`(^|\\n)## ${escaped}[ \\t]*\\n`).test(card.body)) {
    card.body = setSection(card.body, section, `- [ ] ${clean}`, 'before-log');
  } else {
    card.body = appendToSection(card.body, section, `- [ ] ${clean}`);
  }
  logMutation(card, actor, `added task "${clean}"`);
  return card;
}

function hasRelation(card: Card, type: CardRelation['type'], target: string): boolean {
  return card.relations.some((relation) => relation.type === type && relation.target === target);
}

function addRelation(card: Card, type: CardRelation['type'], target: string): boolean {
  if (hasRelation(card, type, target)) return false;
  card.relations.push({ type, target, extra: {} });
  return true;
}

/** Add a same-board relation and its natural inverse. Idempotent. */
export function opLink(
  board: LoadedBoard,
  sourceId: string,
  targetId: string,
  type: CardRelation['type'],
  actor: string,
): { source: Card; target: Card; changed: boolean } {
  if (!(RELATION_TYPES as readonly string[]).includes(type)) throw new UsageError(`unknown relation type "${type}"`);
  if (sourceId === targetId) throw new UsageError('a card cannot relate to itself');
  const source = getCard(board, sourceId);
  const target = getCard(board, targetId);
  const inverse = relationInverse(type);
  const sourceChanged = addRelation(source, type, target.id);
  const targetChanged = addRelation(target, inverse, source.id);
  if (sourceChanged) logMutation(source, actor, `linked ${type} ${target.id}`);
  if (targetChanged) logMutation(target, actor, `linked ${inverse} ${source.id}`);
  return { source, target, changed: sourceChanged || targetChanged };
}

/** Remove a same-board relation and its inverse. Idempotent. */
export function opUnlink(
  board: LoadedBoard,
  sourceId: string,
  targetId: string,
  type: CardRelation['type'],
  actor: string,
): { source: Card; target: Card; changed: boolean } {
  if (!(RELATION_TYPES as readonly string[]).includes(type)) throw new UsageError(`unknown relation type "${type}"`);
  if (sourceId === targetId) throw new UsageError('a card cannot relate to itself');
  const source = getCard(board, sourceId);
  const target = getCard(board, targetId);
  const inverse = relationInverse(type);
  const sourceLength = source.relations.length;
  const targetLength = target.relations.length;
  source.relations = source.relations.filter((relation) => relation.type !== type || relation.target !== target.id);
  target.relations = target.relations.filter((relation) => relation.type !== inverse || relation.target !== source.id);
  const sourceChanged = source.relations.length !== sourceLength;
  const targetChanged = target.relations.length !== targetLength;
  if (sourceChanged) logMutation(source, actor, `unlinked ${type} ${target.id}`);
  if (targetChanged) logMutation(target, actor, `unlinked ${inverse} ${source.id}`);
  return { source, target, changed: sourceChanged || targetChanged };
}

export interface PromoteOptions {
  title?: string | undefined;
  template?: string | undefined;
  lane?: string | undefined;
  labels?: string[] | undefined;
  priority?: string | undefined;
  assignee?: string | undefined;
  delegate?: string | undefined;
  start?: string | undefined;
  due?: string | undefined;
  estimate?: number | undefined;
  evergreen?: boolean | undefined;
  coverColor?: string | undefined;
  fields?: Record<string, unknown> | undefined;
}

/** Promote an unchecked checklist item into a related card. The caller
 * persists both returned cards in one transaction/lock. */
export function opPromote(
  board: LoadedBoard,
  source: Card,
  index: number,
  actor: string,
  overrides: PromoteOptions = {},
): { source: Card; promoted: Card; item: string } {
  const item = parseBody(source.body).checklists.flatMap((checklist) => checklist.items).find((candidate) => candidate.index === index);
  if (item === undefined) throw new UsageError(`no checklist item ${index}`);
  if (item.checked) throw new UsageError(`checklist item ${index} is already complete`);
  const promoted = opAdd(board, {
    title: overrides.title ?? item.text,
    template: overrides.template,
    lane: overrides.lane,
    labels: overrides.labels ?? source.labels,
    priority: overrides.priority ?? source.priority ?? undefined,
    assignee: overrides.assignee ?? source.assignee ?? undefined,
    delegate: overrides.delegate ?? source.delegate ?? undefined,
    start: overrides.start,
    due: overrides.due ?? source.due ?? undefined,
    estimate: overrides.estimate ?? source.estimate ?? undefined,
    evergreen: overrides.evergreen,
    coverColor: overrides.coverColor,
    fields: overrides.fields,
    actor,
  });
  const nextBody = setChecklistItem(source.body, index, true);
  if (nextBody === null) throw new UsageError(`no checklist item ${index}`);
  source.body = nextBody;
  addRelation(source, 'subtask', promoted.id);
  addRelation(promoted, 'parent', source.id);
  logMutation(source, actor, `promoted task "${item.text}" → ${promoted.id}`);
  logMutation(promoted, actor, `promoted from ${source.id}`);
  return { source, promoted, item: item.text };
}

function dedupeRelations(relations: CardRelation[]): CardRelation[] {
  const seen = new Set<string>();
  return relations.filter((relation) => {
    const key = `${relation.type}\u0000${relation.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Merge a duplicate into its canonical card without deleting either audit
 * trail. All validation precedes mutation; wrappers persist returned cards
 * transactionally. */
export function opMergeDuplicates(
  board: LoadedBoard,
  duplicateId: string,
  canonicalId: string,
  actor: string,
): { duplicate: Card; canonical: Card; changed: Card[]; attachmentsMoved: number; referencesRewired: number } {
  if (duplicateId === canonicalId) throw new UsageError('duplicate and canonical card must differ');
  const duplicate = getCard(board, duplicateId);
  const canonical = getCard(board, canonicalId);
  const archive = laneByCanonical(board.config, 'archive', 'archive duplicate into');
  const duplicateAttachments = parseBody(duplicate.body).attachments;
  const canonicalUrls = new Set(parseBody(canonical.body).attachments.map((attachment) => attachment.url));

  let attachmentsMoved = 0;
  for (const attachment of duplicateAttachments) {
    if (canonicalUrls.has(attachment.url)) continue;
    canonical.body = addAttachmentLine(canonical.body, attachment.label, attachment.url);
    canonicalUrls.add(attachment.url);
    attachmentsMoved++;
  }

  let referencesRewired = 0;
  const changed = new Set<Card>([duplicate, canonical]);
  for (const card of board.cards) {
    if (card === duplicate) continue;
    const deps = [...new Set(card.deps.map((dep) => dep === duplicate.id ? canonical.id : dep))]
      .filter((dep) => !(card === canonical && dep === canonical.id));
    let cardChanged = !sameValue(deps, card.deps);
    card.deps = deps;
    const relations = dedupeRelations(card.relations
      .map((relation) => relation.target === duplicate.id ? { ...relation, target: canonical.id } : relation)
      .filter((relation) => !(card === canonical && relation.target === canonical.id)));
    if (!sameValue(relations, card.relations)) cardChanged = true;
    card.relations = relations;
    if (cardChanged && card !== canonical) {
      referencesRewired++;
      changed.add(card);
      logMutation(card, actor, `rewired duplicate ${duplicate.id} → ${canonical.id}`);
    }
  }
  addRelation(duplicate, 'duplicates', canonical.id);
  addRelation(canonical, 'supersedes', duplicate.id);
  canonical.updated = nowDate();
  logMutation(canonical, actor, `merged duplicate ${duplicate.id}${attachmentsMoved > 0 ? `; transferred ${attachmentsMoved} attachment(s)` : ''}`);
  const from = positionLabel({ laneId: duplicate.laneId, substate: duplicate.substate });
  duplicate.laneId = archive.id;
  duplicate.substate = archive.substates.length > 0 ? archive.substates.at(-1)! : null;
  duplicate.blocked = null;
  duplicate.blocker = null;
  logMutation(duplicate, actor, `marked duplicate of ${canonical.id}, moved ${from} → ${positionLabel(duplicate)}`);
  return { duplicate, canonical, changed: [...changed], attachmentsMoved, referencesRewired };
}

export interface QuickAddCard {
  title: string;
  indent: number;
  parent: number | null;
  options: Omit<AddOptions, 'title' | 'actor'>;
}

interface QuickToken { value: string; quoted: boolean }

function quickTokens(line: string): QuickToken[] {
  const out: QuickToken[] = [];
  let value = '';
  let quote: '"' | "'" | null = null;
  let quoted = false;
  const flush = (): void => {
    if (value !== '') out.push({ value, quoted });
    value = ''; quoted = false;
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote !== null) {
      if (ch === '\\' && i + 1 < line.length) value += line[++i]!;
      else if (ch === quote) { quote = null; quoted = true; }
      else value += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
    } else if (/\s/.test(ch)) flush();
    else value += ch;
  }
  if (quote !== null) throw new UsageError('quick add contains an unterminated quote');
  flush();
  return out;
}

/** Parse quick-add magic without touching a board. Quoted tokens are always
 * title text; unquoted metadata tokens are consumed. */
export function parseQuickAdd(text: string, nowValue: number | Date = Date.now()): QuickAddCard[] {
  const today = new Date(nowValue);
  if (Number.isNaN(today.getTime())) throw new UsageError('invalid quick-add clock');
  const date = (days: number): string => {
    const shifted = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days));
    return shifted.toISOString().slice(0, 10);
  };
  const out: QuickAddCard[] = [];
  const stack: { indent: number; index: number }[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.trim() === '') continue;
    const lead = raw.match(/^[ \t]*/)?.[0] ?? '';
    const indent = [...lead].reduce((sum, char) => sum + (char === '\t' ? 2 : 1), 0);
    const labels: string[] = [];
    const title: string[] = [];
    const options: Omit<AddOptions, 'title' | 'actor'> = {};
    for (const token of quickTokens(raw.slice(lead.length))) {
      if (!token.quoted && token.value.startsWith('*') && token.value.length > 1) labels.push(token.value.slice(1));
      else if (!token.quoted && token.value.startsWith('@') && token.value.length > 1) options.assignee = token.value.slice(1);
      else if (!token.quoted && /^!p[0-3]$/.test(token.value)) options.priority = token.value.slice(1);
      else if (!token.quoted && /^\^[1-9]\d*$/.test(token.value)) options.estimate = Number(token.value.slice(1));
      else if (!token.quoted && token.value.startsWith('~') && token.value.length > 1) options.template = token.value.slice(1);
      else if (!token.quoted && token.value.toLowerCase() === 'today') options.due = date(0);
      else if (!token.quoted && token.value.toLowerCase() === 'tomorrow') options.due = date(1);
      else title.push(token.value);
    }
    if (labels.length > 0) options.labels = labels;
    if (title.length === 0) throw new UsageError(`quick add line ${out.length + 1} has no title`);
    while (stack.length > 0 && stack.at(-1)!.indent >= indent) stack.pop();
    const parent = stack.length > 0 ? stack.at(-1)!.index : null;
    out.push({ title: title.join(' '), indent, parent, options });
    stack.push({ indent, index: out.length - 1 });
  }
  if (out.length === 0) throw new UsageError('quick add requires at least one card');
  return out;
}

/** Validate and instantiate a complete quick-add batch. Existing board cards
 * are never mutated; new parent/child relations are formed within the batch. */
export function opQuickAdd(board: LoadedBoard, text: string, actor: string, nowValue: number | Date = Date.now()): Card[] {
  const parsed = parseQuickAdd(text, nowValue);
  const shadow: LoadedBoard = { ...board, cards: [...board.cards] };
  const cards: Card[] = [];
  for (const [index, item] of parsed.entries()) {
    const card = opAdd(shadow, { ...item.options, title: item.title, actor });
    cards.push(card);
    shadow.cards.push(card);
    if (item.parent !== null) {
      const parent = cards[item.parent]!;
      addRelation(parent, 'subtask', card.id);
      addRelation(card, 'parent', parent.id);
      logMutation(parent, actor, `added subtask ${card.id}`);
      logMutation(card, actor, `linked parent ${parent.id}`);
    }
  }
  return cards;
}

export type BulkAction =
  | { kind: 'move'; to: string; force?: boolean | undefined; wipJustification?: string | undefined }
  | { kind: 'close'; reason?: string | undefined; force?: boolean | undefined; wipJustification?: string | undefined }
  | { kind: 'label'; add?: string[] | undefined; remove?: string[] | undefined };

function cloneCard(card: Card): Card {
  return {
    ...card,
    labels: [...card.labels],
    watchers: [...card.watchers],
    votes: [...card.votes],
    deps: [...card.deps],
    relations: card.relations.map((relation) => ({ ...relation, extra: { ...relation.extra } })),
    reminders: [...card.reminders],
    repeat: card.repeat === null ? null : { ...card.repeat, extra: { ...card.repeat.extra } },
    extra: { ...card.extra },
  };
}

/** Apply one action to many cards after cloning the board. A validation error
 * therefore cannot leave the caller's in-memory board half changed. */
export function opBulk(board: LoadedBoard, ids: string[], action: BulkAction, actor: string): { cards: Card[]; warnings: string[] } {
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new UsageError('bulk action requires at least one card');
  for (const id of unique) getCard(board, id); // validate the complete selection first
  const clone: LoadedBoard = { ...board, cards: board.cards.map(cloneCard) };
  const changed: Card[] = [];
  const warnings: string[] = [];
  for (const id of unique) {
    const card = getCard(clone, id);
    if (action.kind === 'move') {
      const result = opMove(clone, card, action.to, actor, action.force === true, action.wipJustification);
      warnings.push(...result.warnings.map((warning) => `${id}: ${warning}`));
      if (result.from !== result.to) changed.push(card);
    } else if (action.kind === 'close') {
      const result = opClose(clone, card, actor, action.reason, action.wipJustification, action.force === true);
      changed.push(card);
      if (result.created !== undefined) {
        clone.cards.push(result.created);
        changed.push(result.created);
      }
    } else {
      const remove = new Set(action.remove ?? []);
      const labels = [...new Set([...card.labels.filter((label) => !remove.has(label)), ...(action.add ?? [])])];
      if (!sameValue(labels, card.labels)) {
        opEdit(card, { labels }, actor, clone);
        changed.push(card);
      }
    }
  }
  return { cards: changed, warnings };
}

export interface ButtonOptions {
  cardId?: string | undefined;
  force?: boolean | undefined;
  wipJustification?: string | undefined;
  now?: number | Date | undefined;
}

/** Resolve and execute one declarative button as a bounded atomic bulk op. */
export function opButton(
  board: LoadedBoard,
  buttonId: string,
  actor: string,
  options: ButtonOptions = {},
): { button: AutomationButton; cards: Card[]; warnings: string[] } {
  const button = board.config.buttons.find((candidate) => candidate.id === buttonId);
  if (button === undefined) throw new UsageError(`no button "${buttonId}"`);
  let ids: string[];
  if (button.scope === 'card') {
    if (!options.cardId) throw new UsageError(`card button "${buttonId}" requires a card id`);
    getCard(board, options.cardId);
    ids = [options.cardId];
  } else {
    const filter = board.config.savedFilters.find((candidate) => candidate.id === button.filter);
    if (filter === undefined) throw new UsageError(`board button "${buttonId}" names a missing filter`);
    const tree = singleBoardTree(board);
    const analysis = analyze(tree, options.now ?? Date.now());
    ids = queryCards(tree, analysis, filter.query, { actor, now: options.now }).map((match) => match.card.id);
    if (ids.length > 100) throw new UsageError(`board button "${buttonId}" matches ${ids.length} cards; maximum is 100`);
  }
  if (ids.length === 0) return { button, cards: [], warnings: [] };
  const action: BulkAction = button.action === 'move'
    ? { kind: 'move', to: button.value!, force: options.force, wipJustification: options.wipJustification }
    : button.action === 'close'
      ? { kind: 'close', force: options.force, wipJustification: options.wipJustification }
      : { kind: 'label', add: [button.value!] };
  const result = opBulk(board, ids, action, actor);
  return { button, ...result };
}

export interface AutomationPassResult {
  cards: Card[];
  actions: AutomationPlanItem[];
  remaining: boolean;
  nextAt: number | null;
}

/** Apply one bounded, rebuildable automation pass on a cloned board. */
export function opAutomationPass(
  board: LoadedBoard,
  nowValue: number | Date = Date.now(),
  limit = 100,
): AutomationPassResult {
  const now = typeof nowValue === 'number' ? nowValue : nowValue.getTime();
  const cap = Math.max(1, Math.min(100, Math.trunc(limit) || 100));
  const clone: LoadedBoard = { ...board, cards: board.cards.map(cloneCard) };
  const actions = automationPlan(clone, now).slice(0, cap);
  const changed = new Set<Card>();
  for (const action of actions) {
    const card = getCard(clone, action.cardId);
    if (action.kind === 'reminder') {
      if (card.due === null) continue;
      logMutation(card, 'botflow', reminderText(action.offset, card.due), now, false);
    } else if (action.kind === 'snooze-expired') {
      card.snooze = null;
      logMutation(card, 'botflow', 'snooze expired', now, false);
    } else {
      const archive = laneByCanonical(clone.config, 'archive', 'sweep into');
      const from = positionLabel(card);
      card.laneId = archive.id;
      card.substate = archive.substates.at(-1) ?? null;
      card.blocked = null;
      card.blocker = null;
      logMutation(card, 'botflow', `swept ${from} → ${positionLabel(card)} after ${clone.config.automation.archiveDoneAfter} days`, now, false);
    }
    changed.add(card);
  }
  const remaining = automationPlan(clone, now).length > 0;
  return { cards: [...changed], actions, remaining, nextAt: nextAutomationAt(clone, now) };
}

export interface TransferOptions {
  /** Reference to the source card as seen from the target board. */
  sourceRef: string;
  /** Build a reference to the newly allocated target card as seen from source. */
  targetRef: (targetId: string) => string;
  /** Rebase a dependency/relation target from source-board context to target. */
  rewriteReference: (reference: string) => string;
  /** Rebase a board-card path; hosted project refs may be returned unchanged. */
  rewriteBoardPath: (boardPath: string) => string;
  lane?: string | undefined;
  move?: boolean | undefined;
}

/** Copy/move one card between already loaded boards. A move retires the
 * source into archive rather than deleting its history. The wrapper writes
 * target first, then source, so a crash can duplicate but never lose work. */
export function opTransferCard(
  sourceBoard: LoadedBoard,
  targetBoard: LoadedBoard,
  source: Card,
  actor: string,
  options: TransferOptions,
): { source: Card; target: Card; moved: boolean } {
  if (sourceBoard === targetBoard || sourceBoard.rootAbs === targetBoard.rootAbs) throw new UsageError('source and target boards must differ');
  const sourceLane = sourceBoard.config.lanes.find((lane) => lane.id === source.laneId);
  const desired = options.lane
    ?? (targetBoard.config.lanes.some((lane) => lane.id === source.laneId && (source.substate === null || lane.substates.includes(source.substate)))
      ? positionLabel(source)
      : targetBoard.config.lanes.find((lane) => lane.canonical === (sourceLane?.canonical ?? 'todo'))?.id
        ?? targetBoard.config.lanes.find((lane) => lane.canonical === 'todo')?.id
        ?? targetBoard.config.lanes[0]?.id);
  if (desired === undefined) throw new UsageError('target board has no lanes');
  const position = resolvePosition(targetBoard.config, desired);
  const id = targetBoard.config.ids === 'seq'
    ? nextSeqId(targetBoard.cards.map((card) => card.id))
    : newHashId(targetBoard.cards.map((card) => card.id));
  const target = cloneCard(source);
  target.id = id;
  target.laneId = position.laneId;
  target.substate = position.substate;
  target.file = `cards/${id}-${slugify(source.title)}.md`;
  target.boardPath = source.boardPath === null ? null : options.rewriteBoardPath(source.boardPath);
  if (target.boardPath !== null) validateBoardPath(target.boardPath);
  target.deps = checkedCardReferences(source.deps.map(options.rewriteReference), 'deps');
  target.relations = checkedRelations(source.relations.map((relation) => ({
    ...relation,
    target: options.rewriteReference(relation.target),
    extra: { ...relation.extra },
  })), id);
  for (const definition of targetBoard.config.customFields) {
    const value = target.extra[definition.id];
    if (value !== undefined && !validCustomFieldValue(definition, value)) {
      throw new UsageError(`target board custom field "${definition.id}" is incompatible with the source value`);
    }
  }
  checkedLabels(target.labels);
  addRelation(target, 'copied-from', options.sourceRef);
  logMutation(target, actor, `${options.move ? 'moved' : 'copied'} from ${options.sourceRef}`);

  // Only after the target is fully valid do we touch source state.
  addRelation(source, 'copied-to', options.targetRef(target.id));
  if (options.move) {
    const archive = laneByCanonical(sourceBoard.config, 'archive', 'retire transferred source into');
    const from = positionLabel(source);
    source.laneId = archive.id;
    source.substate = archive.substates.length > 0 ? archive.substates.at(-1)! : null;
    source.blocked = null;
    source.blocker = null;
    logMutation(source, actor, `moved to ${options.targetRef(target.id)}, ${from} → ${positionLabel(source)}`);
  } else {
    logMutation(source, actor, `copied to ${options.targetRef(target.id)}`);
  }
  return { source, target, moved: options.move === true };
}

export function opAttach(card: Card, actor: string, url: string, label?: string): Card {
  const cleanUrl = sanitizeUrl(url);
  let name = label === undefined ? label : sanitizeInline(label);
  if (!name) {
    try {
      name = new URL(cleanUrl).hostname;
    } catch {
      name = cleanUrl.slice(0, 40);
    }
  }
  card.body = addAttachmentLine(card.body, name, cleanUrl);
  logMutation(card, actor, `attached ${name}`);
  return card;
}

export function opDetach(card: Card, actor: string, index: number): Card {
  const att = parseBody(card.body).attachments.find((a) => a.index === index);
  if (!att) throw new UsageError(`no attachment ${index}`);
  const next = removeAttachmentLine(card.body, index);
  if (next === null) throw new UsageError(`no attachment ${index}`);
  card.body = next;
  logMutation(card, actor, `removed attachment ${att.label}`);
  return card;
}
