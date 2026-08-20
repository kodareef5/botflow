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
import { labelGroupConflict, validCustomFieldValue } from './presentation.ts';

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
    card = parseCard(
      parseYaml(split.yaml),
      fileRef,
      doc.path,
      split.body,
      findings,
      new Set(config.customFields.map((field) => field.id)),
    );
  } catch (err) {
    if (!(err instanceof YamlError)) throw err;
    findings.push(finding('yaml-error', fileRef, `${rel}: ${err.message}`));
  }
  if (card === null) return null;

  const conflict = labelGroupConflict(card.labels);
  if (conflict !== null) findings.push(finding('label-group-conflict', card.id, conflict));
  for (const definition of config.customFields) {
    const value = card.extra[definition.id];
    if (value !== undefined && !validCustomFieldValue(definition, value)) {
      findings.push(finding('custom-field-value', card.id, `custom field "${definition.id}" has an invalid ${definition.type} value`));
    }
  }

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

/** Build a board from raw documents: the pure core of loadBoard. */
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

/** A card doc path a snapshot may write: inside cards/, .md, no traversal. */
export function safeCardDocumentPath(path: string): boolean {
  if (!path.startsWith('cards/') || !path.endsWith('.md') || path.includes('\\')) return false;
  const parts = path.split('/');
  return parts.length >= 2 && parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

export type SnapshotValidation =
  | { docs: BoardDocument[]; board: LoadedBoard }
  | { error: string };

/** Validate a whole board snapshot before anything persists it: hosted import
 *  and CLI pull both gate on this, so a malformed snapshot can never leave a
 *  board half-transformed. Structural findings that would drop or invent card
 *  data are fatal; ordinary lint findings (unknown lanes, dangling deps,
 *  id-scheme drift) remain visible but do not make snapshot sync unusably
 *  strict. */
export function validateBoardDocuments(config: unknown, cards: unknown): SnapshotValidation {
  if (typeof config !== 'string' || !Array.isArray(cards)) return { error: 'config and cards required' };
  const docs: BoardDocument[] = [];
  const seenPaths = new Set<string>();
  for (const value of cards) {
    if (value === null || typeof value !== 'object') return { error: 'malformed card document' };
    const doc = value as { path?: unknown; text?: unknown };
    if (typeof doc.path !== 'string' || typeof doc.text !== 'string') return { error: 'malformed card document' };
    if (!safeCardDocumentPath(doc.path)) return { error: `unsafe card path in import: ${doc.path}` };
    if (seenPaths.has(doc.path)) return { error: `duplicate card path in import: ${doc.path}` };
    seenPaths.add(doc.path);
    docs.push({ path: doc.path, text: doc.text });
  }
  const board = boardFromDocuments(config, docs, 'import');
  const fatalRules = new Set(['yaml-error', 'frontmatter-missing', 'schema', 'dup-id']);
  const errors = board.findings.filter((f) => fatalRules.has(f.rule));
  if (errors.length > 0) {
    const detail = errors.slice(0, 3).map((f) => `${f.rule}(${f.ref}): ${f.message}`).join('; ');
    return { error: `invalid board import: ${detail}` };
  }
  if (board.config.mutationBlocked !== null) {
    return { error: `unsupported board import: ${board.config.mutationBlocked}` };
  }
  return { docs, board };
}
