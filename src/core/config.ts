// board.yaml ⇄ BoardConfig (SPEC §4): parse collects findings instead of
// throwing; emit produces spec-clean yaml (defaults omitted) for tools that
// edit board shape, like the hosted board editor.

import type { YamlValue } from './yaml.ts';
import type { BoardConfig, CardTemplate, CustomFieldDefinition, Finding, LabelDefinition, Lane, LaneSubscription, RollupPolicy, SavedFilter, Canonical } from './model.ts';
import { CUSTOM_FIELD_TYPES, SLUG_RE, defaultLanes, defaultRollup, finding, isCanonical } from './model.ts';
import { bodyHasSection } from './body.ts';
import { emitMap, emitScalar } from './emit.ts';
import { validCardDate, validEstimate } from './fields.ts';
import { BUILTIN_CARD_KEYS, RESERVED_CARD_KEYS, labelGroupConflict, validColor, validCustomFieldValue } from './presentation.ts';
import { QueryError, validateQuery } from './query.ts';

/** Capability names understood by this reader. Later feature phases add to
 *  this registry as their semantics become real; declarations are optional,
 *  but an unknown declaration deliberately makes a board read-only. */
export const SUPPORTED_BOARD_FEATURES = new Set([
  'dates', 'estimates', 'delegation', 'aging', 'scoped-labels', 'custom-fields', 'cover-colors',
  'relations', 'cross-board-deps', 'templates',
  'search', 'collaboration',
]);

/** Serialize a BoardConfig back to board.yaml text. Defaults are omitted so
 *  the file stays as small as a hand-written one; parse(emit(c)) === c. */
export function emitBoardYaml(config: Pick<BoardConfig, 'version' | 'name' | 'ids' | 'features' | 'lanes' | 'labelDefinitions' | 'customFields' | 'templates' | 'savedFilters' | 'subscriptions' | 'rollup' | 'extra'>): string {
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
  if (config.labelDefinitions.length > 0) {
    lines.push('labels:');
    for (const definition of config.labelDefinitions) {
      lines.push(`  - id: ${emitScalar(definition.id)}`);
      if (definition.color !== null) lines.push(`    color: ${emitScalar(definition.color)}`);
      const extra = emitMap(definition.extra, 4);
      if (extra !== '') lines.push(extra);
    }
  }
  if (config.customFields.length > 0) {
    lines.push('fields:');
    for (const definition of config.customFields) {
      lines.push(`  - id: ${definition.id}`);
      if (definition.name !== definition.id) lines.push(`    name: ${emitScalar(definition.name)}`);
      lines.push(`    type: ${definition.type}`);
      if (definition.options.length > 0) lines.push(`    options: [${definition.options.map(emitScalar).join(', ')}]`);
      if (definition.face) lines.push('    face: true');
      const extra = emitMap(definition.extra, 4);
      if (extra !== '') lines.push(extra);
    }
  }
  if (config.templates.length > 0) {
    lines.push('templates:');
    for (const template of config.templates) {
      lines.push(`  - id: ${template.id}`);
      if (template.name !== template.id) lines.push(`    name: ${emitScalar(template.name)}`);
      if (template.lane !== null) lines.push(`    lane: ${emitScalar(template.lane)}`);
      if (template.labels.length > 0) lines.push(`    labels: [${template.labels.map(emitScalar).join(', ')}]`);
      if (template.priority !== null) lines.push(`    priority: ${template.priority}`);
      if (template.assignee !== null) lines.push(`    assignee: ${emitScalar(template.assignee)}`);
      if (template.delegate !== null) lines.push(`    delegate: ${emitScalar(template.delegate)}`);
      if (template.start !== null) lines.push(`    start: ${emitScalar(template.start)}`);
      if (template.due !== null) lines.push(`    due: ${emitScalar(template.due)}`);
      if (template.estimate !== null) lines.push(`    estimate: ${template.estimate}`);
      if (template.evergreen) lines.push('    evergreen: true');
      if (template.coverColor !== null) lines.push(`    cover_color: ${emitScalar(template.coverColor)}`);
      if (Object.keys(template.fields).length > 0) lines.push(emitMap({ fields: template.fields }, 4));
      if (template.body !== '') lines.push(`    body: ${emitScalar(template.body)}`);
      const extra = emitMap(template.extra, 4);
      if (extra !== '') lines.push(extra);
    }
  }
  if (config.savedFilters.length > 0) {
    lines.push('filters:');
    for (const filter of config.savedFilters) {
      lines.push(`  - id: ${filter.id}`);
      if (filter.name !== filter.id) lines.push(`    name: ${emitScalar(filter.name)}`);
      lines.push(`    query: ${emitScalar(filter.query)}`);
      const extra = emitMap(filter.extra, 4);
      if (extra !== '') lines.push(extra);
    }
  }
  if (config.subscriptions.length > 0) {
    lines.push('subscriptions:');
    for (const subscription of config.subscriptions) {
      lines.push(`  - lane: ${subscription.lane}`);
      lines.push(`    watcher: ${emitScalar(subscription.watcher)}`);
      const extra = emitMap(subscription.extra, 4);
      if (extra !== '') lines.push(extra);
    }
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
  const labelDefinitions = parseLabelDefinitions(map['labels'], findings);
  const customFields = parseCustomFields(map['fields'], findings);
  const templates = parseTemplates(map['templates'], findings, lanes, customFields);
  const savedFilters = parseSavedFilters(map['filters'], findings, customFields);
  const subscriptions = parseSubscriptions(map['subscriptions'], findings, lanes);

  const known = new Set(['botflow', 'name', 'ids', 'features', 'lanes', 'labels', 'fields', 'templates', 'filters', 'subscriptions', 'rollup']);
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(map)) {
    if (!known.has(key)) {
      extra[key] = map[key];
      findings.push(finding('unknown-key', REF, `unknown board.yaml key "${key}" (preserved)`));
    }
  }

  return { version, name, ids, features, unsupportedFeatures, mutationBlocked, lanes, lanesDefaulted, labelDefinitions, customFields, templates, savedFilters, subscriptions, rollup, extra };
}

export function parseSavedFilters(
  value: YamlValue | undefined,
  findings: Finding[],
  customFields: CustomFieldDefinition[],
): SavedFilter[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    findings.push(finding('schema', REF, 'filters must be a list of filter maps'));
    return [];
  }
  const out: SavedFilter[] = [];
  const seen = new Set<string>();
  const fieldIds = new Set(customFields.map((field) => field.id));
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      findings.push(finding('schema', REF, 'each saved filter must be a mapping'));
      continue;
    }
    const map = raw as Record<string, YamlValue>;
    const id = typeof map['id'] === 'string' && SLUG_RE.test(map['id']) ? map['id'] : null;
    if (id === null) {
      findings.push(finding('schema', REF, 'saved filter id must be a lowercase slug'));
      continue;
    }
    if (seen.has(id)) {
      findings.push(finding('schema', REF, `duplicate saved filter id "${id}"`));
      continue;
    }
    seen.add(id);
    const name = typeof map['name'] === 'string' && map['name'] !== '' ? map['name'] : id;
    if (map['name'] !== undefined && name === id && map['name'] !== id) {
      findings.push(finding('schema', REF, `saved filter "${id}": name must be a non-empty string`));
    }
    const query = typeof map['query'] === 'string' ? map['query'] : null;
    if (query === null) {
      findings.push(finding('schema', REF, `saved filter "${id}": query must be a string`));
      continue;
    }
    try {
      validateQuery(query, fieldIds);
    } catch (err) {
      findings.push(finding('schema', REF, `saved filter "${id}": ${(err as QueryError).message}`));
    }
    const extra: Record<string, unknown> = {};
    for (const key of Object.keys(map)) {
      if (key !== 'id' && key !== 'name' && key !== 'query') {
        extra[key] = map[key];
        findings.push(finding('unknown-key', REF, `saved filter "${id}": unknown key "${key}" (preserved)`));
      }
    }
    out.push({ id, name, query, extra });
  }
  return out;
}

export function parseSubscriptions(value: YamlValue | undefined, findings: Finding[], lanes: Lane[]): LaneSubscription[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    findings.push(finding('schema', REF, 'subscriptions must be a list of subscription maps'));
    return [];
  }
  const out: LaneSubscription[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      findings.push(finding('schema', REF, 'each lane subscription must be a mapping'));
      continue;
    }
    const map = raw as Record<string, YamlValue>;
    const lane = typeof map['lane'] === 'string' && lanes.some((candidate) => candidate.id === map['lane']) ? map['lane'] : null;
    const watcher = typeof map['watcher'] === 'string' && map['watcher'] !== '' ? map['watcher'] : null;
    if (lane === null) findings.push(finding('schema', REF, `lane subscription has unknown lane ${JSON.stringify(map['lane'] ?? null)}`));
    if (watcher === null) findings.push(finding('schema', REF, 'lane subscription watcher must be a non-empty string'));
    if (lane === null || watcher === null) continue;
    const pair = `${lane}\u0000${watcher}`;
    if (seen.has(pair)) {
      findings.push(finding('schema', REF, `duplicate subscription for "${watcher}" on lane "${lane}"`));
      continue;
    }
    seen.add(pair);
    const extra: Record<string, unknown> = {};
    for (const key of Object.keys(map)) {
      if (key !== 'lane' && key !== 'watcher') {
        extra[key] = map[key];
        findings.push(finding('unknown-key', REF, `subscription for "${watcher}" on "${lane}": unknown key "${key}" (preserved)`));
      }
    }
    out.push({ lane, watcher, extra });
  }
  return out;
}

export function parseLabelDefinitions(value: YamlValue | undefined, findings: Finding[]): LabelDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    findings.push(finding('schema', REF, 'labels must be a list of label maps'));
    return [];
  }
  const out: LabelDefinition[] = [];
  const seen = new Set<string>();
  const knownKeys = new Set(['id', 'color']);
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      findings.push(finding('schema', REF, 'each label definition must be a mapping'));
      continue;
    }
    const map = raw as Record<string, YamlValue>;
    const id = typeof map['id'] === 'string' && map['id'] !== '' ? map['id'] : null;
    if (id === null) {
      findings.push(finding('schema', REF, 'label definition id must be a non-empty string'));
      continue;
    }
    if (seen.has(id)) {
      findings.push(finding('schema', REF, `duplicate label definition "${id}"`));
      continue;
    }
    seen.add(id);
    let color: string | null = null;
    if (map['color'] !== undefined) {
      if (typeof map['color'] === 'string' && validColor(map['color'])) color = map['color'].toLowerCase();
      else findings.push(finding('schema', REF, `label "${id}": color must be #RGB or #RRGGBB`));
    }
    const extra: Record<string, unknown> = {};
    for (const key of Object.keys(map)) {
      if (!knownKeys.has(key)) {
        extra[key] = map[key];
        findings.push(finding('unknown-key', REF, `label "${id}": unknown key "${key}" (preserved)`));
      }
    }
    out.push({ id, color, extra });
  }
  return out;
}

export function parseCustomFields(value: YamlValue | undefined, findings: Finding[]): CustomFieldDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    findings.push(finding('schema', REF, 'fields must be a list of field maps'));
    return [];
  }
  const out: CustomFieldDefinition[] = [];
  const seen = new Set<string>();
  const knownKeys = new Set(['id', 'name', 'type', 'options', 'face']);
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      findings.push(finding('schema', REF, 'each custom field definition must be a mapping'));
      continue;
    }
    const map = raw as Record<string, YamlValue>;
    const id = typeof map['id'] === 'string' && /^[a-z][a-z0-9_-]*$/.test(map['id']) ? map['id'] : null;
    if (id === null) {
      findings.push(finding('schema', REF, 'custom field id must match [a-z][a-z0-9_-]*'));
      continue;
    }
    if (seen.has(id) || BUILTIN_CARD_KEYS.has(id) || RESERVED_CARD_KEYS.has(id)) {
      findings.push(finding('schema', REF, `custom field id "${id}" is duplicate or reserved`));
      continue;
    }
    seen.add(id);
    if (typeof map['type'] !== 'string' || !(CUSTOM_FIELD_TYPES as readonly string[]).includes(map['type'])) {
      findings.push(finding('schema', REF, `custom field "${id}" has an unsupported type`));
      continue;
    }
    const type = map['type'] as CustomFieldDefinition['type'];
    const options: string[] = [];
    if (map['options'] !== undefined) {
      if (!Array.isArray(map['options'])) findings.push(finding('schema', REF, `custom field "${id}": options must be a list`));
      else for (const option of map['options']) {
        if (typeof option !== 'string' || option === '' || options.includes(option)) {
          findings.push(finding('schema', REF, `custom field "${id}": options must be unique non-empty strings`));
        } else options.push(option);
      }
    }
    if ((type === 'select' || type === 'multi-select') && options.length === 0) {
      findings.push(finding('schema', REF, `custom field "${id}": ${type} requires options`));
    } else if (type !== 'select' && type !== 'multi-select' && map['options'] !== undefined) {
      findings.push(finding('schema', REF, `custom field "${id}": options only apply to select types`));
    }
    let face = false;
    if (map['face'] !== undefined) {
      if (typeof map['face'] === 'boolean') face = map['face'];
      else findings.push(finding('schema', REF, `custom field "${id}": face must be true or false`));
    }
    let name = id;
    if (map['name'] !== undefined) {
      if (typeof map['name'] === 'string' && map['name'] !== '') name = map['name'];
      else findings.push(finding('schema', REF, `custom field "${id}": name must be a non-empty string`));
    }
    const extra: Record<string, unknown> = {};
    for (const key of Object.keys(map)) {
      if (!knownKeys.has(key)) {
        extra[key] = map[key];
        findings.push(finding('unknown-key', REF, `custom field "${id}": unknown key "${key}" (preserved)`));
      }
    }
    out.push({ id, name, type, options, face, extra });
  }
  return out;
}

export function parseTemplates(
  value: YamlValue | undefined,
  findings: Finding[],
  lanes: Lane[],
  customFields: CustomFieldDefinition[],
): CardTemplate[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    findings.push(finding('schema', REF, 'templates must be a list of template maps'));
    return [];
  }
  const out: CardTemplate[] = [];
  const seen = new Set<string>();
  const knownKeys = new Set([
    'id', 'name', 'lane', 'labels', 'priority', 'assignee', 'delegate', 'start', 'due',
    'estimate', 'evergreen', 'cover_color', 'fields', 'body',
  ]);
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      findings.push(finding('schema', REF, 'each template must be a mapping'));
      continue;
    }
    const map = raw as Record<string, YamlValue>;
    const id = typeof map['id'] === 'string' && SLUG_RE.test(map['id']) ? map['id'] : null;
    if (id === null) {
      findings.push(finding('schema', REF, 'template id must be a lowercase slug'));
      continue;
    }
    if (seen.has(id)) {
      findings.push(finding('schema', REF, `duplicate template id "${id}"`));
      continue;
    }
    seen.add(id);
    let name = id;
    if (map['name'] !== undefined) {
      if (typeof map['name'] === 'string' && map['name'] !== '') name = map['name'];
      else findings.push(finding('schema', REF, `template "${id}": name must be a non-empty string`));
    }
    let lane: string | null = null;
    if (map['lane'] !== undefined) {
      if (typeof map['lane'] !== 'string' || map['lane'] === '') {
        findings.push(finding('schema', REF, `template "${id}": lane must be a position`));
      } else {
        lane = map['lane'];
        const [laneId, substate] = lane.split('.', 2);
        const definition = lanes.find((candidate) => candidate.id === laneId);
        if (definition === undefined || (substate !== undefined && !definition.substates.includes(substate))) {
          findings.push(finding('schema', REF, `template "${id}": unknown position "${lane}"`));
        }
      }
    }
    const labels: string[] = [];
    if (map['labels'] !== undefined) {
      if (!Array.isArray(map['labels']) || !map['labels'].every((label) => typeof label === 'string' && label !== '')) {
        findings.push(finding('schema', REF, `template "${id}": labels must be a list of strings`));
      } else labels.push(...map['labels'] as string[]);
    }
    const conflict = labelGroupConflict(labels);
    if (conflict !== null) findings.push(finding('schema', REF, `template "${id}": ${conflict}`));
    let priority: string | null = null;
    if (map['priority'] !== undefined) {
      if (typeof map['priority'] === 'string' && /^p[0-3]$/.test(map['priority'])) priority = map['priority'];
      else findings.push(finding('schema', REF, `template "${id}": priority must be p0-p3`));
    }
    const actor = (key: 'assignee' | 'delegate'): string | null => {
      if (map[key] === undefined) return null;
      if (typeof map[key] === 'string' && map[key] !== '') return map[key];
      findings.push(finding('schema', REF, `template "${id}": ${key} must be a non-empty string`));
      return null;
    };
    const date = (key: 'start' | 'due'): string | null => {
      if (map[key] === undefined) return null;
      if (typeof map[key] === 'string' && validCardDate(map[key])) return map[key];
      findings.push(finding('schema', REF, `template "${id}": ${key} must be a UTC card date`));
      return null;
    };
    let estimate: number | null = null;
    if (map['estimate'] !== undefined) {
      if (validEstimate(map['estimate'])) estimate = map['estimate'];
      else findings.push(finding('schema', REF, `template "${id}": estimate must be a positive integer`));
    }
    let evergreen = false;
    if (map['evergreen'] !== undefined) {
      if (typeof map['evergreen'] === 'boolean') evergreen = map['evergreen'];
      else findings.push(finding('schema', REF, `template "${id}": evergreen must be a boolean`));
    }
    let coverColor: string | null = null;
    if (map['cover_color'] !== undefined) {
      if (typeof map['cover_color'] === 'string' && validColor(map['cover_color'])) coverColor = map['cover_color'].toLowerCase();
      else findings.push(finding('schema', REF, `template "${id}": cover_color must be #RGB or #RRGGBB`));
    }
    const fields: Record<string, unknown> = {};
    if (map['fields'] !== undefined) {
      if (map['fields'] === null || typeof map['fields'] !== 'object' || Array.isArray(map['fields'])) {
        findings.push(finding('schema', REF, `template "${id}": fields must be a mapping`));
      } else {
        for (const [fieldId, fieldValue] of Object.entries(map['fields'])) {
          const definition = customFields.find((candidate) => candidate.id === fieldId);
          if (definition === undefined || !validCustomFieldValue(definition, fieldValue)) {
            findings.push(finding('schema', REF, `template "${id}": invalid value for custom field "${fieldId}"`));
          }
          fields[fieldId] = fieldValue;
        }
      }
    }
    let body = '';
    if (map['body'] !== undefined) {
      if (typeof map['body'] === 'string') {
        body = map['body'];
        if (bodyHasSection(body, 'Log')) findings.push(finding('schema', REF, `template "${id}": body must not contain a Log section`));
      }
      else findings.push(finding('schema', REF, `template "${id}": body must be a string`));
    }
    const extra: Record<string, unknown> = {};
    for (const key of Object.keys(map)) {
      if (!knownKeys.has(key)) {
        extra[key] = map[key];
        findings.push(finding('unknown-key', REF, `template "${id}": unknown key "${key}" (preserved)`));
      }
    }
    out.push({
      id, name, lane, labels, priority, assignee: actor('assignee'), delegate: actor('delegate'),
      start: date('start'), due: date('due'), estimate, evergreen, coverColor, fields, body, extra,
    });
  }
  return out;
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
    labelDefinitions: [],
    customFields: [],
    templates: [],
    savedFilters: [],
    subscriptions: [],
    rollup: defaultRollup(),
    extra: {},
  };
}
