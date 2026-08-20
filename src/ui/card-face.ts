// Shared compact-card display rules. The browser renderers embed the numeric
// bounds from here, while persisted worker settings use the same validator.

export const DEFAULT_CARD_TAG_LIMIT = 3;
export const MAX_CARD_TAG_LIMIT = 10;

export function validCardTagLimit(value: unknown): number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_CARD_TAG_LIMIT
    ? value
    : DEFAULT_CARD_TAG_LIMIT;
}

export function cardTagWindow<T>(tags: readonly T[], requestedLimit: unknown): {
  visible: T[];
  hiddenCount: number;
} {
  const limit = validCardTagLimit(requestedLimit);
  return {
    visible: tags.slice(0, limit),
    hiddenCount: Math.max(0, tags.length - limit),
  };
}
