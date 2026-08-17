// Worker API end-to-end: spawns a real `wrangler dev` (isolated state) and
// exercises auth, actor binding, scoping, import/export restore, aggregation,
// sharing, and cascade deletion. Slow (~20s); everything runs in one test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { setupAccess } from '../worker/src/security.ts';

const PORT = 8901 + Math.floor(Math.random() * 90);
const U = `http://127.0.0.1:${PORT}`;
const SETUP_KEY = 'test-setup-key';
const WRANGLER = join(import.meta.dirname, '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');

async function stopWorker(child: ReturnType<typeof spawn>, state: string): Promise<void> {
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      if (process.platform === 'win32' || child.pid === undefined) child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      // It already exited.
    }
  };
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  signalGroup('SIGTERM');
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
  if (child.exitCode === null) {
    signalGroup('SIGKILL');
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
  }
  rmSync(state, { recursive: true, force: true });
}

async function call(path: string, opts: RequestInit & { token?: string } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(U + path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...((opts.headers as Record<string, string> | undefined) ?? {}),
    },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

test('worker api: auth, scoping, restore, aggregation, deletion', { timeout: 180_000 }, async () => {
  const state = mkdtempSync(join(tmpdir(), 'botflow-worker-'));
  // stdio must be 'ignore': piped output nobody reads fills the pipe buffer
  // and stalls wrangler mid-startup (found the hard way).
  const child = spawn(
    process.execPath,
    [WRANGLER, 'dev', '--port', String(PORT), '--persist-to', state, '--var', `SETUP_KEY:${SETUP_KEY}`],
    { cwd: join(import.meta.dirname, '..'), stdio: 'ignore', env: { ...process.env }, detached: true },
  );
  try {
    // Wait for the server.
    let up = false;
    for (let i = 0; i < 90 && !up; i++) {
      up = await fetch(`${U}/api/public/gate`).then((r) => r.ok, () => false);
      if (!up) await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(up, 'wrangler dev came up');

    // Setup requires the key when configured.
    assert.equal((await call('/api/setup', { method: 'POST', body: JSON.stringify({ name: 'testco' }) })).status, 403);
    const setup = await call('/api/setup', { method: 'POST', body: JSON.stringify({ name: 'testco', setupKey: SETUP_KEY }) });
    assert.equal(setup.status, 200);
    const admin = setup.body['token'] as string;
    assert.equal(
      (await call('/api/setup', { method: 'POST', body: JSON.stringify({ name: 'again', setupKey: 'guess' }) })).status,
      409,
      'initialized deployments do not act as setup-key oracles',
    );

    // Org structure: space, parent, child.
    const space = (await call('/api/spaces', { method: 'POST', token: admin, body: JSON.stringify({ name: 'eng' }) })).body['id'] as string;
    const parent = (await call('/api/projects', { method: 'POST', token: admin, body: JSON.stringify({ space, name: 'parent' }) })).body['id'] as string;
    const childP = (await call('/api/projects', { method: 'POST', token: admin, body: JSON.stringify({ parent, name: 'child', lane: 'doing' }) })).body['id'] as string;
    const stranger = (await call('/api/projects', { method: 'POST', token: admin, body: JSON.stringify({ space, name: 'stranger' }) })).body['id'] as string;

    // Agent key on parent; actor forgery must be impossible.
    const key = (await call(`/api/projects/${parent}/keys`, { method: 'POST', token: admin, body: JSON.stringify({ label: 'alpha-agent' }) })).body['token'] as string;
    await call(`/api/projects/${parent}/cards`, { method: 'POST', token: key, body: JSON.stringify({ title: 'Own task', actor: 'admin' }) });
    await call(`/api/projects/${parent}/cards/001/claim`, { method: 'POST', token: key, body: JSON.stringify({ actor: 'root' }) });
    const forged = await call(`/api/projects/${parent}/cards/001`, { token: admin });
    assert.equal(forged.body['assignee'], 'alpha-agent', 'assignee bound to key label');
    const events = (await call(`/api/projects/${parent}/events?limit=10`, { token: admin })).body as unknown as { actor: string }[];
    assert.ok(events.filter((e) => e.actor === 'alpha-agent').length >= 2, 'audit records the key label');
    assert.equal(events.some((e) => e.actor === 'root'), false, 'forged actor never recorded');

    // Scoping: a card referencing an unrelated project is rejected, and a
    // smuggled ref (via board import) leaks nothing at resolution time.
    const refReject = await call(`/api/projects/${parent}/cards`, {
      method: 'POST', token: key, body: JSON.stringify({ title: 'sneak', type: 'board', board: `project:${stranger}` }),
    });
    assert.equal(refReject.status, 400);
    await call(`/api/projects/${stranger}/cards`, { method: 'POST', token: admin, body: JSON.stringify({ title: 'secret work' }) });
    await call(`/api/projects/${stranger}/cards/001/claim`, { method: 'POST', token: admin, body: JSON.stringify({}) });
    const smuggle = {
      config: 'botflow: 0\nname: parent\n',
      cards: [
        { path: 'cards/001-own-task.md', text: '---\nid: 001\ntitle: Own task\nlane: doing\nassignee: alpha-agent\n---\n' },
        { path: 'cards/002-sneak.md', text: `---\nid: 002\ntitle: Sneak\nlane: todo\ntype: board\nboard: project:${stranger}\n---\n` },
      ],
    };
    await call(`/api/projects/${parent}/import`, { method: 'PUT', token: admin, body: JSON.stringify(smuggle) });
    const boardAfter = (await call(`/api/projects/${parent}/board`, { token: admin })).body as { lanes: { cards: { id: string; state: string; childProgress: number | null }[] }[] };
    const sneak = boardAfter.lanes.flatMap((l) => l.cards).find((c) => c.id === '002')!;
    assert.equal(sneak.state, 'todo', 'out-of-scope ref falls back to its lane');
    assert.equal(sneak.childProgress, null, 'no distribution leak');

    // A project cannot reference itself through the friendly card API.
    const selfRef = await call(`/api/projects/${childP}/cards`, {
      method: 'POST', token: admin,
      body: JSON.stringify({ title: 'self cycle', type: 'board', board: `project:${childP}` }),
    });
    assert.equal(selfRef.status, 400);

    // Duplicate paths are rejected.
    const dup = await call(`/api/projects/${parent}/import`, {
      method: 'PUT', token: admin,
      body: JSON.stringify({ config: 'botflow: 0\nname: parent\n', cards: [smuggle.cards[0], { ...smuggle.cards[0], text: smuggle.cards[0]!.text.replace('001', '003') }] }),
    });
    assert.equal(dup.status, 400);

    // Distinct files with the same card id are also rejected atomically.
    const beforeDupId = await call(`/api/projects/${parent}/export`, { token: admin });
    const dupId = await call(`/api/projects/${parent}/import`, {
      method: 'PUT', token: admin,
      body: JSON.stringify({
        config: 'botflow: 0\nname: parent\n',
        cards: [
          { path: 'cards/003-first.md', text: '---\nid: 003\ntitle: First\nlane: todo\n---\n' },
          { path: 'cards/003-second.md', text: '---\nid: 003\ntitle: Second\nlane: done\n---\n' },
        ],
      }),
    });
    assert.equal(dupId.status, 400);
    assert.deepEqual((await call(`/api/projects/${parent}/export`, { token: admin })).body, beforeDupId.body, 'rejected import is atomic');

    // Org imports are fully validated before they create registry state.
    const badOrg = await call('/api/org/import', {
      method: 'PUT', token: admin,
      body: JSON.stringify({
        version: 2,
        spaces: [{ name: 'must-not-stick', projects: [{
          id: 'old-bad', name: 'bad', children: [],
          board: { config: 'botflow: 0\nname: bad\n', cards: [
            { path: 'cards/001-a.md', text: '---\nid: 001\ntitle: A\nlane: todo\n---\n' },
            { path: 'cards/001-a.md', text: '---\nid: 002\ntitle: B\nlane: todo\n---\n' },
          ] },
        }] }],
      }),
    });
    assert.equal(badOrg.status, 400);
    const afterBadOrg = (await call('/api/org', { token: admin })).body as { spaces: { name: string }[] };
    assert.equal(afterBadOrg.spaces.some((s) => s.name === 'must-not-stick'), false, 'failed import created no space');

    // Aggregation must not double-count nested work: parent has 1 done task,
    // child has 1 done task, tree aggregate done must be exactly 2.
    await call(`/api/projects/${parent}/import`, {
      method: 'PUT', token: admin,
      body: JSON.stringify({
        config: 'botflow: 0\nname: parent\n',
        cards: [{ path: 'cards/001-own-task.md', text: `---\nid: 001\ntitle: Own task\nlane: done\n---\n` },
                { path: 'cards/002-kid.md', text: `---\nid: 002\ntitle: child\nlane: doing\ntype: board\nboard: project:${childP}\n---\n` }],
      }),
    });
    await call(`/api/projects/${childP}/cards`, { method: 'POST', token: admin, body: JSON.stringify({ title: 'child task' }) });
    await call(`/api/projects/${childP}/cards/001/close`, { method: 'POST', token: admin, body: JSON.stringify({}) });
    const org1 = (await call('/api/org', { token: admin })).body as {
      spaces: { projects: { name: string; aggregate: { distribution: Record<string, number> } }[] }[];
    };
    const parentNode = org1.spaces[0]!.projects.find((p) => p.name === 'parent')!;
    assert.equal(parentNode.aggregate.distribution['done'], 2, 'no double counting');

    // Share link + export/import round trip as a restore.
    const share = (await call(`/api/projects/${parent}/shares`, { method: 'POST', token: admin, body: JSON.stringify({ label: 'peek' }) })).body['token'] as string;
    assert.equal((await call(`/api/public/${share}/board`)).status, 200, 'direct share url remains usable');
    const closedGate = (await call('/api/public/gate')).body as { shares: { token: string }[] };
    assert.equal(closedGate.shares.length, 0, 'share directory is off by default');
    await call('/api/settings', { method: 'POST', token: admin, body: JSON.stringify({ gateShares: true }) });
    const openGate = (await call('/api/public/gate')).body as { shares: { token: string }[] };
    assert.ok(openGate.shares.some((s) => s.token === share), 'admin can opt in to the share directory');
    await call('/api/settings', { method: 'POST', token: admin, body: JSON.stringify({ gateShares: false }) });
    const exported = (await call('/api/org/export', { token: admin })).body as Record<string, unknown>;
    assert.equal(exported['version'], 2);
    assert.ok(Array.isArray(exported['keys']) && (exported['keys'] as unknown[]).length === 1, 'keys exported');

    await call(`/api/spaces/${space}`, { method: 'DELETE', token: admin });
    assert.equal((await call(`/api/public/${share}/board`)).status, 404, 'share died with the space');
    assert.equal((await call(`/api/projects/${parent}/board`, { token: key })).status, 401, 'deleted key no longer authenticates');

    const imported = await call('/api/org/import', { method: 'PUT', token: admin, body: JSON.stringify(exported) });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const org2 = (await call('/api/org', { token: admin })).body as {
      spaces: { id: string; name: string; projects: { id: string; name: string; children: { id: string; name: string }[] }[] }[];
    };
    const restoredSpace = org2.spaces.find((s) => s.name === 'eng')!;
    const restoredParent = restoredSpace.projects.find((p) => p.name === 'parent')!;
    assert.equal(restoredParent.children.length, 1, 'exactly one restored child, no duplicate project card');
    const rBoard = (await call(`/api/projects/${restoredParent.id}/board`, { token: admin })).body as {
      cards: number; lanes: { id: string; cards: { id: string; type: string; child: string | null; state: string }[] }[];
    };
    const projCards = rBoard.lanes.flatMap((l) => l.cards).filter((c) => c.type === 'board');
    const restoredChild = restoredParent.children[0]!.id;
    const childCards = projCards.filter((c) => c.child === restoredChild);
    assert.equal(childCards.length, 1, 'exactly one project card references the restored child (no duplicates)');
    const doingLane = rBoard.lanes.find((l) => l.id === 'doing')!;
    assert.ok(doingLane.cards.some((c) => c.type === 'board' && c.child === restoredChild), 'project card lane preserved through restore');
    assert.equal(childCards[0]!.state, 'done', 'restored child rolls up');

    // The restored key hash keeps the original agent token valid.
    const whoami = await call('/api/whoami', { token: key });
    assert.equal(whoami.status, 200, 'exported key survives restore');
    assert.equal(whoami.body['label'], 'alpha-agent');

    // A prose mention of an exported project id is not mistaken for a project
    // card during restore: the registry child still gets exactly one card.
    const mentionImport = await call('/api/org/import', {
      method: 'PUT', token: admin,
      body: JSON.stringify({
        version: 2,
        spaces: [{ name: 'mention-space', projects: [{
          id: 'old-parent', name: 'mention-parent',
          board: { config: 'botflow: 0\nname: mention-parent\n', cards: [{
            path: 'cards/001-note.md',
            text: '---\nid: 001\ntitle: Note\nlane: todo\n---\nmentions project:old-child in prose\n',
          }] },
          children: [{ id: 'old-child', name: 'mention-child', children: [] }],
        }] }],
      }),
    });
    assert.equal(mentionImport.status, 200, JSON.stringify(mentionImport.body));
    const org3 = (await call('/api/org', { token: admin })).body as {
      spaces: { name: string; projects: { id: string; children: { id: string }[] }[] }[];
    };
    const mentionParent = org3.spaces.find((s) => s.name === 'mention-space')!.projects[0]!;
    const mentionChild = mentionParent.children[0]!.id;
    const mentionBoard = (await call(`/api/projects/${mentionParent.id}/board`, { token: admin })).body as {
      lanes: { cards: { type: string; child: string | null }[] }[];
    };
    assert.equal(
      mentionBoard.lanes.flatMap((l) => l.cards).filter((c) => c.type === 'board' && c.child === mentionChild).length,
      1,
      'restore creates the missing project card based on parsed frontmatter',
    );

    // Registry snapshot + delete is one serialized transaction. Children that
    // win the race are included; later creates see no parent. None may survive.
    const raceParent = (await call('/api/projects', {
      method: 'POST', token: admin, body: JSON.stringify({ space: restoredSpace.id, name: 'race-parent' }),
    })).body['id'] as string;
    const deleting = call(`/api/projects/${raceParent}`, { method: 'DELETE', token: admin });
    const creating = Array.from({ length: 40 }, (_, i) => call('/api/projects', {
      method: 'POST', token: admin, body: JSON.stringify({ parent: raceParent, name: `race-${i}` }),
    }));
    const [, ...created] = await Promise.all([deleting, ...creating]);
    const successfulIds = created.filter((r) => r.status === 200).map((r) => r.body['id'] as string);
    for (const id of successfulIds) {
      assert.equal((await call(`/api/projects/${id}/board`, { token: admin })).status, 404, `racing child ${id} survived cascade`);
    }

    // Deletion is audited.
    const audit = (await call('/api/org/activity?limit=50', { token: admin })).body as unknown as { action: string }[];
    assert.ok(audit.some((a) => a.action === 'delete-space'), 'deletion in org audit log');
    assert.ok(audit.some((a) => a.action === 'import'), 'restore in org audit log');
  } finally {
    await stopWorker(child, state);
  }
});

test('setup policy: public hosts fail closed while loopback stays zero-config', () => {
  assert.deepEqual(setupAccess('manager.example.test', undefined, undefined), {
    ok: false, status: 503, error: 'setup is locked: configure the SETUP_KEY Worker secret, then enter it here',
  });
  assert.deepEqual(setupAccess('127.0.0.1', undefined, undefined), { ok: true });
  assert.equal(setupAccess('manager.example.test', 'secret', 'wrong').ok, false);
  assert.deepEqual(setupAccess('manager.example.test', 'secret', 'secret'), { ok: true });
});
