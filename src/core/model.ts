// Core data model for botflow boards. See spec/SPEC.md: this file mirrors it.

export const CANONICAL_STATES = ['wishlist', 'todo', 'doing', 'blocked', 'done', 'archive'] as const;
export type Canonical = (typeof CANONICAL_STATES)[number];

export function isCanonical(s: string): s is Canonical {
  return (CANONICAL_STATES as readonly string[]).includes(s);
}

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  rule: string;
  severity: Severity;
  /** Card id, lane id, or file name the finding is about. */
  ref: string;
  message: string;
}

/** Lint rule catalog (SPEC §10). */
export const RULE_SEVERITY: Record<string, Severity> = {
  'yaml-error': 'error',
  'frontmatter-missing': 'error',
  'schema': 'error',
  'dup-id': 'error',
  'unknown-lane': 'error',
  'bad-substate': 'error',
  'dangling-dep': 'error',
  'dep-cycle': 'error',
  'board-path-missing': 'error',
  'board-path-escape': 'error',
  'board-cycle': 'error',
  'id-scheme-mismatch': 'error',
  'wip-breach': 'warning',
  'filename-id-mismatch': 'warning',
  'bare-substate-lane': 'warning',
  'rollup-drift': 'warning',
  'blocked-in-done': 'warning',
  'unknown-blocker': 'error',
  'label-group-conflict': 'error',
  'custom-field-value': 'error',
  'dangling-relation': 'error',
  'self-relation': 'error',
  'boost-value': 'error',
  'unsupported-feature': 'warning',
  'unknown-key': 'info',
  'hosted-ref': 'info',
};

export function finding(rule: string, ref: string, message: string): Finding {
  return { rule, severity: RULE_SEVERITY[rule] ?? 'error', ref, message };
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
export const SEQ_ID_RE = /^[0-9]{3,64}$/;
export const HASH_ID_RE = /^[a-z0-9]{6}$/;

export interface Lane {
  id: string;
  name: string;
  canonical: Canonical;
  substates: string[];
  order: 'strict' | 'free';
  wip: number | null;
  wipMode: 'allow' | 'justify' | 'deny';
  /** Unknown lane-map keys, preserved across board.yaml rewrites. */
  extra: Record<string, unknown>;
}

export interface RollupPolicy {
  blockedWhen: 'any-blocked' | 'never';
  doneWhen: 'all-done';
  doingWhen: 'any-started' | 'any-doing';
  elseState: 'todo' | 'wishlist';
  /** Unknown rollup-map keys, preserved across board.yaml rewrites. */
  extra: Record<string, unknown>;
}

export interface LabelDefinition {
  id: string;
  color: string | null;
  /** Unknown label-map keys, preserved across board.yaml rewrites. */
  extra: Record<string, unknown>;
}

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'checkbox', 'date', 'select', 'multi-select', 'url', 'person'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export interface CustomFieldDefinition {
  id: string;
  name: string;
  type: CustomFieldType;
  options: string[];
  face: boolean;
  /** Unknown field-map keys, preserved across board.yaml rewrites. */
  extra: Record<string, unknown>;
}

export const RELATION_TYPES = [
  'relates', 'duplicates', 'supersedes', 'parent', 'subtask', 'copied-from', 'copied-to',
  'recurs-from', 'recurs-to',
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export interface CardRelation {
  type: RelationType;
  target: string;
  /** Unknown relation-map keys, preserved across card rewrites. */
  extra: Record<string, unknown>;
}

export interface CardTemplate {
  id: string;
  name: string;
  lane: string | null;
  labels: string[];
  priority: string | null;
  assignee: string | null;
  delegate: string | null;
  start: string | null;
  due: string | null;
  estimate: number | null;
  evergreen: boolean;
  coverColor: string | null;
  fields: Record<string, unknown>;
  body: string;
  /** Unknown template-map keys, preserved across board.yaml rewrites. */
  extra: Record<string, unknown>;
}

export interface SavedFilter {
  id: string;
  name: string;
  query: string;
  /** Unknown filter-map keys, preserved across board.yaml rewrites. */
  extra: Record<string, unknown>;
}

export interface LaneSubscription {
  lane: string;
  watcher: string;
  /** Unknown subscription-map keys, preserved across board.yaml rewrites. */
  extra: Record<string, unknown>;
}

export interface BlockerDefinition {
  id: string;
  name: string;
  color: string | null;
  /** Unknown blocker-map keys, preserved across board.yaml rewrites. */
  extra: Record<string, unknown>;
}

export type AutomationButtonAction = 'move' | 'close' | 'label';

export interface AutomationButton {
  id: string;
  name: string;
  scope: 'card' | 'board';
  filter: string | null;
  action: AutomationButtonAction;
  value: string | null;
  /** Unknown button-map keys, preserved across board.yaml rewrites. */
  extra: Record<string, unknown>;
}

export type AutomationRuleEvent = 'enter' | 'close' | 'block';
export type AutomationRuleAction = 'label' | 'unlabel' | 'assign' | 'delegate' | 'comment';

export interface AutomationRule {
  id: string;
  event: AutomationRuleEvent;
  lane: string | null;
  filter: string | null;
  /** False when a filter was declared but did not resolve while parsing. */
  filterValid: boolean;
  action: AutomationRuleAction;
  value: string;
  /** Unknown rule-map keys, preserved across board.yaml rewrites. */
  extra: Record<string, unknown>;
}

export interface AutomationPolicy {
  archiveDoneAfter: number | null;
  /** Unknown automation-map keys, preserved across board.yaml rewrites. */
  extra: Record<string, unknown>;
}

export interface BoardConfig {
  version: number;
  name: string;
  ids: 'seq' | 'hash';
  /** Additive capabilities this board declares it relies on. */
  features: string[];
  /** Features declared by the board but unknown to this reader. */
  unsupportedFeatures: string[];
  /** Non-null means readers may inspect but document mutations must refuse. */
  mutationBlocked: string | null;
  lanes: Lane[];
  /** True when the board omitted `lanes:` and got the canonical six. */
  lanesDefaulted: boolean;
  labelDefinitions: LabelDefinition[];
  customFields: CustomFieldDefinition[];
  templates: CardTemplate[];
  savedFilters: SavedFilter[];
  subscriptions: LaneSubscription[];
  blockers: BlockerDefinition[];
  buttons: AutomationButton[];
  rules: AutomationRule[];
  automation: AutomationPolicy;
  rollup: RollupPolicy;
  /** Unknown top-level board.yaml keys, preserved across rewrites. */
  extra: Record<string, unknown>;
}

export interface Card {
  id: string;
  title: string;
  laneId: string;
  substate: string | null;
  type: 'task' | 'board';
  /** Relative child-board reference (type: board only). */
  boardPath: string | null;
  labels: string[];
  assignee: string | null;
  /** Accountable human and executing agent are distinct roles. */
  delegate: string | null;
  /** Explicit card followers, distinct from accountability or execution. */
  watchers: string[];
  /** Actor names with a current lightweight vote on the card. */
  votes: string[];
  priority: string | null;
  deps: string[];
  relations: CardRelation[];
  start: string | null;
  due: string | null;
  /** Relative minute offsets before due, in source order. */
  reminders: number[];
  repeat: CardRepeat | null;
  snooze: string | null;
  /** Unitless board-local effort points. */
  estimate: number | null;
  /** Manually placed Hill Chart position, 0–100; never advanced automatically. */
  hill: number | null;
  /** Suppress stale-card presentation without suppressing metrics. */
  evergreen: boolean;
  /** Card-art cover: an image url, 'none' to suppress, or null (viewers fall
   *  back to the first image attachment). */
  cover: string | null;
  /** Compact card color band, independent of image cover art. */
  coverColor: string | null;
  /** Blocked-flag reason; null = no flag. */
  blocked: string | null;
  /** Optional reusable blocker id associated with the active flag. */
  blocker: string | null;
  created: string | null;
  updated: string | null;
  /** Unknown frontmatter keys, preserved semantically (SPEC §5). */
  extra: Record<string, unknown>;
  /** Path relative to the board root, e.g. "cards/042-fix-auth.md". */
  file: string;
  /** Markdown body after the frontmatter block. */
  body: string;
}

export interface CardRepeat {
  every: number;
  unit: 'day' | 'week' | 'month';
  from: 'due' | 'completion';
  /** Unknown recurrence-map keys, preserved across card rewrites. */
  extra: Record<string, unknown>;
}

export type Distribution = Record<Canonical, number>;

export function emptyDistribution(): Distribution {
  return { wishlist: 0, todo: 0, doing: 0, blocked: 0, done: 0, archive: 0 };
}

export function distributionTotal(d: Distribution): number {
  return d.wishlist + d.todo + d.doing + d.blocked + d.done + d.archive;
}

export function defaultLanes(): Lane[] {
  return CANONICAL_STATES.map((c) => ({
    id: c,
    name: c,
    canonical: c,
    substates: [],
    order: 'free',
    wip: null,
    wipMode: 'allow',
    extra: {},
  }));
}

export function defaultRollup(): RollupPolicy {
  return { blockedWhen: 'any-blocked', doneWhen: 'all-done', doingWhen: 'any-started', elseState: 'todo', extra: {} };
}

export function fallbackConfig(name: string): BoardConfig {
  return {
    version: 0,
    name,
    ids: 'seq',
    features: [],
    unsupportedFeatures: [],
    mutationBlocked: 'board.yaml is missing or unreadable',
    lanes: defaultLanes(),
    lanesDefaulted: true,
    labelDefinitions: [],
    customFields: [],
    templates: [],
    savedFilters: [],
    subscriptions: [],
    blockers: [],
    buttons: [],
    rules: [],
    automation: { archiveDoneAfter: null, extra: {} },
    rollup: defaultRollup(),
    extra: {},
  };
}

export interface LoadedBoard {
  /** Absolute path of the board root; '' for boards built from raw documents. */
  rootAbs: string;
  config: BoardConfig;
  cards: Card[];
  findings: Finding[];
}

export interface BoardNode {
  /** Board root path relative to the tree root ('.', 'web', 'api/.botflow', …). */
  key: string;
  board: LoadedBoard;
  /** For each board-card id: resolved child key, or null (missing path / cycle). */
  childKeyByCard: Map<string, string | null>;
}

export interface Tree {
  rootAbs: string;
  /** Keyed by BoardNode.key; iteration order is DFS discovery order, root first. */
  boards: Map<string, BoardNode>;
}
