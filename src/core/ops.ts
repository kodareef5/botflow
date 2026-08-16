// Pure workflow operations: validation and card mutation with no filesystem.
// The CLI's mutate.ts and the hosted ProjectDO both apply moves, claims,
// closes, blocks, and edits through these, so the rules exist exactly once.

import type { BoardConfig, Card, Lane, LoadedBoard } from './model.ts';
import { addAttachmentLine, appendToSection, parseBody, removeAttachmentLine, setChecklistItem } from './body.ts';
import { newHashId, nextSeqId, slugify } from './ids.ts';
import { logMutation, nowDate, nowDateTime } from './write.ts';

/** An error caused by how a tool was invoked: message for the caller, no stack. */
export class UsageError extends Error {}

export function defaultBoardYaml(name: string): string {
  return `botflow: 0
name: ${name}

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
export function opAdd(board: LoadedBoard, opts: AddOptions): Card {
  const config = board.config;
  const type = opts.type ?? 'task';
  if (type === 'board' && !opts.boardPath) throw new UsageError('a board-card needs a board path');

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
    priority: opts.priority ?? null,
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
}

export function opMove(board: LoadedBoard, card: Card, spec: string, actor: string, force = false): MoveResult {
  const target = resolvePosition(board.config, spec);
  const from = positionLabel({ laneId: card.laneId, substate: card.substate });

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

export function opClaim(board: LoadedBoard, card: Card, actor: string): MoveResult {
  const lane = laneByCanonical(board.config, 'doing', 'claim into');
  const from = positionLabel({ laneId: card.laneId, substate: card.substate });
  card.assignee = actor;
  card.laneId = lane.id;
  card.substate = lane.substates.length > 0 ? lane.substates[0]! : null;
  const to = positionLabel({ laneId: card.laneId, substate: card.substate });
  logMutation(card, actor, from === to ? 'claimed' : `claimed, moved ${from} → ${to}`);
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
  card.blocked = reason;
  logMutation(card, actor, `blocked: ${reason}`);
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
    card.priority = patch.priority;
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
  card.body = appendToSection(card.body, 'Comments', `- ${nowDateTime()} ${actor}: ${text}`);
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

export function opAttach(card: Card, actor: string, url: string, label?: string): Card {
  let name = label;
  if (!name) {
    try {
      name = new URL(url).hostname;
    } catch {
      name = url.slice(0, 40);
    }
  }
  card.body = addAttachmentLine(card.body, name, url);
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
