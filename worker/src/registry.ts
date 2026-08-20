// RegistryDO: the org tree and auth authority: one company per deployment,
// spaces → projects (projects own projects), and the member directory every
// credential resolves through. A single SQLite-backed Durable Object
// serializes all registry writes.

import { DurableObject } from 'cloudflare:workers';

import { DEFAULT_CARD_TAG_LIMIT, validCardTagLimit } from '../../src/ui/card-face.ts';
import { DEFAULT_THEME, validTheme, type ThemeChoice } from './themes.ts';
import {
  absentPasswordHash,
  hashPassword,
  parseBasic,
  scopeAllows,
  validPassword,
  validRole,
  validScopeKind,
  validStoredPasswordHash,
  validUsername,
  verifyPassword,
  type ProjectLocation,
  type Role,
  type ScopeKind,
} from './security.ts';

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

/** Who is making a request. Every credential form (session, API key, basic
 *  auth) resolves to exactly this, so authorization never has to care which
 *  one was presented. */
export interface Identity {
  memberId: string;
  /** Immutable; the actor string written into card logs and `assignee`. */
  username: string;
  /** Editable; what the UI renders. Never persisted onto a card. */
  display: string;
  kind: 'human' | 'bot';
  role: Role;
  scopeKind: ScopeKind;
  scopeId: string | null;
}

export interface MemberRow extends Identity {
  disabled: boolean;
  created: string;
}

/** The name-resolution table the UI needs to turn stored usernames into
 *  current display names. Carries no credentials, so any member may read it. */
export interface DirectoryEntry {
  username: string;
  display: string;
  kind: 'human' | 'bot';
}

export interface CapabilityRow {
  id: string;
  token: string;
  label: string;
  created: string;
  revoked: boolean;
  kind: 'page' | 'feed';
  projectId: string;
  projectName: string;
  cardId: string | null;
  laneId: string | null;
  filterId: string | null;
  memberUsername: string | null;
  lastViewed: string | null;
}

export interface ResolvedCapability {
  projectId: string;
  name: string;
  kind: 'page' | 'feed';
  cardId: string | null;
  laneId: string | null;
  filterId: string | null;
  memberId: string | null;
  memberUsername: string | null;
}

export interface RestoredMember {
  username: string;
  display: string;
  kind: 'human' | 'bot';
  role: Role;
  scopeKind: ScopeKind;
  scopeId: string | null;
  passHash: string;
  disabled: boolean;
  created: string;
}

export interface RestoredKey {
  hash: string;
  username: string;
  label: string;
  created: string;
  revoked: boolean;
}

export interface RestoredShare {
  token: string;
  projectId: string;
  label: string;
  created: string;
  revoked: boolean;
  cardId: string | null;
  kind: 'page' | 'feed';
  memberUsername: string | null;
  laneId: string | null;
  filterId: string | null;
  lastViewed: string | null;
}

export interface CompanyRestorePlan {
  name?: string;
  theme?: Record<string, unknown>;
  prefs?: Record<string, unknown>;
  members: RestoredMember[];
  keys: RestoredKey[];
  shares: RestoredShare[];
  importDetail: string;
  credentialDetail?: string;
  legacyKeysDetail?: string;
}

export interface OrgPrefs {
  gateShares: boolean;
  cardTagLimit: number;
}

function restoredPrefs(value: Record<string, unknown>): OrgPrefs {
  return {
    gateShares: value['gateShares'] === true,
    cardTagLimit: value['cardTagLimit'] === undefined
      ? DEFAULT_CARD_TAG_LIMIT
      : validCardTagLimit(value['cardTagLimit']),
  };
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How long a verified basic-auth credential stays cached in DO memory. A bot
 *  polling a board would otherwise pay a full PBKDF2 derivation every request. */
const BASIC_CACHE_MS = 5 * 60 * 1000;
/** Capability reads can be much hotter than administrative writes. Access
 * metadata is deliberately coarse: one write per capability per interval is
 * enough to distinguish live links without turning every public poll into a
 * serialized RegistryDO mutation. */
const SHARE_VIEW_TOUCH_MS = 15 * 60 * 1000;

// Failed-credential throttle. PBKDF2 is the only other brake on guessing, and
// it is also what makes a flood expensive to serve.
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
/** Per (client, account). Deliberately narrower than a per-account lock: an
 *  attacker hammering one username from one host locks only themselves out,
 *  so the throttle cannot be turned around and used to lock a real member
 *  (or a bot) out of their own board. */
const THROTTLE_PAIR_MAX = 10;
/** Per client, across every account it tries: catches username spraying,
 *  which the pair counter alone would never see. */
const THROTTLE_CLIENT_MAX = 30;

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
      CREATE TABLE IF NOT EXISTS org(id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, admin_hash TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, space_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display TEXT NOT NULL, kind TEXT NOT NULL, role TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT, pass_hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS member_keys(id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, member_id TEXT NOT NULL, label TEXT NOT NULL, created TEXT NOT NULL, last_used TEXT, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, created TEXT NOT NULL, expires TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_attempts(key TEXT PRIMARY KEY, fails INTEGER NOT NULL, since TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shares(id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, label TEXT NOT NULL, created TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, card_id TEXT, kind TEXT NOT NULL DEFAULT 'page', member_id TEXT, lane_id TEXT, filter_id TEXT, last_viewed TEXT);
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
    `);
    // Upgrade old share tables explicitly. A catch-all ALTER handler hides
    // real migration failures (locked/corrupt tables look exactly like an
    // already-present column), so inspect the schema and execute only missing
    // additive changes.
    const shareColumns = new Set(
      this.sql.exec('PRAGMA table_info(shares)').toArray().map((row) => row['name'] as string),
    );
    for (const migration of [
      { name: 'card_id', sql: 'ALTER TABLE shares ADD COLUMN card_id TEXT' },
      { name: 'kind', sql: "ALTER TABLE shares ADD COLUMN kind TEXT NOT NULL DEFAULT 'page'" },
      { name: 'member_id', sql: 'ALTER TABLE shares ADD COLUMN member_id TEXT' },
      { name: 'lane_id', sql: 'ALTER TABLE shares ADD COLUMN lane_id TEXT' },
      { name: 'filter_id', sql: 'ALTER TABLE shares ADD COLUMN filter_id TEXT' },
      { name: 'last_viewed', sql: 'ALTER TABLE shares ADD COLUMN last_viewed TEXT' },
    ]) {
      if (!shareColumns.has(migration.name)) this.sql.exec(migration.sql);
    }
    this.sql.exec('CREATE INDEX IF NOT EXISTS shares_project_kind ON shares(project_id, kind, revoked, created)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS shares_member_kind ON shares(member_id, kind, revoked, created)');
    // The members model replaced the admin token and per-project agent keys
    // outright. An instance carrying the old table reports uninitialized (see
    // `initialized()`), re-runs setup behind SETUP_KEY, and keeps its spaces,
    // projects and boards; the dead credentials must not outlive that.
    this.sql.exec('DROP TABLE IF EXISTS keys');
  }

  /** Verified basic-auth credentials, keyed by a digest of `user:pass`. Stores
   *  only which member the credential proved, never the member's state: the
   *  row is re-read on every request, so a disable or a scope change is live
   *  immediately and only the PBKDF2 derivation is cached. Lives in DO memory
   *  alone; eviction or a restart simply costs one re-derivation. */
  private readonly basicCache = new Map<string, { memberId: string; until: number }>();

  // ---- org audit log: every org-level action, append-only ----

  audit(actor: string, action: string, detail: string): { ok: boolean } {
    this.sql.exec('INSERT INTO audit(ts, actor, action, detail) VALUES (?, ?, ?, ?)', new Date().toISOString(), actor, action, detail.slice(0, 500));
    return { ok: true };
  }

  listAudit(limit: number, before: number | null = null): { seq: number; ts: string; actor: string; action: string; detail: string }[] {
    const query = before === null
      ? this.sql.exec('SELECT seq, ts, actor, action, detail FROM audit ORDER BY seq DESC LIMIT ?', limit)
      : this.sql.exec('SELECT seq, ts, actor, action, detail FROM audit WHERE seq < ? ORDER BY seq DESC LIMIT ?', before, limit);
    return query.toArray() as unknown as { seq: number; ts: string; actor: string; action: string; detail: string }[];
  }

  // ---- prefs (small org-wide switches) ----

  getPrefs(): OrgPrefs {
    const row = this.sql.exec("SELECT value FROM settings WHERE key = 'prefs'").toArray()[0];
    if (!row) return { gateShares: false, cardTagLimit: DEFAULT_CARD_TAG_LIMIT };
    try {
      return restoredPrefs(JSON.parse(row['value'] as string) as Record<string, unknown>);
    } catch {
      return { gateShares: false, cardTagLimit: DEFAULT_CARD_TAG_LIMIT };
    }
  }

  setPrefs(prefs: { gateShares?: unknown; cardTagLimit?: unknown }): OrgPrefs {
    const current = this.getPrefs();
    const next = {
      gateShares: typeof prefs.gateShares === 'boolean' ? prefs.gateShares : current.gateShares,
      cardTagLimit: prefs.cardTagLimit === undefined
        ? current.cardTagLimit
        : validCardTagLimit(prefs.cardTagLimit),
    };
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
    this.sql.exec("INSERT INTO shares(id, token, project_id, label, created, card_id, kind) VALUES (?, ?, ?, ?, ?, ?, 'page')", id, token, projectId, cleanName(label, 'public link'), new Date().toISOString(), cardId);
    return { id, token };
  }

  createFeed(
    projectId: string,
    memberId: string,
    label: string,
    cardId: string | null = null,
    laneId: string | null = null,
    filterId: string | null = null,
  ): { id: string; token: string } | { error: string } {
    if (this.projectName(projectId) === null) return { error: `no project ${projectId}` };
    const identity = this.memberById(memberId);
    if (identity === null || !this.reaches(identity, projectId)) return { error: 'member no longer reaches this project' };
    if ([cardId, laneId, filterId].filter((value) => value !== null).length > 1) return { error: 'a feed may have only one card, lane, or filter scope' };
    const token = randomToken('bfs').slice(4);
    const id = `sh-${shortId()}`;
    this.sql.exec(
      "INSERT INTO shares(id, token, project_id, label, created, card_id, kind, member_id, lane_id, filter_id) VALUES (?, ?, ?, ?, ?, ?, 'feed', ?, ?, ?)",
      id, token, projectId, cleanName(label, 'activity feed'), new Date().toISOString(), cardId, memberId, laneId, filterId,
    );
    return { id, token };
  }

  listShares(projectId: string): { id: string; token: string; label: string; created: string; revoked: boolean; cardId: string | null }[] {
    return this.sql
      .exec("SELECT id, token, label, created, revoked, card_id FROM shares WHERE project_id = ? AND kind = 'page' ORDER BY created", projectId)
      .toArray()
      .map((r) => ({ id: r['id'] as string, token: r['token'] as string, label: r['label'] as string, created: r['created'] as string, revoked: r['revoked'] === 1, cardId: (r['card_id'] as string | null) ?? null }));
  }

  /** Active board shares across the org, for the login-page listing.
   *  Card-scoped shares stay off the gate: it lists live boards. */
  listGateShares(): { token: string; name: string }[] {
    if (!this.getPrefs().gateShares) return [];
    return this.sql
      .exec("SELECT s.token AS token, p.name AS name FROM shares s JOIN projects p ON p.id = s.project_id WHERE s.revoked = 0 AND s.kind = 'page' AND s.card_id IS NULL ORDER BY s.created")
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

  listFeeds(projectId: string, memberId: string): CapabilityRow[] {
    return this.capabilityRows("WHERE s.project_id = ? AND s.kind = 'feed' AND s.member_id = ?", projectId, memberId);
  }

  revokeOwnFeed(id: string, memberId: string): { ok: boolean } | { error: string } {
    const row = this.sql.exec("SELECT id FROM shares WHERE id = ? AND kind = 'feed' AND member_id = ?", id, memberId).toArray()[0];
    if (!row) return { error: `no feed ${id}` };
    this.sql.exec('UPDATE shares SET revoked = 1 WHERE id = ?', id);
    return { ok: true };
  }

  deleteOwnFeed(id: string, memberId: string): { ok: boolean } | { error: string } {
    const row = this.sql.exec("SELECT id FROM shares WHERE id = ? AND kind = 'feed' AND member_id = ?", id, memberId).toArray()[0];
    if (!row) return { error: `no feed ${id}` };
    this.sql.exec('DELETE FROM shares WHERE id = ?', id);
    return { ok: true };
  }

  private capabilityRows(where = '', ...args: unknown[]): CapabilityRow[] {
    return this.sql
      .exec(
        `SELECT s.id AS id, s.token AS token, s.label AS label, s.created AS created,
                s.revoked AS revoked, s.kind AS kind, s.project_id AS pid, p.name AS pname,
                s.card_id AS cid, s.lane_id AS lid, s.filter_id AS fid, s.last_viewed AS viewed,
                m.username AS username
         FROM shares s JOIN projects p ON p.id = s.project_id
         LEFT JOIN members m ON m.id = s.member_id ${where} ORDER BY s.created`,
        ...args,
      )
      .toArray()
      .map((r) => ({
        id: r['id'] as string,
        token: r['token'] as string,
        label: r['label'] as string,
        created: r['created'] as string,
        revoked: r['revoked'] === 1,
        kind: r['kind'] === 'feed' ? 'feed' : 'page',
        projectId: r['pid'] as string,
        projectName: r['pname'] as string,
        cardId: (r['cid'] as string | null) ?? null,
        laneId: (r['lid'] as string | null) ?? null,
        filterId: (r['fid'] as string | null) ?? null,
        memberUsername: (r['username'] as string | null) ?? null,
        lastViewed: (r['viewed'] as string | null) ?? null,
      }));
  }

  /** Every share link in the org, with its project name (owner manage view). */
  listAllShares(): CapabilityRow[] {
    return this.capabilityRows();
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

  /** Remove project rows plus their shares, and disable any member scoped to
   *  a project that no longer exists: a dangling grant reaches nothing, and
   *  leaving it live would silently re-grant if the id were ever reused. Must
   *  run inside a transactionSync closure owned by the cascade methods below. */
  private deleteProjectRows(ids: string[]): void {
    for (const id of ids) {
      this.sql.exec("UPDATE members SET disabled = 1 WHERE scope_kind = 'project' AND scope_id = ?", id);
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
      this.sql.exec("UPDATE members SET disabled = 1 WHERE scope_kind = 'space' AND scope_id = ?", id);
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

  /** Members for company export, password hashes included: a restore that
   *  locked the owner out of their own company would not be a restore. Key
   *  hashes (never tokens) ride along so existing bearer tokens keep working. */
  exportMembers(): (MemberRow & { passHash: string })[] {
    return this.sql
      .exec('SELECT * FROM members ORDER BY created')
      .toArray()
      .map((r) => ({
        ...this.toIdentity(r),
        disabled: r['disabled'] === 1,
        created: r['created'] as string,
        passHash: r['pass_hash'] as string,
      }));
  }

  exportKeys(): { hash: string; username: string; label: string; created: string; revoked: boolean }[] {
    return this.sql
      .exec('SELECT k.hash AS hash, m.username AS username, k.label AS label, k.created AS created, k.revoked AS revoked FROM member_keys k JOIN members m ON m.id = k.member_id ORDER BY k.created')
      .toArray()
      .map((r) => ({ hash: r['hash'] as string, username: r['username'] as string, label: r['label'] as string, created: r['created'] as string, revoked: r['revoked'] === 1 }));
  }

  /** Apply the credential-bearing half of a company restore in one RegistryDO
   * SQLite transaction. Project trees and integrations are staged first by
   * the Worker; every member scope and capability target is therefore fully
   * resolvable before any password, key, share, session, or org setting moves.
   * A returned error has no registry-side effects. */
  restoreCompany(plan: CompanyRestorePlan, actor: string):
    | { ok: true; members: number; keys: number; shares: number }
    | { error: string } {
    const memberNames = new Set<string>();
    const members: RestoredMember[] = [];
    for (const input of plan.members) {
      if (memberNames.has(input.username)) return { error: `duplicate restored member "${input.username}"` };
      memberNames.add(input.username);
      if (!validUsername(input.username) || !validRole(input.role) || !validScopeKind(input.scopeKind) ||
          (input.kind !== 'human' && input.kind !== 'bot') || typeof input.display !== 'string' ||
          typeof input.created !== 'string' || !validStoredPasswordHash(input.passHash)) {
        return { error: `malformed restored member "${input.username}"` };
      }
      const scope = this.resolveScope(input.role, input.role === 'owner' ? 'org' : input.scopeKind, input.role === 'owner' ? null : input.scopeId);
      if ('error' in scope) return { error: `member "${input.username}": ${scope.error}` };
      members.push({ ...input, scopeKind: scope.kind, scopeId: scope.id });
    }

    const projected = new Map<string, { role: Role; disabled: boolean }>();
    for (const row of this.sql.exec('SELECT username, role, disabled FROM members').toArray()) {
      if (validRole(row['role'])) projected.set(row['username'] as string, { role: row['role'], disabled: row['disabled'] === 1 });
    }
    for (const member of members) projected.set(member.username, { role: member.role, disabled: member.disabled });
    if (![...projected.values()].some((member) => member.role === 'owner' && !member.disabled)) {
      return { error: 'this import would leave the company with no live owner' };
    }

    const existingKeys = new Map(
      this.sql.exec('SELECT k.hash AS hash, m.username AS username FROM member_keys k JOIN members m ON m.id = k.member_id')
        .toArray().map((row) => [row['hash'] as string, row['username'] as string]),
    );
    const keyHashes = new Set<string>();
    for (const key of plan.keys) {
      if (!/^[a-f0-9]{64}$/.test(key.hash) || typeof key.label !== 'string' || typeof key.created !== 'string' || !memberNames.has(key.username)) {
        return { error: `malformed restored api key for "${key.username}"` };
      }
      if (keyHashes.has(key.hash)) return { error: `duplicate restored api key hash ${key.hash}` };
      keyHashes.add(key.hash);
      const owner = existingKeys.get(key.hash);
      if (owner !== undefined && owner !== key.username) return { error: `api key hash already belongs to member "${owner}"` };
    }

    const existingShareTokens = new Set(this.sql.exec('SELECT token FROM shares').toArray().map((row) => row['token'] as string));
    const shareTokens = new Set<string>();
    const memberByUsername = new Map(members.map((member) => [member.username, member]));
    for (const share of plan.shares) {
      if (!/^[a-f0-9]{16,64}$/.test(share.token) || this.projectName(share.projectId) === null ||
          typeof share.label !== 'string' || typeof share.created !== 'string') {
        return { error: `malformed restored share ${share.token}` };
      }
      if (shareTokens.has(share.token)) return { error: `duplicate restored share token ${share.token}` };
      if (existingShareTokens.has(share.token)) return { error: `share token ${share.token} already exists` };
      shareTokens.add(share.token);
      if (share.memberUsername !== null && !memberByUsername.has(share.memberUsername)) {
        return { error: `share ${share.token} names an unknown restored member` };
      }
      if ([share.cardId, share.laneId, share.filterId].filter((value) => value !== null).length > 1) {
        return { error: `share ${share.token} has more than one scope` };
      }
      if (share.kind === 'feed') {
        const member = share.memberUsername === null ? undefined : memberByUsername.get(share.memberUsername);
        const location = this.locate(share.projectId);
        if (member === undefined || location === null || !scopeAllows({ kind: member.scopeKind, id: member.scopeId }, location)) {
          return { error: `feed ${share.token} member does not reach its project` };
        }
      }
    }

    try {
      this.ctx.storage.transactionSync(() => {
        if (plan.name !== undefined) this.sql.exec('UPDATE org SET name = ? WHERE id = 1', cleanName(plan.name, 'company'));
        if (plan.theme !== undefined) {
          this.sql.exec(
            "INSERT INTO settings(key, value) VALUES ('theme', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            JSON.stringify(validTheme(plan.theme)),
          );
        }
        if (plan.prefs !== undefined) {
          this.sql.exec(
            "INSERT INTO settings(key, value) VALUES ('prefs', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            JSON.stringify(restoredPrefs(plan.prefs)),
          );
        }

        for (const member of members) {
          const prior = this.sql.exec('SELECT id, pass_hash FROM members WHERE username = ?', member.username).toArray()[0];
          this.sql.exec(
            `INSERT INTO members(id, username, display, kind, role, scope_kind, scope_id, pass_hash, disabled, created)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(username) DO UPDATE SET
               display = excluded.display, kind = excluded.kind, role = excluded.role,
               scope_kind = excluded.scope_kind, scope_id = excluded.scope_id,
               pass_hash = excluded.pass_hash, disabled = excluded.disabled, created = excluded.created`,
            `m-${shortId()}`, member.username, cleanName(member.display, member.username), member.kind,
            member.role, member.scopeKind, member.scopeId, member.passHash, member.disabled ? 1 : 0, member.created,
          );
          if (prior && (prior['pass_hash'] !== member.passHash || member.disabled)) this.endSessionsFor(prior['id'] as string);
        }

        const memberIds = new Map(this.sql.exec('SELECT id, username FROM members').toArray().map((row) => [row['username'] as string, row['id'] as string]));
        for (const key of plan.keys) {
          this.sql.exec(
            `INSERT INTO member_keys(id, hash, member_id, label, created, revoked) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(hash) DO UPDATE SET member_id = excluded.member_id, label = excluded.label,
               created = excluded.created, revoked = excluded.revoked`,
            `k-${shortId()}`, key.hash, memberIds.get(key.username)!, cleanName(key.label, 'api key'), key.created, key.revoked ? 1 : 0,
          );
        }
        for (const share of plan.shares) {
          const memberId = share.memberUsername === null ? null : memberIds.get(share.memberUsername) ?? null;
          this.sql.exec(
            'INSERT INTO shares(id, token, project_id, label, created, revoked, card_id, kind, member_id, lane_id, filter_id, last_viewed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            `sh-${shortId()}`, share.token, share.projectId, cleanName(share.label, share.kind === 'feed' ? 'activity feed' : 'public link'),
            share.created, share.revoked ? 1 : 0, share.cardId, share.kind, memberId, share.laneId, share.filterId, share.lastViewed,
          );
        }
        if (plan.legacyKeysDetail !== undefined) this.audit(actor, 'import-legacy-keys-dropped', plan.legacyKeysDetail);
        if (plan.credentialDetail !== undefined) this.audit(actor, 'import-credentials', plan.credentialDetail);
        this.audit(actor, 'import', plan.importDetail);
      });
    } catch (err) {
      return { error: `credential restore failed: ${(err as Error).message}` };
    }
    this.basicCache.clear();
    return { ok: true, members: members.length, keys: plan.keys.length, shares: plan.shares.length };
  }

  resolveShare(token: string, expectedKind: 'page' | 'feed' = 'page'): ResolvedCapability | null {
    const row = this.sql
      .exec('SELECT s.id AS id, s.project_id AS pid, p.name AS name, s.card_id AS cid, s.kind AS kind, s.member_id AS mid, s.lane_id AS lid, s.filter_id AS fid FROM shares s JOIN projects p ON p.id = s.project_id WHERE s.token = ? AND s.revoked = 0 AND s.kind = ?', token, expectedKind)
      .toArray()[0];
    if (!row) return null;
    const memberId = (row['mid'] as string | null) ?? null;
    let memberUsername: string | null = null;
    if (memberId !== null) {
      const identity = this.memberById(memberId);
      if (identity === null || !this.reaches(identity, row['pid'] as string)) return null;
      memberUsername = identity.username;
    }
    const viewed = new Date().toISOString();
    const staleBefore = new Date(Date.now() - SHARE_VIEW_TOUCH_MS).toISOString();
    this.sql.exec(
      'UPDATE shares SET last_viewed = ? WHERE id = ? AND (last_viewed IS NULL OR last_viewed < ?)',
      viewed, row['id'], staleBefore,
    );
    return {
      projectId: row['pid'] as string,
      name: row['name'] as string,
      kind: row['kind'] === 'feed' ? 'feed' : 'page',
      cardId: (row['cid'] as string | null) ?? null,
      laneId: (row['lid'] as string | null) ?? null,
      filterId: (row['fid'] as string | null) ?? null,
      memberId,
      memberUsername,
    };
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

  /** Initialized means "somebody owns this deployment", not "a company row
   *  exists". An instance from before the members model therefore reports
   *  false and can be claimed again behind SETUP_KEY, keeping its boards. */
  /** Live owners. A company with none can only be re-entered through the
   *  SETUP_KEY path, so several invariants hang off this count. */
  liveOwners(): number {
    return this.sql.exec("SELECT COUNT(*) AS n FROM members WHERE role = 'owner' AND disabled = 0").one()['n'] as number;
  }

  private initialized(): boolean {
    return this.liveOwners() > 0;
  }

  /** First-run: name the company and create its owner. Returns a live session
   *  so the operator is simply logged in: there is no token to copy down. */
  async setup(name: string, username: string, password: string): Promise<{ token: string; expires: string } | { error: string }> {
    if (this.initialized()) return { error: 'already initialized' };
    // Check and hash before writing anything: a rejected setup that had
    // already created the org row would leave the deployment looking claimed
    // while nobody could log in, and setup would refuse to run again.
    const scope = this.checkNewMember(username, password, 'owner', 'org', null);
    if ('error' in scope) return scope;
    const passHash = await hashPassword(password);
    const memberId = this.ctx.storage.transactionSync(() => {
      const created = new Date().toISOString();
      if (this.sql.exec('SELECT COUNT(*) AS n FROM org').one()['n'] !== 1) {
        this.sql.exec('INSERT INTO org(id, name, admin_hash, created) VALUES (1, ?, ?, ?)', cleanName(name, 'company'), '', created);
      } else {
        this.sql.exec('UPDATE org SET name = ? WHERE id = 1', cleanName(name, 'company'));
      }
      const id = this.insertMemberRow(username, username, 'human', 'owner', scope, passHash);
      this.audit(username, 'setup', 'company initialized');
      return id;
    });
    return this.startSession(memberId);
  }

  /** Recovery rides the same trust anchor as first-run setup (the SETUP_KEY
   *  secret): reset the owner's password, or install an owner if every one of
   *  them is gone. Every live session dies with it. */
  async recover(username: string, password: string): Promise<{ token: string; expires: string } | { error: string }> {
    const owner = this.sql.exec("SELECT id FROM members WHERE username = ? AND role = 'owner'", username).toArray()[0];
    // Validate before touching anything, on both branches. Recovery that
    // accepted an unusable password would set a hash nothing can ever match:
    // the old password stops working and the new one cannot log in, which
    // locks the company rather than recovering it.
    if (!validPassword(password)) return { error: 'password must be at least 8 characters' };
    if (owner === undefined) {
      // Installing an owner is only for a company that has none: otherwise a
      // typo in the username ("rooot") would silently mint a second org-wide
      // owner and kill every session, reported as success. With owners alive,
      // recovery must name one of them.
      if (this.liveOwners() > 0) {
        return { error: `no owner named "${username}": recovery resets an existing owner's password` };
      }
      if (!validUsername(username)) {
        return { error: 'username must be 2-32 chars of a-z, 0-9, - or _, starting with a letter or digit' };
      }
      if (this.sql.exec('SELECT 1 FROM members WHERE username = ?', username).toArray().length === 1) {
        return { error: `"${username}" already exists and is not an owner` };
      }
    }
    const passHash = await hashPassword(password);
    const memberId = this.ctx.storage.transactionSync(() => {
      // Recovery can run on a deployment that was never set up, so it owns
      // the same invariant setup does: an owner exists only alongside an org
      // row. Without this the tree has no name, /api/org 500s, and setup
      // refuses to run because the company already looks initialized.
      if (this.sql.exec('SELECT COUNT(*) AS n FROM org').one()['n'] !== 1) {
        this.sql.exec('INSERT INTO org(id, name, admin_hash, created) VALUES (1, ?, ?, ?)', 'company', '', new Date().toISOString());
      }
      const id = owner
        ? (this.sql.exec('UPDATE members SET pass_hash = ?, disabled = 0 WHERE id = ?', passHash, owner['id'] as string), owner['id'] as string)
        : this.insertMemberRow(username, username, 'human', 'owner', { kind: 'org', id: null }, passHash);
      this.sql.exec('DELETE FROM sessions');
      // Every credential, not just the browser ones. An operator reaching for
      // recovery believes they are evicting whoever holds the account; an api
      // key that outlived the reset would quietly keep full access.
      this.sql.exec('UPDATE member_keys SET revoked = 1 WHERE member_id = ?', id);
      this.audit(username, 'recover-owner', 'owner access recovered via setup key; all sessions ended and api keys revoked');
      return id;
    });
    this.basicCache.clear();
    return this.startSession(memberId);
  }

  status(): { initialized: boolean; name: string | null } {
    const rows = this.sql.exec('SELECT name FROM org').toArray();
    return { initialized: this.initialized(), name: rows.length === 1 ? (rows[0]!['name'] as string) : null };
  }

  // ---- members: the one identity table ----

  /** Row → Identity. Every credential path funnels through this so the shape
   *  of an authenticated caller is defined in exactly one place. */
  private toIdentity(row: Record<string, SqlStorageValue>): Identity {
    return {
      memberId: row['id'] as string,
      username: row['username'] as string,
      display: row['display'] as string,
      kind: row['kind'] === 'bot' ? 'bot' : 'human',
      role: row['role'] as Role,
      scopeKind: row['scope_kind'] as ScopeKind,
      scopeId: (row['scope_id'] as string | null) ?? null,
    };
  }

  private memberById(id: string): Identity | null {
    const row = this.sql.exec('SELECT * FROM members WHERE id = ? AND disabled = 0', id).toArray()[0];
    if (!row) return null;
    const identity = this.toIdentity(row);
    if (!validRole(identity.role) || !validScopeKind(identity.scopeKind)) return null;
    if (identity.role === 'admin' && identity.scopeKind === 'org') return null;
    return identity;
  }

  /** The single insert path for a member, shared by setup, recovery and the
   *  member-administration API, so username/scope validation can never be skipped by one of
   *  them. Callers are responsible for authorizing the create. */
  private checkNewMember(username: string, password: string, role: Role, scopeKind: ScopeKind, scopeId: string | null):
    { kind: ScopeKind; id: string | null } | { error: string } {
    if (!validUsername(username)) {
      return { error: 'username must be 2-32 chars of a-z, 0-9, - or _, starting with a letter or digit' };
    }
    if (!validPassword(password)) return { error: 'password must be at least 8 characters' };
    if (this.sql.exec('SELECT 1 FROM members WHERE username = ?', username).toArray().length === 1) {
      return { error: `username "${username}" is taken` };
    }
    return this.resolveScope(role, scopeKind, scopeId);
  }

  private insertMemberRow(
    username: string, display: string, kind: 'human' | 'bot', role: Role,
    scope: { kind: ScopeKind; id: string | null }, passHash: string,
  ): string {
    const id = `m-${shortId()}`;
    this.sql.exec(
      'INSERT INTO members(id, username, display, kind, role, scope_kind, scope_id, pass_hash, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, username, cleanName(display, username), kind, role, scope.kind, scope.id, passHash, new Date().toISOString(),
    );
    return id;
  }

  private async insertMember(
    username: string,
    display: string,
    kind: 'human' | 'bot',
    role: Role,
    scopeKind: ScopeKind,
    scopeId: string | null,
    password: string,
  ): Promise<{ id: string } | { error: string }> {
    const scope = this.checkNewMember(username, password, role, scopeKind, scopeId);
    if ('error' in scope) return scope;
    return { id: this.insertMemberRow(username, display, kind, role, scope, await hashPassword(password)) };
  }

  /** An owner is org-wide by definition. Admin is deliberately scoped so it
   *  cannot become an owner alias; read/write may still be company-wide. Any
   *  named scope must actually exist or the member would hold a grant over
   *  nothing. */
  private resolveScope(role: Role, kind: ScopeKind, id: string | null): { kind: ScopeKind; id: string | null } | { error: string } {
    if (role === 'owner') return { kind: 'org', id: null };
    if (role === 'admin' && kind === 'org') return { error: 'admin scope must be a space or project' };
    if (kind === 'org') return { kind: 'org', id: null };
    if (typeof id !== 'string' || id === '') return { error: `a ${kind} scope needs a ${kind} id` };
    if (kind === 'space') {
      if (this.sql.exec('SELECT 1 FROM spaces WHERE id = ?', id).toArray().length === 0) return { error: `no space ${id}` };
      return { kind, id };
    }
    if (this.projectName(id) === null) return { error: `no project ${id}` };
    return { kind, id };
  }

  async createMember(input: {
    username?: unknown; display?: unknown; kind?: unknown; role?: unknown;
    scopeKind?: unknown; scopeId?: unknown; password?: unknown;
  }): Promise<{ id: string } | { error: string }> {
    if (!validRole(input.role)) return { error: "role must be 'owner', 'admin', 'write' or 'read'" };
    if (!validScopeKind(input.scopeKind)) return { error: "scope must be 'org', 'space' or 'project'" };
    return this.insertMember(
      typeof input.username === 'string' ? input.username : '',
      typeof input.display === 'string' && input.display !== '' ? input.display : String(input.username ?? ''),
      input.kind === 'bot' ? 'bot' : 'human',
      input.role,
      input.scopeKind,
      typeof input.scopeId === 'string' && input.scopeId !== '' ? input.scopeId : null,
      typeof input.password === 'string' ? input.password : '',
    );
  }

  listMembers(): (MemberRow & { keys: number })[] {
    return this.sql
      .exec('SELECT m.*, (SELECT COUNT(*) FROM member_keys k WHERE k.member_id = m.id AND k.revoked = 0) AS keys FROM members m ORDER BY m.created')
      .toArray()
      .map((r) => ({ ...this.toIdentity(r), disabled: r['disabled'] === 1, created: r['created'] as string, keys: Number(r['keys'] ?? 0) }));
  }

  /** Name resolution for the UI. Usernames are what boards store; this is how
   *  a display-name edit shows up on every card without rewriting one. */
  directory(): DirectoryEntry[] {
    return this.sql
      .exec('SELECT username, display, kind FROM members ORDER BY username')
      .toArray()
      .map((r) => ({ username: r['username'] as string, display: r['display'] as string, kind: r['kind'] === 'bot' ? 'bot' : 'human' }));
  }

  /** Username is deliberately absent: it is baked into card logs, so it is
   *  immutable. Everything else about a member is editable. */
  updateMember(id: string, patch: { display?: unknown; role?: unknown; scopeKind?: unknown; scopeId?: unknown; disabled?: unknown }): { ok: true } | { error: string } {
    const row = this.sql.exec('SELECT * FROM members WHERE id = ?', id).toArray()[0];
    if (!row) return { error: `no member ${id}` };
    const current = this.toIdentity(row);
    const role = patch.role === undefined ? current.role : patch.role;
    if (!validRole(role)) return { error: "role must be 'owner', 'admin', 'write' or 'read'" };
    const scopeKind = patch.scopeKind === undefined ? current.scopeKind : patch.scopeKind;
    if (!validScopeKind(scopeKind)) return { error: "scope must be 'org', 'space' or 'project'" };
    const scopeId = patch.scopeId === undefined ? current.scopeId : (typeof patch.scopeId === 'string' && patch.scopeId !== '' ? patch.scopeId : null);
    const scope = this.resolveScope(role, scopeKind, scopeId);
    if ('error' in scope) return scope;
    const disabled = patch.disabled === undefined ? row['disabled'] === 1 : patch.disabled === true;
    // Never let the last way in disappear: a company with no live owner can
    // only be recovered through the SETUP_KEY path.
    if ((current.role === 'owner' && role !== 'owner') || (current.role === 'owner' && disabled)) {
      const others = this.sql.exec("SELECT COUNT(*) AS n FROM members WHERE role = 'owner' AND disabled = 0 AND id != ?", id).one()['n'] as number;
      if (others === 0) return { error: 'this is the last owner: promote another member first' };
    }
    this.sql.exec(
      'UPDATE members SET display = ?, role = ?, scope_kind = ?, scope_id = ?, disabled = ? WHERE id = ?',
      cleanName(patch.display === undefined ? current.display : patch.display, current.username),
      role, scope.kind, scope.id, disabled ? 1 : 0, id,
    );
    if (disabled) this.endSessionsFor(id);
    this.basicCache.clear();
    return { ok: true };
  }

  /** Changing a password kills every session and key-cache entry for that
   *  member: "log everyone else out" is the whole point of a reset. */
  async setPassword(id: string, password: string): Promise<{ ok: true } | { error: string }> {
    if (!validPassword(password)) return { error: 'password must be at least 8 characters' };
    if (this.sql.exec('SELECT 1 FROM members WHERE id = ?', id).toArray().length === 0) return { error: `no member ${id}` };
    this.sql.exec('UPDATE members SET pass_hash = ? WHERE id = ?', await hashPassword(password), id);
    this.endSessionsFor(id);
    // A password change is how you throw someone out. Leaving their api keys
    // live would leave them in, holding exactly the access you just revoked.
    this.sql.exec('UPDATE member_keys SET revoked = 1 WHERE member_id = ?', id);
    this.basicCache.clear();
    return { ok: true };
  }

  async verifyPasswordFor(id: string, password: string, client = 'unknown'): Promise<boolean> {
    const row = this.sql.exec('SELECT username, pass_hash FROM members WHERE id = ?', id).toArray()[0];
    if (!row) return false;
    const username = row['username'] as string;
    if (this.authRetryAfter(client, username) > 0) return false;
    const ok = await verifyPassword(password, row['pass_hash']);
    if (ok) this.authSucceeded(client, username);
    else this.authFailed(client, username);
    return ok;
  }

  /** Removing a member strips every credential but keeps the row, because the
   *  username is not just a login: it is the actor string already written
   *  into card logs and `assignee` across every board. Freeing it for reuse
   *  would silently hand a new person the previous holder's authorship and
   *  claims. The tombstone is disabled, keyless, and demoted to the narrowest
   *  role, so it grants nothing while the name stays spoken for. */
  deleteMember(id: string): { ok: true } | { error: string } {
    const row = this.sql.exec('SELECT username, display, role FROM members WHERE id = ?', id).toArray()[0];
    if (!row) return { error: `no member ${id}` };
    if (row['role'] === 'owner' && this.liveOwners() <= 1) {
      return { error: 'this is the last owner: promote another member first' };
    }
    this.sql.exec('UPDATE member_keys SET revoked = 1 WHERE member_id = ?', id);
    this.endSessionsFor(id);
    this.sql.exec(
      "UPDATE members SET disabled = 1, role = 'read', scope_kind = 'org', scope_id = NULL, pass_hash = '', display = ? WHERE id = ?",
      `${row['display'] as string} (removed)`, id,
    );
    this.basicCache.clear();
    return { ok: true };
  }

  // ---- failed-credential throttle ----

  /** Both counters for one attempt: the client on its own, and the client
   *  paired with the account it is trying. */
  private throttleKeys(client: string, username: string): string[] {
    return [`c:${client}`, `p:${client}:${username}`];
  }

  private attemptRow(key: string, now: number): { fails: number; since: number } | null {
    const row = this.sql.exec('SELECT fails, since FROM auth_attempts WHERE key = ?', key).toArray()[0];
    if (!row) return null;
    const since = new Date(row['since'] as string).getTime();
    if (now - since >= THROTTLE_WINDOW_MS) {
      this.sql.exec('DELETE FROM auth_attempts WHERE key = ?', key);
      return null;
    }
    return { fails: row['fails'] as number, since };
  }

  /** Seconds the caller must wait, or 0 when it may try now. Read-only: the
   *  attempt is only counted once it actually fails. */
  authRetryAfter(client: string, username: string): number {
    const now = Date.now();
    // Opportunistic prune: this table is pure scratch, and nothing else ever
    // sweeps it.
    this.sql.exec('DELETE FROM auth_attempts WHERE since < ?', new Date(now - THROTTLE_WINDOW_MS).toISOString());
    let wait = 0;
    for (const [i, key] of this.throttleKeys(client, username).entries()) {
      const row = this.attemptRow(key, now);
      if (row === null) continue;
      const max = i === 0 ? THROTTLE_CLIENT_MAX : THROTTLE_PAIR_MAX;
      if (row.fails >= max) wait = Math.max(wait, Math.ceil((row.since + THROTTLE_WINDOW_MS - now) / 1000));
    }
    return wait;
  }

  authFailed(client: string, username: string): void {
    const now = new Date().toISOString();
    for (const key of this.throttleKeys(client, username)) {
      this.sql.exec(
        `INSERT INTO auth_attempts(key, fails, since) VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET fails = auth_attempts.fails + 1`,
        key, now,
      );
    }
  }

  /** A credential that works clears the block for that client: a member who
   *  fat-fingered their password a dozen times is not an attacker. */
  authSucceeded(client: string, username: string): void {
    for (const key of this.throttleKeys(client, username)) {
      this.sql.exec('DELETE FROM auth_attempts WHERE key = ?', key);
    }
  }

  // ---- credentials: sessions, api keys, basic auth ----

  private async startSession(memberId: string): Promise<{ token: string; expires: string }> {
    const token = randomToken('bfu');
    const now = Date.now();
    const expires = new Date(now + SESSION_TTL_MS).toISOString();
    this.sql.exec('INSERT INTO sessions(hash, member_id, created, expires) VALUES (?, ?, ?, ?)', await sha256hex(token), memberId, new Date(now).toISOString(), expires);
    this.sql.exec('DELETE FROM sessions WHERE expires < ?', new Date(now).toISOString());
    return { token, expires };
  }

  private endSessionsFor(memberId: string): void {
    this.sql.exec('DELETE FROM sessions WHERE member_id = ?', memberId);
  }

  async login(username: string, password: string, client = 'unknown'): Promise<{ token: string; expires: string } | { error: string; retryAfter?: number }> {
    const wait = this.authRetryAfter(client, username);
    if (wait > 0) return { error: 'too many failed attempts: wait before trying again', retryAfter: wait };
    const row = this.sql.exec('SELECT id, pass_hash, disabled FROM members WHERE username = ?', username).toArray()[0];
    // Derive against a real hash when the user does not exist: an empty
    // string would be rejected before any PBKDF2 work, and the difference is
    // measurable, which turns login into a username oracle.
    const ok = await verifyPassword(password, row ? row['pass_hash'] : await absentPasswordHash());
    if (!row || !ok || row['disabled'] === 1) {
      this.authFailed(client, username);
      return { error: 'wrong username or password' };
    }
    this.authSucceeded(client, username);
    return this.startSession(row['id'] as string);
  }

  async logout(token: string): Promise<{ ok: true }> {
    this.sql.exec('DELETE FROM sessions WHERE hash = ?', await sha256hex(token));
    return { ok: true };
  }

  /** Resolve any credential to an Identity. Returns null for every failure
   *  mode: unknown, revoked, expired, disabled, or wrong password. */
  async verifyCredential(header: string, client = 'unknown'): Promise<Identity | null> {
    if (!this.initialized()) return null;
    if (header.startsWith('Bearer ')) return this.verifyBearer(header.slice(7));
    const basic = parseBasic(header);
    return basic === null ? null : this.verifyBasic(basic.username, basic.password, client);
  }

  private async verifyBearer(token: string): Promise<Identity | null> {
    if (token === '') return null;
    const hash = await sha256hex(token);
    if (token.startsWith('bfu_')) {
      const row = this.sql.exec('SELECT member_id, expires FROM sessions WHERE hash = ?', hash).toArray()[0];
      if (!row) return null;
      if (new Date(row['expires'] as string).getTime() <= Date.now()) {
        this.sql.exec('DELETE FROM sessions WHERE hash = ?', hash);
        return null;
      }
      return this.memberById(row['member_id'] as string);
    }
    const row = this.sql.exec('SELECT id, member_id FROM member_keys WHERE hash = ? AND revoked = 0', hash).toArray()[0];
    if (!row) return null;
    const identity = this.memberById(row['member_id'] as string);
    if (identity !== null) this.sql.exec('UPDATE member_keys SET last_used = ? WHERE id = ?', new Date().toISOString(), row['id'] as string);
    return identity;
  }

  private async verifyBasic(username: string, password: string, client: string): Promise<Identity | null> {
    const cacheKey = await sha256hex(`${username}:${password}`);
    const hit = this.basicCache.get(cacheKey);
    if (hit && hit.until > Date.now()) return this.memberById(hit.memberId);
    if (this.authRetryAfter(client, username) > 0) return null;
    const row = this.sql.exec('SELECT id, pass_hash, disabled FROM members WHERE username = ?', username).toArray()[0];
    // Derive against a real hash even when the account does not exist, so an
    // unknown username costs the same as a wrong password.
    const ok = await verifyPassword(password, row ? row['pass_hash'] : await absentPasswordHash());
    if (!row || !ok || row['disabled'] === 1) {
      this.basicCache.delete(cacheKey);
      this.authFailed(client, username);
      return null;
    }
    const identity = this.memberById(row['id'] as string);
    if (identity !== null) {
      this.authSucceeded(client, username);
      this.basicCache.set(cacheKey, { memberId: row['id'] as string, until: Date.now() + BASIC_CACHE_MS });
    }
    return identity;
  }

  /** Where a project sits, for the pure scope check in security.ts. */
  locate(pid: string): ProjectLocation | null {
    const row = this.sql.exec('SELECT space_id FROM projects WHERE id = ?', pid).toArray()[0];
    if (!row) return null;
    const ancestorIds: string[] = [];
    let cur: string | null = pid;
    for (let hops = 0; cur !== null && hops < 100; hops++) {
      ancestorIds.push(cur);
      const parent: unknown = this.sql.exec('SELECT parent_id FROM projects WHERE id = ?', cur).toArray()[0]?.['parent_id'];
      cur = typeof parent === 'string' ? parent : null;
    }
    return { spaceId: row['space_id'] as string, ancestorIds };
  }

  /** Does this identity reach that project? The decision itself is pure; the
   *  registry only supplies where the project sits. */
  reaches(identity: Identity, pid: string): boolean {
    const at = this.locate(pid);
    return at === null ? false : scopeAllows({ kind: identity.scopeKind, id: identity.scopeId }, at);
  }

  /** Spaces this identity can see, for filtering the org tree. */
  visibleSpaces(identity: Identity): 'all' | Set<string> {
    if (identity.scopeKind === 'org') return 'all';
    if (identity.scopeKind === 'space') return new Set(identity.scopeId === null ? [] : [identity.scopeId]);
    const at = identity.scopeId === null ? null : this.locate(identity.scopeId);
    return new Set(at === null ? [] : [at.spaceId]);
  }

  tree(): OrgTree {
    const orgRow = this.sql.exec('SELECT name FROM org').toArray()[0];
    const name = (orgRow?.['name'] as string | undefined) ?? 'company';
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

  spaceName(id: string): string | null {
    const row = this.sql.exec('SELECT name FROM spaces WHERE id = ?', id).toArray()[0];
    return row ? (row['name'] as string) : null;
  }

  projectName(id: string): string | null {
    const row = this.sql.exec('SELECT name FROM projects WHERE id = ?', id).toArray()[0];
    return row ? (row['name'] as string) : null;
  }

  // ---- api keys: a member's revocable credentials ----

  /** Default label: past both the highest "api key #N" in use and the number
   *  of keys this member has ever held. Taking the max of the two keeps the
   *  name monotonic under revocation (labels survive) and under renaming
   *  (which frees a number that a live key was once known by), so "api key
   *  #1" never comes to mean a different credential than it used to. */
  private nextKeyLabel(memberId: string): string {
    const rows = this.sql.exec('SELECT label FROM member_keys WHERE member_id = ?', memberId).toArray();
    let highest = rows.length;
    for (const row of rows) {
      const m = /^api key #(\d+)$/.exec(row['label'] as string);
      if (m) highest = Math.max(highest, Number(m[1]));
    }
    return `api key #${highest + 1}`;
  }

  async createKey(memberId: string, label?: unknown): Promise<{ id: string; token: string; label: string } | { error: string }> {
    if (this.sql.exec('SELECT 1 FROM members WHERE id = ?', memberId).toArray().length === 0) return { error: `no member ${memberId}` };
    const token = randomToken('bfk');
    const id = `k-${shortId()}`;
    const named = typeof label === 'string' && label.trim() !== '' ? cleanName(label, '') : this.nextKeyLabel(memberId);
    this.sql.exec('INSERT INTO member_keys(id, hash, member_id, label, created) VALUES (?, ?, ?, ?, ?)', id, await sha256hex(token), memberId, named, new Date().toISOString());
    return { id, token, label: named };
  }

  /** Mint a successor and revoke the old credential in one SQLite
   * transaction. The old label carries forward so clients can replace a
   * deployed secret without quietly changing its operator-facing identity. */
  async replaceKey(id: string): Promise<{ id: string; token: string; label: string; replaced: string } | { error: string }> {
    const row = this.sql.exec('SELECT member_id, label, revoked FROM member_keys WHERE id = ?', id).toArray()[0];
    if (!row) return { error: `no key ${id}` };
    if (row['revoked'] === 1) return { error: `key ${id} is already revoked` };
    const token = randomToken('bfk');
    const replacementId = `k-${shortId()}`;
    const hash = await sha256hex(token);
    const created = new Date().toISOString();
    let label: string | null = null;
    this.ctx.storage.transactionSync(() => {
      // A crypto await yields the DO. Re-check under the SQLite transaction
      // so two concurrent replacements cannot both succeed.
      const current = this.sql.exec('SELECT member_id, label, revoked FROM member_keys WHERE id = ?', id).toArray()[0];
      if (!current || current['revoked'] === 1) return;
      label = String(current['label']);
      this.sql.exec(
        'INSERT INTO member_keys(id, hash, member_id, label, created) VALUES (?, ?, ?, ?, ?)',
        replacementId, hash, current['member_id'], label, created,
      );
      this.sql.exec('UPDATE member_keys SET revoked = 1 WHERE id = ?', id);
    });
    if (label === null) return { error: `key ${id} is already revoked` };
    this.basicCache.clear();
    return { id: replacementId, token, label, replaced: id };
  }

  listKeys(memberId: string): { id: string; label: string; created: string; lastUsed: string | null; revoked: boolean }[] {
    return this.sql
      .exec('SELECT id, label, created, last_used, revoked FROM member_keys WHERE member_id = ? ORDER BY created', memberId)
      .toArray()
      .map((r) => ({
        id: r['id'] as string,
        label: r['label'] as string,
        created: r['created'] as string,
        lastUsed: (r['last_used'] as string | null) ?? null,
        revoked: r['revoked'] === 1,
      }));
  }

  /** A key label is a note to self ("laptop", "CI"), not an identity: renaming
   *  one changes nothing on any board. The member's display name does that. */
  renameKey(id: string, label: unknown): { ok: true; label: string } | { error: string } {
    const row = this.sql.exec('SELECT member_id FROM member_keys WHERE id = ?', id).toArray()[0];
    if (!row) return { error: `no key ${id}` };
    const named = cleanName(label, this.nextKeyLabel(row['member_id'] as string));
    this.sql.exec('UPDATE member_keys SET label = ? WHERE id = ?', named, id);
    return { ok: true, label: named };
  }

  /** Which member owns a key, so a non-owner can only touch its own. */
  keyOwner(id: string): string | null {
    const row = this.sql.exec('SELECT member_id FROM member_keys WHERE id = ?', id).toArray()[0];
    return row ? (row['member_id'] as string) : null;
  }

  revokeKey(id: string): { ok: boolean } {
    this.sql.exec('UPDATE member_keys SET revoked = 1 WHERE id = ?', id);
    this.basicCache.clear();
    return { ok: true };
  }
}
