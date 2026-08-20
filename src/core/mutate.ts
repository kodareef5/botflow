// Filesystem wrappers over the pure operations in ops.ts: every mutation
// takes the board lock, loads the board fresh from files, applies the op, and
// atomically rewrites the one card it touches (SPEC §12). Files stay the
// single source of truth, and two processes on the same tree cannot interleave
// load-mutate-write or mint the same seq id.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import type { Card, LoadedBoard } from './model.ts';
import { analyze } from './analyze.ts';
import { emitBoardYaml } from './config.ts';
import { loadBoard, loadTree, resolveBoardRoot } from './load.ts';
import { logMutation, serializeCard } from './write.ts';
import { parseCardReference } from './refs.ts';
import {
  UsageError,
  defaultBoardYaml,
  getCard,
  opAdd,
  opAttach,
  opBlock,
  opCheck,
  opChecklistAdd,
  opClaim,
  opClose,
  opComment,
  opBoost,
  opDescribe,
  opDetach,
  opEdit,
  opLog,
  opRemoveFilter,
  opSaveFilter,
  opSubscribeLane,
  opSnooze,
  opLink,
  opUnlink,
  opPromote,
  opMergeDuplicates,
  opQuickAdd,
  opBulk,
  opButton,
  opAutomationPass,
  opTransferCard,
  opMove,
  opUnblock,
  opVote,
  opWatch,
  type AddOptions,
  type EditPatch,
  type ClaimMode,
  type PromoteOptions,
  type BulkAction,
  type TransferOptions,
  type MoveResult,
  type ButtonOptions,
} from './ops.ts';

export { UsageError, type AddOptions, type EditPatch, type MoveResult, type PromoteOptions, type BulkAction, type TransferOptions, type ButtonOptions };

// ── Same-tree concurrency ────────────────────────────────────────────────────
// git handles cross-branch races (SPEC §8); these two guards handle two
// processes in one worktree. A short-lived lock file serializes whole
// load-mutate-write cycles (so seq ids are allocated under it), and every
// write lands via temp-file + rename so a crash never leaves a half card.

function lockWaitMs(): number {
  return Number(process.env['BOTFLOW_LOCK_TIMEOUT_MS']) || 5000;
}
function lockStaleMs(): number {
  return Number(process.env['BOTFLOW_LOCK_STALE_MS']) || 10_000;
}

/** Blocking sleep: mutations are synchronous end to end, and a lock wait is
 *  the one place that must pause without yielding half-applied state. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Remove a lock whose owner is provably gone. A live pid is NEVER age-reaped:
 *  long legitimate holds (a big pull applying hundreds of cards) must not have
 *  the lock stolen mid-flight. The mtime fallback exists only for locks whose
 *  pid cannot be read or judged (garbage content, cross-host filesystems). */
function reapStaleLock(lock: string): void {
  try {
    const pid = Number(readFileSync(lock, 'utf8').trim().split(/\s/)[0]);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return; // owner is alive: the lock is real, wait for it
      } catch (err) {
        // EPERM etc means the process exists but is not ours: still alive.
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') return;
      }
      unlinkSync(lock); // owner is dead: reap immediately
      return;
    }
    if (Date.now() - statSync(lock).mtimeMs > lockStaleMs()) unlinkSync(lock);
  } catch {
    // Racing reapers or an owner that just released: the retry loop resolves it.
  }
}

/** Run fn holding <root>/board.lock; waits briefly, reaps dead owners, and
 *  fails with a usage error rather than proceeding unlocked. */
export function withBoardLock<T>(root: string, fn: () => T): T {
  const lock = join(root, 'board.lock');
  const deadline = Date.now() + lockWaitMs();
  for (;;) {
    try {
      const fd = openSync(lock, 'wx');
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      reapStaleLock(lock);
      if (Date.now() > deadline) {
        throw new UsageError(`board is locked by another process (${lock}); retry, or delete the file if its owner is gone`);
      }
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // Reaped as stale mid-run: nothing left to release.
    }
  }
}

/** Crash-safe write: temp file in the same directory, then rename. */
export function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function writeCard(boardRoot: string, card: Card): void {
  atomicWrite(join(boardRoot, card.file), serializeCard(card));
}

export function initBoard(dir: string, name?: string): string {
  const abs = resolve(dir);
  if (resolveBoardRoot(abs) !== null) throw new UsageError(`a board already exists at ${abs}`);
  const root = join(abs, '.botflow');
  mkdirSync(join(root, 'cards'), { recursive: true });
  writeFileSync(join(root, 'board.yaml'), defaultBoardYaml(name ?? basename(abs)));
  writeFileSync(join(root, '.gitignore'), 'index.db\nindex.db-*\nboard.lock\n');
  return root;
}

/** Lock, load fresh, mutate, persist the touched card. Loading inside the
 *  lock is what makes seq id allocation and read-modify-write safe. */
function mutateCard<T>(root: string, fn: (board: LoadedBoard) => T): T {
  return withBoardLock(root, () => {
    const board = loadBoard(root);
    if (board.config.mutationBlocked !== null) {
      throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
    }
    return fn(board);
  });
}

export function addCard(root: string, opts: AddOptions): Card {
  return mutateCard(root, (board) => {
    const card = opAdd(board, opts);
    const path = join(root, card.file);
    if (existsSync(path)) throw new UsageError(`file collision: ${card.file}`);
    writeCard(root, card);
    return card;
  });
}

export function linkCards(root: string, sourceId: string, targetId: string, type: Card['relations'][number]['type'], actor: string): { source: Card; target: Card; changed: boolean } {
  return mutateCard(root, (board) => {
    const result = opLink(board, sourceId, targetId, type, actor);
    if (result.changed) {
      writeCard(root, result.source);
      writeCard(root, result.target);
    }
    return result;
  });
}

export function unlinkCards(root: string, sourceId: string, targetId: string, type: Card['relations'][number]['type'], actor: string): { source: Card; target: Card; changed: boolean } {
  return mutateCard(root, (board) => {
    const result = opUnlink(board, sourceId, targetId, type, actor);
    if (result.changed) {
      writeCard(root, result.source);
      writeCard(root, result.target);
    }
    return result;
  });
}

export function promoteCard(root: string, id: string, index: number, actor: string, overrides: PromoteOptions = {}): { source: Card; promoted: Card; item: string } {
  return mutateCard(root, (board) => {
    const result = opPromote(board, getCard(board, id), index, actor, overrides);
    const targetPath = join(root, result.promoted.file);
    if (existsSync(targetPath)) throw new UsageError(`file collision: ${result.promoted.file}`);
    // The new copy lands first. A crash before the source update can only
    // leave an extra recoverable card; it cannot erase the checklist history.
    writeCard(root, result.promoted);
    writeCard(root, result.source);
    return result;
  });
}

export function mergeDuplicateCards(root: string, duplicateId: string, canonicalId: string, actor: string): ReturnType<typeof opMergeDuplicates> {
  return mutateCard(root, (board) => {
    const result = opMergeDuplicates(board, duplicateId, canonicalId, actor);
    for (const card of result.changed) writeCard(root, card);
    return result;
  });
}

export function quickAddCards(root: string, text: string, actor: string): Card[] {
  return mutateCard(root, (board) => {
    const cards = opQuickAdd(board, text, actor);
    for (const card of cards) {
      if (existsSync(join(root, card.file))) throw new UsageError(`file collision: ${card.file}`);
    }
    for (const card of cards) writeCard(root, card);
    return cards;
  });
}

export function bulkCards(root: string, ids: string[], action: BulkAction, actor: string): ReturnType<typeof opBulk> {
  return mutateCard(root, (board) => {
    const result = opBulk(board, ids, action, actor);
    const created = result.cards.filter((card) => !board.cards.some((existing) => existing.id === card.id));
    for (const card of created) {
      if (existsSync(join(root, card.file))) throw new UsageError(`file collision: ${card.file}`);
    }
    for (const card of [...created, ...result.cards.filter((card) => !created.includes(card))]) writeCard(root, card);
    return result;
  });
}

export function runButton(root: string, buttonId: string, actor: string, options: ButtonOptions = {}): ReturnType<typeof opButton> {
  return mutateCard(root, (board) => {
    const result = opButton(board, buttonId, actor, options);
    const created = result.cards.filter((card) => !board.cards.some((existing) => existing.id === card.id));
    for (const card of created) {
      if (existsSync(join(root, card.file))) throw new UsageError(`file collision: ${card.file}`);
    }
    for (const card of [...created, ...result.cards.filter((card) => !created.includes(card))]) writeCard(root, card);
    return result;
  });
}

export function runAutomation(root: string, nowValue: number | Date = Date.now()): ReturnType<typeof opAutomationPass> {
  return mutateCard(root, (board) => {
    const result = opAutomationPass(board, nowValue);
    for (const card of result.cards) writeCard(root, card);
    return result;
  });
}

export interface TransferResult extends ReturnType<typeof opTransferCard> {
  reused: boolean;
  sourceRoot: string;
  targetRoot: string;
}

function portableRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join('/');
}

function cardReference(fromRoot: string, toRoot: string, id: string): string {
  const boardRef = portableRelative(fromRoot, toRoot);
  return boardRef === '' ? id : `${boardRef}#${id}`;
}

/** Acquire several board locks in stable path order to avoid AB/BA deadlock. */
function withBoardLocks<T>(roots: string[], fn: () => T): T {
  const ordered = [...new Set(roots.map((root) => resolve(root)))].sort();
  const enter = (index: number): T => index === ordered.length ? fn() : withBoardLock(ordered[index]!, () => enter(index + 1));
  return enter(0);
}

export function transferCard(
  sourceRootValue: string,
  targetDir: string,
  id: string,
  actor: string,
  options: { move?: boolean | undefined; lane?: string | undefined } = {},
): TransferResult {
  const sourceRoot = resolveBoardRoot(sourceRootValue) ?? resolve(sourceRootValue);
  const targetRoot = resolveBoardRoot(targetDir);
  if (targetRoot === null) throw new UsageError(`no target board at ${targetDir}`);
  if (resolve(sourceRoot) === resolve(targetRoot)) throw new UsageError('source and target boards must differ');
  const targetPath = relative(sourceRoot, targetRoot);
  if (targetPath === '..' || targetPath.startsWith(`..${sep}`)) {
    throw new UsageError('target board must be nested inside the source project tree');
  }
  return withBoardLocks([sourceRoot, targetRoot], () => {
    const sourceBoard = loadBoard(sourceRoot);
    const targetBoard = loadBoard(targetRoot);
    if (sourceBoard.config.mutationBlocked !== null) throw new UsageError(`source board is read-only: ${sourceBoard.config.mutationBlocked}`);
    if (targetBoard.config.mutationBlocked !== null) throw new UsageError(`target board is read-only: ${targetBoard.config.mutationBlocked}`);
    const source = getCard(sourceBoard, id);
    const sourceRef = cardReference(targetRoot, sourceRoot, source.id);
    const existing = targetBoard.cards.find((card) => hasCopiedFrom(card, sourceRef));
    if (existing !== undefined) {
      const targetRef = cardReference(sourceRoot, targetRoot, existing.id);
      let changed = false;
      if (!source.relations.some((relation) => relation.type === 'copied-to' && relation.target === targetRef)) {
        source.relations.push({ type: 'copied-to', target: targetRef, extra: {} });
        logMutation(source, actor, `recovered transfer link to ${targetRef}`);
        changed = true;
      }
      if (options.move) {
        const archive = sourceBoard.config.lanes.find((lane) => lane.canonical === 'archive');
        if (archive === undefined) throw new UsageError('source board has no archive-canonical lane to retire transfer into');
        const moved = opMove(sourceBoard, source, archive.id, actor, true);
        changed ||= moved.from !== moved.to;
      }
      if (changed) writeCard(sourceRoot, source);
      return { source, target: existing, moved: options.move === true, reused: true, sourceRoot, targetRoot };
    }
    const rebaseReference = (value: string): string => {
      const parsed = parseCardReference(value);
      if (parsed === null) throw new UsageError(`invalid card reference "${value}"`);
      if (parsed.boardRef?.startsWith('project:')) return value;
      const referencedRoot = parsed.boardRef === null ? sourceRoot : resolve(sourceRoot, parsed.boardRef);
      return cardReference(targetRoot, referencedRoot, parsed.cardId);
    };
    const result = opTransferCard(sourceBoard, targetBoard, source, actor, {
      sourceRef,
      targetRef: (targetId) => cardReference(sourceRoot, targetRoot, targetId),
      rewriteReference: rebaseReference,
      rewriteBoardPath: (boardPath) => boardPath.startsWith('project:') ? boardPath : (portableRelative(targetRoot, resolve(sourceRoot, boardPath)) || '.'),
      lane: options.lane,
      move: options.move,
    });
    if (existsSync(join(targetRoot, result.target.file))) throw new UsageError(`file collision: ${result.target.file}`);
    // Target first is the failure-safe ordering: source remains authoritative
    // until a complete destination exists. Replays detect copied-from above.
    writeCard(targetRoot, result.target);
    writeCard(sourceRoot, result.source);
    return { ...result, reused: false, sourceRoot, targetRoot };
  });
}

function hasCopiedFrom(card: Card, sourceRef: string): boolean {
  return card.relations.some((relation) => relation.type === 'copied-from' && relation.target === sourceRef);
}

export function moveCard(root: string, id: string, spec: string, actor: string, force = false, wipJustification?: string): MoveResult {
  return mutateCard(root, (board) => {
    const res = opMove(board, getCard(board, id), spec, actor, force, wipJustification);
    if (res.from !== res.to) writeCard(root, res.card); // same-position move: no-op
    return res;
  });
}

export function claimCard(root: string, id: string, actor: string, force = false, mode: ClaimMode = 'assign', wipJustification?: string): MoveResult {
  return mutateCard(root, (board) => {
    const card = getCard(board, id);
    // Claimability is projection-sensitive: board-card rollups, local deps,
    // cross-board deps, and cycle membership must come from one tree analysis.
    const ba = analyze(loadTree(root)).boards.get('.');
    const externalDependencies = ba?.dependencyStates.get(id) as Map<string, string | null> | undefined;
    const res = opClaim(
      board, card, actor, force, mode, externalDependencies, wipJustification,
      Date.now(), ba?.cycleMembers, ba?.canonical.get(id),
    );
    if (!res.alreadyYours) writeCard(root, res.card);
    return res;
  });
}

export function closeCard(root: string, id: string, actor: string, reason?: string, wipJustification?: string, force = false): MoveResult {
  return mutateCard(root, (board) => {
    const res = opClose(board, getCard(board, id), actor, reason, wipJustification, force);
    if (res.alreadyClosed) return res;
    if (res.created !== undefined) {
      if (existsSync(join(root, res.created.file))) throw new UsageError(`file collision: ${res.created.file}`);
      writeCard(root, res.created);
    }
    writeCard(root, res.card);
    return res;
  });
}

export function blockCard(root: string, id: string, actor: string, reason: string, blocker?: string): Card {
  return mutateCard(root, (board) => {
    const card = opBlock(getCard(board, id), actor, reason, board, blocker);
    writeCard(root, card);
    return card;
  });
}

export function unblockCard(root: string, id: string, actor: string): Card {
  return mutateCard(root, (board) => {
    const card = opUnblock(getCard(board, id), actor);
    writeCard(root, card);
    return card;
  });
}

export function snoozeCard(root: string, id: string, actor: string, until: string | null): Card {
  return mutateCard(root, (board) => {
    const card = opSnooze(getCard(board, id), actor, until);
    writeCard(root, card);
    return card;
  });
}

export function addLogEntry(root: string, id: string, actor: string, message: string): Card {
  return mutateCard(root, (board) => {
    const card = opLog(getCard(board, id), actor, message);
    writeCard(root, card);
    return card;
  });
}

export function editCard(root: string, id: string, patch: EditPatch, actor: string): Card {
  return mutateCard(root, (board) => {
    const card = opEdit(getCard(board, id), patch, actor, board);
    writeCard(root, card);
    return card;
  });
}

export function commentCard(root: string, id: string, actor: string, text: string): Card {
  return mutateCard(root, (board) => {
    const card = opComment(getCard(board, id), actor, text);
    writeCard(root, card);
    return card;
  });
}

export function watchCard(root: string, id: string, actor: string, watching = true): ReturnType<typeof opWatch> {
  return mutateCard(root, (board) => {
    const result = opWatch(getCard(board, id), actor, watching);
    if (result.changed) writeCard(root, result.card);
    return result;
  });
}

export function voteCard(root: string, id: string, actor: string, voting = true): ReturnType<typeof opVote> {
  return mutateCard(root, (board) => {
    const result = opVote(getCard(board, id), actor, voting);
    if (result.changed) writeCard(root, result.card);
    return result;
  });
}

export function boostCard(root: string, id: string, actor: string, text: string): Card {
  return mutateCard(root, (board) => {
    const card = opBoost(getCard(board, id), actor, text);
    writeCard(root, card);
    return card;
  });
}

function writeBoardConfig(root: string, board: LoadedBoard): void {
  atomicWrite(join(root, 'board.yaml'), emitBoardYaml(board.config));
}

export function saveFilter(root: string, id: string, query: string, actor: string, name?: string): ReturnType<typeof opSaveFilter> {
  return mutateCard(root, (board) => {
    const filter = opSaveFilter(board.config, id, query, name);
    writeBoardConfig(root, board);
    return filter;
  });
}

export function removeFilter(root: string, id: string, actor: string): ReturnType<typeof opRemoveFilter> {
  return mutateCard(root, (board) => {
    const filter = opRemoveFilter(board.config, id);
    writeBoardConfig(root, board);
    return filter;
  });
}

export function subscribeLane(root: string, lane: string, actor: string, subscribing = true): ReturnType<typeof opSubscribeLane> {
  return mutateCard(root, (board) => {
    const result = opSubscribeLane(board.config, lane, actor, subscribing);
    if (result.changed) writeBoardConfig(root, board);
    return result;
  });
}

export function checkCard(root: string, id: string, actor: string, index: number, checked: boolean): Card {
  return mutateCard(root, (board) => {
    const card = opCheck(getCard(board, id), actor, index, checked);
    writeCard(root, card);
    return card;
  });
}

export function describeCard(root: string, id: string, actor: string, text: string): Card {
  return mutateCard(root, (board) => {
    const card = opDescribe(getCard(board, id), actor, text);
    writeCard(root, card);
    return card;
  });
}

export function checklistAddCard(root: string, id: string, actor: string, text: string, section?: string): Card {
  return mutateCard(root, (board) => {
    const card = opChecklistAdd(getCard(board, id), actor, text, section);
    writeCard(root, card);
    return card;
  });
}

export function attachCard(root: string, id: string, actor: string, url: string, label?: string): Card {
  return mutateCard(root, (board) => {
    const card = opAttach(getCard(board, id), actor, url, label);
    writeCard(root, card);
    return card;
  });
}

export function detachCard(root: string, id: string, actor: string, index: number): Card {
  return mutateCard(root, (board) => {
    const card = opDetach(getCard(board, id), actor, index);
    writeCard(root, card);
    return card;
  });
}
