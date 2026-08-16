// Pure document → board construction (no filesystem). The fs loader and the
// hosted manager's Durable Objects both build boards through this module, so
// the format semantics exist exactly once.

import { basename } from 'node:path';

import { parseYaml, YamlError } from './yaml.ts';
import { splitFrontmatter } from './frontmatter.ts';
import { parseBoardConfig } from './config.ts';
import { parseCard } from './card.ts';
import type { BoardConfig, Card, Finding, LoadedBoard, Tree } from './model.ts';
import { HASH_ID_RE, SEQ_ID_RE, fallbackConfig, finding } from './model.ts';

export interface BoardDocument {
  /** Path relative to the board root, e.g. "cards/042-fix-auth.md". */
  path: string;
  text: string;
}

/** Parse one card file's text; returns null (with findings) when unusable. */
export function parseCardDocument(doc: BoardDocument, config: BoardConfig, findings: Finding[]): Card | null {
  const rel = doc.path.startsWith('cards/') ? doc.path.slice('cards/'.length) : doc.path;
  const fileRef = basename(doc.path);
  const split = splitFrontmatter(doc.text);
  if (split.kind === 'none') {
    findings.push(finding('frontmatter-missing', fileRef, `${rel}: no frontmatter block`));
    return null;
  }
  if (split.kind === 'unclosed') {
    findings.push(finding('yaml-error', fileRef, `${rel}: unclosed frontmatter block`));
    return null;
  }
  let card: Card | null = null;
  try {
    card = parseCard(parseYaml(split.yaml), fileRef, doc.path, split.body, findings);
  } catch (err) {
    if (!(err instanceof YamlError)) throw err;
    findings.push(finding('yaml-error', fileRef, `${rel}: ${err.message}`));
  }
  if (card === null) return null;

  const idRe = config.ids === 'seq' ? SEQ_ID_RE : HASH_ID_RE;
  if (!idRe.test(card.id)) {
    findings.push(finding('id-scheme-mismatch', card.id, `id "${card.id}" does not match the "${config.ids}" scheme`));
  }
  const nextChar = fileRef.slice(card.id.length, card.id.length + 1);
  if (!fileRef.startsWith(card.id) || (nextChar !== '-' && nextChar !== '.')) {
    findings.push(finding('filename-id-mismatch', card.id, `${rel}: filename does not begin with the card id`));
  }
  return card;
}

/** Build a board from raw documents — the pure core of loadBoard. */
export function boardFromDocuments(
  configText: string | null,
  cardDocs: BoardDocument[],
  fallbackName = 'board',
): LoadedBoard {
  const findings: Finding[] = [];
  let config: BoardConfig;
  if (configText === null) {
    findings.push(finding('schema', 'board.yaml', 'board.yaml not found'));
    config = fallbackConfig(fallbackName);
  } else {
    try {
      config = parseBoardConfig(parseYaml(configText), findings);
    } catch (err) {
      if (!(err instanceof YamlError)) throw err;
      findings.push(finding('yaml-error', 'board.yaml', err.message));
      config = fallbackConfig(fallbackName);
    }
  }

  const cards: Card[] = [];
  for (const doc of [...cardDocs].sort((a, b) => a.path.localeCompare(b.path))) {
    const card = parseCardDocument(doc, config, findings);
    if (card !== null) cards.push(card);
  }

  const byId = new Map<string, number>();
  for (const card of cards) byId.set(card.id, (byId.get(card.id) ?? 0) + 1);
  for (const [id, count] of byId) {
    if (count > 1) findings.push(finding('dup-id', id, `${count} cards share id "${id}"`));
  }

  return { rootAbs: '', config, cards, findings };
}

/** Wrap a single board as a Tree so analyze() runs on it. Board-cards resolve
 *  to nothing (hosted nesting lives in the registry, not in file paths), and
 *  deliberately without board-path-missing findings. */
export function singleBoardTree(board: LoadedBoard): Tree {
  const childKeyByCard = new Map<string, string | null>();
  for (const card of board.cards) if (card.type === 'board') childKeyByCard.set(card.id, null);
  return {
    rootAbs: board.rootAbs || '.',
    boards: new Map([['.', { key: '.', board, childKeyByCard }]]),
  };
}
