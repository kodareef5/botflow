// Resource ceilings for untrusted repository and snapshot documents. These
// bound memory before parsing; they are deliberately generous for a text-first
// kanban while staying below typical Node/Worker process limits.

export const MAX_BOARD_CONFIG_SIZE = 1 * 1024 * 1024;
export const MAX_CARD_DOCUMENT_SIZE = 8 * 1024 * 1024;
export const MAX_CARDS_PER_BOARD = 10_000;
export const MAX_BOARD_DIRECTORY_ENTRIES = 20_000;
export const MAX_BOARD_DOCUMENT_SIZE = 64 * 1024 * 1024;
export const MAX_TREE_BOARDS = 4_096;
export const MAX_TREE_DOCUMENT_SIZE = 128 * 1024 * 1024;

export class ResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceLimitError';
  }
}

/** Character-count checks are runtime-neutral and conservatively bound JS
 *  heap use. Filesystem callers additionally enforce the same limits in bytes
 *  from lstat before allocating strings. */
export function boardDocumentLimitError(config: string | null, cards: readonly { path: string; text: string }[]): string | null {
  if (config !== null && config.length > MAX_BOARD_CONFIG_SIZE) {
    return `board.yaml exceeds the ${MAX_BOARD_CONFIG_SIZE}-character limit`;
  }
  if (cards.length > MAX_CARDS_PER_BOARD) {
    return `board has ${cards.length} card files; limit is ${MAX_CARDS_PER_BOARD}`;
  }
  let total = config?.length ?? 0;
  for (const card of cards) {
    if (card.text.length > MAX_CARD_DOCUMENT_SIZE) {
      return `${card.path} exceeds the ${MAX_CARD_DOCUMENT_SIZE}-character limit`;
    }
    total += card.text.length;
    if (total > MAX_BOARD_DOCUMENT_SIZE) {
      return `board documents exceed the ${MAX_BOARD_DOCUMENT_SIZE}-character total limit`;
    }
  }
  return null;
}
