// botflow manager: Worker entry: auth, REST API, org aggregation, and the
// operator UI. Agents talk REST with scoped keys; humans get the web view.

import { rollupState } from '../../src/core/analyze.ts';
import {
  distributionTotal,
  defaultRollup,
  emptyDistribution,
  type Canonical,
  type Distribution,
} from '../../src/core/model.ts';
import type { BoardDocument } from '../../src/core/docs.ts';
import { ProjectDO } from './project.ts';
import { RegistryDO, type ProjectNode, type TokenIdentity } from './registry.ts';
import { ABOUT_HTML } from './about.ts';
import { DEMO, type OrgImport, type ProjectImport } from './demo.ts';
import { uiHtml } from './ui.ts';

export { ProjectDO, RegistryDO };

export interface Env {
  REGISTRY: DurableObjectNamespace<RegistryDO>;
  PROJECT: DurableObjectNamespace<ProjectDO>;
  /** Optional: when set (wrangler secret/var), /api/setup requires it, which
   *  closes the fresh-deployment claim race. */
  SETUP_KEY?: string;
}

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
        return new Response(uiHtml(shareMatch[1]!), { headers: { 'content-type': 'text/html; charset=utf-8' } });
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
        if (rest === '' || rest === '/board') return json(await stub.board());
        const cardMatch = /^\/cards\/([^/]+)$/.exec(rest);
        if (cardMatch) {
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
        const body = (await req.json()) as { name?: string; setupKey?: string };
        if (typeof env.SETUP_KEY === 'string' && env.SETUP_KEY !== '' && body.setupKey !== env.SETUP_KEY) {
          return json({ error: 'this deployment requires a setup key' }, 403);
        }
        const res = await registry.setup(typeof body.name === 'string' && body.name !== '' ? body.name : 'company');
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
        return json({ name: tree.name, aggregate: toRollup(orgDist, orgDone, orgUnits), spaces });
      }
      if (url.pathname === '/api/settings') {
        const denied = requireAdmin();
        if (denied) return denied;
        if (req.method === 'GET') return json({ ...(await registry.getTheme()), ...(await registry.getPrefs()) });
        if (req.method === 'POST') {
          const body = (await req.json()) as Record<string, unknown>;
          const theme = await registry.setTheme(body as never);
          const prefs = 'gateShares' in body ? await registry.setPrefs(body) : await registry.getPrefs();
          await registry.audit('admin', 'settings', `style ${theme.style}/${theme.accent} mode ${theme.mode}, gate shares ${prefs.gateShares ? 'on' : 'off'}`);
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
        const payload = isDemo ? DEMO : ((await req.json()) as OrgImport);
        if (!payload || !Array.isArray(payload.spaces)) return json({ error: 'spaces required' }, 400);
        const actor = 'admin';
        const idMap = new Map<string, string>(); // exported id → restored id
        let projects = 0;

        // Pass 1: recreate the tree so every exported id has a new id.
        interface CreatedNode { node: ProjectImport; id: string; parentId: string | null; children: CreatedNode[] }
        const createTree = async (spaceId: string, parentId: string | null, node: ProjectImport): Promise<CreatedNode> => {
          const created = await registry.createProject(parentId === null ? spaceId : null, parentId, node.name);
          if ('error' in created) throw new Error(created.error);
          projects++;
          if (typeof node.id === 'string') idMap.set(node.id, created.id);
          await project(created.id).ensureInit(node.name);
          const children: CreatedNode[] = [];
          for (const child of node.children ?? []) children.push(await createTree(spaceId, created.id, child));
          return { node, id: created.id, parentId, children };
        };
        // Pass 2: import boards with project: refs rewritten to the new ids,
        // then add project cards only for children the board doesn't carry.
        const fillTree = async (created: CreatedNode): Promise<void> => {
          let boardText = '';
          if (created.node.board) {
            const rewrite = (text: string): string => {
              let out = text;
              for (const [oldId, newId] of idMap) out = out.split(`project:${oldId}`).join(`project:${newId}`);
              return out;
            };
            const docs = created.node.board.cards.map((d) => ({ path: d.path, text: rewrite(d.text) }));
            const res = (await project(created.id).importDocs(created.node.board.config, docs, actor)) as { error?: unknown };
            if (res.error) throw new Error(String(res.error));
            boardText = docs.map((d) => d.text).join('\n');
          }
          for (const child of created.children) {
            if (!boardText.includes(`project:${child.id}`)) {
              await project(created.id).addCard(
                { title: child.node.name, type: 'board', boardPath: `project:${child.id}`, lane: child.node.lane },
                actor,
              );
            }
            await fillTree(child);
          }
        };
        try {
          for (const space of payload.spaces) {
            const s = await registry.createSpace(space.name);
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
              if (pid) await registry.restoreShare(s.token, pid, s.label, s.created, s.revoked);
            }
          }
        } catch (err) {
          return json({ error: (err as Error).message }, 400);
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
      // Hard deletion. Ordering matters for failure modes: registry rows go
      // first (one synchronous DO transaction, cutting auth and the tree at
      // once), then the parent's project card, then best-effort DO wipes:
      // leftover DO storage is unreachable garbage, never an orphaned live
      // project. Every deletion lands in the org audit log; the company
      // export is the parachute.
      const deleteProjectCascade = async (pid: string): Promise<number> => {
        const ids = await registry.subtreeIds(pid);
        const parent = await registry.parentOf(pid);
        const name = await registry.projectName(pid);
        await registry.deleteProjects(ids);
        await registry.audit('admin', 'delete-project', `"${name ?? pid}" (${ids.length} project(s): ${ids.join(', ')})`);
        if (parent !== null) await project(parent).removeCardsByRef(`project:${pid}`, 'admin');
        await Promise.allSettled(ids.map((id) => project(id).destroy()));
        return ids.length;
      };
      const spaceDelete = /^\/api\/spaces\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && spaceDelete) {
        const denied = requireAdmin();
        if (denied) return denied;
        const sid = spaceDelete[1]!;
        const ids = await registry.projectIdsInSpace(sid);
        await registry.deleteProjects(ids);
        await registry.deleteSpace(sid);
        await registry.audit('admin', 'delete-space', `${sid} (${ids.length} project(s))`);
        await Promise.allSettled(ids.map((id) => project(id).destroy()));
        return json({ deleted: { space: sid, projects: ids.length } });
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
        const projects = await deleteProjectCascade(pid);
        return json({ deleted: { project: pid, projects } });
      }
      if (req.method === 'GET' && (rest === '' || rest === '/board')) return json(await stub.board());
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
          const body = (await req.json()) as { label?: string };
          const res = await registry.createShare(pid, body.label ?? 'public link');
          if (!('error' in res)) await registry.audit('admin', 'create-share', `"${body.label ?? 'public link'}" for ${pid}`);
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
          if ((await registry.projectName(ref)) === null || !(await registry.isWithin(ref, pid))) {
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
        if (req.method === 'POST' && action !== undefined) {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const res = await stub.action(action, cid, body, actorOf(body));
          return 'error' in res ? json(res, 400) : json(res);
        }
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: (err as Error).message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
