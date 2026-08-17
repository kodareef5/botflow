// RegistryDO: the org tree and auth authority: one company per deployment,
// spaces → projects (projects own projects), admin token + per-project agent
// keys. A single SQLite-backed Durable Object serializes all registry writes.

import { DurableObject } from 'cloudflare:workers';

import { DEFAULT_THEME, validTheme, type ThemeChoice } from './themes.ts';

export interface ProjectRow {
  id: string;
  space_id: string;
  parent_id: string | null;
  name: string;
}

export interface ProjectNode {
  id: string;
  name: string;
  children: ProjectNode[];
}

export interface OrgTree {
  name: string;
  spaces: { id: string; name: string; projects: ProjectNode[] }[];
}

export type TokenIdentity =
  | { kind: 'admin' }
  | { kind: 'agent'; projectId: string; label: string }
  | null;

function randomToken(prefix: string): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

async function sha256hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function shortId(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Names and labels: single line, trimmed, bounded. Board configs embed them
 *  via emitScalar too, but bad input should die at the door. */
function cleanName(s: unknown, fallback: string): string {
  if (typeof s !== 'string') return fallback;
  const cleaned = s.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120);
  return cleaned === '' ? fallback : cleaned;
}

export class RegistryDO extends DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS org(id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, admin_hash TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, space_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS keys(id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, label TEXT NOT NULL, created TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shares(id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, label TEXT NOT NULL, created TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, card_id TEXT);
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
    `);
    try {
      // Upgrade path for instances created before card-scoped shares.
      this.sql.exec('ALTER TABLE shares ADD COLUMN card_id TEXT');
    } catch {
      // Column already exists (fresh DDL above or a prior upgrade).
    }
  }

  // ---- org audit log: every org-level action, append-only ----

  audit(actor: string, action: string, detail: string): { ok: boolean } {
    this.sql.exec('INSERT INTO audit(ts, actor, action, detail) VALUES (?, ?, ?, ?)', new Date().toISOString(), actor, action, detail.slice(0, 500));
    return { ok: true };
  }

  listAudit(limit: number): { seq: number; ts: string; actor: string; action: string; detail: string }[] {
    return this.sql
      .exec('SELECT seq, ts, actor, action, detail FROM audit ORDER BY seq DESC LIMIT ?', limit)
      .toArray() as unknown as { seq: number; ts: string; actor: string; action: string; detail: string }[];
  }

  // ---- prefs (small org-wide switches) ----

  getPrefs(): { gateShares: boolean } {
    const row = this.sql.exec("SELECT value FROM settings WHERE key = 'prefs'").toArray()[0];
    if (!row) return { gateShares: false };
    try {
      const parsed = JSON.parse(row['value'] as string) as { gateShares?: unknown };
      return { gateShares: parsed.gateShares === true };
    } catch {
      return { gateShares: false };
    }
  }

  setPrefs(prefs: { gateShares?: unknown }): { gateShares: boolean } {
    const next = { gateShares: prefs.gateShares === true };
    this.sql.exec(
      "INSERT INTO settings(key, value) VALUES ('prefs', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(next),
    );
    return next;
  }

  // ---- public share links (read-only capability urls) ----

  createShare(projectId: string, label: string, cardId: string | null = null): { id: string; token: string } | { error: string } {
    if (this.projectName(projectId) === null) return { error: `no project ${projectId}` };
    const token = randomToken('bfs').slice(4); // bare hex; the url is the capability
    const id = `sh-${shortId()}`;
    this.sql.exec('INSERT INTO shares(id, token, project_id, label, created, card_id) VALUES (?, ?, ?, ?, ?, ?)', id, token, projectId, cleanName(label, 'public link'), new Date().toISOString(), cardId);
    return { id, token };
  }

  listShares(projectId: string): { id: string; token: string; label: string; created: string; revoked: boolean; cardId: string | null }[] {
    return this.sql
      .exec('SELECT id, token, label, created, revoked, card_id FROM shares WHERE project_id = ? ORDER BY created', projectId)
      .toArray()
      .map((r) => ({ id: r['id'] as string, token: r['token'] as string, label: r['label'] as string, created: r['created'] as string, revoked: r['revoked'] === 1, cardId: (r['card_id'] as string | null) ?? null }));
  }

  /** Active board shares across the org, for the login-page listing.
   *  Card-scoped shares stay off the gate: it lists live boards. */
  listGateShares(): { token: string; name: string }[] {
    if (!this.getPrefs().gateShares) return [];
    return this.sql
      .exec('SELECT s.token AS token, p.name AS name FROM shares s JOIN projects p ON p.id = s.project_id WHERE s.revoked = 0 AND s.card_id IS NULL ORDER BY s.created')
      .toArray()
      .map((r) => ({ token: r['token'] as string, name: r['name'] as string }));
  }

  revokeShare(id: string): { ok: boolean } {
    this.sql.exec('UPDATE shares SET revoked = 1 WHERE id = ?', id);
    return { ok: true };
  }

  deleteShare(id: string): { ok: boolean } {
    this.sql.exec('DELETE FROM shares WHERE id = ?', id);
    return { ok: true };
  }

  /** Every share link in the org, with its project name (admin manage view). */
  listAllShares(): { id: string; token: string; label: string; created: string; revoked: boolean; projectId: string; projectName: string; cardId: string | null }[] {
    return this.sql
      .exec('SELECT s.id AS id, s.token AS token, s.label AS label, s.created AS created, s.revoked AS revoked, s.project_id AS pid, p.name AS pname, s.card_id AS cid FROM shares s JOIN projects p ON p.id = s.project_id ORDER BY s.created')
      .toArray()
      .map((r) => ({
        id: r['id'] as string,
        token: r['token'] as string,
        label: r['label'] as string,
        created: r['created'] as string,
        revoked: r['revoked'] === 1,
        projectId: r['pid'] as string,
        projectName: r['pname'] as string,
        cardId: (r['cid'] as string | null) ?? null,
      }));
  }

  // ---- deletion (hard; the export tool is the parachute) ----

  /** A project id plus every project nested beneath it. */
  private subtreeIds(pid: string): string[] {
    const rows = this.sql.exec('SELECT id, parent_id FROM projects').toArray() as { id: string; parent_id: string | null }[];
    const kids = new Map<string, string[]>();
    for (const r of rows) {
      if (r.parent_id === null) continue;
      if (!kids.has(r.parent_id)) kids.set(r.parent_id, []);
      kids.get(r.parent_id)!.push(r.id);
    }
    const out: string[] = [];
    const queue = [pid];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      out.push(cur);
      for (const k of kids.get(cur) ?? []) queue.push(k);
    }
    return out;
  }

  private projectIdsInSpace(spaceId: string): string[] {
    return this.sql.exec('SELECT id FROM projects WHERE space_id = ?', spaceId).toArray().map((r) => r['id'] as string);
  }

  /** Remove project rows plus their keys and shares. Must run inside a
   *  transactionSync closure owned by the public cascade methods below. */
  private deleteProjectRows(ids: string[]): void {
    for (const id of ids) {
      this.sql.exec('DELETE FROM keys WHERE project_id = ?', id);
      this.sql.exec('DELETE FROM shares WHERE project_id = ?', id);
      this.sql.exec('DELETE FROM projects WHERE id = ?', id);
    }
  }

  /** Resolve, authorize-cut, delete, and audit one project subtree as a
   *  single RegistryDO transaction. A concurrent child create therefore runs
   *  wholly before this snapshot (and is included) or after it (and sees no
   *  parent); it cannot become an orphan between separate RPCs. */
  deleteProjectCascade(pid: string, actor: string):
    | { ids: string[]; parent: string | null; name: string }
    | { error: string } {
    return this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec('SELECT name, parent_id FROM projects WHERE id = ?', pid).toArray()[0];
      if (!row) return { error: `no project ${pid}` };
      const ids = this.subtreeIds(pid);
      const parentValue: unknown = row['parent_id'];
      const parent = typeof parentValue === 'string' ? parentValue : null;
      const name = row['name'] as string;
      this.deleteProjectRows(ids);
      this.audit(actor, 'delete-project', `"${name}" (${ids.length} project(s): ${ids.join(', ')})`);
      return { ids, parent, name };
    });
  }

  /** Space equivalent of deleteProjectCascade: registry rows and the audit
   *  record commit together; ProjectDO storage cleanup remains best effort. */
  deleteSpaceCascade(id: string, actor: string): { ids: string[]; name: string } | { error: string } {
    return this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec('SELECT name FROM spaces WHERE id = ?', id).toArray()[0];
      if (!row) return { error: `no space ${id}` };
      const ids = this.projectIdsInSpace(id);
      this.deleteProjectRows(ids);
      this.sql.exec('DELETE FROM spaces WHERE id = ?', id);
      const name = row['name'] as string;
      this.audit(actor, 'delete-space', `"${name}" (${id}, ${ids.length} project(s))`);
      return { ids, name };
    });
  }

  /** Best-effort compensation for a company import that failed after staging
   *  new spaces. The caller records one import-failed audit event. */
  rollbackSpaces(spaceIds: string[]): { ids: string[] } {
    return this.ctx.storage.transactionSync(() => {
      const projectIds = new Set<string>();
      for (const sid of spaceIds) for (const pid of this.projectIdsInSpace(sid)) projectIds.add(pid);
      const ids = [...projectIds];
      this.deleteProjectRows(ids);
      for (const sid of spaceIds) this.sql.exec('DELETE FROM spaces WHERE id = ?', sid);
      return { ids };
    });
  }

  // ---- restore-grade export metadata ----

  setOrgName(name: string): { ok: boolean } {
    this.sql.exec('UPDATE org SET name = ? WHERE id = 1', cleanName(name, 'company'));
    return { ok: true };
  }

  /** Key hashes (not tokens) for company export; restoring them keeps the
   *  original bearer tokens valid. */
  exportKeys(): { hash: string; projectId: string; label: string; created: string; revoked: boolean }[] {
    return this.sql
      .exec('SELECT hash, project_id, label, created, revoked FROM keys ORDER BY created')
      .toArray()
      .map((r) => ({ hash: r['hash'] as string, projectId: r['project_id'] as string, label: r['label'] as string, created: r['created'] as string, revoked: r['revoked'] === 1 }));
  }

  restoreKey(hash: string, projectId: string, label: string, created: string, revoked: boolean): { ok: boolean } {
    this.sql.exec(
      'INSERT OR IGNORE INTO keys(id, hash, project_id, label, created, revoked) VALUES (?, ?, ?, ?, ?, ?)',
      `k-${shortId()}`, hash, projectId, cleanName(label, 'agent'), created, revoked ? 1 : 0,
    );
    return { ok: true };
  }

  restoreShare(token: string, projectId: string, label: string, created: string, revoked: boolean, cardId: string | null = null): { ok: boolean } {
    this.sql.exec(
      'INSERT OR IGNORE INTO shares(id, token, project_id, label, created, revoked, card_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      `sh-${shortId()}`, token, projectId, cleanName(label, 'public link'), created, revoked ? 1 : 0, cardId,
    );
    return { ok: true };
  }

  resolveShare(token: string): { projectId: string; name: string; cardId: string | null } | null {
    const row = this.sql
      .exec('SELECT s.project_id AS pid, p.name AS name, s.card_id AS cid FROM shares s JOIN projects p ON p.id = s.project_id WHERE s.token = ? AND s.revoked = 0', token)
      .toArray()[0];
    return row ? { projectId: row['pid'] as string, name: row['name'] as string, cardId: (row['cid'] as string | null) ?? null } : null;
  }

  getTheme(): ThemeChoice {
    const row = this.sql.exec("SELECT value FROM settings WHERE key = 'theme'").toArray()[0];
    if (!row) return DEFAULT_THEME;
    try {
      return validTheme(JSON.parse(row['value'] as string) as Partial<ThemeChoice>);
    } catch {
      return DEFAULT_THEME;
    }
  }

  setTheme(choice: Partial<ThemeChoice>): ThemeChoice {
    const valid = validTheme(choice);
    this.sql.exec(
      "INSERT INTO settings(key, value) VALUES ('theme', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(valid),
    );
    return valid;
  }

  /** True when `pid` is `ancestor` itself or sits anywhere beneath it. */
  isWithin(pid: string, ancestor: string): boolean {
    let cur: string | null = pid;
    for (let hops = 0; cur !== null && hops < 100; hops++) {
      if (cur === ancestor) return true;
      const rows = this.sql.exec('SELECT parent_id FROM projects WHERE id = ?', cur).toArray();
      const parent: unknown = rows[0]?.['parent_id'];
      cur = typeof parent === 'string' ? parent : null;
    }
    return false;
  }

  private initialized(): boolean {
    return this.sql.exec('SELECT COUNT(*) AS n FROM org').one()['n'] === 1;
  }

  /** First-run: name the company, mint the admin token (returned exactly once). */
  async setup(name: string): Promise<{ token: string } | { error: string }> {
    if (this.initialized()) return { error: 'already initialized' };
    const token = randomToken('bfa');
    this.sql.exec('INSERT INTO org(id, name, admin_hash, created) VALUES (1, ?, ?, ?)', cleanName(name, 'company'), await sha256hex(token), new Date().toISOString());
    this.audit('system', 'setup', 'company initialized');
    return { token };
  }

  /** Mint a fresh admin token and retire the old one, in one update. Used by
   *  authenticated rotation and by setup-key recovery; the caller supplies
   *  the audit action so the trail says which path was taken. */
  async rotateAdminToken(auditAction: 'rotate-token' | 'recover-admin'): Promise<{ token: string } | { error: string }> {
    if (!this.initialized()) return { error: 'not initialized' };
    const token = randomToken('bfa');
    this.sql.exec('UPDATE org SET admin_hash = ? WHERE id = 1', await sha256hex(token));
    this.audit('admin', auditAction, auditAction === 'rotate-token' ? 'admin token rotated; previous token is dead' : 'admin token recovered via setup key; previous token is dead');
    return { token };
  }

  status(): { initialized: boolean; name: string | null } {
    const rows = this.sql.exec('SELECT name FROM org').toArray();
    return { initialized: rows.length === 1, name: rows.length === 1 ? (rows[0]!['name'] as string) : null };
  }

  async verifyToken(token: string): Promise<TokenIdentity> {
    if (!this.initialized()) return null;
    const hash = await sha256hex(token);
    if (token.startsWith('bfa_')) {
      const row = this.sql.exec('SELECT 1 AS ok FROM org WHERE admin_hash = ?', hash).toArray();
      return row.length === 1 ? { kind: 'admin' } : null;
    }
    const rows = this.sql.exec('SELECT project_id, label FROM keys WHERE hash = ? AND revoked = 0', hash).toArray();
    const row = rows[0];
    return row ? { kind: 'agent', projectId: row['project_id'] as string, label: row['label'] as string } : null;
  }

  tree(): OrgTree {
    const name = (this.sql.exec('SELECT name FROM org').one()['name'] as string) ?? 'org';
    const projects = this.sql.exec('SELECT id, space_id, parent_id, name FROM projects ORDER BY created').toArray() as unknown as ProjectRow[];
    const childrenOf = (parent: string | null, spaceId: string): ProjectNode[] =>
      projects
        .filter((p) => p.space_id === spaceId && p.parent_id === parent)
        .map((p) => ({ id: p.id, name: p.name, children: childrenOf(p.id, spaceId) }));
    const spaces = this.sql
      .exec('SELECT id, name FROM spaces ORDER BY created')
      .toArray()
      .map((s) => ({ id: s['id'] as string, name: s['name'] as string, projects: childrenOf(null, s['id'] as string) }));
    return { name, spaces };
  }

  createSpace(name: string): { id: string } {
    const id = `s-${shortId()}`;
    this.sql.exec('INSERT INTO spaces(id, name, created) VALUES (?, ?, ?)', id, cleanName(name, 'space'), new Date().toISOString());
    return { id };
  }

  createProject(spaceId: string | null, parentId: string | null, name: string): { id: string } | { error: string } {
    if (parentId !== null) {
      const parent = this.sql.exec('SELECT space_id FROM projects WHERE id = ?', parentId).toArray()[0];
      if (!parent) return { error: `no parent project ${parentId}` };
      const parentSpace = parent['space_id'] as string;
      if (spaceId !== null && parentSpace !== spaceId) return { error: 'parent belongs to a different space' };
      spaceId = parentSpace;
    }
    if (spaceId === null) return { error: 'space or parent required' };
    if (this.sql.exec('SELECT 1 FROM spaces WHERE id = ?', spaceId).toArray().length === 0) return { error: `no space ${spaceId}` };
    const id = `p-${shortId()}`;
    this.sql.exec('INSERT INTO projects(id, space_id, parent_id, name, created) VALUES (?, ?, ?, ?, ?)', id, spaceId, parentId, cleanName(name, 'project'), new Date().toISOString());
    return { id };
  }

  projectName(id: string): string | null {
    const row = this.sql.exec('SELECT name FROM projects WHERE id = ?', id).toArray()[0];
    return row ? (row['name'] as string) : null;
  }

  async createKey(projectId: string, label: string): Promise<{ id: string; token: string } | { error: string }> {
    if (this.projectName(projectId) === null) return { error: `no project ${projectId}` };
    const token = randomToken('bfk');
    const id = `k-${shortId()}`;
    this.sql.exec('INSERT INTO keys(id, hash, project_id, label, created) VALUES (?, ?, ?, ?, ?)', id, await sha256hex(token), projectId, cleanName(label, 'agent'), new Date().toISOString());
    return { id, token };
  }

  listKeys(projectId: string): { id: string; label: string; created: string; revoked: boolean }[] {
    return this.sql
      .exec('SELECT id, label, created, revoked FROM keys WHERE project_id = ? ORDER BY created', projectId)
      .toArray()
      .map((r) => ({ id: r['id'] as string, label: r['label'] as string, created: r['created'] as string, revoked: r['revoked'] === 1 }));
  }

  revokeKey(id: string): { ok: boolean } {
    this.sql.exec('UPDATE keys SET revoked = 1 WHERE id = ?', id);
    return { ok: true };
  }
}
