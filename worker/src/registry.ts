// RegistryDO — the org tree and auth authority: one company per deployment,
// spaces → projects (projects own projects), admin token + per-project agent
// keys. A single SQLite-backed Durable Object serializes all registry writes.

import { DurableObject } from 'cloudflare:workers';

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
    `);
  }

  private initialized(): boolean {
    return this.sql.exec('SELECT COUNT(*) AS n FROM org').one()['n'] === 1;
  }

  /** First-run: name the company, mint the admin token (returned exactly once). */
  async setup(name: string): Promise<{ token: string } | { error: string }> {
    if (this.initialized()) return { error: 'already initialized' };
    const token = randomToken('bfa');
    this.sql.exec('INSERT INTO org(id, name, admin_hash, created) VALUES (1, ?, ?, ?)', name, await sha256hex(token), new Date().toISOString());
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
    this.sql.exec('INSERT INTO spaces(id, name, created) VALUES (?, ?, ?)', id, name, new Date().toISOString());
    return { id };
  }

  createProject(spaceId: string, parentId: string | null, name: string): { id: string } | { error: string } {
    if (this.sql.exec('SELECT 1 FROM spaces WHERE id = ?', spaceId).toArray().length === 0) return { error: `no space ${spaceId}` };
    if (parentId !== null) {
      const parent = this.sql.exec('SELECT space_id FROM projects WHERE id = ?', parentId).toArray()[0];
      if (!parent) return { error: `no parent project ${parentId}` };
      if (parent['space_id'] !== spaceId) return { error: 'parent belongs to a different space' };
    }
    const id = `p-${shortId()}`;
    this.sql.exec('INSERT INTO projects(id, space_id, parent_id, name, created) VALUES (?, ?, ?, ?, ?)', id, spaceId, parentId, name, new Date().toISOString());
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
    this.sql.exec('INSERT INTO keys(id, hash, project_id, label, created) VALUES (?, ?, ?, ?, ?)', id, await sha256hex(token), projectId, label, new Date().toISOString());
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
