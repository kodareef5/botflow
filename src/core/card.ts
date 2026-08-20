// Card frontmatter → Card (SPEC §5), collecting findings instead of throwing.

import type { YamlValue } from './yaml.ts';
import type { Card, CardRelation, CardRepeat, Finding } from './model.ts';
import { RELATION_TYPES, SLUG_RE, finding } from './model.ts';
import { validCardDate, validEstimate, validHill } from './fields.ts';
import { BUILTIN_CARD_KEYS, validColor } from './presentation.ts';
import { parseCardReference } from './refs.ts';

const PRIORITY_RE = /^p[0-3]$/;

/** Parse card frontmatter data. `fileBase` is the file's basename, used as the
 *  finding ref until an id is known. Returns null when the card is unusable. */
export function parseCard(
  value: YamlValue,
  fileBase: string,
  file: string,
  body: string,
  findings: Finding[],
  customFieldIds: ReadonlySet<string> = new Set(),
): Card | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    findings.push(finding('schema', fileBase, 'card frontmatter must be a mapping'));
    return null;
  }
  const m = value as { [key: string]: YamlValue };

  const id = asIdString(m['id']);
  if (id === null) {
    findings.push(finding('schema', fileBase, 'card id is required'));
    return null;
  }
  const invalidKnown = new Set<string>();
  const invalid = (key: string, message: string): void => {
    invalidKnown.add(key);
    findings.push(finding('schema', id, message));
  };

  let title = '(untitled)';
  if (typeof m['title'] === 'string' && m['title'] !== '') title = m['title'];
  else invalid('title', 'title is required and must be a string');

  let laneId = 'todo';
  let substate: string | null = null;
  if (typeof m['lane'] === 'string' && m['lane'] !== '') {
    const dot = m['lane'].indexOf('.');
    if (dot === -1) laneId = m['lane'];
    else {
      laneId = m['lane'].slice(0, dot);
      substate = m['lane'].slice(dot + 1);
    }
  } else {
    invalid('lane', 'lane is required and must be a string');
  }

  let type: 'task' | 'board' = 'task';
  if (m['type'] !== undefined) {
    if (m['type'] === 'task' || m['type'] === 'board') type = m['type'];
    else invalid('type', `type must be "task" or "board", got ${JSON.stringify(m['type'])}`);
  }

  let boardPath: string | null = null;
  if (type === 'board') {
    if (typeof m['board'] === 'string' && m['board'] !== '') boardPath = m['board'];
    else invalid('board', 'a board-card requires a board: path');
  } else if (m['board'] !== undefined) {
    invalid('board', 'board: is only allowed on type: board cards');
  }

  const labels: string[] = [];
  if (m['labels'] !== undefined) {
    if (Array.isArray(m['labels'])) {
      for (const l of m['labels']) {
        const s = asIdString(l);
        if (s !== null) labels.push(s);
        else invalid('labels', `bad label ${JSON.stringify(l)}`);
      }
    } else {
      invalid('labels', 'labels must be a list');
    }
  }

  const actorList = (key: 'watchers' | 'votes'): string[] => {
    const raw = m[key];
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      invalid(key, `${key} must be a list`);
      return [];
    }
    const values: string[] = [];
    for (const value of raw) {
      if (typeof value !== 'string' || value === '') {
        invalid(key, `${key} must contain non-empty actor names`);
      } else if (values.includes(value)) {
        invalid(key, `${key} contains duplicate actor "${value}"`);
      } else {
        values.push(value);
      }
    }
    return values;
  };

  const deps: string[] = [];
  if (m['deps'] !== undefined) {
    if (Array.isArray(m['deps'])) {
      for (const d of m['deps']) {
        const s = asIdString(d);
        if (s !== null && parseCardReference(s) !== null) deps.push(s);
        else invalid('deps', `bad dep ${JSON.stringify(d)}`);
      }
    } else {
      invalid('deps', 'deps must be a list');
    }
  }

  const relations: CardRelation[] = [];
  if (m['relations'] !== undefined) {
    if (!Array.isArray(m['relations'])) {
      invalid('relations', 'relations must be a list of maps');
    } else {
      const seen = new Set<string>();
      for (const raw of m['relations']) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          invalid('relations', 'each relation must be a mapping');
          continue;
        }
        const map = raw as Record<string, YamlValue>;
        if (typeof map['type'] !== 'string' || !(RELATION_TYPES as readonly string[]).includes(map['type'])) {
          invalid('relations', `relation type must be one of ${RELATION_TYPES.join(', ')}`);
          continue;
        }
        const target = asIdString(map['target']);
        if (target === null || parseCardReference(target) === null) {
          invalid('relations', 'relation target must be a card reference');
          continue;
        }
        const key = `${map['type']}\u0000${target}`;
        if (seen.has(key)) {
          invalid('relations', `duplicate ${map['type']} relation to "${target}"`);
          continue;
        }
        seen.add(key);
        const extra: Record<string, unknown> = {};
        for (const name of Object.keys(map)) {
          if (name !== 'type' && name !== 'target') {
            extra[name] = map[name];
            findings.push(finding('unknown-key', id, `relation to "${target}": unknown key "${name}" (preserved)`));
          }
        }
        relations.push({ type: map['type'] as CardRelation['type'], target, extra });
      }
    }
  }

  let priority: string | null = null;
  if (m['priority'] !== undefined) {
    if (typeof m['priority'] === 'string' && PRIORITY_RE.test(m['priority'])) priority = m['priority'];
    else invalid('priority', `priority must be p0–p3, got ${JSON.stringify(m['priority'])}`);
  }

  const dateField = (key: 'start' | 'due' | 'snooze'): string | null => {
    const value = m[key];
    if (value === undefined) return null;
    if (typeof value === 'string' && validCardDate(value)) return value;
    invalid(key, `${key} must be YYYY-MM-DD or a UTC ISO datetime, got ${JSON.stringify(value)}`);
    return null;
  };

  const start = dateField('start');
  const due = dateField('due');
  const snooze = dateField('snooze');

  const reminders: number[] = [];
  if (m['reminders'] !== undefined) {
    if (!Array.isArray(m['reminders'])) {
      invalid('reminders', 'reminders must be a list of nonnegative minute offsets');
    } else {
      for (const value of m['reminders']) {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || reminders.includes(value)) {
          invalid('reminders', 'reminders must contain unique nonnegative integers');
        } else reminders.push(value);
      }
    }
    if (due === null) invalid('reminders', 'reminders require due');
  }

  let repeat: CardRepeat | null = null;
  if (m['repeat'] !== undefined) {
    const raw = m['repeat'];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      invalid('repeat', 'repeat must be a recurrence mapping');
    } else {
      const map = raw as Record<string, YamlValue>;
      const every = typeof map['every'] === 'number' && Number.isSafeInteger(map['every']) && map['every'] > 0 ? map['every'] : null;
      const unit = map['unit'] === 'day' || map['unit'] === 'week' || map['unit'] === 'month' ? map['unit'] : null;
      const from = map['from'] === undefined || map['from'] === 'due' ? 'due' : map['from'] === 'completion' ? 'completion' : null;
      if (every === null) invalid('repeat', 'repeat.every must be a positive integer');
      if (unit === null) invalid('repeat', 'repeat.unit must be day, week, or month');
      if (from === null) invalid('repeat', 'repeat.from must be due or completion');
      const extra: Record<string, unknown> = {};
      for (const key of Object.keys(map)) {
        if (key !== 'every' && key !== 'unit' && key !== 'from') {
          extra[key] = map[key];
          findings.push(finding('unknown-key', id, `repeat: unknown key "${key}" (preserved)`));
        }
      }
      if (every !== null && unit !== null && from !== null) repeat = { every, unit, from, extra };
    }
    if (due === null) invalid('repeat', 'repeat requires due');
    if (type === 'board') invalid('repeat', 'repeat is not allowed on board-cards');
  }

  let blocker: string | null = null;
  if (m['blocker'] !== undefined) {
    if (typeof m['blocker'] === 'string' && SLUG_RE.test(m['blocker'])) blocker = m['blocker'];
    else invalid('blocker', 'blocker must be a lowercase slug');
  }
  const blocked = optString(m['blocked']);
  if (m['blocked'] !== undefined && blocked === null) invalid('blocked', 'blocked must be a non-empty string');
  if (blocker !== null && blocked === null) invalid('blocker', 'blocker requires blocked');

  let estimate: number | null = null;
  if (m['estimate'] !== undefined) {
    if (validEstimate(m['estimate'])) estimate = m['estimate'];
    else invalid('estimate', `estimate must be a positive integer, got ${JSON.stringify(m['estimate'])}`);
  }

  let hill: number | null = null;
  if (m['hill'] !== undefined) {
    if (validHill(m['hill'])) hill = m['hill'];
    else invalid('hill', `hill must be an integer from 0 to 100, got ${JSON.stringify(m['hill'])}`);
  }

  let evergreen = false;
  if (m['evergreen'] !== undefined) {
    if (typeof m['evergreen'] === 'boolean') evergreen = m['evergreen'];
    else invalid('evergreen', `evergreen must be true or false, got ${JSON.stringify(m['evergreen'])}`);
  }

  const actorField = (key: 'assignee' | 'delegate'): string | null => {
    const value = m[key];
    if (value === undefined) return null;
    if (typeof value === 'string' && value !== '') return value;
    invalid(key, `${key} must be a non-empty string, got ${JSON.stringify(value)}`);
    return null;
  };

  let coverColor: string | null = null;
  if (m['cover_color'] !== undefined) {
    if (typeof m['cover_color'] === 'string' && validColor(m['cover_color'])) coverColor = m['cover_color'].toLowerCase();
    else invalid('cover_color', `cover_color must be #RGB or #RRGGBB, got ${JSON.stringify(m['cover_color'])}`);
  }

  // Parse helpers that can mark rejected built-ins must run before `extra` is
  // assembled, so the original YAML value can be retained for round trips.
  const assignee = actorField('assignee');
  const delegate = actorField('delegate');
  const watchers = actorList('watchers');
  const votes = actorList('votes');

  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(m)) {
    if (!BUILTIN_CARD_KEYS.has(key)) {
      extra[key] = m[key];
      if (!customFieldIds.has(key)) findings.push(finding('unknown-key', id, `unknown frontmatter key "${key}" (preserved)`));
    } else if (invalidKnown.has(key)) extra[key] = m[key];
  }

  return {
    id,
    title,
    laneId,
    substate,
    type,
    boardPath,
    labels,
    assignee,
    delegate,
    watchers,
    votes,
    priority,
    deps,
    relations,
    start,
    due,
    reminders,
    repeat,
    snooze,
    estimate,
    hill,
    evergreen,
    cover: optString(m['cover']),
    coverColor,
    blocked,
    blocker,
    created: optString(m['created']),
    updated: optString(m['updated']),
    extra,
    file,
    body,
  };
}

function asIdString(v: YamlValue | undefined | unknown): string | null {
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  return null;
}

function optString(v: YamlValue | undefined): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}
