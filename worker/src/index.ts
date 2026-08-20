// botflow manager: Worker entry: auth, REST API, org aggregation, and the
// operator UI. Agents talk REST with scoped keys; humans get the web view.

import { rollupState } from '../../src/core/analyze.ts';
import {
  distributionTotal,
  defaultRollup,
  emptyDistribution,
  fallbackConfig,
  type Canonical,
  type Distribution,
} from '../../src/core/model.ts';
import { resolvePosition } from '../../src/core/ops.ts';
import type { BoardDocument } from '../../src/core/docs.ts';
import { parseCardReference } from '../../src/core/refs.ts';
import { serializeCard } from '../../src/core/write.ts';
import { ProjectDO, validateImportDocuments } from './project.ts';
import { RegistryDO, type Identity, type OrgTree, type ProjectNode, type RestoredMember, type RestoredShare } from './registry.ts';
import { atomFeed, calendarFeed, rssFeed } from './feeds.ts';
import { ABOUT_HTML } from './about.ts';
import { DEMO, type OrgImport, type ProjectImport } from './demo.ts';
import { readIntegrationSnapshot } from './integration-snapshot.ts';
import { roleAllows, setupAccess, validRole, validScopeKind, validStoredPasswordHash, validUsername } from './security.ts';
import { fetchImage, fetchOg } from './unfurl.ts';
import { uiHtml } from './ui.ts';

export { ProjectDO, RegistryDO };

export interface Env {
  REGISTRY: DurableObjectNamespace<RegistryDO>;
  PROJECT: DurableObjectNamespace<ProjectDO>;
  /** Optional: when set (wrangler secret/var), /api/setup requires it, which
   *  closes the fresh-deployment claim race. */
  SETUP_KEY?: string;
  /** Optional R2 bucket: when bound, cards accept binary attachment uploads
   *  served from /files/. Without it everything else works and the UI hides
   *  upload affordances. Bind a bucket as ATTACHMENTS to enable. */
  ATTACHMENTS?: R2Bucket;
  /** Link previews are off unless this is "on". They make the worker fetch
   *  urls that members choose, and while unfurlTarget refuses anything that
   *  is not publicly routable, a hostname can still resolve to a private
   *  address after that check. Cloudflare's edge will not route there; a
   *  self-hosted workerd on a LAN might, so the operator opts in. */
  LINK_PREVIEWS?: string;
  /** Test-only: lets the suite point an unfurl at a loopback fixture server.
   *  Never set on a real deployment. */
  UNFURL_ALLOW_PRIVATE?: string;
  /** Username of the one dedicated bot allowed to lease outbound email.
   * Owners retain a recovery/test path; other write-scoped bots cannot read
   * recipient payloads or acknowledge delivery. */
  EMAIL_BRIDGE_USERNAME?: string;
}

// Uploaded files the browser may render inline; anything else downloads.
// HTML and SVG stay out: same-origin inline markup could script against the
// operator session. The sandbox CSP below is the second lock on that door.
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'application/pdf', 'text/plain']);
const MAX_UPLOAD = 10 * 1024 * 1024;
const MAX_API_JSON = 1024 * 1024;

/** App and share pages carry destructive in-page-confirm owner actions, so
 *  they never load inside a frame (clickjacking). */
const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

/** Every uploaded object's key/size/type: the export's uploads manifest. */
async function listUploadManifest(bucket: R2Bucket): Promise<{ key: string; size: number; contentType: string | null }[]> {
  const out: { key: string; size: number; contentType: string | null }[] = [];
  let cursor: string | undefined;
  for (;;) {
    const batch = await bucket.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const o of batch.objects) out.push({ key: o.key, size: o.size, contentType: o.httpMetadata?.contentType ?? null });
    if (!batch.truncated) return out;
    cursor = batch.cursor;
  }
}

const sha256hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** How many links one project may unfurl in a day. */
const UNFURL_DAILY_CAP = 200;
/** How many to resolve per board read, so a backlog drains over several loads
 *  instead of stalling one. */
const UNFURL_BATCH = 3;

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json',
      'x-content-type-options': 'nosniff',
    },
  });

/** Reads ?limit as an integer in [1, 500]: SQLite treats a negative LIMIT as
 *  unlimited, so clamp the low end as well as the high. */
const limitParam = (value: string | null): number =>
  Math.max(1, Math.min(500, Math.trunc(Number(value ?? 100) || 100)));

/** Pre-read reject on the declared body size. content-length can lie low, so
 *  this only short-circuits; readers keep their real checks after buffering. */
const bodyTooBig = (req: Request, max: number): boolean =>
  Number(req.headers.get('content-length') ?? 0) > max;

class RequestBodyError extends Error {
  readonly status: 400 | 413;
  constructor(message: string, status: 400 | 413) {
    super(message);
    this.name = 'RequestBodyError';
    this.status = status;
  }
}

/** Buffer a request with a real ceiling. A declared length is only an early
 *  reject; chunked bodies are counted while reading. */
async function boundedBody(req: Request, max: number, label: string): Promise<Uint8Array> {
  if (bodyTooBig(req, max)) throw new RequestBodyError(`${label} exceeds ${max} bytes`, 413);
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new RequestBodyError(`${label} exceeds ${max} bytes`, 413);
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { joined.set(c, at); at += c.byteLength; }
  return joined;
}

/** Stream and parse a JSON object with a real ceiling. Empty bodies become
 *  {}, preserving optional-body actions without letting an oversized or
 *  malformed body degrade into an authorized mutation. */
async function smallJson(req: Request, max = 64 * 1024): Promise<Record<string, unknown>> {
  const joined = await boundedBody(req, max, 'JSON body');
  if (joined.byteLength === 0) return {};
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(joined));
    if (!isRecord(parsed)) throw new RequestBodyError('JSON body must be an object', 400);
    return parsed;
  } catch (err) {
    if (err instanceof RequestBodyError) throw err;
    throw new RequestBodyError('invalid JSON body', 400);
  }
}

interface ProjectSummary {
  name: string;
  cards: number;
  distribution: Distribution;
  progress: number | null;
  taskDistribution: Distribution;
  taskUnits: number;
  taskDoneWeight: number;
  errors: number;
}

interface Rollup {
  distribution: Distribution;
  progress: number | null;
  state: Canonical;
}

function addDist(into: Distribution, from: Distribution): void {
  for (const k of Object.keys(into) as (keyof Distribution)[]) into[k] += from[k];
}

function toRollup(dist: Distribution, doneWeight: number, units: number): Rollup {
  const countable = distributionTotal(dist) - dist.archive;
  return {
    distribution: dist,
    progress: units === 0 ? null : doneWeight / units,
    state: countable === 0 ? 'todo' : rollupState(dist, countable, defaultRollup()),
  };
}

/** Aggregate a project subtree: own board + all descendant projects. */
function aggregateNode(
  node: ProjectNode,
  summaries: Map<string, ProjectSummary>,
): { dist: Distribution; units: number; doneWeight: number } {
  const dist = emptyDistribution();
  let units = 0;
  let doneWeight = 0;
  const own = summaries.get(node.id);
  if (own) {
    // task* fields exclude project-ref cards: nested projects are added as
    // their own summaries below, so counting their rolled-up cards here would
    // double-count the same work.
    addDist(dist, own.taskDistribution);
    units += own.taskUnits;
    doneWeight += own.taskDoneWeight;
  }
  for (const child of node.children) {
    const c = aggregateNode(child, summaries);
    addDist(dist, c.dist);
    units += c.units;
    doneWeight += c.doneWeight;
  }
  return { dist, units, doneWeight };
}

function flattenProjects(nodes: ProjectNode[]): string[] {
  return nodes.flatMap((n) => [n.id, ...flattenProjects(n.children)]);
}

/** The org tree as one identity may see it. An org scope gets everything; a
 *  space scope keeps that space whole; a project scope is pruned down to the
 *  branch containing that project, with the project itself as the root, so a
 *  member never learns the names of siblings it cannot open. Aggregates are
 *  then computed over the pruned tree, which is what makes a member's
 *  progress meter describe their own work rather than the whole company. */
async function scopedTree(
  registry: DurableObjectStub<RegistryDO>,
  identity: Identity,
  full: OrgTree,
): Promise<OrgTree> {
  if (identity.scopeKind === 'org') return full;
  if (identity.scopeKind === 'space') {
    return { name: full.name, spaces: full.spaces.filter((sp) => sp.id === identity.scopeId) };
  }
  const target = identity.scopeId;
  if (target === null) return { name: full.name, spaces: [] };
  const find = (nodes: ProjectNode[]): ProjectNode | null => {
    for (const n of nodes) {
      if (n.id === target) return n;
      const hit = find(n.children);
      if (hit !== null) return hit;
    }
    return null;
  };
  for (const sp of full.spaces) {
    const node = find(sp.projects);
    if (node !== null) return { name: full.name, spaces: [{ id: sp.id, name: sp.name, projects: [node] }] };
  }
  return { name: full.name, spaces: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function remapProjectReference(value: string, idMap: ReadonlyMap<string, string>): string {
  const parsed = parseCardReference(value);
  if (parsed === null || parsed.boardRef === null || !parsed.boardRef.startsWith('project:')) return value;
  const restored = idMap.get(parsed.boardRef.slice('project:'.length));
  return restored === undefined ? value : `project:${restored}#${parsed.cardId}`;
}

/** Remap only fields whose schema declares them to be project references.
 * Titles, URLs, comments, descriptions, and logs are ordinary prose; only an
 * explicit `[[project:<id>#<card>]]` token inside body text is rewritten. */
function remapImportDocuments(
  config: string,
  docs: BoardDocument[],
  idMap: ReadonlyMap<string, string>,
): { config: string; docs: BoardDocument[] } | { error: string } {
  const original = validateImportDocuments(config, docs);
  if ('error' in original) return original;
  const remapped = original.board.cards.map((card): BoardDocument => {
    if (card.boardPath?.startsWith('project:')) {
      const restored = idMap.get(card.boardPath.slice('project:'.length));
      if (restored !== undefined) card.boardPath = `project:${restored}`;
    }
    card.deps = card.deps.map((reference) => remapProjectReference(reference, idMap));
    card.relations = card.relations.map((relation) => ({
      ...relation,
      target: remapProjectReference(relation.target, idMap),
      extra: { ...relation.extra },
    }));
    card.body = card.body.replace(/\[\[([^\]\r\n]+)\]\]/g, (whole, inner: string) => {
      const reference = inner.trim();
      const rewritten = remapProjectReference(reference, idMap);
      return rewritten === reference ? whole : whole.replace(reference, rewritten);
    });
    return { path: card.file, text: serializeCard(card) };
  });
  const checked = validateImportDocuments(config, remapped);
  return 'error' in checked ? checked : { config, docs: remapped };
}

/** Validate a company import completely before pass 1 creates any registry
 *  rows. Version 1 remains accepted for old/demo payloads; restore-grade v2+
 *  require stable, unique exported project ids. v3 added members and
 *  re-keyed api keys from a project to a member, so a v2 payload's `keys`
 *  block is structurally different: it is ignored on restore rather than
 *  rejected, because a board backup should still restore its boards. v4 adds
 *  validated per-project integration configuration, never old delivery state;
 *  v5 adds the persisted scoped-admin role. */
function validateOrgImportPayload(value: unknown, allowPrivate = false): string | null {
  if (!isRecord(value) || ![1, 2, 3, 4, 5].includes(value['version'] as number)) return 'version must be 1, 2, 3, 4 or 5';
  if (!Array.isArray(value['spaces'])) return 'spaces required';
  const version = value['version'] as number;
  const ids = new Set<string>();
  const spaceIds = new Set<string>();
  const visit = (node: unknown, ref: string): string | null => {
    if (!isRecord(node)) return `${ref} must be a project object`;
    if (typeof node['name'] !== 'string' || node['name'].trim() === '') return `${ref}.name required`;
    if (node['id'] !== undefined) {
      if (typeof node['id'] !== 'string' || node['id'] === '') return `${ref}.id must be a string`;
      if (ids.has(node['id'])) return `duplicate exported project id: ${node['id']}`;
      ids.add(node['id']);
    } else if (version >= 2) {
      return `${ref}.id required in version ${version}`;
    }
    if (node['lane'] !== undefined && typeof node['lane'] !== 'string') return `${ref}.lane must be a string`;
    let config = fallbackConfig(node['name']);
    if (node['board'] !== undefined) {
      if (!isRecord(node['board'])) return `${ref}.board must be an object`;
      const checked = validateImportDocuments(node['board']['config'], node['board']['cards']);
      if ('error' in checked) return `${ref}.board: ${checked.error}`;
      config = checked.board.config;
    }
    if (version >= 4 && node['integrations'] !== undefined) {
      const integrations = readIntegrationSnapshot(node['integrations'], allowPrivate);
      if (!integrations.ok) return `${ref}.integrations: ${integrations.error}`;
    }
    const children = node['children'] ?? [];
    if (!Array.isArray(children)) return `${ref}.children must be a list`;
    for (let i = 0; i < children.length; i++) {
      if (isRecord(children[i])) {
        const requested = children[i]!['lane'];
        const lane = typeof requested === 'string'
          ? requested
          : (config.lanes.find((l) => l.canonical === 'todo') ?? config.lanes[0])?.id;
        if (!lane) return `${ref}.board has no lane for child projects`;
        try {
          resolvePosition(config, lane);
        } catch (err) {
          return `${ref}.children[${i}].lane: ${(err as Error).message}`;
        }
      }
      const error = visit(children[i], `${ref}.children[${i}]`);
      if (error) return error;
    }
    return null;
  };
  for (let si = 0; si < value['spaces'].length; si++) {
    const space = value['spaces'][si];
    if (!isRecord(space)) return `spaces[${si}] must be an object`;
    if (typeof space['name'] !== 'string' || space['name'].trim() === '') return `spaces[${si}].name required`;
    if (space['id'] !== undefined) {
      if (typeof space['id'] !== 'string' || space['id'] === '') return `spaces[${si}].id must be a string`;
      if (spaceIds.has(space['id'])) return `duplicate exported space id: ${space['id']}`;
      spaceIds.add(space['id']);
    }
    if (!Array.isArray(space['projects'])) return `spaces[${si}].projects must be a list`;
    for (let pi = 0; pi < space['projects'].length; pi++) {
      const error = visit(space['projects'][pi], `spaces[${si}].projects[${pi}]`);
      if (error) return error;
    }
  }
  const usernames = new Set<string>();
  if (version >= 3 && value['members'] !== undefined) {
    if (!Array.isArray(value['members'])) return 'members must be a list';
    for (const m of value['members']) {
      if (version < 5 && isRecord(m) && m['role'] === 'admin') return 'admin role requires version 5';
      if (!isRecord(m) || !validUsername(m['username']) || typeof m['display'] !== 'string' ||
          (m['kind'] !== 'human' && m['kind'] !== 'bot') || !validRole(m['role']) || !validScopeKind(m['scopeKind']) ||
          (m['scopeId'] !== null && typeof m['scopeId'] !== 'string') ||
          !validStoredPasswordHash(m['passHash']) ||
          typeof m['disabled'] !== 'boolean' || typeof m['created'] !== 'string') return 'malformed member metadata';
      if (usernames.has(m['username'])) return `duplicate member username: ${m['username']}`;
      if (m['role'] !== 'owner') {
        if (m['role'] === 'admin' && m['scopeKind'] === 'org') return `member ${m['username']}: admin scope must be a space or project`;
        if (m['scopeKind'] === 'org' && m['scopeId'] !== null) return `member ${m['username']}: org scope must have a null id`;
        if (m['scopeKind'] === 'space' && (typeof m['scopeId'] !== 'string' || !spaceIds.has(m['scopeId']))) {
          return `member ${m['username']}: space scope does not name an exported space`;
        }
        if (m['scopeKind'] === 'project' && (typeof m['scopeId'] !== 'string' || !ids.has(m['scopeId']))) {
          return `member ${m['username']}: project scope does not name an exported project`;
        }
      }
      usernames.add(m['username']);
    }
  }
  // Pre-v3 keys belonged to a project and cannot be re-homed onto a member
  // that never existed, so they are dropped by the restore, not validated.
  if (version >= 3 && value['keys'] !== undefined) {
    if (!Array.isArray(value['keys'])) return 'keys must be a list';
    const hashes = new Set<string>();
    for (const key of value['keys']) {
      if (!isRecord(key) || typeof key['hash'] !== 'string' || !/^[a-f0-9]{64}$/.test(key['hash']) ||
          typeof key['username'] !== 'string' || !usernames.has(key['username']) || typeof key['label'] !== 'string' ||
          typeof key['created'] !== 'string' || typeof key['revoked'] !== 'boolean') return 'malformed key metadata';
      if (hashes.has(key['hash'])) return `duplicate api key hash: ${key['hash']}`;
      hashes.add(key['hash']);
    }
  }
  if (value['shares'] !== undefined) {
    if (!Array.isArray(value['shares'])) return 'shares must be a list';
    const tokens = new Set<string>();
    for (const share of value['shares']) {
      if (!isRecord(share) || typeof share['token'] !== 'string' || !/^[a-f0-9]{16,64}$/.test(share['token']) ||
          typeof share['projectId'] !== 'string' || !ids.has(share['projectId']) || typeof share['label'] !== 'string' ||
          typeof share['created'] !== 'string' || typeof share['revoked'] !== 'boolean' ||
          (share['cardId'] !== undefined && share['cardId'] !== null && typeof share['cardId'] !== 'string') ||
          (share['kind'] !== undefined && share['kind'] !== 'page' && share['kind'] !== 'feed') ||
          (share['memberUsername'] !== undefined && share['memberUsername'] !== null && typeof share['memberUsername'] !== 'string') ||
          (share['laneId'] !== undefined && share['laneId'] !== null && typeof share['laneId'] !== 'string') ||
          (share['filterId'] !== undefined && share['filterId'] !== null && typeof share['filterId'] !== 'string') ||
          (share['lastViewed'] !== undefined && share['lastViewed'] !== null && typeof share['lastViewed'] !== 'string')) return 'malformed share metadata';
      if (tokens.has(share['token'])) return `duplicate share token: ${share['token']}`;
      tokens.add(share['token']);
      if (typeof share['memberUsername'] === 'string' && !usernames.has(share['memberUsername'])) return 'capability names an unknown member';
      if (share['kind'] === 'feed') {
        if (typeof share['memberUsername'] !== 'string') return 'feed capability names an unknown member';
        if ([share['cardId'], share['laneId'], share['filterId']].filter((scope) => typeof scope === 'string' && scope !== '').length > 1) {
          return 'feed capability has more than one scope';
        }
      }
    }
  }
  if (value['theme'] !== undefined && !isRecord(value['theme'])) return 'theme must be an object';
  if (value['prefs'] !== undefined && !isRecord(value['prefs'])) return 'prefs must be an object';
  return null;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    // Who is asking, for the failed-credential throttle. Cloudflare sets
    // cf-connecting-ip itself and it cannot be spoofed; behind another proxy
    // the first x-forwarded-for hop is the best available answer. That header
    // IS spoofable, but the trade runs the safe way: a forged value only buys
    // an attacker a fresh bucket (leaving PBKDF2 as the brake, which is where
    // a deployment with no header at all already stands), while a real proxied
    // client gets a bucket of its own and so cannot be locked out by someone
    // else's flood. Everything collapsing to one bucket is the bad case, not
    // the safe one.
    const client = req.headers.get('cf-connecting-ip')
      ?? ((req.headers.get('x-forwarded-for') ?? '').split(',')[0]!.trim() || 'local');
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName('main'));
    const project = (id: string) => env.PROJECT.get(env.PROJECT.idFromName(id));

    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return new Response(uiHtml(null), { headers: HTML_HEADERS });
      }
      if (req.method === 'GET' && url.pathname === '/about') {
        return new Response(ABOUT_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      const shareMatch = /^\/s\/([a-f0-9]{16,64})$/.exec(url.pathname);
      if (req.method === 'GET' && shareMatch) {
        const share = await registry.resolveShare(shareMatch[1]!);
        return new Response(uiHtml(shareMatch[1]!, share?.cardId ?? null), { headers: HTML_HEADERS });
      }
      const feedMatch = /^\/feeds\/([a-f0-9]{16,64})\.(atom|rss|ics)$/.exec(url.pathname);
      if (req.method === 'GET' && feedMatch) {
        const capability = await registry.resolveShare(feedMatch[1]!, 'feed');
        if (capability === null) return new Response('feed not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        const snapshot = await project(capability.projectId).feedSnapshot({
          cardId: capability.cardId,
          laneId: capability.laneId,
          filterId: capability.filterId,
        }, capability.memberUsername ?? 'feed');
        if ('error' in snapshot) return new Response('feed scope is no longer available\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        const generatedAt = new Date().toISOString();
        const self = `${url.origin}${url.pathname}`;
        const format = feedMatch[2]!;
        const body = format === 'atom'
          ? atomFeed({ ...snapshot, feedUrl: self, generatedAt })
          : format === 'rss'
            ? rssFeed({ ...snapshot, feedUrl: self, generatedAt })
            : calendarFeed({ ...snapshot, generatedAt });
        const contentType = format === 'atom'
          ? 'application/atom+xml; charset=utf-8'
          : format === 'rss'
            ? 'application/rss+xml; charset=utf-8'
            : 'text/calendar; charset=utf-8';
        return new Response(body, {
          headers: {
            'content-type': contentType,
            'cache-control': 'private, max-age=60',
            'x-content-type-options': 'nosniff',
          },
        });
      }
      // Uploaded attachments: the random key segment is the capability, like
      // share tokens; objects render in <img> tags and on public card pages,
      // where auth headers never travel.
      // Preview art, proxied. The browser never talks to the site being
      // previewed, which matters most on a public share page: otherwise every
      // stranger you send a board link to is reported to whoever hosts the
      // image. The hash resolves only against urls already in a project's
      // unfurl cache, so this cannot be used as an open proxy.
      const ogMatch = /^\/og\/([a-f0-9]{64})$/.exec(url.pathname);
      if (req.method === 'GET' && ogMatch) {
        const cached = await caches.default.match(req);
        if (cached) return cached;
        const pid = url.searchParams.get('p') ?? '';
        if (!/^p-[a-z0-9]+$/.test(pid)) return json({ error: 'not found' }, 404);
        // Resolve registry existence before obtaining/calling a project stub:
        // a Durable Object RPC instantiates persistent SQLite storage even
        // when the project id was invented by an anonymous caller.
        if ((await registry.projectName(pid)) === null) return json({ error: 'not found' }, 404);
        const source = await project(pid).unfurlImageFor(ogMatch[1]!);
        if (source === null) return json({ error: 'not found' }, 404);
        const image = await fetchImage(source, env.UNFURL_ALLOW_PRIVATE === 'on');
        if (image === null) return json({ error: 'not found' }, 404);
        const out = new Response(image.body, {
          headers: {
            'content-type': image.type,
            'x-content-type-options': 'nosniff',
            'content-security-policy': 'sandbox',
            'cache-control': 'public, max-age=86400',
          },
        });
        ctx.waitUntil(caches.default.put(req, out.clone()));
        return out;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
        if (!env.ATTACHMENTS) return json({ error: 'uploads are not enabled on this deployment' }, 404);
        const key = decodeURIComponent(url.pathname.slice('/files/'.length));
        if (!/^p-[a-z0-9-]+\/[^/]+\/[a-z0-9]+-[^/]+$/.test(key)) return json({ error: 'not found' }, 404);
        const obj = await env.ATTACHMENTS.get(key);
        if (obj === null) return json({ error: 'not found' }, 404);
        const type = obj.httpMetadata?.contentType ?? 'application/octet-stream';
        const seg = key.slice(key.lastIndexOf('/') + 1);
        const name = seg.slice(seg.indexOf('-') + 1);
        return new Response(obj.body, {
          headers: {
            'content-type': type,
            'x-content-type-options': 'nosniff',
            'content-security-policy': 'sandbox',
            'cache-control': 'private, max-age=3600',
            ...(INLINE_TYPES.has(type) ? {} : { 'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"` }),
          },
        });
      }
      if (!url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);

      // ---- public (no auth): gate listing + shared read-only boards ----
      if (req.method === 'GET' && url.pathname === '/api/public/gate') {
        const status0 = await registry.status();
        // A setup key is only meaningful where setupAccess would demand one.
        // Asking for it on a loopback dev instance that ignores it is just
        // friction, so the form is told which of the two cases it is in.
        const probe = await setupAccess(url.hostname, env.SETUP_KEY, undefined);
        return json({
          shares: status0.initialized ? await registry.listGateShares() : [],
          setup: { needsKey: !probe.ok && probe.status === 403, locked: !probe.ok && probe.status === 503 },
        });
      }
      const pub = /^\/api\/public\/([a-f0-9]{16,64})(\/.*)?$/.exec(url.pathname);
      if (req.method === 'GET' && pub) {
        const share = await registry.resolveShare(pub[1]!);
        if (share === null) return json({ error: 'this link is no longer live' }, 404);
        const rest = pub[2] ?? '/board';
        const stub = project(share.projectId);
        // A card-scoped link is a capability for exactly that card: the rest
        // of the board does not exist through it.
        if (rest === '' || rest === '/board') {
          if (share.cardId !== null) return json({ error: 'this link shares a single card' }, 404);
          return json(await stub.publicBoard(url.searchParams.get('flow') !== '0'));
        }
        const cardMatch = /^\/cards\/([^/]+)(?:\/(activity|comments))?$/.exec(rest);
        if (cardMatch) {
          if (share.cardId !== null && cardMatch[1] !== share.cardId) return json({ error: 'no such card' }, 404);
          if (cardMatch[2] !== undefined) {
            const rawBefore = url.searchParams.get('before');
            const before = rawBefore === null ? null : Number(rawBefore);
            if (before !== null && (!Number.isSafeInteger(before) || before < 1)) return json({ error: 'before must be a positive integer' }, 400);
            const limit = Math.min(100, limitParam(url.searchParams.get('limit')));
            const history = await stub.cardHistory(cardMatch[1]!, cardMatch[2] as 'activity' | 'comments', limit, before);
            if (history === null) return json({ error: 'no such card' }, 404);
            return 'error' in history ? json(history, 400) : json(history);
          }
          const card = await stub.card(cardMatch[1]!, url.searchParams.get('compact') === '1');
          return card === null ? json({ error: 'no such card' }, 404) : json(card);
        }
        return json({ error: 'not found' }, 404);
      }

      // Provider-neutral inbound email. The bridge verifies its provider's
      // signature, then forwards only normalized text to this narrow route
      // capability. A bad project id and a bad token are intentionally
      // indistinguishable.
      const inboundEmail = /^\/api\/email\/inbound\/(p-[a-z0-9-]+)\/(bfmail_[a-f0-9]{64})$/.exec(url.pathname);
      if (req.method === 'POST' && inboundEmail) {
        if ((await registry.projectName(inboundEmail[1]!)) === null) return json({ error: 'email route not found' }, 404);
        const body = await smallJson(req, 128 * 1024);
        if (body === null) return json({ error: 'a normalized email JSON object is required' }, 400);
        const res = await project(inboundEmail[1]!).processInboundEmail(inboundEmail[2]!, body);
        if ('retryAfter' in res) {
          return new Response(JSON.stringify(res, null, 2), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(res.retryAfter) } });
        }
        if ('error' in res) return json(res, res.error === 'email route not found' ? 404 : 400);
        return json(res, 202);
      }

      const status = await registry.status();
      // Theme is public chrome: the gate and share pages paint with it pre-auth.
      if (req.method === 'GET' && url.pathname === '/api/theme') {
        const prefs = await registry.getPrefs();
        return json({ ...(await registry.getTheme()), cardTagLimit: prefs.cardTagLimit });
      }
      if (req.method === 'POST' && url.pathname === '/api/setup') {
        if (status.initialized) return json({ error: 'already initialized' }, 409);
        const body = ((await smallJson(req)) ?? {}) as { name?: string; username?: string; password?: string; setupKey?: string };
        const throttleKey = '__setup_key__';
        const retryAfter = await registry.authRetryAfter(client, throttleKey);
        if (retryAfter > 0) {
          return new Response(JSON.stringify({ error: 'too many failed attempts: wait before trying again', retryAfter }, null, 2), {
            status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(retryAfter) },
          });
        }
        const access = await setupAccess(url.hostname, env.SETUP_KEY, body.setupKey);
        if (!access.ok) {
          await registry.authFailed(client, throttleKey);
          return json({ error: access.error }, access.status);
        }
        await registry.authSucceeded(client, throttleKey);
        const res = await registry.setup(
          typeof body.name === 'string' && body.name !== '' ? body.name : 'company',
          typeof body.username === 'string' ? body.username : '',
          typeof body.password === 'string' ? body.password : '',
        );
        return 'error' in res ? json(res, 409) : json(res);
      }
      // Lost-token recovery rides the same trust anchor as first-run setup:
      // the SETUP_KEY secret (loopback stays zero-config). It mints a fresh
      // admin token and kills the old one; the audit log records it.
      if (req.method === 'POST' && url.pathname === '/api/recover') {
        const body = ((await smallJson(req)) ?? {}) as { username?: string; password?: string; setupKey?: string };
        const throttleKey = '__setup_key__';
        const retryAfter = await registry.authRetryAfter(client, throttleKey);
        if (retryAfter > 0) {
          return new Response(JSON.stringify({ error: 'too many failed attempts: wait before trying again', retryAfter }, null, 2), {
            status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(retryAfter) },
          });
        }
        const access = await setupAccess(url.hostname, env.SETUP_KEY, body.setupKey);
        if (!access.ok) {
          await registry.authFailed(client, throttleKey);
          return json({ error: access.error }, access.status);
        }
        await registry.authSucceeded(client, throttleKey);
        const res = await registry.recover(
          typeof body.username === 'string' ? body.username : '',
          typeof body.password === 'string' ? body.password : '',
        );
        return 'error' in res ? json(res, 409) : json(res);
      }
      // Logging in is public by definition: it is how a credential is obtained.
      if (req.method === 'POST' && url.pathname === '/api/login') {
        if (!status.initialized) return json({ error: 'not initialized: use setup' }, 409);
        const body = ((await smallJson(req)) ?? {}) as { username?: string; password?: string };
        const res = await registry.login(
          typeof body.username === 'string' ? body.username : '',
          typeof body.password === 'string' ? body.password : '',
          client,
        );
        if (!('error' in res)) return json(res);
        return res.retryAfter
          ? new Response(JSON.stringify(res, null, 2), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(res.retryAfter) } })
          : json(res, 401);
      }
      if (!status.initialized) return json({ uninitialized: true }, url.pathname === '/api/org' ? 200 : 403);

      // ---- auth ----
      // One gate, three credential forms: a session bearer (the web UI), an
      // API key bearer (CLI, CI, bots), or basic auth (a bot using its own
      // username and password). All three resolve to the same Identity.
      const header = req.headers.get('authorization') ?? '';
      const identity: Identity | null = header === '' ? null : await registry.verifyCredential(header, client);
      if (identity === null) return json({ error: 'unauthorized' }, 401);
      const actor = identity.username;

      /** Company-level policy: hierarchy, credentials, integrations, public
       *  access, recovery, and emergency overrides. */
      const requireOwner = (): Response | null =>
        roleAllows(identity.role, 'owner') ? null : json({ error: 'owner only' }, 403);
      /** Anything that mutates a board. A read member is a spectator. */
      const requireWrite = (): Response | null =>
        roleAllows(identity.role, 'write') ? null : json({ error: 'your access to this board is read-only' }, 403);
      /** Board workflow policy inside the caller's already-checked scope. */
      const requireAdmin = (): Response | null =>
        roleAllows(identity.role, 'admin') ? null : json({ error: 'admin or owner required to reshape this board' }, 403);

      // Who am I?: lets a bot handed a bare credential discover its own reach.
      if (req.method === 'GET' && url.pathname === '/api/whoami') {
        return json({
          username: identity.username,
          display: identity.display,
          kind: identity.kind,
          role: identity.role,
          scope: { kind: identity.scopeKind, id: identity.scopeId },
          scopeName: identity.scopeId === null
            ? status.name
            : identity.scopeKind === 'project'
              ? await registry.projectName(identity.scopeId)
              : await registry.spaceName(identity.scopeId),
          org: status.name,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
        return json(bearer === '' ? { ok: true } : await registry.logout(bearer));
      }
      // Change my own password. Proving the current one is what stops a
      // borrowed session from locking the real member out of their account.
      if (req.method === 'POST' && url.pathname === '/api/me/password') {
        const body = ((await smallJson(req)) ?? {}) as { current?: string; next?: string };
        if (!(await registry.verifyPasswordFor(identity.memberId, typeof body.current === 'string' ? body.current : '', client))) {
          return json({ error: 'current password is wrong' }, 403);
        }
        const res = await registry.setPassword(identity.memberId, typeof body.next === 'string' ? body.next : '');
        if ('error' in res) return json(res, 400);
        await registry.audit(actor, 'password-change', 'own password changed; other sessions ended');
        // The caller just invalidated its own session along with the rest, so
        // hand back a fresh one. If that somehow fails the password change
        // still stands: say so with a status that means "log in again".
        const fresh = await registry.login(identity.username, body.next as string, client);
        return 'error' in fresh ? json({ error: 'password changed: please log in again' }, 401) : json(fresh);
      }

      // ---- org ----
      // The whole UI bootstraps off this, so it is scope-aware rather than
      // owner-only: a member sees the slice of the company it can reach, plus
      // who it is and the directory needed to render usernames as names.
      if (req.method === 'GET' && url.pathname === '/api/org') {
        const full = await registry.tree();
        const tree = await scopedTree(registry, identity, full);
        const ids = tree.spaces.flatMap((s) => flattenProjects(s.projects));
        const summaries = new Map<string, ProjectSummary>();
        await Promise.all(
          ids.map(async (id) => {
            summaries.set(id, (await project(id).summary()) as unknown as ProjectSummary);
          }),
        );
        const renderNode = (n: ProjectNode): Record<string, unknown> => {
          const agg = aggregateNode(n, summaries);
          return {
            id: n.id,
            name: n.name,
            summary: summaries.get(n.id) ?? null,
            aggregate: toRollup(agg.dist, agg.doneWeight, agg.units),
            children: n.children.map(renderNode),
          };
        };
        const orgDist = emptyDistribution();
        let orgUnits = 0;
        let orgDone = 0;
        const spaces = tree.spaces.map((s) => {
          const sDist = emptyDistribution();
          let sUnits = 0;
          let sDone = 0;
          for (const p of s.projects) {
            const agg = aggregateNode(p, summaries);
            addDist(sDist, agg.dist);
            sUnits += agg.units;
            sDone += agg.doneWeight;
          }
          addDist(orgDist, sDist);
          orgUnits += sUnits;
          orgDone += sDone;
          return { id: s.id, name: s.name, aggregate: toRollup(sDist, sDone, sUnits), projects: s.projects.map(renderNode) };
        });
        return json({
          name: tree.name,
          aggregate: toRollup(orgDist, orgDone, orgUnits),
          spaces,
          uploads: env.ATTACHMENTS !== undefined,
          previews: env.LINK_PREVIEWS === 'on',
          me: {
            username: identity.username,
            display: identity.display,
            kind: identity.kind,
            role: identity.role,
            scope: { kind: identity.scopeKind, id: identity.scopeId },
          },
          directory: await registry.directory(),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/org/name') {
        const denied = requireOwner();
        if (denied) return denied;
        const body = ((await smallJson(req)) ?? {}) as { name?: string };
        if (typeof body.name !== 'string' || body.name.trim() === '') return json({ error: 'name required' }, 400);
        await registry.setOrgName(body.name);
        await registry.audit(actor, 'rename-company', `renamed to "${body.name}"`);
        return json({ name: (await registry.status()).name });
      }
      if (url.pathname === '/api/settings') {
        const denied = requireOwner();
        if (denied) return denied;
        if (req.method === 'GET') return json({ ...(await registry.getTheme()), ...(await registry.getPrefs()) });
        if (req.method === 'POST') {
          const body = await smallJson(req);
          const theme = await registry.setTheme(body as never);
          const prefs = 'gateShares' in body || 'cardTagLimit' in body ? await registry.setPrefs(body) : await registry.getPrefs();
          await registry.audit(actor, 'settings', `style ${theme.style}/${theme.accent} ${theme.density}, mode ${theme.mode}, card tags ${prefs.cardTagLimit}, gate shares ${prefs.gateShares ? 'on' : 'off'}`);
          return json({ ...theme, ...prefs });
        }
      }
      if (url.pathname === '/api/org/export' && req.method === 'GET') {
        const denied = requireOwner();
        if (denied) return denied;
        const tree = await registry.tree();
        const exportNode = async (n: ProjectNode): Promise<Record<string, unknown>> => ({
          id: n.id,
          name: n.name,
          board: await project(n.id).exportDocs(),
          integrations: await project(n.id).exportIntegrations(),
          children: await Promise.all(n.children.map(exportNode)),
        });
        await registry.audit(actor, 'export', 'company export downloaded');
        return json({
          version: 5,
          name: tree.name,
          theme: await registry.getTheme(),
          prefs: await registry.getPrefs(),
          members: await registry.exportMembers(),
          keys: await registry.exportKeys(),
          shares: (await registry.listAllShares()).map((s) => ({
            token: s.token, projectId: s.projectId, label: s.label, created: s.created, revoked: s.revoked,
            ...(s.cardId ? { cardId: s.cardId } : {}),
            ...(s.kind === 'feed' ? { kind: 'feed' as const, memberUsername: s.memberUsername } : {}),
            ...(s.laneId ? { laneId: s.laneId } : {}),
            ...(s.filterId ? { filterId: s.filterId } : {}),
            ...(s.lastViewed ? { lastViewed: s.lastViewed } : {}),
          })),
          // Uploaded binaries stay in R2: the export carries a manifest of
          // them, not the bytes. Back the bucket up separately; a restore
          // into a bucket missing these keys has broken attachment links.
          ...(env.ATTACHMENTS ? { uploads: await listUploadManifest(env.ATTACHMENTS) } : {}),
          // Space ids ride along so a space-scoped member's grant can be
          // remapped onto the restored space rather than dangling.
          spaces: await Promise.all(
            tree.spaces.map(async (s) => ({ id: s.id, name: s.name, projects: await Promise.all(s.projects.map(exportNode)) })),
          ),
        });
      }
      if ((url.pathname === '/api/org/import' && req.method === 'PUT') || (url.pathname === '/api/demo' && req.method === 'POST')) {
        const denied = requireOwner();
        if (denied) return denied;
        const isDemo = url.pathname === '/api/demo';
        if (!isDemo && bodyTooBig(req, MAX_UPLOAD)) return json({ error: 'import exceeds 10 MiB' }, 413);
        const rawPayload: unknown = isDemo ? DEMO : await smallJson(req, MAX_UPLOAD);
        const validationError = validateOrgImportPayload(rawPayload, env.UNFURL_ALLOW_PRIVATE === 'on');
        if (validationError) return json({ error: validationError }, 400);
        const payload = rawPayload as OrgImport;
        const idMap = new Map<string, string>(); // exported id → restored id
        const spaceMap = new Map<string, string>(); // exported space id → restored
        const createdSpaceIds: string[] = [];
        let projects = 0;
        // Pass 1: recreate the tree so every exported id has a new id.
        interface CreatedNode { node: ProjectImport; id: string; children: CreatedNode[] }
        const createTree = async (spaceId: string, parentId: string | null, node: ProjectImport): Promise<CreatedNode> => {
          const created = await registry.createProject(parentId === null ? spaceId : null, parentId, node.name);
          if ('error' in created) throw new Error(created.error);
          projects++;
          if (typeof node.id === 'string') idMap.set(node.id, created.id);
          await project(created.id).ensureInit(node.name);
          const children: CreatedNode[] = [];
          for (const child of node.children ?? []) children.push(await createTree(spaceId, created.id, child));
          return { node, id: created.id, children };
        };
        // Pass 2: import boards with project: refs rewritten to the new ids,
        // then add project cards only for children the board doesn't carry.
        const fillTree = async (created: CreatedNode): Promise<void> => {
          const importedRefs = new Set<string>();
          if (created.node.board) {
            const remapped = remapImportDocuments(created.node.board.config, created.node.board.cards, idMap);
            if ('error' in remapped) throw new Error(remapped.error);
            const checked = validateImportDocuments(remapped.config, remapped.docs);
            if ('error' in checked) throw new Error(checked.error);
            for (const card of checked.board.cards) {
              if (card.type === 'board' && card.boardPath !== null) importedRefs.add(card.boardPath);
            }
            const res = (await project(created.id).importDocs(remapped.config, remapped.docs, actor, true)) as { error?: unknown };
            if (res.error) throw new Error(String(res.error));
          }
          for (const child of created.children) {
            if (!importedRefs.has(`project:${child.id}`)) {
              const added = await project(created.id).addCard(
                { title: child.node.name, type: 'board', boardPath: `project:${child.id}`, lane: child.node.lane },
                actor,
              );
              if ('error' in added) throw new Error(added.error);
            }
            await fillTree(child);
          }
          if (payload.version >= 4 && created.node.integrations !== undefined) {
            const restored = await project(created.id).restoreIntegrations(created.node.integrations);
            if ('error' in restored) throw new Error(`integrations: ${restored.error}`);
          }
        };
        try {
          const stagedRoots: CreatedNode[][] = [];
          for (const space of payload.spaces) {
            const s = await registry.createSpace(space.name);
            createdSpaceIds.push(s.id);
            if (typeof space.id === 'string') spaceMap.set(space.id, s.id);
            const roots: CreatedNode[] = [];
            for (const p of space.projects) roots.push(await createTree(s.id, null, p));
            stagedRoots.push(roots);
          }
          // All ids exist before any document is rewritten, so forward and
          // cross-space references remap just as reliably as backward ones.
          for (const roots of stagedRoots) for (const root of roots) await fillTree(root);
          // Restore-grade metadata: name, theme, prefs, members
          // (password hashes included, or the restore locks its owner out),
          // key hashes (original tokens stay valid), and share links. Members
          // land before keys, which are attached to them by username.
          if (!isDemo) {
            const members: RestoredMember[] = [];
            for (const member of (payload.version as number) >= 3 ? payload.members ?? [] : []) {
              let scopeId: string | null = null;
              const scopeKind = member.role === 'owner' ? 'org' : member.scopeKind as RestoredMember['scopeKind'];
              if (scopeKind !== 'org') {
                if (member.scopeId === null) throw new Error(`member "${member.username}" has no ${scopeKind} scope id`);
                const mapped = scopeKind === 'space' ? spaceMap.get(member.scopeId) : idMap.get(member.scopeId);
                if (mapped === undefined) throw new Error(`member "${member.username}" scope was not restored`);
                scopeId = mapped;
              }
              members.push({
                ...member,
                kind: member.kind as RestoredMember['kind'],
                role: member.role as RestoredMember['role'],
                scopeKind,
                scopeId,
              });
            }
            const shares: RestoredShare[] = [];
            for (const share of payload.shares ?? []) {
              const projectId = idMap.get(share.projectId);
              if (projectId === undefined) throw new Error(`share ${share.token} project was not restored`);
              shares.push({
                token: share.token,
                projectId,
                label: share.label,
                created: share.created,
                revoked: share.revoked,
                cardId: share.cardId ?? null,
                kind: share.kind ?? 'page',
                memberUsername: share.memberUsername ?? null,
                laneId: share.laneId ?? null,
                filterId: share.filterId ?? null,
                lastViewed: share.lastViewed ?? null,
              });
            }
            const keys = (payload.version as number) >= 3 ? payload.keys ?? [] : [];
            // Itemize what the payload brought with it. A company export is a
            // credential bundle: restoring one can overwrite passwords, add
            // api keys, and publish share urls, and "1 space(s)" in the audit
            // log does not tell an operator any of that happened.
            const credentialDetail = payload.version >= 3
              ? `${members.length} member(s): ${members.map((member) => `${member.username}/${member.role}`).join(', ') || 'none'}; ${keys.length} api key(s); ${shares.length} share link(s)${payload.version >= 4 ? '; project integration configuration (delivery state reset)' : ''}`
              : `${shares.length} share link(s)`;
            const legacyKeysDetail = (payload.version as number) < 3 && Array.isArray(payload.keys) && payload.keys.length > 0
              ? `${payload.keys.length} pre-members api key(s) in this v${payload.version} export could not be restored; re-issue them from the member's account`
              : undefined;
            const restored = await registry.restoreCompany({
              ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
              ...(payload.theme ? { theme: payload.theme } : {}),
              ...(payload.prefs ? { prefs: payload.prefs } : {}),
              members,
              keys,
              shares,
              importDetail: `${payload.spaces.length} space(s), ${projects} project(s)`,
              credentialDetail,
              ...(legacyKeysDetail === undefined ? {} : { legacyKeysDetail }),
            }, actor);
            if ('error' in restored) throw new Error(restored.error);
          }
        } catch (err) {
          const message = (err as Error).message;
          let cleanup = 'rollback complete';
          try {
            const rolledBack = await registry.rollbackSpaces(createdSpaceIds);
            const storageCleanup = await Promise.allSettled(rolledBack.ids.map((id) => project(id).destroy()));
            const storageFailures = storageCleanup.filter((result) => result.status === 'rejected').length;
            if (storageFailures > 0) cleanup = `registry rollback complete; ${storageFailures} unreachable storage cleanup failure(s)`;
          } catch (rollbackErr) {
            cleanup = `rollback failed: ${(rollbackErr as Error).message}`;
          }
          await registry.audit(actor, 'import-failed', `${message}; ${cleanup}`);
          return json({ error: message }, 400);
        }
        if (isDemo) await registry.audit(actor, 'demo', `${payload.spaces.length} space(s), ${projects} project(s)`);
        return json({ imported: { spaces: payload.spaces.length, projects } });
      }
      if (req.method === 'POST' && url.pathname === '/api/spaces') {
        const denied = requireOwner();
        if (denied) return denied;
        const body = await smallJson(req) as { name?: string };
        if (!body.name) return json({ error: 'name required' }, 400);
        const created = await registry.createSpace(body.name);
        await registry.audit(actor, 'create-space', `"${body.name}" (${created.id})`);
        return json(created);
      }
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const denied = requireWrite();
        if (denied) return denied;
        const body = await smallJson(req) as { space?: string; parent?: string; name?: string; lane?: string };
        if (!body.name) return json({ error: 'name required' }, 400);
        if (!body.parent) {
          // A root project reshapes the company, exactly like creating the
          // space that holds it, so it carries the same owner bar the UI
          // shows. Decomposing work you already own is the write-level case
          // below.
          const notOwner = requireOwner();
          if (notOwner) return notOwner;
          if (!body.space) return json({ error: 'space or parent required' }, 400);
        } else if (!(await registry.reaches(identity, body.parent))) {
          // A member may decompose its own reach into sub-projects, but may
          // not grow the tree sideways: the parent has to be inside scope.
          return json({ error: 'you can only create sub-projects inside your own scope' }, 403);
        }
        const res = await registry.createProject(body.space ?? null, body.parent ?? null, body.name);
        if ('error' in res) return json(res, 400);
        await registry.audit(actor, 'create-project', `"${body.name}" (${res.id})${body.parent ? ` under ${body.parent}` : ''}`);
        await project(res.id).ensureInit(body.name);
        // Projects can be cards: the sub-project appears as a project card in
        // the parent's board: one nesting mechanism, same as the file spec.
        // If the parent card cannot be created (bad lane, say), the child
        // registry entry must not survive as an orphan: compensate and fail.
        if (body.parent) {
          const cardRes = await project(body.parent).addCard(
            { title: body.name, type: 'board', boardPath: `project:${res.id}`, lane: body.lane },
            actor,
          );
          if ('error' in cardRes) {
            await registry.deleteProjectCascade(res.id, 'system');
            await project(res.id).destroy().catch(() => {});
            return json({ error: `parent board rejected the project card: ${cardRes.error}` }, 400);
          }
        }
        return json(res);
      }
      // ---- api keys: a member's own credentials; owners may manage anyone's ----
      /** Whose keys is this request about? Defaults to the caller. */
      const keySubject = async (): Promise<string | Response> => {
        const wanted = url.searchParams.get('member');
        if (wanted === null || wanted === identity.memberId) return identity.memberId;
        const denied = requireOwner();
        return denied ?? wanted;
      };
      if (url.pathname === '/api/keys') {
        const subject = await keySubject();
        if (subject instanceof Response) return subject;
        if (req.method === 'GET') return json(await registry.listKeys(subject));
        if (req.method === 'POST') {
          const body = await smallJson(req) as { label?: unknown };
          const res = await registry.createKey(subject, body.label);
          if ('error' in res) return json(res, 400);
          await registry.audit(actor, 'create-key', `"${res.label}"${subject === identity.memberId ? '' : ` for ${subject}`}`);
          return json(res);
        }
      }
      const keyOne = /^\/api\/keys\/([^/]+)(?:\/(revoke|replace))?$/.exec(url.pathname);
      if (keyOne && (req.method === 'POST' || req.method === 'PATCH')) {
        const kid = keyOne[1]!;
        const owner = await registry.keyOwner(kid);
        if (owner === null) return json({ error: `no key ${kid}` }, 404);
        if (owner !== identity.memberId) {
          const denied = requireOwner();
          if (denied) return denied;
        }
        if (req.method === 'POST' && keyOne[2] === 'revoke') {
          const res = await registry.revokeKey(kid);
          await registry.audit(actor, 'revoke-key', kid);
          return json(res);
        }
        if (req.method === 'POST' && keyOne[2] === 'replace') {
          const res = await registry.replaceKey(kid);
          if ('error' in res) return json(res, 400);
          await registry.audit(actor, 'replace-key', `${kid} → ${res.id}`);
          return json(res);
        }
        if (req.method === 'PATCH' && keyOne[2] === undefined) {
          const body = await smallJson(req) as { label?: unknown };
          const res = await registry.renameKey(kid, body.label);
          if ('error' in res) return json(res, 400);
          await registry.audit(actor, 'rename-key', `${kid} is now "${res.label}"`);
          return json(res);
        }
      }

      // ---- members: the directory owners administer ----
      if (url.pathname === '/api/members') {
        const denied = requireOwner();
        if (denied) return denied;
        if (req.method === 'GET') return json(await registry.listMembers());
        if (req.method === 'POST') {
          const body = (await smallJson(req)) ?? {};
          const res = await registry.createMember(body);
          if ('error' in res) return json(res, 400);
          await registry.audit(actor, 'create-member', `"${String(body['username'])}" (${String(body['role'])} on ${String(body['scopeKind'])})`);
          return json(res);
        }
      }
      const memberOne = /^\/api\/members\/([^/]+)(\/password)?$/.exec(url.pathname);
      if (memberOne) {
        const denied = requireOwner();
        if (denied) return denied;
        const mid = memberOne[1]!;
        if (memberOne[2] === '/password' && req.method === 'POST') {
          const body = ((await smallJson(req)) ?? {}) as { password?: string };
          const res = await registry.setPassword(mid, typeof body.password === 'string' ? body.password : '');
          if ('error' in res) return json(res, 400);
          await registry.audit(actor, 'set-password', `password reset for ${mid}`);
          return json(res);
        }
        if (memberOne[2] === undefined && req.method === 'PATCH') {
          const body = (await smallJson(req)) ?? {};
          const res = await registry.updateMember(mid, body);
          if ('error' in res) return json(res, 400);
          await registry.audit(actor, 'update-member', `${mid}: ${Object.keys(body).join(', ')}`);
          return json(res);
        }
        if (memberOne[2] === undefined && req.method === 'DELETE') {
          if (mid === identity.memberId) return json({ error: 'you cannot delete your own account' }, 400);
          const res = await registry.deleteMember(mid);
          if ('error' in res) return json(res, 400);
          await registry.audit(actor, 'delete-member', mid);
          return json(res);
        }
      }
      const shareRevoke = /^\/api\/shares\/([^/]+)\/revoke$/.exec(url.pathname);
      if (req.method === 'POST' && shareRevoke) {
        const denied = requireOwner();
        if (denied) return denied;
        const res = await registry.revokeShare(shareRevoke[1]!);
        await registry.audit(actor, 'revoke-share', shareRevoke[1]!);
        return json(res);
      }
      const shareDelete = /^\/api\/shares\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && shareDelete) {
        const denied = requireOwner();
        if (denied) return denied;
        const res = await registry.deleteShare(shareDelete[1]!);
        await registry.audit(actor, 'delete-share', shareDelete[1]!);
        return json(res);
      }
      const feedRevoke = /^\/api\/feeds\/([^/]+)\/revoke$/.exec(url.pathname);
      if (req.method === 'POST' && feedRevoke) {
        const res = await registry.revokeOwnFeed(feedRevoke[1]!, identity.memberId);
        if ('error' in res) return json(res, 404);
        await registry.audit(actor, 'revoke-feed', feedRevoke[1]!);
        return json(res);
      }
      const feedDelete = /^\/api\/feeds\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && feedDelete) {
        const res = await registry.deleteOwnFeed(feedDelete[1]!, identity.memberId);
        if ('error' in res) return json(res, 404);
        await registry.audit(actor, 'delete-feed', feedDelete[1]!);
        return json(res);
      }
      if (req.method === 'GET' && url.pathname === '/api/org/shares') {
        const denied = requireOwner();
        if (denied) return denied;
        return json(await registry.listAllShares());
      }
      // Hard deletion. RegistryDO resolves the subtree, cuts auth/tree rows,
      // and appends the audit event in one transaction. Cross-DO storage/card
      // cleanup is necessarily best effort; failures are reported and audited,
      // while deleted registry ids remain unreachable.
      const purgeUploads = async (projectId: string): Promise<void> => {
        if (!env.ATTACHMENTS) return;
        for (;;) {
          const batch = await env.ATTACHMENTS.list({ prefix: `${projectId}/`, limit: 1000 });
          if (batch.objects.length === 0) return;
          await Promise.all(batch.objects.map((o) => env.ATTACHMENTS!.delete(o.key)));
          if (!batch.truncated) return;
        }
      };
      const finishDeleteCleanup = async (pid: string, ids: string[], parent: string | null): Promise<number> => {
        const jobs: (() => Promise<unknown>)[] = ids.flatMap((id) => [() => project(id).destroy(), () => purgeUploads(id)]);
        if (parent !== null) jobs.push(() => project(parent).removeCardsByRef(`project:${pid}`, actor));
        const first = await Promise.allSettled(jobs.map((job) => job()));
        const retry = jobs.filter((_, i) => first[i]?.status === 'rejected');
        const second = await Promise.allSettled(retry.map((job) => job()));
        const failures = second.filter((r) => r.status === 'rejected').length;
        if (failures > 0) await registry.audit('system', 'delete-cleanup-failed', `${pid}: ${failures} cleanup operation(s)`);
        return failures;
      };
      const spaceDelete = /^\/api\/spaces\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && spaceDelete) {
        const denied = requireOwner();
        if (denied) return denied;
        const sid = spaceDelete[1]!;
        const removed = await registry.deleteSpaceCascade(sid, actor);
        if ('error' in removed) return json(removed, 404);
        const cleanupFailures = await finishDeleteCleanup(sid, removed.ids, null);
        return json({ deleted: { space: sid, projects: removed.ids.length }, cleanupFailures });
      }
      if (req.method === 'GET' && url.pathname === '/api/org/activity') {
        const denied = requireOwner();
        if (denied) return denied;
        // Audit sequence numbers only grow, so an exclusive cursor avoids the
        // skips and duplicates that OFFSET pagination gets when new activity
        // arrives while somebody is looking through older pages.
        const rawBefore = url.searchParams.get('before');
        const before = rawBefore === null ? null : Number(rawBefore);
        if (before !== null && (!Number.isSafeInteger(before) || before < 1)) {
          return json({ error: 'before must be a positive integer' }, 400);
        }
        const limit = Math.min(100, limitParam(url.searchParams.get('limit')));
        return json(await registry.listAudit(limit, before));
      }

      // ---- project routes ----
      const match = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (!match) return json({ error: 'not found' }, 404);
      const pid = match[1]!;
      const rest = match[2] ?? '';
      if ((await registry.projectName(pid)) === null) return json({ error: 'project not found' }, 404);
      // A member reaches whatever its scope covers: the whole company, one
      // space, or one project and everything nested beneath it.
      if (!(await registry.reaches(identity, pid))) return json({ error: 'project not found' }, 404);
      const stub = project(pid);

      if (req.method === 'DELETE' && (rest === '' || rest === '/')) {
        const denied = requireOwner();
        if (denied) return denied;
        const removed = await registry.deleteProjectCascade(pid, actor);
        if ('error' in removed) return json(removed, 404);
        const cleanupFailures = await finishDeleteCleanup(pid, removed.ids, removed.parent);
        return json({ deleted: { project: pid, projects: removed.ids.length }, cleanupFailures });
      }
      /** Resolve a few of this project's un-previewed links, after the response. */
      const drainUnfurls = (): void => {
        if (env.LINK_PREVIEWS !== 'on') return;
        ctx.waitUntil((async () => {
          try {
            if ((await stub.unfurlsToday()) >= UNFURL_DAILY_CAP) return;
            const allowPrivate = env.UNFURL_ALLOW_PRIVATE === 'on';
            for (const link of await stub.pendingUnfurls(UNFURL_BATCH)) {
              const og = await fetchOg(link, allowPrivate);
              await stub.saveUnfurl(link, og, og?.image ? await sha256hex(og.image) : null);
            }
          } catch {
            // A preview is decoration: never let one break the request that
            // happened to trigger it.
          }
        })());
      };
      if (req.method === 'GET' && (rest === '' || rest === '/board')) {
        const body = await stub.board(url.searchParams.get('flow') !== '0');
        drainUnfurls();
        return json(body);
      }
      if (req.method === 'GET' && rest === '/config') return json(await stub.boardConfig());
      if (req.method === 'PUT' && rest === '/config') {
        // Board shape is workflow policy: admins reshape it, agents work it.
        const denied = requireAdmin();
        if (denied) return denied;
        const body = await smallJson(req, MAX_API_JSON);
        const res = await stub.editBoardConfig(body, actor);
        if (!('error' in res)) await registry.audit(actor, 'board-edit', `reshaped board of ${pid}`);
        return 'error' in res ? json(res, 400) : json(res);
      }
      if (req.method === 'GET' && rest === '/export') return json(await stub.exportDocs());
      if (req.method === 'PUT' && rest === '/import') {
        const denied = requireWrite();
        if (denied) return denied;
        const body = await smallJson(req, MAX_UPLOAD) as { config?: string; cards?: BoardDocument[]; actor?: string };
        if (typeof body.config !== 'string' || !Array.isArray(body.cards)) return json({ error: 'config and cards required' }, 400);
        const res = await stub.importDocs(body.config, body.cards, actor, roleAllows(identity.role, 'admin'));
        if ('error' in res) return json(res, res['forbidden'] === true ? 403 : 400);
        if (res['configChanged'] === true) await registry.audit(actor, 'board-edit', `snapshot reshaped board of ${pid}`);
        drainUnfurls();
        return json(res);
      }
      if (req.method === 'GET' && rest === '/events') {
        const rawBefore = url.searchParams.get('before');
        const before = rawBefore === null ? null : Number(rawBefore);
        if (before !== null && (!Number.isSafeInteger(before) || before < 1)) return json({ error: 'before must be a positive integer' }, 400);
        const limit = Math.min(100, limitParam(url.searchParams.get('limit')));
        return json(await stub.listEvents(limit, before));
      }
      if (rest === '/webhooks') {
        const denied = requireOwner();
        if (denied) return denied;
        if (req.method === 'GET') return json(await stub.listWebhooks());
        if (req.method === 'POST') {
          const body = await smallJson(req);
          if (body === null) return json({ error: 'a small JSON object is required' }, 400);
          const res = await stub.createWebhook(body);
          if ('error' in res) return json(res, 400);
          const created = res['webhook'] as { id?: unknown; name?: unknown } | undefined;
          await registry.audit(actor, 'create-webhook', `${pid}/${String(created?.id ?? '')} "${String(created?.name ?? '')}"`);
          return json(res);
        }
      }
      const webhookOne = /^\/webhooks\/([^/]+)$/.exec(rest);
      if (req.method === 'DELETE' && webhookOne) {
        const denied = requireOwner();
        if (denied) return denied;
        const res = await stub.revokeWebhook(webhookOne[1]!);
        if ('error' in res) return json(res, 404);
        await registry.audit(actor, 'revoke-webhook', `${pid}/${webhookOne[1]}`);
        return json(res);
      }
      const webhookRotate = /^\/webhooks\/([^/]+)\/rotate$/.exec(rest);
      if (req.method === 'POST' && webhookRotate) {
        const denied = requireOwner();
        if (denied) return denied;
        const res = await stub.rotateWebhook(webhookRotate[1]!);
        if ('error' in res) return json(res, 404);
        await registry.audit(actor, 'rotate-webhook', `${pid}/${webhookRotate[1]}`);
        return json(res);
      }
      const webhookDeliveries = /^\/webhooks\/([^/]+)\/deliveries$/.exec(rest);
      if (req.method === 'GET' && webhookDeliveries) {
        const denied = requireOwner();
        if (denied) return denied;
        const rawBefore = url.searchParams.get('before');
        const before = rawBefore === null ? null : Number(rawBefore);
        if (before !== null && (!Number.isSafeInteger(before) || before < 1)) return json({ error: 'before must be a positive integer' }, 400);
        const limit = Math.min(100, limitParam(url.searchParams.get('limit')));
        const res = await stub.listWebhookDeliveries(webhookDeliveries[1]!, limit, before);
        return 'error' in res ? json(res, 404) : json(res);
      }
      const webhookReplay = /^\/webhooks\/([^/]+)\/deliveries\/([^/]+)\/replay$/.exec(rest);
      if (req.method === 'POST' && webhookReplay) {
        const denied = requireOwner();
        if (denied) return denied;
        const res = await stub.replayWebhookDelivery(webhookReplay[1]!, webhookReplay[2]!);
        if ('error' in res) return json(res, 404);
        await registry.audit(actor, 'replay-webhook', `${pid}/${webhookReplay[1]}/${webhookReplay[2]}`);
        return json(res);
      }
      if (rest === '/email/routes') {
        const denied = requireOwner();
        if (denied) return denied;
        if (req.method === 'GET') return json(await stub.listEmailRoutes());
        if (req.method === 'POST') {
          const body = await smallJson(req);
          if (body === null) return json({ error: 'a small JSON object is required' }, 400);
          const res = await stub.createEmailRoute(body, actor);
          if ('error' in res) return json(res, 400);
          const created = res['route'] as { id?: unknown; kind?: unknown } | undefined;
          await registry.audit(actor, 'create-email-route', `${pid}/${String(created?.id ?? '')} ${String(created?.kind ?? '')}`);
          return json(res);
        }
      }
      const emailRouteOne = /^\/email\/routes\/([^/]+)$/.exec(rest);
      if (req.method === 'DELETE' && emailRouteOne) {
        const denied = requireOwner();
        if (denied) return denied;
        const res = await stub.revokeEmailRoute(emailRouteOne[1]!);
        if ('error' in res) return json(res, 404);
        await registry.audit(actor, 'revoke-email-route', `${pid}/${emailRouteOne[1]}`);
        return json(res);
      }
      if (rest === '/email/subscriptions') {
        const denied = requireOwner();
        if (denied) return denied;
        if (req.method === 'GET') return json(await stub.listEmailSubscriptions());
        if (req.method === 'POST') {
          const body = await smallJson(req);
          if (body === null) return json({ error: 'a small JSON object is required' }, 400);
          const res = await stub.createEmailSubscription(body);
          if ('error' in res) return json(res, 400);
          const created = res['subscription'] as { id?: unknown } | undefined;
          await registry.audit(actor, 'create-email-subscription', `${pid}/${String(created?.id ?? '')}`);
          return json(res);
        }
      }
      const emailSubscriptionOne = /^\/email\/subscriptions\/([^/]+)$/.exec(rest);
      if (req.method === 'DELETE' && emailSubscriptionOne) {
        const denied = requireOwner();
        if (denied) return denied;
        const res = await stub.revokeEmailSubscription(emailSubscriptionOne[1]!);
        if ('error' in res) return json(res, 404);
        await registry.audit(actor, 'revoke-email-subscription', `${pid}/${emailSubscriptionOne[1]}`);
        return json(res);
      }
      if (req.method === 'GET' && rest === '/email/outbox') {
        const denied = requireOwner();
        if (denied) return denied;
        const rawBefore = url.searchParams.get('before');
        const before = rawBefore === null ? null : Number(rawBefore);
        if (before !== null && (!Number.isSafeInteger(before) || before < 1)) return json({ error: 'before must be a positive integer' }, 400);
        const limit = Math.min(100, limitParam(url.searchParams.get('limit')));
        const subscription = url.searchParams.get('subscription');
        return json(await stub.listEmailOutbox(limit, before, subscription === null || subscription === '' ? null : subscription));
      }
      const emailBridgeDenied = (): Response | null => {
        const denied = requireWrite();
        if (denied) return denied;
        if (roleAllows(identity.role, 'owner')) return null;
        const bridge = env.EMAIL_BRIDGE_USERNAME?.trim() ?? '';
        return identity.kind === 'bot' && bridge !== '' && identity.username === bridge
          ? null
          : json({ error: 'email outbox delivery requires the configured bridge bot or an owner' }, 403);
      };
      if (req.method === 'POST' && rest === '/email/outbox/claim') {
        const denied = emailBridgeDenied();
        if (denied) return denied;
        const body = (await smallJson(req)) ?? {};
        const limit = body['limit'] === undefined ? 10 : Number(body['limit']);
        if (!Number.isInteger(limit) || limit < 1) return json({ error: 'limit must be a positive integer' }, 400);
        return json(await stub.claimEmailOutbox(limit, actor));
      }
      const emailOutboxAck = /^\/email\/outbox\/([^/]+)\/ack$/.exec(rest);
      if (req.method === 'POST' && emailOutboxAck) {
        const denied = emailBridgeDenied();
        if (denied) return denied;
        const body = await smallJson(req);
        if (body === null) return json({ error: 'a small JSON object is required' }, 400);
        const res = await stub.acknowledgeEmailOutbox(emailOutboxAck[1]!, body);
        return 'error' in res ? json(res, 'conflict' in res ? 409 : 400) : json(res);
      }
      if (req.method === 'GET' && rest === '/search') {
        const saved = url.searchParams.get('saved');
        let query = url.searchParams.get('q') ?? '';
        if (saved !== null) {
          if (url.searchParams.has('q')) return json({ error: 'use q or saved, not both' }, 400);
          const config = await stub.boardConfig() as { filters?: { id: string; query: string }[] };
          const filter = config.filters?.find((candidate) => candidate.id === saved);
          if (filter === undefined) return json({ error: `no saved filter "${saved}"` }, 404);
          query = filter.query;
        }
        if (query.length > 4_000) return json({ error: 'query exceeds 4000 characters' }, 400);
        const res = await stub.search(query, actor);
        return 'error' in res ? json(res, 400) : json(res);
      }
      if (req.method === 'POST' && rest === '/automate') {
        const denied = requireWrite();
        if (denied) return denied;
        return json(await stub.automate());
      }
      const buttonRun = /^\/buttons\/([a-z0-9][a-z0-9-]*)$/.exec(rest);
      if (req.method === 'POST' && buttonRun) {
        const denied = requireWrite();
        if (denied) return denied;
        const body = await smallJson(req, MAX_API_JSON);
        if (body['card'] !== undefined && body['card'] !== null && typeof body['card'] !== 'string') {
          return json({ error: 'card must be a string or null' }, 400);
        }
        if (body['wipReason'] !== undefined && typeof body['wipReason'] !== 'string') {
          return json({ error: 'wipReason must be a string' }, 400);
        }
        if (body['force'] !== undefined && typeof body['force'] !== 'boolean') {
          return json({ error: 'force must be a boolean' }, 400);
        }
        if (body['force'] === true) {
          const ownerOnly = requireOwner();
          if (ownerOnly) return json({ error: 'force is an owner override' }, 403);
          await registry.audit(actor, 'force-override', `button ${buttonRun[1]} on ${pid}`);
        }
        const res = await stub.runButton(
          buttonRun[1]!,
          typeof body['card'] === 'string' && body['card'] !== '' ? body['card'] : null,
          body,
          actor,
        );
        return 'error' in res ? json(res, 400) : json(res);
      }
      if (rest === '/filters') {
        if (req.method === 'GET') {
          const config = await stub.boardConfig() as { filters?: unknown[] };
          return json(config.filters ?? []);
        }
        if (req.method === 'POST') {
          const denied = requireWrite();
          if (denied) return denied;
          const body = await smallJson(req) as { id?: unknown; name?: unknown; query?: unknown };
          if (body === null || typeof body.id !== 'string' || typeof body.query !== 'string') return json({ error: 'id and query strings required' }, 400);
          if (body.name !== undefined && typeof body.name !== 'string') return json({ error: 'name must be a string' }, 400);
          const res = await stub.saveFilter(body.id, body.query, typeof body.name === 'string' ? body.name : null, actor);
          return 'error' in res ? json(res, 400) : json(res);
        }
      }
      const filterDelete = /^\/filters\/([a-z0-9][a-z0-9-]*)$/.exec(rest);
      if (req.method === 'DELETE' && filterDelete) {
        const denied = requireWrite();
        if (denied) return denied;
        const res = await stub.removeFilter(filterDelete[1]!, actor);
        return 'error' in res ? json(res, 404) : json(res);
      }
      const laneSubscribe = /^\/lanes\/([a-z0-9][a-z0-9-]*)\/subscribe$/.exec(rest);
      if (req.method === 'POST' && laneSubscribe) {
        const denied = requireWrite();
        if (denied) return denied;
        const body = await smallJson(req) as { active?: unknown };
        if (body.active !== undefined && typeof body.active !== 'boolean') return json({ error: 'active must be a boolean' }, 400);
        const res = await stub.subscribeLane(laneSubscribe[1]!, actor, body.active !== false);
        return 'error' in res ? json(res, 400) : json(res);
      }
      if (rest === '/shares') {
        const denied = requireOwner();
        if (denied) return denied;
        if (req.method === 'GET') return json(await registry.listShares(pid));
        if (req.method === 'POST') {
          const body = await smallJson(req) as { label?: string; card?: string };
          let cardId: string | null = null;
          if (typeof body.card === 'string' && body.card !== '') {
            if ((await stub.card(body.card)) === null) return json({ error: `no card ${body.card}` }, 400);
            cardId = body.card;
          }
          const res = await registry.createShare(pid, body.label ?? 'public link', cardId);
          if (!('error' in res)) {
            await registry.audit(actor, 'create-share', `"${body.label ?? 'public link'}" for ${pid}${cardId ? ` (card ${cardId})` : ''}`);
          }
          return 'error' in res ? json(res, 400) : json(res);
        }
      }
      if (rest === '/feeds') {
        if (req.method === 'GET') return json(await registry.listFeeds(pid, identity.memberId));
        if (req.method === 'POST') {
          const body = await smallJson(req) as { label?: unknown; card?: unknown; lane?: unknown; filter?: unknown };
          for (const field of ['label', 'card', 'lane', 'filter'] as const) {
            if (body[field] !== undefined && typeof body[field] !== 'string') return json({ error: `${field} must be a string` }, 400);
          }
          const cardId = typeof body.card === 'string' && body.card !== '' ? body.card : null;
          const laneId = typeof body.lane === 'string' && body.lane !== '' ? body.lane : null;
          const filterId = typeof body.filter === 'string' && body.filter !== '' ? body.filter : null;
          if ([cardId, laneId, filterId].filter((value) => value !== null).length > 1) return json({ error: 'choose only one card, lane, or saved filter scope' }, 400);
          if (cardId !== null && (await stub.card(cardId)) === null) return json({ error: `no card ${cardId}` }, 400);
          if (laneId !== null || filterId !== null) {
            const config = await stub.boardConfig() as { lanes?: { id: string }[]; filters?: { id: string }[] };
            if (laneId !== null && !config.lanes?.some((lane) => lane.id === laneId)) return json({ error: `no lane ${laneId}` }, 400);
            if (filterId !== null && !config.filters?.some((filter) => filter.id === filterId)) return json({ error: `no saved filter ${filterId}` }, 400);
          }
          const res = await registry.createFeed(pid, identity.memberId, typeof body.label === 'string' ? body.label : 'activity feed', cardId, laneId, filterId);
          if ('error' in res) return json(res, 400);
          await registry.audit(actor, 'create-feed', `${pid}${cardId ? ` card ${cardId}` : laneId ? ` lane ${laneId}` : filterId ? ` filter ${filterId}` : ''}`);
          return json({
            ...res,
            atom: `${url.origin}/feeds/${res.token}.atom`,
            rss: `${url.origin}/feeds/${res.token}.rss`,
            ical: `${url.origin}/feeds/${res.token}.ics`,
          });
        }
      }
      if (req.method === 'POST' && rest === '/cards') {
        const denied = requireWrite();
        if (denied) return denied;
        const body = await smallJson(req, MAX_API_JSON);
        if (typeof body['title'] !== 'string' || body['title'] === '') return json({ error: 'title required' }, 400);
        // A list field that is not a list is a client bug, and silently
        // dropping it looks exactly like success. Say so instead.
        for (const field of ['labels', 'deps', 'reminders']) {
          if (body[field] !== undefined && !Array.isArray(body[field])) return json({ error: `${field} must be a list` }, 400);
        }
        if (Array.isArray(body['reminders']) && !body['reminders'].every((value) => typeof value === 'number' && Number.isInteger(value))) {
          return json({ error: 'reminders must contain integer minute offsets' }, 400);
        }
        for (const field of ['template', 'lane', 'priority', 'assignee', 'delegate', 'start', 'due', 'snooze', 'cover_color', 'wipReason']) {
          if (body[field] !== undefined && typeof body[field] !== 'string') return json({ error: `${field} must be a string` }, 400);
        }
        if (body['repeat'] !== undefined && (body['repeat'] === null || typeof body['repeat'] !== 'object' || Array.isArray(body['repeat']))) {
          return json({ error: 'repeat must be an object' }, 400);
        }
        if (body['estimate'] !== undefined && typeof body['estimate'] !== 'number') return json({ error: 'estimate must be a number' }, 400);
        if (body['hill'] !== undefined && typeof body['hill'] !== 'number') return json({ error: 'hill must be a number' }, 400);
        if (body['evergreen'] !== undefined && typeof body['evergreen'] !== 'boolean') return json({ error: 'evergreen must be a boolean' }, 400);
        if (body['force'] !== undefined && typeof body['force'] !== 'boolean') return json({ error: 'force must be a boolean' }, 400);
        if (body['fields'] !== undefined && (body['fields'] === null || typeof body['fields'] !== 'object' || Array.isArray(body['fields']))) {
          return json({ error: 'fields must be an object' }, 400);
        }
        if (body['force'] === true) {
          const ownerOnly = requireOwner();
          if (ownerOnly) return json({ error: 'force is an owner override' }, 403);
          await registry.audit(actor, 'force-override', `add card on ${pid}`);
        }
        if (Array.isArray(body['deps'])) {
          const refs = await stub.validateReferenceChanges({ deps: (body['deps'] as unknown[]).map(String) });
          if ('error' in refs) return json(refs, 400);
        }
        // project: refs must point at projects nested beneath this board; the
        // DO enforces this at resolution time too, this is the friendly error.
        if (typeof body['board'] === 'string' && body['board'].startsWith('project:')) {
          const ref = (body['board'] as string).slice('project:'.length);
          if (ref === pid || (await registry.projectName(ref)) === null || !(await registry.isWithin(ref, pid))) {
            return json({ error: 'a project card may only reference a project nested beneath this board' }, 400);
          }
        }
        const res = await stub.addCard(
          {
            title: body['title'] as string,
            template: typeof body['template'] === 'string' ? (body['template'] as string) : undefined,
            lane: typeof body['lane'] === 'string' ? (body['lane'] as string) : undefined,
            type: body['type'] === 'board' ? 'board' : 'task',
            boardPath: typeof body['board'] === 'string' ? (body['board'] as string) : undefined,
            labels: Array.isArray(body['labels']) ? (body['labels'] as unknown[]).map(String) : undefined,
            priority: typeof body['priority'] === 'string' ? (body['priority'] as string) : undefined,
            deps: Array.isArray(body['deps']) ? (body['deps'] as unknown[]).map(String) : undefined,
            assignee: typeof body['assignee'] === 'string' ? (body['assignee'] as string) : undefined,
            delegate: typeof body['delegate'] === 'string' ? (body['delegate'] as string) : undefined,
            start: typeof body['start'] === 'string' ? (body['start'] as string) : undefined,
            due: typeof body['due'] === 'string' ? (body['due'] as string) : undefined,
            reminders: Array.isArray(body['reminders']) ? body['reminders'] as number[] : undefined,
            repeat: isRecord(body['repeat']) ? {
              every: Number(body['repeat']['every']),
              unit: String(body['repeat']['unit']) as 'day' | 'week' | 'month',
              from: String(body['repeat']['from'] ?? 'due') as 'due' | 'completion',
              extra: {},
            } : undefined,
            snooze: typeof body['snooze'] === 'string' ? body['snooze'] : undefined,
            estimate: body['estimate'] as number | undefined,
            hill: body['hill'] as number | undefined,
            evergreen: body['evergreen'] as boolean | undefined,
            coverColor: body['cover_color'] as string | undefined,
            fields: body['fields'] as Record<string, unknown> | undefined,
            wipJustification: typeof body['wipReason'] === 'string' ? body['wipReason'] : undefined,
            force: body['force'] === true,
          },
          actor,
        );
        return 'error' in res ? json(res, 400) : json(res);
      }
      if (req.method === 'POST' && rest === '/cards/quick') {
        const denied = requireWrite();
        if (denied) return denied;
        const body = await smallJson(req, MAX_API_JSON) as { text?: unknown };
        if (body === null || typeof body.text !== 'string' || body.text.trim() === '') return json({ error: 'text required' }, 400);
        const res = await stub.quickAdd(body.text, actor);
        return 'error' in res ? json(res, 400) : json(res);
      }
      if (req.method === 'POST' && rest === '/cards/bulk') {
        const denied = requireWrite();
        if (denied) return denied;
        const body = await smallJson(req, MAX_API_JSON) as { ids?: unknown; action?: unknown };
        if (body === null || !Array.isArray(body.ids) || !body.ids.every((id) => typeof id === 'string')) return json({ error: 'ids must be a list of strings' }, 400);
        if (body.action === null || typeof body.action !== 'object' || Array.isArray(body.action)) return json({ error: 'action must be an object' }, 400);
        const action = body.action as Record<string, unknown>;
        if (action['force'] === true) {
          const ownerOnly = requireOwner();
          if (ownerOnly) return json({ error: 'force is an owner override' }, 403);
          await registry.audit(actor, 'force-override', `bulk action on ${pid}`);
        }
        const res = await stub.bulkAction(body.ids as string[], action, actor);
        return 'error' in res ? json(res, 400) : json(res);
      }
      const cardMatch = /^\/cards\/([^/]+)(?:\/([a-z]+))?$/.exec(rest);
      if (cardMatch) {
        const cid = cardMatch[1]!;
        const action = cardMatch[2];
        if (req.method === 'GET' && action === undefined) {
          const card = await stub.card(cid, url.searchParams.get('compact') === '1');
          return card === null ? json({ error: `no card ${cid}` }, 404) : json(card);
        }
        if (req.method === 'GET' && (action === 'activity' || action === 'comments')) {
          const rawBefore = url.searchParams.get('before');
          const before = rawBefore === null ? null : Number(rawBefore);
          if (before !== null && (!Number.isSafeInteger(before) || before < 1)) return json({ error: 'before must be a positive integer' }, 400);
          const limit = Math.min(100, limitParam(url.searchParams.get('limit')));
          const history = await stub.cardHistory(cid, action, limit, before);
          if (history === null) return json({ error: `no card ${cid}` }, 404);
          return 'error' in history ? json(history, 400) : json(history);
        }
        if (req.method === 'POST' && action !== undefined) {
          const denied = requireWrite();
          if (denied) return denied;
        }
        if (req.method === 'POST' && action === 'upload') {
          // Binary attachment: store in R2, then record a normal markdown
          // attachment line pointing at /files/<key>. Format truth intact.
          if (!env.ATTACHMENTS) return json({ error: 'uploads are not enabled: bind an R2 bucket as ATTACHMENTS' }, 503);
          const name = (url.searchParams.get('name') ?? 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'file';
          const type = (req.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
          const bytes = await boundedBody(req, MAX_UPLOAD, 'upload');
          if (bytes.byteLength === 0) return json({ error: 'empty upload' }, 400);
          if ((await stub.card(cid)) === null) return json({ error: `no card ${cid}` }, 404);
          // 128 bits of key entropy: the URL is a permanent bearer capability
          // (it must render in <img> and on public pages), so make guessing
          // absurd. Revoking a share never revokes a copied file URL.
          const rand = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
          const key = `${pid}/${cid}/${rand}-${name}`;
          await env.ATTACHMENTS.put(key, bytes, { httpMetadata: { contentType: type } });
          const res = await stub.action('attach', cid, { url: `/files/${key}`, label: name }, actor);
          if ('error' in res) {
            await env.ATTACHMENTS.delete(key).catch(() => {});
            return json(res, 400);
          }
          return json({ url: `/files/${key}`, name });
        }
        if (req.method === 'POST' && action !== undefined) {
          const body = await smallJson(req, MAX_API_JSON);
          if (action === 'edit' && Array.isArray(body['deps'])) {
            const refs = await stub.validateReferenceChanges({ cardId: cid, deps: (body['deps'] as unknown[]).map(String) });
            if ('error' in refs) return json(refs, 400);
          }
          // force is an authorization capability, not an operation flag: it
          // bypasses claim conflicts and strict-lane rules, so only the
          // human operator gets it (SPEC §12). Its use is separately audited.
          if (body['force'] === true) {
            const denied = requireOwner();
            if (denied) return json({ error: 'force is an owner override: members coordinate, they do not push through' }, 403);
            await registry.audit(actor, 'force-override', `${action} on ${pid}/${cid}`);
          }
          if (action === 'link' || action === 'unlink') {
            const rawTarget = typeof body['target'] === 'string' ? body['target'] : '';
            const parsed = parseCardReference(rawTarget);
            if (parsed === null) return json({ error: 'a valid target card ref is required' }, 400);
            if (parsed.boardRef !== null) {
              if (!parsed.boardRef.startsWith('project:')) return json({ error: 'hosted cross-project refs use project:<id>#<card-id>' }, 400);
              const targetProject = parsed.boardRef.slice('project:'.length);
              if (targetProject === pid) {
                body['target'] = parsed.cardId;
              } else {
                if (targetProject === '' || !(await registry.reaches(identity, targetProject))) {
                  return json({ error: 'target project is outside your scope' }, 403);
                }
                const descendant = await registry.isWithin(targetProject, pid);
                const inverseSide = action === 'unlink' && await registry.isWithin(pid, targetProject);
                if (!descendant && !inverseSide) {
                  return json({ error: 'relation target must be a descendant project (an authorized inverse may be unlinked from either side)' }, 400);
                }
                const source = await stub.relationSource(cid);
                if ('error' in source) return json(source, 400);
                const type = String(body['type'] ?? '') as Parameters<ProjectDO['receiveRelation']>[3];
                const unlink = action === 'unlink';
                const received = await project(targetProject).receiveRelation(pid, cid, parsed.cardId, type, actor, unlink);
                if ('error' in received) return json(received, 400);
                const completed = await stub.completeRelation(cid, targetProject, parsed.cardId, type, actor, unlink);
                if ('error' in completed) {
                  return json({ error: `${completed.error}; target half converged safely — retry to finish`, target: parsed.cardId, recoverable: true }, 409);
                }
                const changed = received['changed'] === true || completed['changed'] === true;
                if (changed) await registry.audit(actor, `${action}-card`, `${pid}/${cid} ${type} project:${targetProject}#${parsed.cardId}`);
                return json({ source: cid, target: `project:${targetProject}#${parsed.cardId}`, targetId: parsed.cardId, project: targetProject, type, changed });
              }
            }
          }
          if (action === 'transfer') {
            const target = typeof body['target'] === 'string' ? body['target'] : '';
            const move = body['move'] === true;
            const lane = typeof body['lane'] === 'string' && body['lane'] !== '' ? body['lane'] : null;
            if (target === '' || target === pid) return json({ error: 'a different target project is required' }, 400);
            if (!(await registry.reaches(identity, target))) return json({ error: 'target project is outside your scope' }, 403);
            // Persisted cross-project refs must remain safe for every future
            // reader of this board, including identities scoped below it.
            if (!(await registry.isWithin(target, pid))) return json({ error: 'handoff target must be this project or one of its descendants' }, 400);
            const source = await stub.transferSource(cid);
            if ('error' in source) return json(source, 400);
            const received = await project(target).receiveTransfer(pid, source, actor, lane, move);
            if ('error' in received) return json(received, 400);
            const targetId = received['id'] as string;
            const completed = await stub.completeTransfer(cid, target, targetId, move, actor);
            if ('error' in completed) {
              return json({ error: `${completed.error}; target ${target}/${targetId} exists safely — retry to converge`, target: targetId, recoverable: true }, 409);
            }
            await registry.audit(actor, move ? 'move-card' : 'copy-card', `${pid}/${cid} → ${target}/${targetId}`);
            return json({ source: cid, target: targetId, project: target, moved: move, reused: received['reused'] === true });
          }
          // Detaching an uploaded file also drops the R2 object (best effort).
          // Only objects uploaded to THIS card qualify: an attachment line can
          // reference any URL, and detaching a reference to someone else's
          // /files/ key must never delete their object.
          let uploadedUrl: string | null = null;
          if (action === 'detach' && env.ATTACHMENTS) {
            const detail = (await stub.card(cid)) as { parsed?: { attachments?: { index: number; url: string }[] } } | null;
            const att = detail?.parsed?.attachments?.find((a) => a.index === Number(body['index']));
            if (att && att.url.startsWith(`/files/${pid}/${cid}/`)) uploadedUrl = att.url;
          }
          const actionArgs = action === 'claim' ? { ...body, delegate: identity.kind === 'bot' } : body;
          const res = await stub.action(action, cid, actionArgs, actor);
          if ('error' in res) return json(res, 'conflict' in res ? 409 : 400);
          if (action === 'attach') drainUnfurls();
          if (uploadedUrl !== null) await env.ATTACHMENTS!.delete(uploadedUrl.slice('/files/'.length)).catch(() => {});
          return json(res);
        }
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      if (err instanceof RequestBodyError) return json({ error: err.message }, err.status);
      console.error('unhandled request failure:', err);
      return json({ error: 'internal error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
