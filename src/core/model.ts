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
  'unsupported-feature': 'warning',
  'unknown-key': 'info',
  'hosted-ref': 'info',
};

export function finding(rule: string, ref: string, message: string): Finding {
  return { rule, severity: RULE_SEVERITY[rule] ?? 'error', ref, message };
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
export const SEQ_ID_RE = /^[0-9]{3,}$/;
export const HASH_ID_RE = /^[a-z0-9]{6}$/;

export interface Lane {
  id: string;
  name: string;
  canonical: Canonical;
  substates: string[];
  order: 'strict' | 'free';
  wip: number | null;
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
  priority: string | null;
  deps: string[];
  start: string | null;
  due: string | null;
  /** Unitless board-local effort points. */
  estimate: number | null;
  /** Suppress stale-card presentation without suppressing metrics. */
  evergreen: boolean;
  /** Card-art cover: an image url, 'none' to suppress, or null (viewers fall
   *  back to the first image attachment). */
  cover: string | null;
  /** Blocked-flag reason; null = no flag. */
  blocked: string | null;
  created: string | null;
  updated: string | null;
  /** Unknown frontmatter keys, preserved semantically (SPEC §5). */
  extra: Record<string, unknown>;
  /** Path relative to the board root, e.g. "cards/042-fix-auth.md". */
  file: string;
  /** Markdown body after the frontmatter block. */
  body: string;
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
