// Filesystem loading: board directories → LoadedBoard, and recursive board
// trees with cycle detection (SPEC §3, §7).

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { boardFromDocuments, type BoardDocument } from './docs.ts';
import type { BoardNode, LoadedBoard, Tree } from './model.ts';
import { finding } from './model.ts';

export type { BoardNode, LoadedBoard, Tree } from './model.ts';

/** Resolve a directory to a board root per SPEC §3, or null. */
export function resolveBoardRoot(dir: string): string | null {
  const abs = resolve(dir);
  if (existsSync(join(abs, 'board.yaml'))) return abs;
  const dotted = join(abs, '.botflow');
  if (existsSync(join(dotted, 'board.yaml'))) return dotted;
  return null;
}

/** Walk up from `dir` to find the active board root (SPEC §3 discovery). */
export function discoverBoardRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const dotted = join(dir, '.botflow');
    if (existsSync(join(dotted, 'board.yaml'))) return dotted;
    if (existsSync(join(dir, 'board.yaml')) && existsSync(join(dir, 'cards'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Read a board's raw documents from disk: the wire format for push/pull.
 *  Only regular files are read (lstat semantics at every level), so a
 *  committed symlink — cards/007.md -> /etc/passwd, or a symlinked cards/
 *  subdir — is silently skipped instead of exfiltrated into a push. */
export function readBoardDocuments(rootAbs: string): { configText: string | null; cards: BoardDocument[] } {
  const configPath = join(rootAbs, 'board.yaml');
  const configText = existsSync(configPath) && lstatSync(configPath).isFile() ? readFileSync(configPath, 'utf8') : null;

  const cards: BoardDocument[] = [];
  const cardsDir = join(rootAbs, 'cards');
  if (existsSync(cardsDir) && lstatSync(cardsDir).isDirectory()) {
    const walk = (dirAbs: string, rel: string): void => {
      for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(join(dirAbs, entry.name), childRel);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          cards.push({ path: `cards/${childRel}`, text: readFileSync(join(dirAbs, entry.name), 'utf8') });
        }
      }
    };
    walk(cardsDir, '');
  }
  return { configText, cards };
}

export function loadBoard(rootAbs: string): LoadedBoard {
  const { configText, cards } = readBoardDocuments(rootAbs);
  const board = boardFromDocuments(configText, cards, basename(rootAbs));
  board.rootAbs = rootAbs;
  return board;
}

/** Load a board and, recursively, every board its board-cards reference. */
export function loadTree(rootDir: string): Tree {
  const rootAbs = resolveBoardRoot(rootDir) ?? resolve(rootDir);
  const boards = new Map<string, BoardNode>();
  const byAbs = new Map<string, BoardNode>();
  const stack = new Set<string>();

  const keyFor = (abs: string): string => {
    const rel = relative(rootAbs, abs).split(sep).join('/');
    return rel === '' ? '.' : rel;
  };

  const visit = (abs: string): BoardNode => {
    const existing = byAbs.get(abs);
    if (existing) return existing;
    const node: BoardNode = { key: keyFor(abs), board: loadBoard(abs), childKeyByCard: new Map() };
    boards.set(node.key, node);
    byAbs.set(abs, node);
    stack.add(abs);
    for (const card of node.board.cards) {
      if (card.type !== 'board' || card.boardPath === null) continue;
      if (card.boardPath.startsWith('project:')) {
        // Hosted-manager reference (SPEC §3): meaningless on the filesystem.
        node.board.findings.push(finding('hosted-ref', card.id, `"${card.boardPath}" resolves only on a botflow manager`));
        node.childKeyByCard.set(card.id, null);
        continue;
      }
      const targetAbs = resolve(abs, card.boardPath);
      const relToRoot = relative(rootAbs, targetAbs);
      if (isAbsolute(card.boardPath) || relToRoot === '..' || relToRoot.startsWith(`..${sep}`) || isAbsolute(relToRoot)) {
        // A child-board reference is relative to the referencing board and
        // must stay inside the tree (SPEC §3); never walk out of the project.
        node.board.findings.push(finding('board-path-escape', card.id, `board path "${card.boardPath}" escapes the project root`));
        node.childKeyByCard.set(card.id, null);
        continue;
      }
      const childRoot = resolveBoardRoot(targetAbs);
      if (childRoot === null) {
        node.board.findings.push(finding('board-path-missing', card.id, `board path "${card.boardPath}" does not resolve to a board`));
        node.childKeyByCard.set(card.id, null);
      } else if (stack.has(childRoot)) {
        node.board.findings.push(finding('board-cycle', card.id, `board path "${card.boardPath}" creates a reference cycle`));
        node.childKeyByCard.set(card.id, null);
      } else {
        node.childKeyByCard.set(card.id, visit(childRoot).key);
      }
    }
    stack.delete(abs);
    return node;
  };

  visit(rootAbs);
  return { rootAbs, boards };
}
