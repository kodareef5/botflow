// Card frontmatter → Card (SPEC §5), collecting findings instead of throwing.

import type { YamlValue } from './yaml.ts';
import type { Card, Finding } from './model.ts';
import { finding } from './model.ts';

const KNOWN_KEYS = new Set([
  'id', 'title', 'lane', 'type', 'board', 'labels', 'assignee', 'priority', 'deps', 'blocked', 'created', 'updated',
]);

const PRIORITY_RE = /^p[0-3]$/;

/** Parse card frontmatter data. `fileBase` is the file's basename, used as the
 *  finding ref until an id is known. Returns null when the card is unusable. */
export function parseCard(value: YamlValue, fileBase: string, file: string, body: string, findings: Finding[]): Card | null {
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

  const deps: string[] = [];
  if (m['deps'] !== undefined) {
    if (Array.isArray(m['deps'])) {
      for (const d of m['deps']) {
        const s = asIdString(d);
        if (s !== null) deps.push(s);
        else findings.push(finding('schema', id, `bad dep ${JSON.stringify(d)}`));
      }
    } else {
      findings.push(finding('schema', id, 'deps must be a list'));
    }
  }

  let priority: string | null = null;
  if (m['priority'] !== undefined) {
    if (typeof m['priority'] === 'string' && PRIORITY_RE.test(m['priority'])) priority = m['priority'];
    else findings.push(finding('schema', id, `priority must be p0–p3, got ${JSON.stringify(m['priority'])}`));
  }

  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(m)) {
    if (!KNOWN_KEYS.has(key)) {
      extra[key] = m[key];
      findings.push(finding('unknown-key', id, `unknown frontmatter key "${key}" (preserved)`));
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
    assignee: optString(m['assignee']),
    priority,
    deps,
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
