// Pure card-reference helpers shared by filesystem analysis, Workers, JSON
// projection, and operations. Board paths use slash semantics on every host;
// filesystem resolution itself remains in load.ts.

import type { BoardNode, Card, RelationType, Tree } from './model.ts';

export interface ParsedCardReference {
  /** null means the card's own board. */
  boardRef: string | null;
  cardId: string;
}

const CARD_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function parseCardReference(value: string): ParsedCardReference | null {
  if (value === '' || /[\r\n]/.test(value)) return null;
  const hash = value.lastIndexOf('#');
  if (hash === -1) return CARD_ID_RE.test(value) ? { boardRef: null, cardId: value } : null;
  const boardRef = value.slice(0, hash);
  const cardId = value.slice(hash + 1);
  if (boardRef === '' || !CARD_ID_RE.test(cardId)) return null;
  return { boardRef, cardId };
}

function normalizedBoardKey(fromKey: string, boardRef: string): string | null {
  if (/^(?:[\\/]|[A-Za-z]:[\\/])/.test(boardRef) || boardRef.startsWith('project:')) return null;
  const parts = fromKey === '.' ? [] : fromKey.split('/').filter(Boolean);
  for (const part of boardRef.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length === 0 ? '.' : parts.join('/');
}

export interface ResolvedTreeCardReference {
  key: string;
  node: BoardNode;
  card: Card;
}

/** Resolve a ref only among boards already in a loaded tree. A directory ref
 * may resolve to either a bare board or its .botflow child, matching load.ts. */
export function resolveTreeCardReference(tree: Tree, fromKey: string, value: string): ResolvedTreeCardReference | null {
  const parsed = parseCardReference(value);
  if (parsed === null) return null;
  let key = fromKey;
  if (parsed.boardRef !== null) {
    const normalized = normalizedBoardKey(fromKey, parsed.boardRef);
    if (normalized === null) return null;
    if (tree.boards.has(normalized)) key = normalized;
    else {
      const dotted = normalized === '.' ? '.botflow' : `${normalized}/.botflow`;
      if (!tree.boards.has(dotted)) return null;
      key = dotted;
    }
  }
  const node = tree.boards.get(key);
  const card = node?.board.cards.find((candidate) => candidate.id === parsed.cardId);
  return node && card ? { key, node, card } : null;
}

export function relationInverse(type: RelationType): RelationType {
  switch (type) {
    case 'parent': return 'subtask';
    case 'subtask': return 'parent';
    case 'duplicates': return 'supersedes';
    case 'supersedes': return 'duplicates';
    case 'copied-from': return 'copied-to';
    case 'copied-to': return 'copied-from';
    case 'recurs-from': return 'recurs-to';
    case 'recurs-to': return 'recurs-from';
    case 'relates': return 'relates';
  }
}

/** Explicit text refs are bracketed because bare sequential ids are far too
 * common in dates and prose to infer safely. Order is text order, deduped. */
export function textCardReferences(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\[\[([^\]\r\n]+)\]\]/g)) {
    const ref = match[1]!.trim();
    if (parseCardReference(ref) !== null && !out.includes(ref)) out.push(ref);
  }
  return out;
}
