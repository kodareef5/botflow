// board.yaml ⇄ BoardConfig (SPEC §4): parse collects findings instead of
// throwing; emit produces spec-clean yaml (defaults omitted) for tools that
// edit board shape, like the hosted board editor.

import type { YamlValue } from './yaml.ts';
import type { BoardConfig, Finding, Lane, RollupPolicy, Canonical } from './model.ts';
import { SLUG_RE, defaultLanes, defaultRollup, finding, isCanonical } from './model.ts';
import { emitMap, emitScalar } from './emit.ts';

/** Capability names understood by this reader. Later feature phases add to
 *  this registry as their semantics become real; declarations are optional,
 *  but an unknown declaration deliberately makes a board read-only. */
export const SUPPORTED_BOARD_FEATURES = new Set(['dates', 'estimates', 'delegation', 'aging']);

/** Serialize a BoardConfig back to board.yaml text. Defaults are omitted so
 *  the file stays as small as a hand-written one; parse(emit(c)) === c. */
export function emitBoardYaml(config: Pick<BoardConfig, 'version' | 'name' | 'ids' | 'features' | 'lanes' | 'rollup' | 'extra'>): string {
  const lines = [`botflow: ${config.version}`, `name: ${emitScalar(config.name)}`];
  if (config.ids === 'hash') lines.push('ids: hash');
  if (config.features.length > 0) lines.push(`features: [${config.features.map(emitScalar).join(', ')}]`);
  lines.push('lanes:');
  for (const lane of config.lanes) {
    lines.push(`  - id: ${lane.id}`);
    if (lane.name !== lane.id) lines.push(`    name: ${emitScalar(lane.name)}`);
    if (!isCanonical(lane.id)) lines.push(`    canonical: ${lane.canonical}`);
    if (lane.substates.length > 0) lines.push(`    substates: [${lane.substates.join(', ')}]`);
    if (lane.order === 'strict') lines.push('    order: strict');
    if (lane.wip !== null) lines.push(`    wip: ${lane.wip}`);
    const laneExtra = emitMap(lane.extra, 4);
    if (laneExtra !== '') lines.push(laneExtra);
  }
  const d = defaultRollup();
  const rollup: string[] = [];
  if (config.rollup.blockedWhen !== d.blockedWhen) rollup.push(`  blocked_when: ${config.rollup.blockedWhen}`);
  if (config.rollup.doingWhen !== d.doingWhen) rollup.push(`  doing_when: ${config.rollup.doingWhen}`);
  if (config.rollup.elseState !== d.elseState) rollup.push(`  else: ${config.rollup.elseState}`);
  const rollupExtra = emitMap(config.rollup.extra, 2);
  if (rollupExtra !== '') rollup.push(rollupExtra);
  if (rollup.length > 0) lines.push('rollup:', ...rollup);
  const extra = emitMap(config.extra);
  if (extra !== '') lines.push(extra);
  return lines.join('\n') + '\n';
}

const REF = 'board.yaml';

export function parseBoardConfig(value: YamlValue, findings: Finding[]): BoardConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    findings.push(finding('schema', REF, 'board.yaml must be a mapping'));
    return { ...fallback('unnamed') };
  }
  const map = value as { [key: string]: YamlValue };

  const rawVersion = map['botflow'];
  const version = typeof rawVersion === 'number' && Number.isInteger(rawVersion) ? rawVersion : 0;
  let mutationBlocked: string | null = null;
  if (rawVersion !== 0) {
    findings.push(finding('schema', REF, `unsupported or missing botflow version (expected 0, got ${JSON.stringify(rawVersion ?? null)})`));
    mutationBlocked = typeof rawVersion === 'number' && Number.isInteger(rawVersion)
      ? `botflow major ${rawVersion} is unsupported by this reader`
      : 'botflow major is missing or invalid';
  }

  let name = 'unnamed';
  if (typeof map['name'] === 'string' && map['name'] !== '') name = map['name'];
  else findings.push(finding('schema', REF, 'name is required and must be a string'));

  let ids: 'seq' | 'hash' = 'seq';
  if (map['ids'] !== undefined) {
    if (map['ids'] === 'seq' || map['ids'] === 'hash') ids = map['ids'];
    else findings.push(finding('schema', REF, `ids must be "seq" or "hash", got ${JSON.stringify(map['ids'])}`));
  }

  const features: string[] = [];
  const unsupportedFeatures: string[] = [];
  if (map['features'] !== undefined) {
    if (Array.isArray(map['features'])) {
      for (const feature of map['features']) {
        if (typeof feature !== 'string' || !SLUG_RE.test(feature)) {
          findings.push(finding('schema', REF, `feature must be a slug, got ${JSON.stringify(feature)}`));
          mutationBlocked ??= 'features declaration is invalid';
          continue;
        }
        if (features.includes(feature)) continue;
        features.push(feature);
        if (!SUPPORTED_BOARD_FEATURES.has(feature)) {
          unsupportedFeatures.push(feature);
          findings.push(finding('unsupported-feature', REF, `unsupported board feature "${feature}"; board is read-only`));
        }
      }
    } else {
      findings.push(finding('schema', REF, 'features must be a list of slugs'));
      mutationBlocked ??= 'features declaration is invalid';
    }
  }
  if (unsupportedFeatures.length > 0 && mutationBlocked === null) {
    mutationBlocked = `unsupported board feature(s): ${unsupportedFeatures.join(', ')}`;
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

  const known = new Set(['botflow', 'name', 'ids', 'features', 'lanes', 'rollup']);
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(map)) {
    if (!known.has(key)) {
      extra[key] = map[key];
      findings.push(finding('unknown-key', REF, `unknown board.yaml key "${key}" (preserved)`));
    }
  }

  return { version, name, ids, features, unsupportedFeatures, mutationBlocked, lanes, lanesDefaulted, rollup, extra };
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
    const extra: Record<string, unknown> = {};
    for (const key of Object.keys(m)) {
      if (!knownLaneKeys.has(key)) {
        extra[key] = m[key];
        findings.push(finding('unknown-key', REF, `lane "${id}": unknown key "${key}" (preserved)`));
      }
    }

    lanes.push({
      id,
      name: typeof m['name'] === 'string' && m['name'] !== '' ? m['name'] : id,
      canonical,
      substates,
      order,
      wip,
      extra,
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
    if (!knownKeys.has(key)) {
      rollup.extra[key] = m[key];
      findings.push(finding('unknown-key', REF, `rollup: unknown key "${key}" (preserved)`));
    }
  }
  return rollup;
}

function fallback(name: string): BoardConfig {
  return {
    version: 0,
    name,
    ids: 'seq',
    features: [],
    unsupportedFeatures: [],
    mutationBlocked: 'board.yaml is malformed',
    lanes: defaultLanes(),
    lanesDefaulted: true,
    rollup: defaultRollup(),
    extra: {},
  };
}
