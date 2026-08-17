// ProjectDO: one SQLite-backed Durable Object per project. A project IS a
// board: the DO stores the exact botflow document format (board.yaml text +
// card file texts), applies the same pure ops the CLI uses, serializes every
// mutation (single writer), and keeps an append-only audit log.
//
// Nesting: a card with `board: project:<id>` is a project card. This DO asks
// the referenced sibling DO for its distribution (rollupInfo) so hosted
// boards roll up exactly like the file engine: a visited-set breaks cycles.

import { DurableObject } from 'cloudflare:workers';

import { analyzeSingle, type ExternalChild } from '../../src/core/analyze.ts';
import { boardFromDocuments, type BoardDocument } from '../../src/core/docs.ts';
import { boardJson, cardDetailJson, cardJson } from '../../src/core/json.ts';
import type { BoardAnalysis } from '../../src/core/analyze.ts';
import type { BoardNode, Card, LoadedBoard } from '../../src/core/model.ts';
import {
  ClaimConflict,
  UsageError,
  defaultBoardYaml,
  getCard,
  opAdd,
  opAttach,
  opBlock,
  opCheck,
  opClaim,
  opClose,
  opComment,
  opDetach,
  opEdit,
  opLog,
  opMove,
  opUnblock,
  type AddOptions,
  type EditPatch,
} from '../../src/core/ops.ts';
import { newHashId, nextSeqId, slugify } from '../../src/core/ids.ts';
import { serializeCard } from '../../src/core/write.ts';

export interface AuditEvent {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  card_id: string | null;
  detail: string;
}

export type ActionResult = Record<string, unknown> | { error: string };

import type { RegistryDO } from './registry.ts';

interface ProjectEnv {
  PROJECT: DurableObjectNamespace<ProjectDO>;
  REGISTRY: DurableObjectNamespace<RegistryDO>;
}

const PROJECT_REF = 'project:';

export type ImportValidation =
  | { docs: BoardDocument[]; board: LoadedBoard }
  | { error: string };

function safeCardDocumentPath(path: string): boolean {
  if (!path.startsWith('cards/') || !path.endsWith('.md') || path.includes('\\')) return false;
  const parts = path.split('/');
  return parts.length >= 2 && parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Validate a snapshot completely before any Durable Object mutates. Reject
 *  structural findings that would drop or invent card data; ordinary lint
 *  findings (unknown lanes, dangling deps, id-scheme drift) remain visible but
 *  do not make snapshot sync unusably strict. */
export function validateImportDocuments(config: unknown, cards: unknown): ImportValidation {
  if (typeof config !== 'string' || !Array.isArray(cards)) return { error: 'config and cards required' };
  const docs: BoardDocument[] = [];
  const seenPaths = new Set<string>();
  for (const value of cards) {
    if (value === null || typeof value !== 'object') return { error: 'malformed card document' };
    const doc = value as { path?: unknown; text?: unknown };
    if (typeof doc.path !== 'string' || typeof doc.text !== 'string') return { error: 'malformed card document' };
    if (!safeCardDocumentPath(doc.path)) return { error: `unsafe card path in import: ${doc.path}` };
    if (seenPaths.has(doc.path)) return { error: `duplicate card path in import: ${doc.path}` };
    seenPaths.add(doc.path);
    docs.push({ path: doc.path, text: doc.text });
  }
  const board = boardFromDocuments(config, docs, 'import');
  const fatalRules = new Set(['yaml-error', 'frontmatter-missing', 'schema', 'dup-id']);
  const errors = board.findings.filter((f) => fatalRules.has(f.rule));
  if (errors.length > 0) {
    const detail = errors.slice(0, 3).map((f) => `${f.rule}(${f.ref}): ${f.message}`).join('; ');
    return { error: `invalid board import: ${detail}` };
  }
  return { docs, board };
}

const DDL = `
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY, file TEXT NOT NULL, text TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, card_id TEXT, detail TEXT NOT NULL);
`;

export class ProjectDO extends DurableObject<ProjectEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: ProjectEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(DDL);
  }

  // ---- storage helpers ----

  private selfId(): string {
    return this.ctx.id.name ?? '';
  }

  private configText(): string | null {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = 'config'").toArray()[0];
    return row ? (row['value'] as string) : null;
  }

  private loadBoardDocs(): LoadedBoard {
    const docs = this.sql
      .exec('SELECT file, text FROM cards ORDER BY file')
      .toArray()
      .map((r): BoardDocument => ({ path: r['file'] as string, text: r['text'] as string }));
    return boardFromDocuments(this.configText(), docs, 'project');
  }

  private persistCard(card: Card): void {
    this.sql.exec(
      'INSERT INTO cards(id, file, text, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET file = excluded.file, text = excluded.text, updated_at = excluded.updated_at',
      card.id,
      card.file,
      serializeCard(card),
      new Date().toISOString(),
    );
  }

  private event(actor: string, action: string, cardId: string | null, detail: string): void {
    this.sql.exec('INSERT INTO events(ts, actor, action, card_id, detail) VALUES (?, ?, ?, ?, ?)', new Date().toISOString(), actor, action, cardId, detail);
  }

  /** Resolve project-card children by asking sibling DOs. Cycle-safe, and
   *  scope-enforcing: a board may only roll up projects nested beneath it in
   *  the registry, so a smuggled `project:` ref cannot leak an unrelated
   *  project's distribution. */
  private async resolveChildren(board: LoadedBoard, visited: string[]): Promise<Map<string, ExternalChild | null>> {
    const children = new Map<string, ExternalChild | null>();
    const chain = [...visited, this.selfId()];
    const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName('main'));
    await Promise.all(
      board.cards
        .filter((c) => c.type === 'board')
        .map(async (card) => {
          const ref = card.boardPath ?? '';
          if (!ref.startsWith(PROJECT_REF)) {
            children.set(card.id, null);
            return;
          }
          const pid = ref.slice(PROJECT_REF.length);
          if (chain.includes(pid) || !(await registry.isWithin(pid, this.selfId()))) {
            children.set(card.id, null); // cycle or out-of-scope → lane fallback
            return;
          }
          const stub = this.env.PROJECT.get(this.env.PROJECT.idFromName(pid));
          children.set(card.id, await stub.rollupInfo(chain));
        }),
    );
    return children;
  }

  private async analyzed(visited: string[] = []): Promise<{
    board: LoadedBoard;
    ba: BoardAnalysis;
    node: BoardNode;
    children: Map<string, ExternalChild | null>;
  }> {
    const board = this.loadBoardDocs();
    const children = await this.resolveChildren(board, visited);
    const ba = analyzeSingle(board, children);
    const childKeyByCard = new Map<string, string | null>();
    for (const card of board.cards) {
      if (card.type === 'board') {
        const ref = card.boardPath ?? '';
        childKeyByCard.set(card.id, ref.startsWith(PROJECT_REF) ? ref.slice(PROJECT_REF.length) : null);
      }
    }
    return { board, ba, node: { key: '.', board, childKeyByCard }, children };
  }

  // ---- RPC surface ----

  ensureInit(name: string): { initialized: boolean } {
    if (this.configText() === null) {
      this.sql.exec("INSERT INTO meta(key, value) VALUES ('config', ?)", defaultBoardYaml(name));
      this.event('system', 'init', null, `project "${name}" created`);
      return { initialized: true };
    }
    return { initialized: false };
  }

  /** Distribution + progress for a parent's rollup; null when `visited`
   *  already contains this project (cycle). */
  async rollupInfo(visited: string[]): Promise<ExternalChild | null> {
    if (visited.includes(this.selfId())) return null;
    const { ba } = await this.analyzed(visited);
    return { distribution: ba.distribution, progress: ba.progress };
  }

  /** Compact state for org-tree aggregation. The task* fields exclude
   *  project-ref cards entirely: in tree sums those children are counted by
   *  their own summaries, so including their rolled-up card here would count
   *  the same work twice. */
  async summary(): Promise<Record<string, unknown>> {
    const { board, ba } = await this.analyzed();
    const taskDistribution = { wishlist: 0, todo: 0, doing: 0, blocked: 0, done: 0, archive: 0 } as Record<string, number>;
    let taskUnits = 0;
    let taskDoneWeight = 0;
    for (const card of board.cards) {
      if (card.type === 'board' && (card.boardPath ?? '').startsWith(PROJECT_REF)) continue;
      const state = ba.canonical.get(card.id)!;
      taskDistribution[state]!++;
      if (state === 'archive') continue;
      taskUnits++;
      if (state === 'done') taskDoneWeight++;
    }
    return {
      name: board.config.name,
      cards: board.cards.length,
      distribution: ba.distribution,
      progress: ba.progress,
      taskDistribution,
      taskUnits,
      taskDoneWeight,
      errors: [...board.findings, ...ba.findings].filter((f) => f.severity === 'error').length,
    };
  }

  /** Full board (viewer shape, card bodies + parsed structure included). */
  async board(): Promise<Record<string, unknown>> {
    const { board, ba, node, children } = await this.analyzed();
    const tree = { rootAbs: '.', boards: new Map([['.', node]]) };
    const analysis = { boards: new Map([['.', ba]]) };
    const json = boardJson(tree, analysis) as Record<string, unknown>;
    json['lanes'] = board.config.lanes.map((lane) => ({
      id: lane.id,
      name: lane.name,
      canonical: lane.canonical,
      substates: lane.substates,
      order: lane.order,
      wip: lane.wip,
      cards: board.cards
        .filter((c) => c.laneId === lane.id)
        .map((c) => ({ ...cardDetailJson(c, node, ba), childProgress: children.get(c.id)?.progress ?? null })),
    }));
    return json;
  }

  async card(id: string): Promise<Record<string, unknown> | null> {
    const { board, ba, node } = await this.analyzed();
    const found = board.cards.find((c) => c.id === id);
    if (!found) return null;
    return cardDetailJson(found, node, ba);
  }

  exportDocs(): { config: string | null; cards: BoardDocument[] } {
    return {
      config: this.configText(),
      cards: this.sql
        .exec('SELECT file, text FROM cards ORDER BY file')
        .toArray()
        .map((r) => ({ path: r['file'] as string, text: r['text'] as string })),
    };
  }

  /** Snapshot import (push): replace the board's documents: but preserve
   *  manager-native project cards (`board: project:…`) the snapshot doesn't
   *  carry, so a repo push can't sever hosted sub-projects. */
  importDocs(config: string, cards: BoardDocument[], actor: string): Record<string, unknown> {
    const validation = validateImportDocuments(config, cards);
    if ('error' in validation) return validation;
    const docs = validation.docs;
    const current = this.loadBoardDocs();
    const parsed = validation.board;
    // Preserve manager-native project cards whose referenced project the
    // snapshot doesn't itself carry (matched by ref, not card id: a snapshot
    // representing the same child under any id already covers it). When a
    // file card claims a preserved card's id, re-id it instead of letting the
    // push sever a hosted sub-project.
    const incomingRefs = new Set(
      parsed.cards.filter((c) => c.type === 'board' && c.boardPath !== null).map((c) => c.boardPath as string),
    );
    const preserved = current.cards.filter(
      (c) => c.type === 'board' && (c.boardPath ?? '').startsWith(PROJECT_REF) && !incomingRefs.has(c.boardPath as string),
    );
    const takenIds = new Set(parsed.cards.map((c) => c.id));
    const reIds: string[] = [];
    for (const card of preserved) {
      if (takenIds.has(card.id)) {
        const newId = parsed.config.ids === 'hash' ? newHashId([...takenIds]) : nextSeqId([...takenIds]);
        reIds.push(`${card.id}→${newId}`);
        card.id = newId;
        card.file = `cards/${newId}-${slugify(card.title)}.md`;
      }
      takenIds.add(card.id);
    }

    const now = new Date().toISOString();
    const byPath = new Map(docs.map((doc) => [doc.path, doc.text]));
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO meta(key, value) VALUES ('config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", config);
      this.sql.exec('DELETE FROM cards');
      for (const card of parsed.cards) {
        this.sql.exec(
          'INSERT INTO cards(id, file, text, updated_at) VALUES (?, ?, ?, ?)',
          card.id, card.file, byPath.get(card.file) ?? serializeCard(card), now,
        );
      }
      for (const card of preserved) {
        this.sql.exec('INSERT INTO cards(id, file, text, updated_at) VALUES (?, ?, ?, ?)', card.id, card.file, serializeCard(card), now);
      }
      this.event(
        actor,
        'import',
        null,
        `imported ${parsed.cards.length} cards (snapshot, last-write-wins)` +
          (preserved.length > 0 ? `; preserved ${preserved.length} project card(s)` : '') +
          (reIds.length > 0 ? `; re-id on collision: ${reIds.join(', ')}` : ''),
      );
    });
    return { imported: parsed.cards.length, preserved: preserved.length, reIds, findings: parsed.findings.length };
  }

  addCard(opts: Omit<AddOptions, 'actor'>, actor: string): ActionResult {
    try {
      const board = this.loadBoardDocs();
      const card = opAdd(board, { ...opts, actor });
      this.persistCard(card);
      this.event(actor, 'add', card.id, `created "${card.title}" in ${card.laneId}`);
      return { id: card.id, file: card.file, lane: card.laneId };
    } catch (err) {
      if (err instanceof UsageError) return { error: err.message };
      throw err;
    }
  }

  action(kind: string, id: string, args: Record<string, unknown>, actor: string): ActionResult {
    try {
      const board = this.loadBoardDocs();
      const card = getCard(board, id);
      switch (kind) {
        case 'move': {
          const res = opMove(board, card, String(args['to']), actor, args['force'] === true);
          this.persistCard(card);
          this.event(actor, 'move', id, `${res.from} → ${res.to}`);
          return { id, from: res.from, to: res.to, warnings: res.warnings };
        }
        case 'claim': {
          const res = opClaim(board, card, actor, args['force'] === true);
          if (res.alreadyYours) return { id, at: res.to, assignee: card.assignee, alreadyYours: true };
          this.persistCard(card);
          this.event(actor, 'claim', id, `${res.from} → ${res.to}`);
          return { id, from: res.from, to: res.to, assignee: card.assignee, warnings: res.warnings };
        }
        case 'close': {
          const reason = typeof args['reason'] === 'string' ? (args['reason'] as string) : undefined;
          const res = opClose(board, card, actor, reason);
          this.persistCard(card);
          this.event(actor, 'close', id, reason ?? 'closed');
          return { id, from: res.from, to: res.to };
        }
        case 'block': {
          opBlock(card, actor, String(args['reason'] ?? 'blocked'));
          this.persistCard(card);
          this.event(actor, 'block', id, String(args['reason'] ?? ''));
          return { id, blocked: card.blocked };
        }
        case 'unblock': {
          opUnblock(card, actor);
          this.persistCard(card);
          this.event(actor, 'unblock', id, '');
          return { id, blocked: null };
        }
        case 'comment': {
          const text = String(args['message'] ?? '').trim();
          if (text === '') return { error: 'message required' };
          opComment(card, actor, text);
          this.persistCard(card);
          this.event(actor, 'comment', id, text.slice(0, 200));
          return { id, commented: true };
        }
        case 'check': {
          const index = Number(args['index']);
          const checked = args['checked'] !== false;
          opCheck(card, actor, index, checked);
          this.persistCard(card);
          this.event(actor, checked ? 'check' : 'uncheck', id, `item ${index}`);
          return { id, index, checked };
        }
        case 'attach': {
          const url = String(args['url'] ?? '').trim();
          if (url === '') return { error: 'url required' };
          opAttach(card, actor, url, typeof args['label'] === 'string' ? (args['label'] as string) : undefined);
          this.persistCard(card);
          this.event(actor, 'attach', id, url.slice(0, 200));
          return { id, attached: url };
        }
        case 'detach': {
          const index = Number(args['index']);
          opDetach(card, actor, index);
          this.persistCard(card);
          this.event(actor, 'detach', id, `attachment ${index}`);
          return { id, detached: index };
        }
        case 'edit': {
          const patch: EditPatch = {};
          if ('title' in args) patch.title = String(args['title']);
          if ('labels' in args && Array.isArray(args['labels'])) patch.labels = (args['labels'] as unknown[]).map(String);
          if ('priority' in args) patch.priority = args['priority'] === null ? null : String(args['priority']);
          if ('assignee' in args) patch.assignee = args['assignee'] === null ? null : String(args['assignee']);
          if ('deps' in args && Array.isArray(args['deps'])) patch.deps = (args['deps'] as unknown[]).map(String);
          if ('cover' in args) patch.cover = args['cover'] === null ? null : String(args['cover']);
          opEdit(card, patch, actor);
          this.persistCard(card);
          this.event(actor, 'edit', id, Object.keys(patch).join(', '));
          return { id, edited: Object.keys(patch) };
        }
        case 'log': {
          opLog(card, actor, String(args['message'] ?? ''));
          this.persistCard(card);
          this.event(actor, 'log', id, String(args['message'] ?? ''));
          return { id, logged: true };
        }
        default:
          return { error: `unknown action "${kind}"` };
      }
    } catch (err) {
      if (err instanceof ClaimConflict) {
        return { error: err.message, conflict: { reason: err.reason, holder: err.holder, position: err.position } };
      }
      if (err instanceof UsageError) return { error: err.message };
      throw err;
    }
  }

  /** Wipe this project's entire storage (board, events). Registry rows and
   *  the parent's project card are the caller's job. No undo. */
  async destroy(): Promise<{ ok: boolean }> {
    await this.ctx.storage.deleteAll();
    this.sql.exec(DDL); // leave the instance usable if ever touched again
    return { ok: true };
  }

  /** Remove project cards pointing at a given ref (used when the referenced
   *  project is deleted). Not a general card-delete: archive is the verb for
   *  ordinary cards. */
  removeCardsByRef(ref: string, actor: string): { removed: number } {
    const board = this.loadBoardDocs();
    const doomed = board.cards.filter((c) => c.type === 'board' && c.boardPath === ref);
    for (const card of doomed) {
      this.sql.exec('DELETE FROM cards WHERE id = ?', card.id);
      this.event(actor, 'remove', card.id, `project card removed ("${card.title}": target deleted)`);
    }
    return { removed: doomed.length };
  }

  listEvents(limit: number): AuditEvent[] {
    return this.sql
      .exec('SELECT seq, ts, actor, action, card_id, detail FROM events ORDER BY seq DESC LIMIT ?', limit)
      .toArray() as unknown as AuditEvent[];
  }
}
