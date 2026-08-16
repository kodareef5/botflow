// board.yaml → BoardConfig (SPEC §4), collecting findings instead of throwing.

import type { YamlValue } from './yaml.ts';
import type { BoardConfig, Finding, Lane, RollupPolicy, Canonical } from './model.ts';
import { SLUG_RE, defaultLanes, defaultRollup, finding, isCanonical } from './model.ts';

const REF = 'board.yaml';

export function parseBoardConfig(value: YamlValue, findings: Finding[]): BoardConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    findings.push(finding('schema', REF, 'board.yaml must be a mapping'));
    return { ...fallback('unnamed') };
  }
  const map = value as { [key: string]: YamlValue };

  const version = map['botflow'];
  if (version !== 0) {
    findings.push(finding('schema', REF, `unsupported or missing botflow version (expected 0, got ${JSON.stringify(version ?? null)})`));
  }

  let name = 'unnamed';
  if (typeof map['name'] === 'string' && map['name'] !== '') name = map['name'];
  else findings.push(finding('schema', REF, 'name is required and must be a string'));

  let ids: 'seq' | 'hash' = 'seq';
  if (map['ids'] !== undefined) {
    if (map['ids'] === 'seq' || map['ids'] === 'hash') ids = map['ids'];
    else findings.push(finding('schema', REF, `ids must be "seq" or "hash", got ${JSON.stringify(map['ids'])}`));
  }

  let lanes: Lane[];
  let lanesDefaulted = false;
  if (map['lanes'] === undefined) {
    lanes = defaultLanes();
    lanesDefaulted = true;
  } else if (!Array.isArray(map['lanes'])) {
    findings.push(finding('schema', REF, 'lanes must be a list'));
    lanes = defaultLanes();
    lanesDefaulted = true;
  } else {
    lanes = parseLanes(map['lanes'], findings);
  }

  const rollup = parseRollup(map['rollup'], findings);

  const known = new Set(['botflow', 'name', 'ids', 'lanes', 'rollup']);
  for (const key of Object.keys(map)) {
    if (!known.has(key)) findings.push(finding('unknown-key', REF, `unknown board.yaml key "${key}"`));
  }

  return { version: 0, name, ids, lanes, lanesDefaulted, rollup };
}

function parseLanes(items: YamlValue[], findings: Finding[]): Lane[] {
  const lanes: Lane[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      findings.push(finding('schema', REF, 'each lane must be a mapping'));
      continue;
    }
    const m = item as { [key: string]: YamlValue };
    const id = typeof m['id'] === 'string' ? m['id'] : null;
    if (id === null || !SLUG_RE.test(id)) {
      findings.push(finding('schema', REF, `lane id missing or not a slug: ${JSON.stringify(m['id'] ?? null)}`));
      continue;
    }
    if (seen.has(id)) {
      findings.push(finding('schema', REF, `duplicate lane id "${id}"`));
      continue;
    }
    seen.add(id);

    let canonical: Canonical;
    const rawCanonical = m['canonical'];
    if (isCanonical(id)) {
      canonical = id;
      if (rawCanonical !== undefined && rawCanonical !== id) {
        findings.push(finding('schema', REF, `lane "${id}" is a canonical name; its canonical must be "${id}"`));
      }
    } else if (typeof rawCanonical === 'string' && isCanonical(rawCanonical)) {
      canonical = rawCanonical;
    } else {
      findings.push(finding('schema', REF, `lane "${id}" needs a canonical state`));
      canonical = 'todo';
    }

    const substates: string[] = [];
    if (m['substates'] !== undefined) {
      if (Array.isArray(m['substates'])) {
        for (const s of m['substates']) {
          if (typeof s === 'string' && SLUG_RE.test(s) && !substates.includes(s)) substates.push(s);
          else findings.push(finding('schema', REF, `lane "${id}": bad substate ${JSON.stringify(s)}`));
        }
      } else {
        findings.push(finding('schema', REF, `lane "${id}": substates must be a list`));
      }
    }

    let order: 'strict' | 'free' = 'free';
    if (m['order'] !== undefined) {
      if (m['order'] === 'strict' || m['order'] === 'free') order = m['order'];
      else findings.push(finding('schema', REF, `lane "${id}": order must be "strict" or "free"`));
    }

    let wip: number | null = null;
    if (m['wip'] !== undefined) {
      if (typeof m['wip'] === 'number' && Number.isInteger(m['wip']) && m['wip'] > 0) wip = m['wip'];
      else findings.push(finding('schema', REF, `lane "${id}": wip must be a positive integer`));
    }

    const knownLaneKeys = new Set(['id', 'name', 'canonical', 'substates', 'order', 'wip']);
    for (const key of Object.keys(m)) {
      if (!knownLaneKeys.has(key)) findings.push(finding('unknown-key', REF, `lane "${id}": unknown key "${key}"`));
    }

    lanes.push({
      id,
      name: typeof m['name'] === 'string' && m['name'] !== '' ? m['name'] : id,
      canonical,
      substates,
      order,
      wip,
    });
  }
  return lanes;
}

function parseRollup(value: YamlValue | undefined, findings: Finding[]): RollupPolicy {
  const rollup = defaultRollup();
  if (value === undefined) return rollup;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    findings.push(finding('schema', REF, 'rollup must be a mapping'));
    return rollup;
  }
  const m = value as { [key: string]: YamlValue };
  const pick = <T extends string>(key: string, allowed: readonly T[], set: (v: T) => void): void => {
    const v = m[key];
    if (v === undefined) return;
    if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) set(v as T);
    else findings.push(finding('schema', REF, `rollup.${key} must be one of ${allowed.join(', ')}`));
  };
  pick('blocked_when', ['any-blocked', 'never'] as const, (v) => (rollup.blockedWhen = v));
  pick('done_when', ['all-done'] as const, (v) => (rollup.doneWhen = v));
  pick('doing_when', ['any-started', 'any-doing'] as const, (v) => (rollup.doingWhen = v));
  pick('else', ['todo', 'wishlist'] as const, (v) => (rollup.elseState = v));
  const knownKeys = new Set(['blocked_when', 'done_when', 'doing_when', 'else']);
  for (const key of Object.keys(m)) {
    if (!knownKeys.has(key)) findings.push(finding('unknown-key', REF, `rollup: unknown key "${key}"`));
  }
  return rollup;
}

function fallback(name: string): BoardConfig {
  return { version: 0, name, ids: 'seq', lanes: defaultLanes(), lanesDefaulted: true, rollup: defaultRollup() };
}
