// Card frontmatter → Card (SPEC §5), collecting findings instead of throwing.

import type { YamlValue } from './yaml.ts';
import type { Card, CardRelation, Finding } from './model.ts';
import { RELATION_TYPES, finding } from './model.ts';
import { validCardDate, validEstimate } from './fields.ts';
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

  let title = '(untitled)';
  if (typeof m['title'] === 'string' && m['title'] !== '') title = m['title'];
  else findings.push(finding('schema', id, 'title is required and must be a string'));

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
    findings.push(finding('schema', id, 'lane is required and must be a string'));
  }

  let type: 'task' | 'board' = 'task';
  if (m['type'] !== undefined) {
    if (m['type'] === 'task' || m['type'] === 'board') type = m['type'];
    else findings.push(finding('schema', id, `type must be "task" or "board", got ${JSON.stringify(m['type'])}`));
  }

  let boardPath: string | null = null;
  if (type === 'board') {
    if (typeof m['board'] === 'string' && m['board'] !== '') boardPath = m['board'];
    else findings.push(finding('schema', id, 'a board-card requires a board: path'));
  } else if (m['board'] !== undefined) {
    findings.push(finding('schema', id, 'board: is only allowed on type: board cards'));
  }

  const labels: string[] = [];
  if (m['labels'] !== undefined) {
    if (Array.isArray(m['labels'])) {
      for (const l of m['labels']) {
        const s = asIdString(l);
        if (s !== null) labels.push(s);
        else findings.push(finding('schema', id, `bad label ${JSON.stringify(l)}`));
      }
    } else {
      findings.push(finding('schema', id, 'labels must be a list'));
    }
  }

  const actorList = (key: 'watchers' | 'votes'): string[] => {
    const raw = m[key];
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      findings.push(finding('schema', id, `${key} must be a list`));
      return [];
    }
    const values: string[] = [];
    for (const value of raw) {
      if (typeof value !== 'string' || value === '') {
        findings.push(finding('schema', id, `${key} must contain non-empty actor names`));
      } else if (values.includes(value)) {
        findings.push(finding('schema', id, `${key} contains duplicate actor "${value}"`));
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
        else findings.push(finding('schema', id, `bad dep ${JSON.stringify(d)}`));
      }
    } else {
      findings.push(finding('schema', id, 'deps must be a list'));
    }
  }

  const relations: CardRelation[] = [];
  if (m['relations'] !== undefined) {
    if (!Array.isArray(m['relations'])) {
      findings.push(finding('schema', id, 'relations must be a list of maps'));
    } else {
      const seen = new Set<string>();
      for (const raw of m['relations']) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          findings.push(finding('schema', id, 'each relation must be a mapping'));
          continue;
        }
        const map = raw as Record<string, YamlValue>;
        if (typeof map['type'] !== 'string' || !(RELATION_TYPES as readonly string[]).includes(map['type'])) {
          findings.push(finding('schema', id, `relation type must be one of ${RELATION_TYPES.join(', ')}`));
          continue;
        }
        const target = asIdString(map['target']);
        if (target === null || parseCardReference(target) === null) {
          findings.push(finding('schema', id, 'relation target must be a card reference'));
          continue;
        }
        const key = `${map['type']}\u0000${target}`;
        if (seen.has(key)) {
          findings.push(finding('schema', id, `duplicate ${map['type']} relation to "${target}"`));
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
    else findings.push(finding('schema', id, `priority must be p0–p3, got ${JSON.stringify(m['priority'])}`));
  }

  const dateField = (key: 'start' | 'due'): string | null => {
    const value = m[key];
    if (value === undefined) return null;
    if (typeof value === 'string' && validCardDate(value)) return value;
    findings.push(finding('schema', id, `${key} must be YYYY-MM-DD or a UTC ISO datetime, got ${JSON.stringify(value)}`));
    return null;
  };

  let estimate: number | null = null;
  if (m['estimate'] !== undefined) {
    if (validEstimate(m['estimate'])) estimate = m['estimate'];
    else findings.push(finding('schema', id, `estimate must be a positive integer, got ${JSON.stringify(m['estimate'])}`));
  }

  let evergreen = false;
  if (m['evergreen'] !== undefined) {
    if (typeof m['evergreen'] === 'boolean') evergreen = m['evergreen'];
    else findings.push(finding('schema', id, `evergreen must be true or false, got ${JSON.stringify(m['evergreen'])}`));
  }

  const actorField = (key: 'assignee' | 'delegate'): string | null => {
    const value = m[key];
    if (value === undefined) return null;
    if (typeof value === 'string' && value !== '') return value;
    findings.push(finding('schema', id, `${key} must be a non-empty string, got ${JSON.stringify(value)}`));
    return null;
  };

  let coverColor: string | null = null;
  if (m['cover_color'] !== undefined) {
    if (typeof m['cover_color'] === 'string' && validColor(m['cover_color'])) coverColor = m['cover_color'].toLowerCase();
    else findings.push(finding('schema', id, `cover_color must be #RGB or #RRGGBB, got ${JSON.stringify(m['cover_color'])}`));
  }

  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(m)) {
    if (!BUILTIN_CARD_KEYS.has(key)) {
      extra[key] = m[key];
      if (!customFieldIds.has(key)) findings.push(finding('unknown-key', id, `unknown frontmatter key "${key}" (preserved)`));
    }
  }

  return {
    id,
    title,
    laneId,
    substate,
    type,
    boardPath,
    labels,
    assignee: actorField('assignee'),
    delegate: actorField('delegate'),
    watchers: actorList('watchers'),
    votes: actorList('votes'),
    priority,
    deps,
    relations,
    start: dateField('start'),
    due: dateField('due'),
    estimate,
    evergreen,
    cover: optString(m['cover']),
    coverColor,
    blocked: optString(m['blocked']),
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
