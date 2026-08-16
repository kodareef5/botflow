// Filesystem wrappers over the pure operations in ops.ts: every mutation
// loads the board fresh from files, applies the op, and rewrites the one card
// it touches (SPEC §12). Files stay the single source of truth.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { Card } from './model.ts';
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
  opClaim,
  opClose,
  opComment,
  opDetach,
  opEdit,
  opLog,
  opMove,
  opUnblock,
  type AddOptions,
  type EditPatch,
  type MoveResult,
} from './ops.ts';

export { UsageError, type AddOptions, type EditPatch, type MoveResult };

export function writeCard(boardRoot: string, card: Card): void {
  writeFileSync(join(boardRoot, card.file), serializeCard(card));
}

export function initBoard(dir: string, name?: string): string {
  const abs = resolve(dir);
  if (resolveBoardRoot(abs) !== null) throw new UsageError(`a board already exists at ${abs}`);
  const root = join(abs, '.botflow');
  mkdirSync(join(root, 'cards'), { recursive: true });
  writeFileSync(join(root, 'board.yaml'), defaultBoardYaml(name ?? basename(abs)));
  writeFileSync(join(root, '.gitignore'), 'index.db\nindex.db-*\n');
  return root;
}

export function addCard(root: string, opts: AddOptions): Card {
  const board = loadBoard(root);
  const card = opAdd(board, opts);
  const path = join(root, card.file);
  if (existsSync(path)) throw new UsageError(`file collision: ${card.file}`);
  writeCard(root, card);
  return card;
}

export function moveCard(root: string, id: string, spec: string, actor: string, force = false): MoveResult {
  const board = loadBoard(root);
  const res = opMove(board, getCard(board, id), spec, actor, force);
  writeCard(root, res.card);
  return res;
}

export function claimCard(root: string, id: string, actor: string): MoveResult {
  const board = loadBoard(root);
  const res = opClaim(board, getCard(board, id), actor);
  writeCard(root, res.card);
  return res;
}

export function closeCard(root: string, id: string, actor: string, reason?: string): MoveResult {
  const board = loadBoard(root);
  const res = opClose(board, getCard(board, id), actor, reason);
  writeCard(root, res.card);
  return res;
}

export function blockCard(root: string, id: string, actor: string, reason: string): Card {
  const board = loadBoard(root);
  const card = opBlock(getCard(board, id), actor, reason);
  writeCard(root, card);
  return card;
}

export function unblockCard(root: string, id: string, actor: string): Card {
  const board = loadBoard(root);
  const card = opUnblock(getCard(board, id), actor);
  writeCard(root, card);
  return card;
}

export function addLogEntry(root: string, id: string, actor: string, message: string): Card {
  const board = loadBoard(root);
  const card = opLog(getCard(board, id), actor, message);
  writeCard(root, card);
  return card;
}

export function editCard(root: string, id: string, patch: EditPatch, actor: string): Card {
  const board = loadBoard(root);
  const card = opEdit(getCard(board, id), patch, actor);
  writeCard(root, card);
  return card;
}

export function commentCard(root: string, id: string, actor: string, text: string): Card {
  const board = loadBoard(root);
  const card = opComment(getCard(board, id), actor, text);
  writeCard(root, card);
  return card;
}

export function checkCard(root: string, id: string, actor: string, index: number, checked: boolean): Card {
  const board = loadBoard(root);
  const card = opCheck(getCard(board, id), actor, index, checked);
  writeCard(root, card);
  return card;
}

export function attachCard(root: string, id: string, actor: string, url: string, label?: string): Card {
  const board = loadBoard(root);
  const card = opAttach(getCard(board, id), actor, url, label);
  writeCard(root, card);
  return card;
}

export function detachCard(root: string, id: string, actor: string, index: number): Card {
  const board = loadBoard(root);
  const card = opDetach(getCard(board, id), actor, index);
  writeCard(root, card);
  return card;
}
