// ProjectDO: one SQLite-backed Durable Object per project. A project IS a
// board: the DO stores the exact botflow document format (board.yaml text +
// card file texts), applies the same pure ops the CLI uses, serializes every
// mutation (single writer), and keeps an append-only audit log.
//
// Nesting: a card with `board: project:<id>` is a project card. This DO asks
// the referenced sibling DO for its distribution (rollupInfo) so hosted
// boards roll up exactly like the file engine: a visited-set breaks cycles.

import { DurableObject } from 'cloudflare:workers';

import { analyzeSingle, type ExternalChild, type ExternalReference } from '../../src/core/analyze.ts';
import { boardFromDocuments, validateBoardDocuments, type BoardDocument } from '../../src/core/docs.ts';
import { boardJson, cardDetailJson, cardJson } from '../../src/core/json.ts';
import { parseBody } from '../../src/core/body.ts';
import type { BoardAnalysis } from '../../src/core/analyze.ts';
import type { BoardNode, Canonical, Card, Finding, Lane, LoadedBoard } from '../../src/core/model.ts';
import { SLUG_RE, defaultRollup, isCanonical } from '../../src/core/model.ts';
import { emitBoardYaml, parseCustomFields, parseLabelDefinitions, parseTemplates } from '../../src/core/config.ts';
import type { YamlValue } from '../../src/core/yaml.ts';
import { validCustomFieldValue } from '../../src/core/presentation.ts';
import { parseCardReference } from '../../src/core/refs.ts';
import {
  ClaimConflict,
  UsageError,
  defaultBoardYaml,
  getCard,
  opAdd,
  opAttach,
  opBlock,
  opCheck,
  opChecklistAdd,
  opClaim,
  opClose,
  opComment,
  opDescribe,
  opDetach,
  opEdit,
  opLog,
  opLink,
  opUnlink,
  opPromote,
  opMergeDuplicates,
  opQuickAdd,
  opBulk,
  opTransferCard,
  opMove,
  opUnblock,
  type AddOptions,
  type EditPatch,
} from '../../src/core/ops.ts';
import { newHashId, nextSeqId, slugify } from '../../src/core/ids.ts';
import { logMutation, serializeCard } from '../../src/core/write.ts';

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

/** Snapshot validation lives in core (docs.ts) so hosted import and CLI pull
 *  share one gate; this alias keeps the worker-side name. */
export const validateImportDocuments = validateBoardDocuments;

/** Card text is permanent: the Log is append-only by spec and there is no
 *  delete verb to reclaim the space. Unbounded single-line entries let one
 *  write member grow a card without limit, and every board read re-parses the
 *  whole document. These caps are generous for real use and finite. */
const MAX_LINE_TEXT = 4_000;
const MAX_BODY_TEXT = 100_000;

const clampLine = (value: unknown, fallback: string): string => {
  const text = value === undefined || value === null ? fallback : String(value);
  return text.slice(0, MAX_LINE_TEXT);
};

const DDL = `
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY, file TEXT NOT NULL, text TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, card_id TEXT, detail TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS unfurls(url TEXT PRIMARY KEY, image TEXT, image_hash TEXT, title TEXT, site TEXT, status TEXT NOT NULL, fetched TEXT NOT NULL);
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

  /** Resolve hosted dependency/relation refs without exposing arbitrary
   * projects through a board visible to a narrower identity. A project may
   * reference itself (bare ids) or descendants, matching project-card scope. */
  private async resolveReferences(board: LoadedBoard, visited: string[]): Promise<Map<string, ExternalReference | null>> {
    const references = new Map<string, ExternalReference | null>();
    const chain = [...visited, this.selfId()];
    const wanted = new Set(board.cards.flatMap((card) => [
      ...card.deps,
      ...card.relations.map((relation) => relation.target),
    ]).filter((value) => value.startsWith(PROJECT_REF)));
    const registry = this.env.REGISTRY.get(this.env.REGISTRY.idFromName('main'));
    await Promise.all([...wanted].map(async (value) => {
      const parsed = parseCardReference(value);
      const boardRef = parsed?.boardRef ?? '';
      const pid = boardRef.startsWith(PROJECT_REF) ? boardRef.slice(PROJECT_REF.length) : '';
      if (parsed === null || pid === '' || pid === this.selfId()) {
        references.set(value, null);
        return;
      }
      // Descendant references drive dependency handoffs; ancestor references
      // are the natural copied-from half written on the target. Siblings and
      // unrelated projects stay opaque, so a guessed id cannot become a
      // cross-scope state oracle.
      const related = (await registry.isWithin(pid, this.selfId())) || (await registry.isWithin(this.selfId(), pid));
      if (!related) {
        references.set(value, null);
        return;
      }
      const stub = this.env.PROJECT.get(this.env.PROJECT.idFromName(pid));
      references.set(value, await stub.referenceState(parsed.cardId, chain));
    }));
    return references;
  }

  private async analyzed(visited: string[] = []): Promise<{
    board: LoadedBoard;
    ba: BoardAnalysis;
    node: BoardNode;
    children: Map<string, ExternalChild | null>;
  }> {
    const board = this.loadBoardDocs();
    const [children, references] = await Promise.all([this.resolveChildren(board, visited), this.resolveReferences(board, visited)]);
    const ba = analyzeSingle(board, children, references);
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

  /** Canonical state only: cross-board dependency resolution does not need
   * card content, and omitting refs here prevents dependency cycles from
   * recursively calling one another just to learn lane state. */
  async referenceState(id: string, visited: string[] = []): Promise<ExternalReference | null> {
    const board = this.loadBoardDocs();
    const children = await this.resolveChildren(board, visited);
    const ba = analyzeSingle(board, children);
    return ba.canonical.has(id) ? { state: ba.canonical.get(id)! } : null;
  }

  transferSource(id: string): { card: Card; canonical: Canonical } | { error: string } {
    const board = this.loadBoardDocs();
    if (board.config.mutationBlocked !== null) return { error: `board is read-only: ${board.config.mutationBlocked}` };
    const card = board.cards.find((candidate) => candidate.id === id);
    if (card === undefined) return { error: `no card "${id}"` };
    const lane = board.config.lanes.find((candidate) => candidate.id === card.laneId);
    return { card, canonical: lane?.canonical ?? 'todo' };
  }

  /** Idempotent target half of a cross-DO transfer. */
  receiveTransfer(
    sourceProject: string,
    payload: { card: Card; canonical: Canonical },
    actor: string,
    lane: string | null,
    move: boolean,
  ): ActionResult {
    try {
      const board = this.loadBoardDocs();
      if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
      const sourceRef = `project:${sourceProject}#${payload.card.id}`;
      const existing = board.cards.find((card) => card.relations.some((relation) => relation.type === 'copied-from' && relation.target === sourceRef));
      if (existing !== undefined) return { id: existing.id, reused: true };
      const sourceLane: Lane = {
        id: payload.card.laneId,
        name: payload.card.laneId,
        canonical: payload.canonical,
        substates: payload.card.substate === null ? [] : [payload.card.substate],
        order: 'free',
        wip: null,
        extra: {},
      };
      const synthetic: LoadedBoard = {
        ...board,
        rootAbs: `project:${sourceProject}`,
        cards: [payload.card],
        config: { ...board.config, lanes: [sourceLane, ...(sourceLane.canonical === 'archive' ? [] : [{ ...sourceLane, id: 'transfer-archive', name: 'archive', canonical: 'archive' as const, substates: [] }])] },
      };
      const result = opTransferCard(synthetic, board, payload.card, actor, {
        sourceRef,
        targetRef: (targetId) => `project:${this.selfId()}#${targetId}`,
        rewriteReference: (reference) => reference.includes('#') ? reference : `project:${sourceProject}#${reference}`,
        rewriteBoardPath: (boardPath) => boardPath,
        lane: lane ?? undefined,
        move,
      });
      this.persistCard(result.target);
      this.event(actor, move ? 'receive-move' : 'receive-copy', result.target.id, `from ${sourceRef}`);
      return { id: result.target.id, reused: false };
    } catch (err) {
      if (err instanceof UsageError) return { error: err.message };
      throw err;
    }
  }

  /** Idempotent source half. Called only after receiveTransfer succeeded. */
  completeTransfer(id: string, targetProject: string, targetId: string, move: boolean, actor: string): ActionResult {
    try {
      const board = this.loadBoardDocs();
      if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
      const card = getCard(board, id);
      const targetRef = `project:${targetProject}#${targetId}`;
      let changed = false;
      let relationAdded = false;
      if (!card.relations.some((relation) => relation.type === 'copied-to' && relation.target === targetRef)) {
        card.relations.push({ type: 'copied-to', target: targetRef, extra: {} });
        changed = true;
        relationAdded = true;
      }
      if (move) {
        const archive = board.config.lanes.find((lane) => lane.canonical === 'archive');
        if (archive === undefined) throw new UsageError('source board has no archive-canonical lane');
        const moved = opMove(board, card, archive.id, actor, true);
        changed ||= moved.from !== moved.to;
        if (relationAdded && moved.from === moved.to) logMutation(card, actor, `moved to ${targetRef}`);
      }
      if (changed) {
        if (!move) logMutation(card, actor, `copied to ${targetRef}`);
        this.persistCard(card);
        this.event(actor, move ? 'complete-move' : 'complete-copy', id, `to ${targetRef}`);
      }
      return { id, target: targetId, changed };
    } catch (err) {
      if (err instanceof UsageError) return { error: err.message };
      throw err;
    }
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
    const previewCache = this.unfurlImages();
    json['lanes'] = board.config.lanes.map((lane) => ({
      id: lane.id,
      name: lane.name,
      canonical: lane.canonical,
      substates: lane.substates,
      order: lane.order,
      wip: lane.wip,
      estimate: board.cards.filter((c) => c.laneId === lane.id).reduce((sum, card) => sum + (card.estimate ?? 0), 0),
      cards: board.cards
        .filter((c) => c.laneId === lane.id)
        .map((c) => this.withPreviews(
          { ...cardDetailJson(c, node, ba), childProgress: children.get(c.id)?.progress ?? null },
          previewCache,
        )),
    }));
    return json;
  }

  async card(id: string): Promise<Record<string, unknown> | null> {
    const { board, ba, node } = await this.analyzed();
    const found = board.cards.find((c) => c.id === id);
    if (!found) return null;
    return this.withPreviews(cardDetailJson(found, node, ba));
  }

  // ---- link previews ----
  // Derived, hosted-only state: an attachment url is not an image, but the
  // page behind it may advertise one. Dropping this table costs a re-fetch and
  // nothing else, so it is a cache, not a record.

  /** Every cached picture, keyed by the url that advertised it. */
  private unfurlImages(): Map<string, string> {
    const out = new Map<string, string>();
    for (const row of this.sql.exec("SELECT url, image_hash FROM unfurls WHERE status = 'ok' AND image_hash IS NOT NULL").toArray()) {
      out.set(row['url'] as string, `/og/${row['image_hash'] as string}?p=${this.selfId()}`);
    }
    return out;
  }

  /** Attach previews in attachment order, so the first previewable attachment
   *  is the one a viewer falls back to for cover art. */
  private withPreviews(card: Record<string, unknown>, cached?: Map<string, string>): Record<string, unknown> {
    const images = cached ?? this.unfurlImages();
    const parsed = card['parsed'] as { attachments?: { url: string }[] } | undefined;
    const previews = (parsed?.attachments ?? [])
      .map((a) => ({ url: a.url, image: images.get(a.url) }))
      .filter((p): p is { url: string; image: string } => p.image !== undefined);
    return previews.length > 0 ? { ...card, previews } : card;
  }

  /** Attachment urls with no verdict yet, for the caller to go and fetch. */
  pendingUnfurls(limit: number): string[] {
    const known = new Set(this.sql.exec('SELECT url FROM unfurls').toArray().map((r) => r['url'] as string));
    const out: string[] = [];
    for (const row of this.sql.exec('SELECT text FROM cards').toArray()) {
      for (const a of parseBody(row['text'] as string).attachments) {
        // Uploads are already ours and self-describing; only foreign urls have
        // anything to unfurl.
        if (a.url.startsWith('/') || known.has(a.url)) continue;
        known.add(a.url);
        out.push(a.url);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** Record a verdict, including "nothing there": an absent og:image is an
   *  answer, and re-asking every board load would hammer the far end. */
  saveUnfurl(
    url: string,
    result: { image: string | null; title: string | null; site: string | null } | null,
    imageHash: string | null = null,
  ): { ok: true } {
    this.sql.exec(
      `INSERT INTO unfurls(url, image, image_hash, title, site, status, fetched) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET image = excluded.image, image_hash = excluded.image_hash,
         title = excluded.title, site = excluded.site, status = excluded.status, fetched = excluded.fetched`,
      url, result?.image ?? null, imageHash, result?.title ?? null, result?.site ?? null,
      result === null ? 'error' : result.image === null ? 'none' : 'ok', new Date().toISOString(),
    );
    return { ok: true };
  }

  /** The url a proxied preview hash stands for. Only urls this worker chose to
   *  fetch are resolvable, so the proxy cannot be pointed anywhere else. */
  unfurlImageFor(hash: string): string | null {
    const row = this.sql.exec("SELECT image FROM unfurls WHERE status = 'ok' AND image_hash = ?", hash).toArray()[0];
    return row ? (row['image'] as string) : null;
  }

  /** How many unfurls this project has recorded today, so one member cannot
   *  turn the worker into a fetch amplifier by attaching a thousand links. */
  unfurlsToday(): number {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return this.sql.exec('SELECT COUNT(*) AS n FROM unfurls WHERE fetched > ?', since).one()['n'] as number;
  }

  /** Structured board.yaml view for the editor UI. */
  boardConfig(): Record<string, unknown> {
    const c = this.loadBoardDocs().config;
    return {
      version: c.version,
      name: c.name,
      ids: c.ids,
      features: c.features,
      readOnlyReason: c.mutationBlocked,
      lanes: c.lanes.map((l) => ({ id: l.id, name: l.name, canonical: l.canonical, substates: l.substates, order: l.order, wip: l.wip })),
      labels: c.labelDefinitions.map(({ id, color }) => ({ id, color })),
      fields: c.customFields.map(({ id, name, type, options, face }) => ({ id, name, type, options, face })),
      templates: c.templates.map(({ id, name, lane, labels, priority, assignee, delegate, start, due, estimate, evergreen, coverColor, fields, body }) => ({
        id, name, lane, labels, priority, assignee, delegate, start, due, estimate, evergreen, cover_color: coverColor, fields, body,
      })),
      rollup: { blockedWhen: c.rollup.blockedWhen, doneWhen: c.rollup.doneWhen, doingWhen: c.rollup.doingWhen, elseState: c.rollup.elseState },
    };
  }

  /** Reshape the board: lanes (canonical mapping required), rollup policy,
   *  name. Cards stranded by a removed lane or substate migrate per the
   *  caller's plan (or to a same-canonical lane), each move logged on the
   *  card. Validates everything, then commits all-or-nothing. */
  editBoardConfig(payload: unknown, actor: string): ActionResult {
    const board = this.loadBoardDocs();
    if (board.config.mutationBlocked !== null) return { error: `board is read-only: ${board.config.mutationBlocked}` };
    if (payload === null || typeof payload !== 'object') return { error: 'malformed config' };
    const p = payload as { name?: unknown; lanes?: unknown; labels?: unknown; fields?: unknown; templates?: unknown; rollup?: unknown; migrations?: unknown };
    const name = typeof p.name === 'string' && p.name.trim() !== '' ? p.name.trim().replace(/[\r\n]+/g, ' ') : null;
    if (name === null) return { error: 'board name required' };
    if (!Array.isArray(p.lanes) || p.lanes.length === 0) return { error: 'at least one lane required' };

    const lanes: Lane[] = [];
    const seen = new Set<string>();
    for (const raw of p.lanes) {
      if (raw === null || typeof raw !== 'object') return { error: 'each lane must be an object' };
      const l = raw as Record<string, unknown>;
      const id = typeof l['id'] === 'string' ? l['id'].trim() : '';
      if (!SLUG_RE.test(id)) return { error: `lane id must be a lowercase slug, got "${id}"` };
      if (seen.has(id)) return { error: `duplicate lane id "${id}"` };
      seen.add(id);
      let canonical: Canonical;
      if (isCanonical(id)) canonical = id;
      else if (typeof l['canonical'] === 'string' && isCanonical(l['canonical'])) canonical = l['canonical'];
      else return { error: `lane "${id}" needs a canonical state (wishlist, todo, doing, blocked, done, archive)` };
      const substates: string[] = [];
      if (l['substates'] !== undefined && l['substates'] !== null) {
        if (!Array.isArray(l['substates'])) return { error: `lane "${id}": substates must be a list` };
        for (const s of l['substates']) {
          if (typeof s !== 'string' || !SLUG_RE.test(s)) return { error: `lane "${id}": substates must be lowercase slugs` };
          if (!substates.includes(s)) substates.push(s);
        }
      }
      const order = l['order'] === 'strict' ? 'strict' : 'free';
      let wip: number | null = null;
      if (l['wip'] !== undefined && l['wip'] !== null && l['wip'] !== '') {
        const n = Number(l['wip']);
        if (!Number.isInteger(n) || n <= 0) return { error: `lane "${id}": wip must be a positive integer` };
        wip = n;
      }
      lanes.push({
        id,
        name: typeof l['name'] === 'string' && l['name'].trim() !== '' ? l['name'].trim() : id,
        canonical,
        substates,
        order,
        wip,
        extra: { ...(board.config.lanes.find((old) => old.id === id)?.extra ?? {}) },
      });
    }

    const rollup = defaultRollup();
    rollup.extra = { ...board.config.rollup.extra };
    if (p.rollup !== undefined && p.rollup !== null) {
      if (typeof p.rollup !== 'object') return { error: 'rollup must be an object' };
      const r = p.rollup as Record<string, unknown>;
      if (r['blockedWhen'] !== undefined) {
        if (r['blockedWhen'] !== 'any-blocked' && r['blockedWhen'] !== 'never') return { error: 'rollup.blockedWhen must be any-blocked or never' };
        rollup.blockedWhen = r['blockedWhen'];
      }
      if (r['doingWhen'] !== undefined) {
        if (r['doingWhen'] !== 'any-started' && r['doingWhen'] !== 'any-doing') return { error: 'rollup.doingWhen must be any-started or any-doing' };
        rollup.doingWhen = r['doingWhen'];
      }
      if (r['elseState'] !== undefined) {
        if (r['elseState'] !== 'todo' && r['elseState'] !== 'wishlist') return { error: 'rollup.elseState must be todo or wishlist' };
        rollup.elseState = r['elseState'];
      }
    }

    const presentationFindings: Finding[] = [];
    const parsedLabels = p.labels === undefined
      ? board.config.labelDefinitions
      : parseLabelDefinitions(p.labels as YamlValue, presentationFindings);
    const parsedFields = p.fields === undefined
      ? board.config.customFields
      : parseCustomFields(p.fields as YamlValue, presentationFindings);
    const presentationError = presentationFindings.find((finding) => finding.severity === 'error');
    if (presentationError !== undefined) return { error: presentationError.message };
    const labelDefinitions = parsedLabels.map((definition) => ({
      ...definition,
      extra: { ...(board.config.labelDefinitions.find((old) => old.id === definition.id)?.extra ?? {}), ...definition.extra },
    }));
    const customFields = parsedFields.map((definition) => ({
      ...definition,
      extra: { ...(board.config.customFields.find((old) => old.id === definition.id)?.extra ?? {}), ...definition.extra },
    }));
    const parsedTemplates = p.templates === undefined
      ? board.config.templates
      : parseTemplates(p.templates as YamlValue, presentationFindings, lanes, customFields);
    const templateError = presentationFindings.find((finding) => finding.severity === 'error');
    if (templateError !== undefined) return { error: templateError.message };
    const templates = parsedTemplates.map((template) => ({
      ...template,
      extra: { ...(board.config.templates.find((old) => old.id === template.id)?.extra ?? {}), ...template.extra },
    }));
    for (const card of board.cards) {
      for (const definition of customFields) {
        const value = card.extra[definition.id];
        if (value !== undefined && !validCustomFieldValue(definition, value)) {
          return { error: `card ${card.id}: existing value for custom field "${definition.id}" is not valid for the new ${definition.type} definition` };
        }
      }
    }

    const migrations = new Map<string, string>();
    if (p.migrations !== undefined && p.migrations !== null) {
      if (typeof p.migrations !== 'object' || Array.isArray(p.migrations)) return { error: 'migrations must be an object of oldLane: newLane' };
      for (const [from, to] of Object.entries(p.migrations as Record<string, unknown>)) {
        if (typeof to !== 'string' || !seen.has(to)) return { error: `migration target for lane "${from}" must be one of the new lanes` };
        migrations.set(from, to);
      }
    }

    const laneById = new Map(lanes.map((l) => [l.id, l]));
    const oldLaneById = new Map(board.config.lanes.map((l) => [l.id, l]));
    const fallbackFor = (oldLaneId: string): Lane => {
      const oldCanonical = oldLaneById.get(oldLaneId)?.canonical ?? 'todo';
      return laneById.get(migrations.get(oldLaneId) ?? '') ?? lanes.find((l) => l.canonical === oldCanonical) ?? lanes.find((l) => l.canonical === 'todo') ?? lanes[0]!;
    };
    const moved: Card[] = [];
    for (const card of board.cards) {
      const lane = laneById.get(card.laneId) ?? fallbackFor(card.laneId);
      let substate = card.substate;
      if (lane.substates.length === 0) substate = null;
      else if (substate === null || !lane.substates.includes(substate)) substate = lane.substates[0]!;
      if (lane.id === card.laneId && substate === card.substate) continue;
      const from = card.substate ? `${card.laneId}.${card.substate}` : card.laneId;
      card.laneId = lane.id;
      card.substate = substate;
      const to = substate ? `${lane.id}.${substate}` : lane.id;
      logMutation(card, actor, `migrated ${from} → ${to} (board edit)`);
      moved.push(card);
    }

    const configYaml = emitBoardYaml({ ...board.config, name, lanes, labelDefinitions, customFields, templates, rollup });
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO meta(key, value) VALUES ('config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", configYaml);
      for (const card of moved) this.persistCard(card);
      this.event(actor, 'board-edit', null, `lanes: ${lanes.map((l) => l.id).join(', ')}${moved.length > 0 ? `; migrated ${moved.length} card(s)` : ''}`);
    });
    return { ok: true, migrated: moved.length };
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
    if (this.configText() !== null && current.config.mutationBlocked !== null) {
      return { error: `board is read-only: ${current.config.mutationBlocked}` };
    }
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
      if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
      const card = opAdd(board, { ...opts, actor });
      this.persistCard(card);
      this.event(actor, 'add', card.id, `created "${card.title}" in ${card.laneId}`);
      return { id: card.id, file: card.file, lane: card.laneId };
    } catch (err) {
      if (err instanceof UsageError) return { error: err.message };
      throw err;
    }
  }

  quickAdd(text: string, actor: string): ActionResult {
    try {
      if (text.length > MAX_BODY_TEXT) throw new UsageError(`quick-add text exceeds ${MAX_BODY_TEXT} characters`);
      const board = this.loadBoardDocs();
      if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
      const cards = opQuickAdd(board, text, actor);
      this.ctx.storage.transactionSync(() => {
        for (const card of cards) {
          this.persistCard(card);
          this.event(actor, 'quick-add', card.id, `created "${card.title}" in ${card.laneId}`);
        }
      });
      return { cards: cards.map((card) => ({ id: card.id, title: card.title, file: card.file })) };
    } catch (err) {
      if (err instanceof UsageError) return { error: err.message };
      throw err;
    }
  }

  bulkAction(ids: string[], action: Record<string, unknown>, actor: string): ActionResult {
    try {
      const board = this.loadBoardDocs();
      if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
      const kind = String(action['kind'] ?? '');
      const operation = kind === 'move'
        ? { kind: 'move' as const, to: String(action['to'] ?? ''), force: action['force'] === true }
        : kind === 'close'
          ? { kind: 'close' as const, reason: typeof action['reason'] === 'string' ? action['reason'] : undefined }
          : kind === 'label'
            ? {
                kind: 'label' as const,
                add: Array.isArray(action['add']) ? action['add'].map(String) : undefined,
                remove: Array.isArray(action['remove']) ? action['remove'].map(String) : undefined,
              }
            : (() => { throw new UsageError('bulk kind must be move, close, or label'); })();
      const result = opBulk(board, ids, operation, actor);
      this.ctx.storage.transactionSync(() => {
        for (const card of result.cards) {
          this.persistCard(card);
          this.event(actor, `bulk-${kind}`, card.id, kind);
        }
      });
      return { changed: result.cards.map((card) => card.id), warnings: result.warnings };
    } catch (err) {
      if (err instanceof UsageError) return { error: err.message };
      throw err;
    }
  }

  async action(kind: string, id: string, args: Record<string, unknown>, actor: string): Promise<ActionResult> {
    try {
      const analyzed = kind === 'claim' ? await this.analyzed() : null;
      const board = analyzed?.board ?? this.loadBoardDocs();
      if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
      const card = getCard(board, id);
      switch (kind) {
        case 'move': {
          const res = opMove(board, card, String(args['to']), actor, args['force'] === true);
          this.persistCard(card);
          this.event(actor, 'move', id, `${res.from} → ${res.to}${args['force'] === true ? ' (forced)' : ''}`);
          return { id, from: res.from, to: res.to, warnings: res.warnings };
        }
        case 'claim': {
          const mode = args['delegate'] === true ? 'delegate' : 'assign';
          const external = analyzed?.ba.dependencyStates.get(id) as Map<string, string | null> | undefined;
          const res = opClaim(board, card, actor, args['force'] === true, mode, external);
          if (res.alreadyYours) return { id, at: res.to, assignee: card.assignee, delegate: card.delegate, alreadyYours: true };
          this.persistCard(card);
          this.event(actor, 'claim', id, `${res.from} → ${res.to}${args['force'] === true ? ' (forced)' : ''}`);
          return { id, from: res.from, to: res.to, assignee: card.assignee, delegate: card.delegate, warnings: res.warnings };
        }
        case 'close': {
          const reason = typeof args['reason'] === 'string' ? (args['reason'] as string) : undefined;
          const res = opClose(board, card, actor, reason);
          this.persistCard(card);
          this.event(actor, 'close', id, reason ?? 'closed');
          return { id, from: res.from, to: res.to };
        }
        case 'block': {
          const reason = clampLine(args['reason'], 'blocked');
          opBlock(card, actor, reason);
          this.persistCard(card);
          this.event(actor, 'block', id, reason.slice(0, 200));
          return { id, blocked: card.blocked };
        }
        case 'unblock': {
          opUnblock(card, actor);
          this.persistCard(card);
          this.event(actor, 'unblock', id, '');
          return { id, blocked: null };
        }
        case 'comment': {
          const text = clampLine(args['message'], '').trim();
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
          if ('delegate' in args) patch.delegate = args['delegate'] === null ? null : String(args['delegate']);
          if ('deps' in args && Array.isArray(args['deps'])) patch.deps = (args['deps'] as unknown[]).map(String);
          if ('start' in args) {
            if (args['start'] !== null && typeof args['start'] !== 'string') throw new UsageError('start must be a string or null');
            patch.start = args['start'];
          }
          if ('due' in args) {
            if (args['due'] !== null && typeof args['due'] !== 'string') throw new UsageError('due must be a string or null');
            patch.due = args['due'];
          }
          if ('estimate' in args) {
            if (args['estimate'] !== null && typeof args['estimate'] !== 'number') throw new UsageError('estimate must be a number or null');
            patch.estimate = args['estimate'];
          }
          if ('evergreen' in args) {
            if (typeof args['evergreen'] !== 'boolean') throw new UsageError('evergreen must be a boolean');
            patch.evergreen = args['evergreen'];
          }
          if ('cover' in args) patch.cover = args['cover'] === null ? null : String(args['cover']);
          if ('cover_color' in args) {
            if (args['cover_color'] !== null && typeof args['cover_color'] !== 'string') throw new UsageError('cover_color must be a string or null');
            patch.coverColor = args['cover_color'];
          }
          if ('fields' in args) {
            if (args['fields'] === null || typeof args['fields'] !== 'object' || Array.isArray(args['fields'])) throw new UsageError('fields must be an object');
            patch.fields = args['fields'] as Record<string, unknown>;
          }
          opEdit(card, patch, actor, board);
          this.persistCard(card);
          this.event(actor, 'edit', id, Object.keys(patch).join(', '));
          return { id, edited: Object.keys(patch) };
        }
        case 'link':
        case 'unlink': {
          const targetId = String(args['target'] ?? '');
          const type = String(args['type'] ?? '') as Card['relations'][number]['type'];
          const result = kind === 'link'
            ? opLink(board, id, targetId, type, actor)
            : opUnlink(board, id, targetId, type, actor);
          if (result.changed) {
            this.ctx.storage.transactionSync(() => {
              this.persistCard(result.source);
              this.persistCard(result.target);
              this.event(actor, kind, id, `${type} ${targetId}`);
            });
          }
          return { id, target: targetId, type, changed: result.changed };
        }
        case 'promote': {
          const index = Number(args['index']);
          if (!Number.isInteger(index) || index < 0) throw new UsageError('index must be a non-negative integer');
          const result = opPromote(board, card, index, actor, {
            title: typeof args['title'] === 'string' ? args['title'] : undefined,
            template: typeof args['template'] === 'string' ? args['template'] : undefined,
            lane: typeof args['lane'] === 'string' ? args['lane'] : undefined,
          });
          this.ctx.storage.transactionSync(() => {
            this.persistCard(result.promoted);
            this.persistCard(result.source);
            this.event(actor, 'promote', id, `item ${index} → ${result.promoted.id}`);
          });
          return { id, promoted: result.promoted.id, index };
        }
        case 'merge': {
          const canonical = String(args['canonical'] ?? '');
          const result = opMergeDuplicates(board, id, canonical, actor);
          this.ctx.storage.transactionSync(() => {
            for (const changed of result.changed) this.persistCard(changed);
            this.event(actor, 'merge', id, `merged into ${canonical}`);
          });
          return { duplicate: id, canonical, attachmentsMoved: result.attachmentsMoved, referencesRewired: result.referencesRewired };
        }
        case 'log': {
          const message = clampLine(args['message'], '');
          opLog(card, actor, message);
          this.persistCard(card);
          this.event(actor, 'log', id, message.slice(0, 200));
          return { id, logged: true };
        }
        case 'describe': {
          const text = String(args['text'] ?? '').slice(0, MAX_BODY_TEXT);
          opDescribe(card, actor, text);
          this.persistCard(card);
          this.event(actor, 'describe', id, text.slice(0, 160));
          return { id, described: true };
        }
        case 'checkadd': {
          const section = typeof args['section'] === 'string' && args['section'].trim() !== '' ? (args['section'] as string) : undefined;
          const item = clampLine(args['text'], '');
          opChecklistAdd(card, actor, item, section);
          this.persistCard(card);
          this.event(actor, 'checkadd', id, item.slice(0, 160));
          return { id, added: true };
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
    if (board.config.mutationBlocked !== null) throw new UsageError(`board is read-only: ${board.config.mutationBlocked}`);
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
