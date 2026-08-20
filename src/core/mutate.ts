// Filesystem wrappers over the pure operations in ops.ts: every mutation
// takes the board lock, loads the board fresh from files, applies the op, and
// atomically rewrites the one card it touches (SPEC §12). Files stay the
// single source of truth, and two processes on the same tree cannot interleave
// load-mutate-write or mint the same seq id.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

import type { Card, LoadedBoard } from './model.ts';
import { loadBoard, resolveBoardRoot } from './load.ts';
import { serializeCard } from './write.ts';
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
  opDescribe,
  opDetach,
  opEdit,
  opLog,
  opMove,
  opUnblock,
  type AddOptions,
  type EditPatch,
  type ClaimMode,
  type MoveResult,
} from './ops.ts';

export { UsageError, type AddOptions, type EditPatch, type MoveResult };

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

export function moveCard(root: string, id: string, spec: string, actor: string, force = false): MoveResult {
  return mutateCard(root, (board) => {
    const res = opMove(board, getCard(board, id), spec, actor, force);
    if (res.from !== res.to) writeCard(root, res.card); // same-position move: no-op
    return res;
  });
}

export function claimCard(root: string, id: string, actor: string, force = false, mode: ClaimMode = 'assign'): MoveResult {
  return mutateCard(root, (board) => {
    const res = opClaim(board, getCard(board, id), actor, force, mode);
    if (!res.alreadyYours) writeCard(root, res.card);
    return res;
  });
}

export function closeCard(root: string, id: string, actor: string, reason?: string): MoveResult {
  return mutateCard(root, (board) => {
    const res = opClose(board, getCard(board, id), actor, reason);
    writeCard(root, res.card);
    return res;
  });
}

export function blockCard(root: string, id: string, actor: string, reason: string): Card {
  return mutateCard(root, (board) => {
    const card = opBlock(getCard(board, id), actor, reason);
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
