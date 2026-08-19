// Pure workflow operations: validation and card mutation with no filesystem.
// The CLI's mutate.ts and the hosted ProjectDO both apply moves, claims,
// closes, blocks, and edits through these, so the rules exist exactly once.

import type { BoardConfig, Card, Lane, LoadedBoard } from './model.ts';
import { addAttachmentLine, appendToSection, parseBody, removeAttachmentLine, setChecklistItem, setSection } from './body.ts';
import { emitScalar } from './emit.ts';
import { newHashId, nextSeqId, slugify } from './ids.ts';
import { logMutation, nowDate, nowDateTime, sanitizeActor, sanitizeBlock, sanitizeInline, sanitizeSectionName, sanitizeUrl } from './write.ts';

/** An error caused by how a tool was invoked: message for the caller, no stack. */
export class UsageError extends Error {}

/** A claim that lost: the card is not claimable by this actor right now.
 *  Extends UsageError so every surface that already reports usage errors
 *  degrades to a clear message; surfaces that know about claims can read the
 *  structured fields (REST returns 409 with them). */
export class ClaimConflict extends UsageError {
  readonly reason: 'assigned' | 'blocked' | 'not-ready' | 'deps';
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

function wipWarnings(board: LoadedBoard, moved: Card): string[] {
  const lane = board.config.lanes.find((l) => l.id === moved.laneId);
  if (!lane || lane.wip === null) return [];
  const inBoard = board.cards.includes(moved);
  const count = board.cards.filter((c) => c.laneId === lane.id).length + (inBoard ? 0 : 1);
  return count > lane.wip ? [`wip: lane "${lane.id}" now holds ${count} cards (limit ${lane.wip})`] : [];
}

export interface AddOptions {
  title: string;
  lane?: string | undefined;
  type?: 'task' | 'board' | undefined;
  boardPath?: string | undefined;
  labels?: string[] | undefined;
  priority?: string | undefined;
  deps?: string[] | undefined;
  assignee?: string | undefined;
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

export function opAdd(board: LoadedBoard, opts: AddOptions): Card {
  const config = board.config;
  const type = opts.type ?? 'task';
  if (type === 'board') {
    if (!opts.boardPath) throw new UsageError('a board-card needs a board path');
    validateBoardPath(opts.boardPath);
  }

  const spec = opts.lane ?? (config.lanes.find((l) => l.canonical === 'todo') ?? config.lanes[0])?.id;
  if (!spec) throw new UsageError('board has no lanes');
  const pos = resolvePosition(config, spec);

  const existing = board.cards.map((c) => c.id);
  const id = config.ids === 'seq' ? nextSeqId(existing) : newHashId(existing);
  const card: Card = {
    id,
    title: opts.title,
    laneId: pos.laneId,
    substate: pos.substate,
    type,
    boardPath: type === 'board' ? opts.boardPath! : null,
    labels: opts.labels ?? [],
    assignee: opts.assignee ?? null,
    priority: checkedPriority(opts.priority) ?? null,
    deps: opts.deps ?? [],
    cover: null,
    blocked: null,
    created: nowDate(),
    updated: null,
    extra: {},
    file: `cards/${id}-${slugify(opts.title)}.md`,
    body: '',
  };
  logMutation(card, opts.actor, `created in ${positionLabel(pos)}`);
  return card;
}

export interface MoveResult {
  card: Card;
  from: string;
  to: string;
  warnings: string[];
  /** Claim no-op: the actor already holds this card in doing. */
  alreadyYours?: boolean;
}

export function opMove(board: LoadedBoard, card: Card, spec: string, actor: string, force = false): MoveResult {
  const target = resolvePosition(board.config, spec);
  const from = positionLabel({ laneId: card.laneId, substate: card.substate });

  // Same-position move: a successful no-op, like a re-claim — no log entry,
  // no rewrite, and strict-lane adjacency does not apply to standing still.
  if (target.laneId === card.laneId && target.substate === card.substate) {
    return { card, from, to: from, warnings: [] };
  }

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

  card.laneId = target.laneId;
  card.substate = target.substate;
  const to = positionLabel(target);
  logMutation(card, actor, `moved ${from} → ${to}`);
  return { card, from, to, warnings: wipWarnings(board, card) };
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

export type Claimability = { ok: true; alreadyYours: boolean } | { ok: false; conflict: ClaimConflict };

/** Claim is a coordination primitive (SPEC §12): it succeeds only for a card
 *  that is ready (todo, unblocked, deps done) and unassigned, or already
 *  assigned to the claiming actor. Everything else is a conflict. */
export function claimability(board: LoadedBoard, card: Card, actor: string): Claimability {
  const position = positionLabel({ laneId: card.laneId, substate: card.substate });
  const fail = (message: string, reason: ClaimConflict['reason'], holder: string | null = null): Claimability => ({
    ok: false,
    conflict: new ClaimConflict(`cannot claim ${card.id}: ${message}`, reason, holder, position),
  });

  const state = localCanonical(board, card);
  if (card.assignee !== null && card.assignee !== actor) {
    return fail(`already assigned to ${card.assignee} (${position})`, 'assigned', card.assignee);
  }
  if (card.assignee === actor && state === 'doing') return { ok: true, alreadyYours: true };
  if (state === 'blocked') return fail(`blocked: ${card.blocked}`, 'blocked');
  if (state !== 'todo') return fail(`not ready, it sits in ${position}`, 'not-ready');
  const unmet = card.deps.filter((dep) => {
    const depCard = board.cards.find((c) => c.id === dep);
    if (!depCard) return true;
    const depState = localCanonical(board, depCard);
    return depState !== 'done' && depState !== 'archive';
  });
  if (unmet.length > 0) return fail(`deps not done: ${unmet.join(', ')}`, 'deps');
  return { ok: true, alreadyYours: false };
}

export function opClaim(board: LoadedBoard, card: Card, actor: string, force = false): MoveResult {
  const check = claimability(board, card, actor);
  if (check.ok && check.alreadyYours) {
    const at = positionLabel({ laneId: card.laneId, substate: card.substate });
    return { card, from: at, to: at, warnings: [], alreadyYours: true };
  }
  if (!check.ok && !force) throw check.conflict;
  const forced = !check.ok;
  const lane = laneByCanonical(board.config, 'doing', 'claim into');
  const from = positionLabel({ laneId: card.laneId, substate: card.substate });
  card.assignee = actor;
  card.laneId = lane.id;
  card.substate = lane.substates.length > 0 ? lane.substates[0]! : null;
  const to = positionLabel({ laneId: card.laneId, substate: card.substate });
  const verb = forced ? 'claimed (forced)' : 'claimed';
  logMutation(card, actor, from === to ? verb : `${verb}, moved ${from} → ${to}`);
  return { card, from, to, warnings: wipWarnings(board, card) };
}

export function opClose(board: LoadedBoard, card: Card, actor: string, reason?: string): MoveResult {
  const lane = laneByCanonical(board.config, 'done', 'close into');
  const from = positionLabel({ laneId: card.laneId, substate: card.substate });
  card.laneId = lane.id;
  card.substate = lane.substates.length > 0 ? lane.substates[lane.substates.length - 1]! : null;
  card.blocked = null;
  const to = positionLabel({ laneId: card.laneId, substate: card.substate });
  logMutation(card, actor, `closed${reason ? `: ${reason}` : ''}`);
  return { card, from, to, warnings: [] };
}

export function opBlock(card: Card, actor: string, reason: string): Card {
  const clean = sanitizeInline(reason);
  card.blocked = clean;
  logMutation(card, actor, `blocked: ${clean}`);
  return card;
}

export function opUnblock(card: Card, actor: string): Card {
  if (card.blocked === null) throw new UsageError(`card "${card.id}" is not blocked`);
  card.blocked = null;
  logMutation(card, actor, 'unblocked');
  return card;
}

export interface EditPatch {
  title?: string | undefined;
  labels?: string[] | undefined;
  priority?: string | null | undefined;
  assignee?: string | null | undefined;
  deps?: string[] | undefined;
  boardPath?: string | undefined;
  /** Image url, 'none' to suppress card art, or null to clear (auto fallback). */
  cover?: string | null | undefined;
}

export function opEdit(card: Card, patch: EditPatch, actor: string): Card {
  const changed: string[] = [];
  if (patch.title !== undefined && patch.title !== card.title) {
    card.title = patch.title;
    changed.push('title');
  }
  if (patch.labels !== undefined) {
    card.labels = patch.labels;
    changed.push('labels');
  }
  if (patch.priority !== undefined) {
    card.priority = checkedPriority(patch.priority) ?? null;
    changed.push('priority');
  }
  if (patch.assignee !== undefined) {
    card.assignee = patch.assignee;
    changed.push('assignee');
  }
  if (patch.deps !== undefined) {
    card.deps = patch.deps;
    changed.push('deps');
  }
  if (patch.boardPath !== undefined) {
    if (card.type !== 'board') throw new UsageError('board path only applies to board-cards');
    validateBoardPath(patch.boardPath);
    card.boardPath = patch.boardPath;
    changed.push('board');
  }
  if (patch.cover !== undefined) {
    card.cover = patch.cover;
    changed.push('cover');
  }
  if (changed.length === 0) throw new UsageError('nothing to edit');
  logMutation(card, actor, `edited ${changed.join(', ')}`);
  return card;
}

export function opLog(card: Card, actor: string, message: string): Card {
  logMutation(card, actor, message);
  return card;
}

/** Append to the card's Comments section (discourse; separate from the Log). */
export function opComment(card: Card, actor: string, text: string): Card {
  card.body = appendToSection(card.body, 'Comments', `- ${nowDateTime()} ${sanitizeActor(actor)}: ${sanitizeInline(text)}`);
  card.updated = nowDate();
  return card;
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
