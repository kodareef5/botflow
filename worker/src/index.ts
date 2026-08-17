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
import { ProjectDO, validateImportDocuments } from './project.ts';
import { RegistryDO, type ProjectNode, type TokenIdentity } from './registry.ts';
import { ABOUT_HTML } from './about.ts';
import { DEMO, type OrgImport, type ProjectImport } from './demo.ts';
import { setupAccess } from './security.ts';
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
}

// Uploaded files the browser may render inline; anything else downloads.
// HTML and SVG stay out: same-origin inline markup could script against the
// operator session. The sandbox CSP below is the second lock on that door.
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'application/pdf', 'text/plain']);
const MAX_UPLOAD = 10 * 1024 * 1024;

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value, null, 2), { status, headers: { 'content-type': 'application/json' } });

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate a company import completely before pass 1 creates any registry
 *  rows. Version 1 remains accepted for old/demo payloads; restore-grade v2
 *  requires stable, unique exported project ids. */
function validateOrgImportPayload(value: unknown): string | null {
  if (!isRecord(value) || (value['version'] !== 1 && value['version'] !== 2)) return 'version must be 1 or 2';
  if (!Array.isArray(value['spaces'])) return 'spaces required';
  const version = value['version'];
  const ids = new Set<string>();
  const visit = (node: unknown, ref: string): string | null => {
    if (!isRecord(node)) return `${ref} must be a project object`;
    if (typeof node['name'] !== 'string' || node['name'].trim() === '') return `${ref}.name required`;
    if (node['id'] !== undefined) {
      if (typeof node['id'] !== 'string' || node['id'] === '') return `${ref}.id must be a string`;
      if (ids.has(node['id'])) return `duplicate exported project id: ${node['id']}`;
      ids.add(node['id']);
    } else if (version === 2) {
      return `${ref}.id required in version 2`;
    }
    if (node['lane'] !== undefined && typeof node['lane'] !== 'string') return `${ref}.lane must be a string`;
    let config = fallbackConfig(node['name']);
    if (node['board'] !== undefined) {
      if (!isRecord(node['board'])) return `${ref}.board must be an object`;
      const checked = validateImportDocuments(node['board']['config'], node['board']['cards']);
      if ('error' in checked) return `${ref}.board: ${checked.error}`;
      config = checked.board.config;
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
    if (!Array.isArray(space['projects'])) return `spaces[${si}].projects must be a list`;
    for (let pi = 0; pi < space['projects'].length; pi++) {
      const error = visit(space['projects'][pi], `spaces[${si}].projects[${pi}]`);
      if (error) return error;
    }
  }
  if (value['keys'] !== undefined) {
    if (!Array.isArray(value['keys'])) return 'keys must be a list';
    for (const key of value['keys']) {
      if (!isRecord(key) || typeof key['hash'] !== 'string' || !/^[a-f0-9]{64}$/.test(key['hash']) ||
          typeof key['projectId'] !== 'string' || !ids.has(key['projectId']) || typeof key['label'] !== 'string' ||
          typeof key['created'] !== 'string' || typeof key['revoked'] !== 'boolean') return 'malformed key metadata';
    }
  }
  if (value['shares'] !== undefined) {
    if (!Array.isArray(value['shares'])) return 'shares must be a list';
    for (const share of value['shares']) {
      if (!isRecord(share) || typeof share['token'] !== 'string' || !/^[a-f0-9]{16,64}$/.test(share['token']) ||
          typeof share['projectId'] !== 'string' || !ids.has(share['projectId']) || typeof share['label'] !== 'string' ||
          typeof share['created'] !== 'string' || typeof share['revoked'] !== 'boolean' ||
          (share['cardId'] !== undefined && typeof share['cardId'] !== 'string')) return 'malformed share metadata';
    }
  }
  if (value['theme'] !== undefined && !isRecord(value['theme'])) return 'theme must be an object';
  if (value['prefs'] !== undefined && !isRecord(value['prefs'])) return 'prefs must be an object';
  return null;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const registry = env.REGISTRY.get(env.REGISTRY.idFromName('main'));
    const project = (id: string) => env.PROJECT.get(env.PROJECT.idFromName(id));

    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return new Response(uiHtml(null), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (req.method === 'GET' && url.pathname === '/about') {
        return new Response(ABOUT_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      const shareMatch = /^\/s\/([a-f0-9]{16,64})$/.exec(url.pathname);
      if (req.method === 'GET' && shareMatch) {
        const share = await registry.resolveShare(shareMatch[1]!);
        return new Response(uiHtml(shareMatch[1]!, share?.cardId ?? null), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      // Uploaded attachments: the random key segment is the capability, like
      // share tokens; objects render in <img> tags and on public card pages,
      // where auth headers never travel.
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
        return json({ shares: status0.initialized ? await registry.listGateShares() : [] });
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
          return json(await stub.board());
        }
        const cardMatch = /^\/cards\/([^/]+)$/.exec(rest);
        if (cardMatch) {
          if (share.cardId !== null && cardMatch[1] !== share.cardId) return json({ error: 'no such card' }, 404);
          const card = await stub.card(cardMatch[1]!);
          return card === null ? json({ error: 'no such card' }, 404) : json(card);
        }
        return json({ error: 'not found' }, 404);
      }

      const status = await registry.status();
      // Theme is public chrome: the gate and share pages paint with it pre-auth.
      if (req.method === 'GET' && url.pathname === '/api/theme') {
        return json(await registry.getTheme());
      }
      if (req.method === 'POST' && url.pathname === '/api/setup') {
        if (status.initialized) return json({ error: 'already initialized' }, 409);
        const body = (await req.json()) as { name?: string; setupKey?: string };
        const access = setupAccess(url.hostname, env.SETUP_KEY, body.setupKey);
        if (!access.ok) return json({ error: access.error }, access.status);
        const res = await registry.setup(typeof body.name === 'string' && body.name !== '' ? body.name : 'company');
        return 'error' in res ? json(res, 409) : json(res);
      }
      // Lost-token recovery rides the same trust anchor as first-run setup:
      // the SETUP_KEY secret (loopback stays zero-config). It mints a fresh
      // admin token and kills the old one; the audit log records it.
      if (req.method === 'POST' && url.pathname === '/api/recover') {
        if (!status.initialized) return json({ error: 'not initialized: use setup' }, 409);
        const body = (await req.json().catch(() => ({}))) as { setupKey?: string };
        const access = setupAccess(url.hostname, env.SETUP_KEY, body.setupKey);
        if (!access.ok) return json({ error: access.error }, access.status);
        const res = await registry.rotateAdminToken('recover-admin');
        return 'error' in res ? json(res, 409) : json(res);
      }
      if (!status.initialized) return json({ uninitialized: true }, url.pathname === '/api/org' ? 200 : 403);

      // ---- auth ----
      const header = req.headers.get('authorization') ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      const identity: TokenIdentity = token === '' ? null : await registry.verifyToken(token);
      if (identity === null) return json({ error: 'unauthorized' }, 401);
      const requireAdmin = (): Response | null => (identity.kind === 'admin' ? null : json({ error: 'admin only' }, 403));
      // Who am I?: lets an agent handed a bare key discover its own project.
      if (req.method === 'GET' && url.pathname === '/api/whoami') {
        if (identity.kind === 'admin') return json({ kind: 'admin', org: status.name });
        return json({
          kind: 'agent',
          label: identity.label,
          project: identity.projectId,
          projectName: await registry.projectName(identity.projectId),
        });
      }
      // Rotate the admin credential: new token minted, old one dead, audited.
      if (req.method === 'POST' && url.pathname === '/api/rotate-token') {
        const denied = requireAdmin();
        if (denied) return denied;
        const res = await registry.rotateAdminToken('rotate-token');
        return 'error' in res ? json(res, 409) : json(res);
      }
      // Agent identity is the key's label, always: request bodies cannot forge
      // the audit trail. Only the admin may act under a chosen name.
      const actorOf = (body: Record<string, unknown>): string =>
        identity.kind === 'agent'
          ? identity.label
          : typeof body['actor'] === 'string' && body['actor'] !== ''
            ? (body['actor'] as string)
            : 'admin';

      // ---- org ----
      if (req.method === 'GET' && url.pathname === '/api/org') {
        const denied = requireAdmin();
        if (denied) return denied;
        const tree = await registry.tree();
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
        return json({ name: tree.name, aggregate: toRollup(orgDist, orgDone, orgUnits), spaces, uploads: env.ATTACHMENTS !== undefined });
      }
      if (url.pathname === '/api/settings') {
        const denied = requireAdmin();
        if (denied) return denied;
        if (req.method === 'GET') return json({ ...(await registry.getTheme()), ...(await registry.getPrefs()) });
        if (req.method === 'POST') {
          const body = (await req.json()) as Record<string, unknown>;
          const theme = await registry.setTheme(body as never);
          const prefs = 'gateShares' in body ? await registry.setPrefs(body) : await registry.getPrefs();
          await registry.audit('admin', 'settings', `style ${theme.style}/${theme.accent} ${theme.density}, mode ${theme.mode}, gate shares ${prefs.gateShares ? 'on' : 'off'}`);
          return json({ ...theme, ...prefs });
        }
      }
      if (url.pathname === '/api/org/export' && req.method === 'GET') {
        const denied = requireAdmin();
        if (denied) return denied;
        const tree = await registry.tree();
        const exportNode = async (n: ProjectNode): Promise<Record<string, unknown>> => ({
          id: n.id,
          name: n.name,
          board: await project(n.id).exportDocs(),
          children: await Promise.all(n.children.map(exportNode)),
        });
        await registry.audit('admin', 'export', 'company export downloaded');
        return json({
          version: 2,
          name: tree.name,
          theme: await registry.getTheme(),
          prefs: await registry.getPrefs(),
          keys: await registry.exportKeys(),
          shares: (await registry.listAllShares()).map((s) => ({
            token: s.token, projectId: s.projectId, label: s.label, created: s.created, revoked: s.revoked,
            ...(s.cardId ? { cardId: s.cardId } : {}),
          })),
          spaces: await Promise.all(
            tree.spaces.map(async (s) => ({ name: s.name, projects: await Promise.all(s.projects.map(exportNode)) })),
          ),
        });
      }
      if ((url.pathname === '/api/org/import' && req.method === 'PUT') || (url.pathname === '/api/demo' && req.method === 'POST')) {
        const denied = requireAdmin();
        if (denied) return denied;
        const isDemo = url.pathname === '/api/demo';
        const rawPayload: unknown = isDemo ? DEMO : await req.json();
        const validationError = validateOrgImportPayload(rawPayload);
        if (validationError) return json({ error: validationError }, 400);
        const payload = rawPayload as OrgImport;
        const actor = 'admin';
        const idMap = new Map<string, string>(); // exported id → restored id
        const createdSpaceIds: string[] = [];
        let projects = 0;
        const previousMetadata = isDemo ? null : {
          name: status.name ?? 'company',
          theme: await registry.getTheme(),
          prefs: await registry.getPrefs(),
        };

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
            const rewrite = (text: string): string => {
              let out = text;
              for (const [oldId, newId] of idMap) out = out.split(`project:${oldId}`).join(`project:${newId}`);
              return out;
            };
            const docs = created.node.board.cards.map((d) => ({ path: d.path, text: rewrite(d.text) }));
            const checked = validateImportDocuments(created.node.board.config, docs);
            if ('error' in checked) throw new Error(checked.error);
            for (const card of checked.board.cards) {
              if (card.type === 'board' && card.boardPath !== null) importedRefs.add(card.boardPath);
            }
            const res = (await project(created.id).importDocs(created.node.board.config, docs, actor)) as { error?: unknown };
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
        };
        try {
          for (const space of payload.spaces) {
            const s = await registry.createSpace(space.name);
            createdSpaceIds.push(s.id);
            const roots: CreatedNode[] = [];
            for (const p of space.projects) roots.push(await createTree(s.id, null, p));
            for (const r of roots) await fillTree(r);
          }
          // Restore-grade metadata (v2 exports): name, theme, prefs, key
          // hashes (original tokens stay valid), and share links.
          if (!isDemo) {
            if (typeof payload.name === 'string') await registry.setOrgName(payload.name);
            if (payload.theme) await registry.setTheme(payload.theme);
            if (payload.prefs) await registry.setPrefs(payload.prefs);
            for (const k of payload.keys ?? []) {
              const pid = idMap.get(k.projectId);
              if (pid) await registry.restoreKey(k.hash, pid, k.label, k.created, k.revoked);
            }
            for (const s of payload.shares ?? []) {
              const pid = idMap.get(s.projectId);
              if (pid) await registry.restoreShare(s.token, pid, s.label, s.created, s.revoked, s.cardId ?? null);
            }
          }
        } catch (err) {
          const message = (err as Error).message;
          let cleanup = 'rollback complete';
          try {
            const rolledBack = await registry.rollbackSpaces(createdSpaceIds);
            const storageCleanup = await Promise.allSettled(rolledBack.ids.map((id) => project(id).destroy()));
            const storageFailures = storageCleanup.filter((result) => result.status === 'rejected').length;
            if (storageFailures > 0) cleanup = `registry rollback complete; ${storageFailures} unreachable storage cleanup failure(s)`;
            if (previousMetadata) {
              await registry.setOrgName(previousMetadata.name);
              await registry.setTheme(previousMetadata.theme);
              await registry.setPrefs(previousMetadata.prefs);
            }
          } catch (rollbackErr) {
            cleanup = `rollback failed: ${(rollbackErr as Error).message}`;
          }
          await registry.audit('admin', 'import-failed', `${message}; ${cleanup}`);
          return json({ error: message }, 400);
        }
        await registry.audit('admin', isDemo ? 'demo' : 'import', `${payload.spaces.length} space(s), ${projects} project(s)`);
        return json({ imported: { spaces: payload.spaces.length, projects } });
      }
      if (req.method === 'POST' && url.pathname === '/api/spaces') {
        const denied = requireAdmin();
        if (denied) return denied;
        const body = (await req.json()) as { name?: string };
        if (!body.name) return json({ error: 'name required' }, 400);
        const created = await registry.createSpace(body.name);
        await registry.audit('admin', 'create-space', `"${body.name}" (${created.id})`);
        return json(created);
      }
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const body = (await req.json()) as { space?: string; parent?: string; name?: string; lane?: string };
        if (!body.name) return json({ error: 'name required' }, 400);
        if (identity.kind === 'agent') {
          // Agents may decompose their own scope into sub-projects.
          if (!body.parent || !(await registry.isWithin(body.parent, identity.projectId))) {
            return json({ error: 'agents can only create sub-projects inside their own project' }, 403);
          }
        } else if (!body.space && !body.parent) {
          return json({ error: 'space or parent required' }, 400);
        }
        const res = await registry.createProject(body.space ?? null, body.parent ?? null, body.name);
        if ('error' in res) return json(res, 400);
        await registry.audit(actorOf(body as Record<string, unknown>), 'create-project', `"${body.name}" (${res.id})${body.parent ? ` under ${body.parent}` : ''}`);
        await project(res.id).ensureInit(body.name);
        // Projects can be cards: the sub-project appears as a project card in
        // the parent's board: one nesting mechanism, same as the file spec.
        if (body.parent) {
          await project(body.parent).addCard(
            { title: body.name, type: 'board', boardPath: `project:${res.id}`, lane: body.lane },
            actorOf(body as Record<string, unknown>),
          );
        }
        return json(res);
      }
      const keyRevoke = /^\/api\/keys\/([^/]+)\/revoke$/.exec(url.pathname);
      if (req.method === 'POST' && keyRevoke) {
        const denied = requireAdmin();
        if (denied) return denied;
        const res = await registry.revokeKey(keyRevoke[1]!);
        await registry.audit('admin', 'revoke-key', keyRevoke[1]!);
        return json(res);
      }
      const shareRevoke = /^\/api\/shares\/([^/]+)\/revoke$/.exec(url.pathname);
      if (req.method === 'POST' && shareRevoke) {
        const denied = requireAdmin();
        if (denied) return denied;
        const res = await registry.revokeShare(shareRevoke[1]!);
        await registry.audit('admin', 'revoke-share', shareRevoke[1]!);
        return json(res);
      }
      const shareDelete = /^\/api\/shares\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && shareDelete) {
        const denied = requireAdmin();
        if (denied) return denied;
        const res = await registry.deleteShare(shareDelete[1]!);
        await registry.audit('admin', 'delete-share', shareDelete[1]!);
        return json(res);
      }
      if (req.method === 'GET' && url.pathname === '/api/org/shares') {
        const denied = requireAdmin();
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
        if (parent !== null) jobs.push(() => project(parent).removeCardsByRef(`project:${pid}`, 'admin'));
        const first = await Promise.allSettled(jobs.map((job) => job()));
        const retry = jobs.filter((_, i) => first[i]?.status === 'rejected');
        const second = await Promise.allSettled(retry.map((job) => job()));
        const failures = second.filter((r) => r.status === 'rejected').length;
        if (failures > 0) await registry.audit('system', 'delete-cleanup-failed', `${pid}: ${failures} cleanup operation(s)`);
        return failures;
      };
      const spaceDelete = /^\/api\/spaces\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && spaceDelete) {
        const denied = requireAdmin();
        if (denied) return denied;
        const sid = spaceDelete[1]!;
        const removed = await registry.deleteSpaceCascade(sid, 'admin');
        if ('error' in removed) return json(removed, 404);
        const cleanupFailures = await finishDeleteCleanup(sid, removed.ids, null);
        return json({ deleted: { space: sid, projects: removed.ids.length }, cleanupFailures });
      }
      if (req.method === 'GET' && url.pathname === '/api/org/activity') {
        const denied = requireAdmin();
        if (denied) return denied;
        const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 100) || 100);
        return json(await registry.listAudit(limit));
      }

      // ---- project routes ----
      const match = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (!match) return json({ error: 'not found' }, 404);
      const pid = match[1]!;
      const rest = match[2] ?? '';
      if ((await registry.projectName(pid)) === null) return json({ error: `no project ${pid}` }, 404);
      // Agent keys cover their project and everything nested beneath it.
      if (identity.kind === 'agent' && !(await registry.isWithin(pid, identity.projectId))) {
        return json({ error: 'key is scoped to another project' }, 403);
      }
      const stub = project(pid);

      if (req.method === 'DELETE' && (rest === '' || rest === '/')) {
        const denied = requireAdmin();
        if (denied) return denied;
        const removed = await registry.deleteProjectCascade(pid, 'admin');
        if ('error' in removed) return json(removed, 404);
        const cleanupFailures = await finishDeleteCleanup(pid, removed.ids, removed.parent);
        return json({ deleted: { project: pid, projects: removed.ids.length }, cleanupFailures });
      }
      if (req.method === 'GET' && (rest === '' || rest === '/board')) return json(await stub.board());
      if (req.method === 'GET' && rest === '/config') return json(await stub.boardConfig());
      if (req.method === 'PUT' && rest === '/config') {
        // Board shape is workflow policy: admins reshape it, agents work it.
        const denied = requireAdmin();
        if (denied) return denied;
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        const res = await stub.editBoardConfig(body, actorOf(body ?? {}));
        if (!('error' in res)) await registry.audit('admin', 'board-edit', `reshaped board of ${pid}`);
        return 'error' in res ? json(res, 400) : json(res);
      }
      if (req.method === 'GET' && rest === '/export') return json(await stub.exportDocs());
      if (req.method === 'PUT' && rest === '/import') {
        const body = (await req.json()) as { config?: string; cards?: BoardDocument[]; actor?: string };
        if (typeof body.config !== 'string' || !Array.isArray(body.cards)) return json({ error: 'config and cards required' }, 400);
        const res = await stub.importDocs(body.config, body.cards, actorOf(body as Record<string, unknown>));
        return 'error' in res ? json(res, 400) : json(res);
      }
      if (req.method === 'GET' && rest === '/events') {
        const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 100) || 100);
        return json(await stub.listEvents(limit));
      }
      if (rest === '/shares') {
        const denied = requireAdmin();
        if (denied) return denied;
        if (req.method === 'GET') return json(await registry.listShares(pid));
        if (req.method === 'POST') {
          const body = (await req.json()) as { label?: string; card?: string };
          let cardId: string | null = null;
          if (typeof body.card === 'string' && body.card !== '') {
            if ((await stub.card(body.card)) === null) return json({ error: `no card ${body.card}` }, 400);
            cardId = body.card;
          }
          const res = await registry.createShare(pid, body.label ?? 'public link', cardId);
          if (!('error' in res)) {
            await registry.audit('admin', 'create-share', `"${body.label ?? 'public link'}" for ${pid}${cardId ? ` (card ${cardId})` : ''}`);
          }
          return 'error' in res ? json(res, 400) : json(res);
        }
      }
      if (req.method === 'GET' && rest === '/keys') {
        const denied = requireAdmin();
        if (denied) return denied;
        return json(await registry.listKeys(pid));
      }
      if (req.method === 'POST' && rest === '/keys') {
        const denied = requireAdmin();
        if (denied) return denied;
        const body = (await req.json()) as { label?: string };
        if (!body.label) return json({ error: 'label required' }, 400);
        const res = await registry.createKey(pid, body.label);
        if (!('error' in res)) await registry.audit('admin', 'create-key', `"${body.label}" for ${pid}`);
        return 'error' in res ? json(res, 400) : json(res);
      }
      if (req.method === 'POST' && rest === '/cards') {
        const body = (await req.json()) as Record<string, unknown>;
        if (typeof body['title'] !== 'string' || body['title'] === '') return json({ error: 'title required' }, 400);
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
            lane: typeof body['lane'] === 'string' ? (body['lane'] as string) : undefined,
            type: body['type'] === 'board' ? 'board' : 'task',
            boardPath: typeof body['board'] === 'string' ? (body['board'] as string) : undefined,
            labels: Array.isArray(body['labels']) ? (body['labels'] as unknown[]).map(String) : undefined,
            priority: typeof body['priority'] === 'string' ? (body['priority'] as string) : undefined,
            deps: Array.isArray(body['deps']) ? (body['deps'] as unknown[]).map(String) : undefined,
            assignee: typeof body['assignee'] === 'string' ? (body['assignee'] as string) : undefined,
          },
          actorOf(body),
        );
        return 'error' in res ? json(res, 400) : json(res);
      }
      const cardMatch = /^\/cards\/([^/]+)(?:\/([a-z]+))?$/.exec(rest);
      if (cardMatch) {
        const cid = cardMatch[1]!;
        const action = cardMatch[2];
        if (req.method === 'GET' && action === undefined) {
          const card = await stub.card(cid);
          return card === null ? json({ error: `no card ${cid}` }, 404) : json(card);
        }
        if (req.method === 'POST' && action === 'upload') {
          // Binary attachment: store in R2, then record a normal markdown
          // attachment line pointing at /files/<key>. Format truth intact.
          if (!env.ATTACHMENTS) return json({ error: 'uploads are not enabled: bind an R2 bucket as ATTACHMENTS' }, 503);
          const name = (url.searchParams.get('name') ?? 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'file';
          const type = (req.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
          const bytes = await req.arrayBuffer();
          if (bytes.byteLength === 0) return json({ error: 'empty upload' }, 400);
          if (bytes.byteLength > MAX_UPLOAD) return json({ error: 'upload exceeds 10 MiB' }, 413);
          if ((await stub.card(cid)) === null) return json({ error: `no card ${cid}` }, 404);
          const rand = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
          const key = `${pid}/${cid}/${rand}-${name}`;
          await env.ATTACHMENTS.put(key, bytes, { httpMetadata: { contentType: type } });
          const res = await stub.action('attach', cid, { url: `/files/${key}`, label: name }, actorOf({ actor: url.searchParams.get('actor') ?? '' }));
          if ('error' in res) {
            await env.ATTACHMENTS.delete(key).catch(() => {});
            return json(res, 400);
          }
          return json({ url: `/files/${key}`, name });
        }
        if (req.method === 'POST' && action !== undefined) {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          // Detaching an uploaded file also drops the R2 object (best effort).
          let uploadedUrl: string | null = null;
          if (action === 'detach' && env.ATTACHMENTS) {
            const detail = (await stub.card(cid)) as { parsed?: { attachments?: { index: number; url: string }[] } } | null;
            const att = detail?.parsed?.attachments?.find((a) => a.index === Number(body['index']));
            if (att && att.url.startsWith('/files/')) uploadedUrl = att.url;
          }
          const res = await stub.action(action, cid, body, actorOf(body));
          if ('error' in res) return json(res, 'conflict' in res ? 409 : 400);
          if (uploadedUrl !== null) await env.ATTACHMENTS!.delete(uploadedUrl.slice('/files/'.length)).catch(() => {});
          return json(res);
        }
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: (err as Error).message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
