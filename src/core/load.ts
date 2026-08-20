// Filesystem loading: board directories → LoadedBoard, and recursive board
// trees with cycle detection (SPEC §3, §7).

import { existsSync, lstatSync, opendirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { boardFromDocuments, type BoardDocument } from './docs.ts';
import type { BoardNode, LoadedBoard, Tree } from './model.ts';
import { finding } from './model.ts';
import { parseCardReference } from './refs.ts';
import {
  MAX_BOARD_CONFIG_SIZE,
  MAX_BOARD_DOCUMENT_SIZE,
  MAX_BOARD_DIRECTORY_ENTRIES,
  MAX_CARD_DOCUMENT_SIZE,
  MAX_CARDS_PER_BOARD,
  MAX_TREE_BOARDS,
  MAX_TREE_DOCUMENT_SIZE,
  ResourceLimitError,
} from './limits.ts';

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
export function readBoardDocuments(rootAbs: string): { configText: string | null; cards: BoardDocument[]; bytes: number } {
  const configPath = join(rootAbs, 'board.yaml');
  const configStat = existsSync(configPath) ? lstatSync(configPath) : null;
  if (configStat?.isFile() && configStat.size > MAX_BOARD_CONFIG_SIZE) {
    throw new ResourceLimitError(`board.yaml exceeds the ${MAX_BOARD_CONFIG_SIZE}-byte limit`);
  }
  const configText = configStat?.isFile() ? readFileSync(configPath, 'utf8') : null;
  let bytes = configStat?.isFile() ? configStat.size : 0;

  const cards: BoardDocument[] = [];
  let entries = 0;
  const cardsDir = join(rootAbs, 'cards');
  if (existsSync(cardsDir) && lstatSync(cardsDir).isDirectory()) {
    const pending: { dirAbs: string; rel: string }[] = [{ dirAbs: cardsDir, rel: '' }];
    while (pending.length > 0) {
      const { dirAbs, rel } = pending.pop()!;
      const directory = opendirSync(dirAbs);
      try {
        for (;;) {
          const entry = directory.readSync();
          if (entry === null) break;
          entries++;
          if (entries > MAX_BOARD_DIRECTORY_ENTRIES) {
            throw new ResourceLimitError(`cards directory has more than ${MAX_BOARD_DIRECTORY_ENTRIES} entries`);
          }
          const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
          if (entry.isDirectory()) {
            pending.push({ dirAbs: join(dirAbs, entry.name), rel: childRel });
          } else if (entry.isFile() && entry.name.endsWith('.md')) {
            if (cards.length >= MAX_CARDS_PER_BOARD) {
              throw new ResourceLimitError(`board has more than ${MAX_CARDS_PER_BOARD} card files`);
            }
            const path = join(dirAbs, entry.name);
            const stat = lstatSync(path);
            if (stat.size > MAX_CARD_DOCUMENT_SIZE) {
              throw new ResourceLimitError(`cards/${childRel} exceeds the ${MAX_CARD_DOCUMENT_SIZE}-byte limit`);
            }
            bytes += stat.size;
            if (bytes > MAX_BOARD_DOCUMENT_SIZE) {
              throw new ResourceLimitError(`board documents exceed the ${MAX_BOARD_DOCUMENT_SIZE}-byte total limit`);
            }
            cards.push({ path: `cards/${childRel}`, text: readFileSync(path, 'utf8') });
          }
        }
      } finally {
        directory.closeSync();
      }
    }
  }
  return { configText, cards, bytes };
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
  const workspaceAbs = basename(rootAbs) === '.botflow' ? dirname(rootAbs) : rootAbs;
  const workspacePhysical = realpathSync(workspaceAbs);
  const rootPhysical = realpathSync(rootAbs);
  const physicalRelative = relative(workspacePhysical, rootPhysical);
  if (lstatSync(rootAbs).isSymbolicLink()
    || physicalRelative === '..'
    || physicalRelative.startsWith(`..${sep}`)
    || isAbsolute(physicalRelative)) {
    throw new ResourceLimitError('board root resolves outside its workspace through a symbolic link');
  }
  const boards = new Map<string, BoardNode>();
  const byAbs = new Map<string, BoardNode>();
  const stack = new Set<string>();
  let totalBytes = 0;

  const keyFor = (abs: string): string => {
    const rel = relative(rootAbs, abs).split(sep).join('/');
    return rel === '' ? '.' : rel;
  };

  const physicallyContainedBoardRoot = (targetAbs: string): { root: string | null; escaped: boolean } => {
    const childRoot = resolveBoardRoot(targetAbs);
    if (childRoot === null) return { root: null, escaped: false };
    const rel = relative(workspaceAbs, childRoot);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { root: null, escaped: true };

    // lstat each lexical component before realpath: a final realpath-only
    // check catches escapes, while this also rejects symlink aliases that
    // stay inside the workspace and could otherwise defeat cycle identity.
    let cursor = workspaceAbs;
    for (const component of rel.split(sep).filter(Boolean)) {
      cursor = join(cursor, component);
      if (lstatSync(cursor).isSymbolicLink()) return { root: null, escaped: true };
    }
    const physical = realpathSync(childRoot);
    const physicalRel = relative(workspacePhysical, physical);
    if (physicalRel === '..' || physicalRel.startsWith(`..${sep}`) || isAbsolute(physicalRel)) {
      return { root: null, escaped: true };
    }
    return { root: childRoot, escaped: false };
  };

  const visit = (abs: string): BoardNode => {
    const existing = byAbs.get(abs);
    if (existing) return existing;
    if (boards.size >= MAX_TREE_BOARDS) throw new ResourceLimitError(`board tree exceeds the ${MAX_TREE_BOARDS}-board limit`);
    const documents = readBoardDocuments(abs);
    totalBytes += documents.bytes;
    if (totalBytes > MAX_TREE_DOCUMENT_SIZE) {
      throw new ResourceLimitError(`board tree documents exceed the ${MAX_TREE_DOCUMENT_SIZE}-byte total limit`);
    }
    const board = boardFromDocuments(documents.configText, documents.cards, basename(abs));
    board.rootAbs = abs;
    const node: BoardNode = { key: keyFor(abs), board, childKeyByCard: new Map() };
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
      const relToWorkspace = relative(workspaceAbs, targetAbs);
      if (isAbsolute(card.boardPath) || relToWorkspace === '..' || relToWorkspace.startsWith(`..${sep}`) || isAbsolute(relToWorkspace)) {
        // A child-board reference is relative to the referencing board and
        // must stay inside the workspace (SPEC §3); never walk above it.
        node.board.findings.push(finding('board-path-escape', card.id, `board path "${card.boardPath}" escapes the workspace`));
        node.childKeyByCard.set(card.id, null);
        continue;
      }
      const resolvedChild = physicallyContainedBoardRoot(targetAbs);
      const childRoot = resolvedChild.root;
      if (resolvedChild.escaped) {
        node.board.findings.push(finding('board-path-escape', card.id, `board path "${card.boardPath}" resolves through a symbolic link or outside the workspace`));
        node.childKeyByCard.set(card.id, null);
      } else if (childRoot === null) {
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

  // Board cards establish the containment tree, but dependency/relation refs
  // may be the only edge to a sibling board. Discover those boards too so a
  // local ref has identical meaning in lint, ready/claim, JSON, and the UI.
  // Newly discovered boards can introduce more refs, hence the growing scan.
  const scanned = new Set<string>();
  for (;;) {
    let added = false;
    for (const node of [...boards.values()]) {
      if (scanned.has(node.key)) continue;
      scanned.add(node.key);
      for (const card of node.board.cards) {
        const refs = [...card.deps, ...card.relations.map((relation) => relation.target)];
        for (const value of refs) {
          const parsed = parseCardReference(value);
          if (parsed?.boardRef === null || parsed === null || parsed.boardRef.startsWith('project:')) continue;
          const targetAbs = resolve(node.board.rootAbs, parsed.boardRef);
          const relToWorkspace = relative(workspaceAbs, targetAbs);
          if (isAbsolute(parsed.boardRef) || relToWorkspace === '..' || relToWorkspace.startsWith(`..${sep}`) || isAbsolute(relToWorkspace)) continue;
          const targetRoot = physicallyContainedBoardRoot(targetAbs).root;
          if (targetRoot !== null && !byAbs.has(targetRoot)) {
            visit(targetRoot);
            added = true;
          }
        }
      }
    }
    if (!added && [...boards.values()].every((node) => scanned.has(node.key))) break;
  }
  return { rootAbs, boards };
}
