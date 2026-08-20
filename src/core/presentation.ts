// Board-declared presentation semantics. Custom values remain ordinary card
// frontmatter (`Card.extra`) so old readers preserve them; this module only
// validates and projects those values for current readers.

import type { BoardConfig, Card, CustomFieldDefinition } from './model.ts';
import { validCardDate } from './fields.ts';

export const BUILTIN_CARD_KEYS = new Set([
  'id', 'title', 'lane', 'type', 'board', 'labels', 'assignee', 'delegate', 'priority', 'deps', 'relations',
  'start', 'due', 'estimate', 'evergreen', 'cover', 'cover_color', 'blocked', 'created', 'updated',
]);

export const RESERVED_CARD_KEYS = new Set(['spent', 'watchers', 'relates', 'weight']);

const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const PALETTE = ['#2a78d6', '#d03b3b', '#0e8a67', '#8d5bd1', '#c47317', '#b43f8c', '#427a3c', '#5266b8', '#b5512e', '#087d8f'];

export function validColor(value: string): boolean {
  return COLOR_RE.test(value);
}

export function scopedLabel(label: string): { group: string; value: string } | null {
  const slash = label.indexOf('/');
  if (slash <= 0 || slash === label.length - 1) return null;
  return { group: label.slice(0, slash), value: label.slice(slash + 1) };
}

export function labelGroupConflict(labels: string[]): string | null {
  const groups = new Map<string, string>();
  for (const label of labels) {
    const scoped = scopedLabel(label);
    if (!scoped) continue;
    const previous = groups.get(scoped.group);
    if (previous !== undefined && previous !== label) return `labels "${previous}" and "${label}" both belong to group "${scoped.group}"`;
    groups.set(scoped.group, label);
  }
  return null;
}

function colorHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function labelColor(config: BoardConfig, label: string): string {
  const declared = config.labelDefinitions.find((definition) => definition.id === label)?.color;
  return declared ?? PALETTE[colorHash(scopedLabel(label)?.group ?? label) % PALETTE.length]!;
}

export function validCustomFieldValue(definition: CustomFieldDefinition, value: unknown): boolean {
  switch (definition.type) {
    case 'text':
    case 'person':
      return typeof value === 'string';
    case 'url': {
      if (typeof value !== 'string') return false;
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    }
    case 'number':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'checkbox':
      return typeof value === 'boolean';
    case 'date':
      return typeof value === 'string' && validCardDate(value);
    case 'select':
      return typeof value === 'string' && definition.options.includes(value);
    case 'multi-select':
      return Array.isArray(value) && value.every((item) => typeof item === 'string' && definition.options.includes(item));
  }
}

export function customFieldFilled(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0);
}

export interface CustomFieldValue {
  id: string;
  name: string;
  type: CustomFieldDefinition['type'];
  value: unknown;
  face: boolean;
}

export function cardCustomFields(card: Card, config: BoardConfig): CustomFieldValue[] {
  return config.customFields
    .filter((definition) => customFieldFilled(card.extra[definition.id]))
    .map((definition) => ({
      id: definition.id,
      name: definition.name,
      type: definition.type,
      value: card.extra[definition.id],
      face: definition.face,
    }));
}

/** CLI convenience: turn one `--field id=value` string into the same YAML-ish
 *  value the JSON APIs accept. Empty input is the clear sentinel. */
export function parseCustomFieldText(definition: CustomFieldDefinition, text: string): unknown {
  if (text === '') return null;
  switch (definition.type) {
    case 'number': {
      const value = Number(text);
      if (!Number.isSafeInteger(value)) throw new Error(`${definition.id} must be an integer`);
      return value;
    }
    case 'checkbox':
      if (text === 'true') return true;
      if (text === 'false') return false;
      throw new Error(`${definition.id} must be true or false`);
    case 'multi-select':
      return text.split(',').map((item) => item.trim()).filter(Boolean);
    default:
      return text;
  }
}
