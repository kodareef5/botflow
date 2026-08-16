// ProjectDO — one SQLite-backed Durable Object per project. A project IS a
// board: the DO stores the exact botflow document format (board.yaml text +
// card file texts), applies the same pure ops the CLI uses, serializes every
// mutation (single writer), and keeps an append-only audit log.

import { DurableObject } from 'cloudflare:workers';

import { analyze } from '../../src/core/analyze.ts';
import { boardFromDocuments, singleBoardTree, type BoardDocument } from '../../src/core/docs.ts';
import { boardJson, cardJson } from '../../src/core/json.ts';
import type { Card, LoadedBoard } from '../../src/core/model.ts';
import {
  UsageError,
  defaultBoardYaml,
  getCard,
  opAdd,
  opBlock,
  opClaim,
  opClose,
  opEdit,
  opLog,
  opMove,
  opUnblock,
  type AddOptions,
  type EditPatch,
} from '../../src/core/ops.ts';
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

export class ProjectDO extends DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY, file TEXT NOT NULL, text TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, card_id TEXT, detail TEXT NOT NULL);
    `);
  }

  // ---- storage helpers ----

  private configText(): string | null {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = 'config'").toArray()[0];
    return row ? (row['value'] as string) : null;
  }

  private loadBoard(): LoadedBoard {
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

  // ---- RPC surface ----

  ensureInit(name: string): { initialized: boolean } {
    if (this.configText() === null) {
      this.sql.exec("INSERT INTO meta(key, value) VALUES ('config', ?)", defaultBoardYaml(name));
      this.event('system', 'init', null, `project "${name}" created`);
      return { initialized: true };
    }
    return { initialized: false };
  }

  /** Compact state for org-tree aggregation. */
  summary(): Record<string, unknown> {
    const board = this.loadBoard();
    const analysis = analyze(singleBoardTree(board));
    const ba = analysis.boards.get('.')!;
    return {
      name: board.config.name,
      cards: board.cards.length,
      distribution: ba.distribution,
      progress: ba.progress,
      errors: [...board.findings, ...ba.findings].filter((f) => f.severity === 'error').length,
    };
  }

  /** Full board (viewer shape, card bodies included). */
  board(): Record<string, unknown> {
    const board = this.loadBoard();
    const tree = singleBoardTree(board);
    const analysis = analyze(tree);
    const node = tree.boards.get('.')!;
    const ba = analysis.boards.get('.')!;
    const json = boardJson(tree, analysis) as Record<string, unknown>;
    json['lanes'] = board.config.lanes.map((lane) => ({
      id: lane.id,
      name: lane.name,
      canonical: lane.canonical,
      substates: lane.substates,
      order: lane.order,
      wip: lane.wip,
      cards: board.cards.filter((c) => c.laneId === lane.id).map((c) => ({ ...cardJson(c, node, ba), body: c.body })),
    }));
    return json;
  }

  card(id: string): Record<string, unknown> | null {
    const board = this.loadBoard();
    const found = board.cards.find((c) => c.id === id);
    if (!found) return null;
    const tree = singleBoardTree(board);
    const analysis = analyze(tree);
    return { ...cardJson(found, tree.boards.get('.')!, analysis.boards.get('.')!), body: found.body };
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

  /** Snapshot import (push): replace the whole board document set. */
  importDocs(config: string, cards: BoardDocument[], actor: string): Record<string, unknown> {
    const parsed = boardFromDocuments(config, cards, 'import');
    this.sql.exec("INSERT INTO meta(key, value) VALUES ('config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", config);
    this.sql.exec('DELETE FROM cards');
    const now = new Date().toISOString();
    for (const card of parsed.cards) {
      const doc = cards.find((d) => d.path === card.file);
      this.sql.exec('INSERT OR REPLACE INTO cards(id, file, text, updated_at) VALUES (?, ?, ?, ?)', card.id, card.file, doc?.text ?? serializeCard(card), now);
    }
    this.event(actor, 'import', null, `imported ${parsed.cards.length} cards (snapshot, last-write-wins)`);
    return { imported: parsed.cards.length, findings: parsed.findings.length };
  }

  addCard(opts: Omit<AddOptions, 'actor'>, actor: string): ActionResult {
    try {
      const board = this.loadBoard();
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
      const board = this.loadBoard();
      const card = getCard(board, id);
      switch (kind) {
        case 'move': {
          const res = opMove(board, card, String(args['to']), actor, args['force'] === true);
          this.persistCard(card);
          this.event(actor, 'move', id, `${res.from} → ${res.to}`);
          return { id, from: res.from, to: res.to, warnings: res.warnings };
        }
        case 'claim': {
          const res = opClaim(board, card, actor);
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
        case 'edit': {
          const patch: EditPatch = {};
          if ('title' in args) patch.title = String(args['title']);
          if ('labels' in args && Array.isArray(args['labels'])) patch.labels = (args['labels'] as unknown[]).map(String);
          if ('priority' in args) patch.priority = args['priority'] === null ? null : String(args['priority']);
          if ('assignee' in args) patch.assignee = args['assignee'] === null ? null : String(args['assignee']);
          if ('deps' in args && Array.isArray(args['deps'])) patch.deps = (args['deps'] as unknown[]).map(String);
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
      if (err instanceof UsageError) return { error: err.message };
      throw err;
    }
  }

  listEvents(limit: number): AuditEvent[] {
    return this.sql
      .exec('SELECT seq, ts, actor, action, card_id, detail FROM events ORDER BY seq DESC LIMIT ?', limit)
      .toArray() as unknown as AuditEvent[];
  }
}
