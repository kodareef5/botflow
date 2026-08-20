// Worker API end-to-end: spawns a real `wrangler dev` (isolated state) and
// exercises auth, actor binding, scoping, import/export restore, aggregation,
// sharing, and cascade deletion. Slow (~20s); everything runs in one test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { setupAccess } from '../worker/src/security.ts';

let U = '';
const SETUP_KEY = 'test-setup-key';
const WRANGLER = join(import.meta.dirname, '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');

async function freePort(): Promise<number> {
  // Keep this range disjoint from stress.test.ts's Wrangler range: Node runs
  // test files concurrently, and a check-then-spawn port probe cannot reserve
  // a port across processes.
  const first = Math.floor(Math.random() * 90);
  for (let offset = 0; offset < 90; offset++) {
    const port = 8901 + ((first + offset) % 90);
    const server = createServer();
    const available = await new Promise<boolean>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') resolve(false);
        else reject(error);
      });
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (!available) continue;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }
  throw new Error('no test port available');
}

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

/** A tiny site that advertises Open Graph art, for the unfurl test. */
function ogFixture(port: number): { close: () => Promise<void> } {
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d4944415478da63fcffff3f0300050001274d0b6f0000000049454e44ae426082', 'hex');
  const server = createServer((req, res) => {
    const path = req.url ?? '/';
    if (path.startsWith('/thumb.png')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
      return void res.end(png);
    }
    if (path.startsWith('/redirect-private')) {
      // The classic bypass: a public url that sends you somewhere private.
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      return void res.end();
    }
    if (path.startsWith('/no-og')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return void res.end('<html><head><title>bare</title></head><body>x</body></html>');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><meta property="og:title" content="A Video"><meta property="og:site_name" content="Fixture">'
      + '<meta property="og:image" content="/thumb.png"></head><body>hi</body></html>');
  });
  server.listen(port, '127.0.0.1');
  return { close: () => new Promise<void>((done) => server.close(() => done())) };
}

test('worker api: auth, scoping, restore, aggregation, deletion', { timeout: 180_000 }, async () => {
  const port = await freePort();
  U = `http://127.0.0.1:${port}`;
  const state = mkdtempSync(join(tmpdir(), 'botflow-worker-'));
  // The shipped wrangler.jsonc deliberately has no R2 binding (uploads are
  // opt-in); this run gets one via a generated config so the upload path is
  // exercised for real against workerd's local R2 simulation.
  const config = {
    name: 'botflow-manager-test',
    main: join(import.meta.dirname, '..', 'worker', 'src', 'index.ts'),
    compatibility_date: '2026-08-01',
    compatibility_flags: ['nodejs_compat'],
    migrations: [{ tag: 'v1', new_sqlite_classes: ['RegistryDO', 'ProjectDO'] }],
    durable_objects: {
      bindings: [
        { name: 'REGISTRY', class_name: 'RegistryDO' },
        { name: 'PROJECT', class_name: 'ProjectDO' },
      ],
    },
    r2_buckets: [{ binding: 'ATTACHMENTS', bucket_name: 'test-attachments' }],
  };
  writeFileSync(join(state, 'wrangler.json'), JSON.stringify(config));
  // stdio must be 'ignore': piped output nobody reads fills the pipe buffer
  // and stalls wrangler mid-startup (found the hard way).
  const child = spawn(
    process.execPath,
    [WRANGLER, 'dev', '--config', join(state, 'wrangler.json'), '--port', String(port), '--persist-to', state, '--var', `SETUP_KEY:${SETUP_KEY}`,
      '--var', 'LINK_PREVIEWS:on', '--var', 'UNFURL_ALLOW_PRIVATE:on'],
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

    // The gate tells the form what this deployment actually needs, so it can
    // stop asking for a setup key where one would be ignored.
    const gate0 = (await call('/api/public/gate')).body as { setup: { needsKey: boolean; locked: boolean } };
    assert.deepEqual(gate0.setup, { needsKey: true, locked: false }, 'SETUP_KEY is configured here, so the form must ask');

    // Setup requires the key when configured, and now mints the owner account.
    const OWNER_PW = 'owner-password-1';
    assert.equal((await call('/api/setup', { method: 'POST', body: JSON.stringify({ name: 'testco', username: 'root', password: OWNER_PW }) })).status, 403);
    assert.equal(
      (await call('/api/setup', { method: 'POST', body: JSON.stringify({ name: 'testco', username: 'root', password: 'short', setupKey: SETUP_KEY }) })).status,
      409,
      'a weak owner password does not initialize the company',
    );
    assert.equal(
      (await call('/api/setup', { method: 'POST', body: JSON.stringify({ name: 'testco', username: 'Root Bot', password: OWNER_PW, setupKey: SETUP_KEY }) })).status,
      409,
      'an unusable username does not initialize the company',
    );
    const setup = await call('/api/setup', { method: 'POST', body: JSON.stringify({ name: 'testco', username: 'root', password: OWNER_PW, setupKey: SETUP_KEY }) });
    assert.equal(setup.status, 200);
    const admin = setup.body['token'] as string;
    assert.ok(admin.startsWith('bfu_'), 'setup returns a live session, not a token to copy down');
    assert.equal(
      (await call('/api/setup', { method: 'POST', body: JSON.stringify({ name: 'again', username: 'x', password: OWNER_PW, setupKey: 'guess' }) })).status,
      409,
      'initialized deployments do not act as setup-key oracles',
    );

    // Login is the ordinary way in; a wrong password is not a way in.
    assert.equal((await call('/api/login', { method: 'POST', body: JSON.stringify({ username: 'root', password: 'nope' }) })).status, 401);
    assert.equal((await call('/api/login', { method: 'POST', body: JSON.stringify({ username: 'ghost', password: OWNER_PW }) })).status, 401);
    const second = await call('/api/login', { method: 'POST', body: JSON.stringify({ username: 'root', password: OWNER_PW }) });
    assert.equal(second.status, 200, 'the owner can open a second session');
    assert.equal((await call('/api/whoami', { token: second.body['token'] as string })).body['role'], 'owner');
    await call('/api/logout', { method: 'POST', token: second.body['token'] as string });
    assert.equal((await call('/api/whoami', { token: second.body['token'] as string })).status, 401, 'logout kills that session only');
    assert.equal((await call('/api/whoami', { token: admin })).status, 200, 'and leaves the other one alone');

    // Org structure: space, parent, child.
    const space = (await call('/api/spaces', { method: 'POST', token: admin, body: JSON.stringify({ name: 'eng' }) })).body['id'] as string;
    const parent = (await call('/api/projects', { method: 'POST', token: admin, body: JSON.stringify({ space, name: 'parent' }) })).body['id'] as string;
    const childP = (await call('/api/projects', { method: 'POST', token: admin, body: JSON.stringify({ parent, name: 'child', lane: 'doing' }) })).body['id'] as string;
    const stranger = (await call('/api/projects', { method: 'POST', token: admin, body: JSON.stringify({ space, name: 'stranger' }) })).body['id'] as string;
    // A second space with two sibling projects: the shape a space-wide grant
    // has to cover and a project-wide one must not.
    const space2 = (await call('/api/spaces', { method: 'POST', token: admin, body: JSON.stringify({ name: 'ops' }) })).body['id'] as string;
    const sibA = (await call('/api/projects', { method: 'POST', token: admin, body: JSON.stringify({ space: space2, name: 'sib-a' }) })).body['id'] as string;
    const sibB = (await call('/api/projects', { method: 'POST', token: admin, body: JSON.stringify({ space: space2, name: 'sib-b' }) })).body['id'] as string;

    // Structured card fields keep their JSON types across the hosted API and
    // invalid types fail instead of being silently coerced.
    const scheduledCreate = await call(`/api/projects/${sibA}/cards`, {
      method: 'POST', token: admin, body: JSON.stringify({
        title: 'Scheduled API card', start: '2026-08-20', due: '2026-08-24T12:30Z',
        estimate: 5, evergreen: true, assignee: 'root', delegate: 'agent-a',
      }),
    });
    assert.equal(scheduledCreate.status, 200);
    const scheduledId = scheduledCreate.body['id'] as string;
    let scheduled = (await call(`/api/projects/${sibA}/cards/${scheduledId}`, { token: admin })).body;
    assert.equal(scheduled['start'], '2026-08-20');
    assert.equal(scheduled['due'], '2026-08-24T12:30Z');
    assert.equal(scheduled['estimate'], 5);
    assert.equal(scheduled['evergreen'], true);
    assert.equal(scheduled['assignee'], 'root');
    assert.equal(scheduled['delegate'], 'agent-a');
    const scheduledEdit = await call(`/api/projects/${sibA}/cards/${scheduledId}/edit`, {
      method: 'POST', token: admin, body: JSON.stringify({ start: null, estimate: null, evergreen: false }),
    });
    assert.equal(scheduledEdit.status, 200);
    scheduled = (await call(`/api/projects/${sibA}/cards/${scheduledId}`, { token: admin })).body;
    assert.equal(scheduled['start'], null);
    assert.equal(scheduled['estimate'], null);
    assert.equal(scheduled['evergreen'], false);
    assert.equal((await call(`/api/projects/${sibA}/cards`, {
      method: 'POST', token: admin, body: JSON.stringify({ title: 'Bad types', estimate: true }),
    })).status, 400);
    assert.equal((await call(`/api/projects/${sibA}/cards/${scheduledId}/edit`, {
      method: 'POST', token: admin, body: JSON.stringify({ evergreen: 'yes' }),
    })).status, 400);

    // A sub-project whose parent card cannot be created must not survive as
    // a registry orphan: the create compensates and fails whole.
    const badLane = await call('/api/projects', { method: 'POST', token: admin, body: JSON.stringify({ parent, name: 'ghost', lane: 'no-such-lane' }) });
    assert.equal(badLane.status, 400, 'invalid parent lane rejects the sub-project');
    const orgTree0 = (await call('/api/org', { token: admin })).body as { spaces: { projects: { name: string; children: { name: string }[] }[] }[] };
    const parentNode0 = orgTree0.spaces[0]!.projects.find((p) => p.name === 'parent')!;
    assert.ok(!parentNode0.children.some((c) => c.name === 'ghost'), 'no orphan child in the org tree');

    // A bot member scoped to `parent`, plus an api key for it. Actor forgery
    // must be impossible: identity comes from the credential, never the body.
    const BOT_PW = 'alpha-agent-pw';
    const botCreate = await call('/api/members', { method: 'POST', token: admin, body: JSON.stringify({
      username: 'alpha-agent', display: 'Alpha Agent', kind: 'bot', password: BOT_PW,
      role: 'write', scopeKind: 'project', scopeId: parent,
    }) });
    assert.equal(botCreate.status, 200);
    const botId = botCreate.body['id'] as string;
    const mintedKey = await call(`/api/keys?member=${botId}`, { method: 'POST', token: admin, body: JSON.stringify({}) });
    assert.equal(mintedKey.body['label'], 'api key #1', 'an unnamed key names itself');
    const key = mintedKey.body['token'] as string;
    assert.ok(key.startsWith('bfk_'));
    const own = (await call(`/api/projects/${parent}/cards`, { method: 'POST', token: key, body: JSON.stringify({ title: 'Own task', actor: 'admin' }) })).body['id'] as string;
    const claimed = await call(`/api/projects/${parent}/cards/${own}/claim`, { method: 'POST', token: key, body: JSON.stringify({ actor: 'imposter' }) });
    assert.equal(claimed.status, 200, 'ready unassigned card claims fine');
    const forged = await call(`/api/projects/${parent}/cards/${own}`, { token: admin });
    assert.equal(forged.body['delegate'], 'alpha-agent', 'bot delegate bound to the member username, not the request body');
    assert.equal(forged.body['assignee'], null, 'bot claim does not impersonate an accountable human');
    assert.equal(forged.body['author'], 'alpha-agent', 'the card records who created it');
    const events = (await call(`/api/projects/${parent}/events?limit=10`, { token: admin })).body as unknown as { actor: string }[];
    assert.ok(events.filter((e) => e.actor === 'alpha-agent').length >= 2, 'audit records the member username');
    assert.equal(events.some((e) => e.actor === 'imposter'), false, 'forged actor never recorded');
    assert.equal(events.some((e) => e.actor === 'admin'), false, 'nor the one smuggled in at create time');

    // Claim is conditional: re-claim by the same role holder is a no-op. The
    // human ownership role is separate, but the card is already doing, so a
    // non-forced owner claim still gets a structured 409; force takes it back.
    const again = await call(`/api/projects/${parent}/cards/${own}/claim`, { method: 'POST', token: key, body: JSON.stringify({}) });
    assert.equal(again.status, 200);
    assert.equal(again.body['alreadyYours'], true, 're-claim by holder is idempotent');
    const lost = await call(`/api/projects/${parent}/cards/${own}/claim`, { method: 'POST', token: admin, body: JSON.stringify({}) });
    assert.equal(lost.status, 409, 'claiming a held card conflicts');
    const conflict = lost.body['conflict'] as { reason: string; holder: string };
    assert.equal(conflict.reason, 'not-ready');
    assert.equal(conflict.holder, null);
    const agentForce = await call(`/api/projects/${parent}/cards/${own}/claim`, { method: 'POST', token: key, body: JSON.stringify({ force: true }) });
    assert.equal(agentForce.status, 403, 'force is an owner-only override');
    const agentForceMove = await call(`/api/projects/${parent}/cards/${own}/move`, { method: 'POST', token: key, body: JSON.stringify({ to: 'done', force: true }) });
    assert.equal(agentForceMove.status, 403, 'forced moves are owner-only too');
    const forcedClaim = await call(`/api/projects/${parent}/cards/${own}/claim`, { method: 'POST', token: admin, body: JSON.stringify({ force: true }) });
    assert.equal(forcedClaim.status, 200);
    assert.equal(forcedClaim.body['assignee'], 'root', 'force takes the card under the owner username');
    const forceAudit = (await call('/api/org/activity?limit=10', { token: admin })).body as unknown as { action: string }[];
    assert.ok(forceAudit.some((a) => a.action === 'force-override'), 'admin force use lands in the org audit log');

    // Company activity is keyset-paginated. The cursor is exclusive so two
    // adjacent pages cannot repeat an event, even as newer rows are appended.
    type AuditItem = { seq: number; action: string };
    const newestAudit = (await call('/api/org/activity?limit=3', { token: admin })).body as unknown as AuditItem[];
    assert.equal(newestAudit.length, 3);
    assert.ok(newestAudit.every((row, i) => i === 0 || newestAudit[i - 1]!.seq > row.seq), 'activity is newest first');
    const auditCursor = newestAudit.at(-1)!.seq;
    const olderAudit = (await call(`/api/org/activity?limit=3&before=${auditCursor}`, { token: admin })).body as unknown as AuditItem[];
    assert.equal(olderAudit.length, 3);
    assert.ok(olderAudit.every((row) => row.seq < auditCursor), 'the next page is strictly older than its cursor');
    assert.equal(new Set([...newestAudit, ...olderAudit].map((row) => row.seq)).size, 6, 'adjacent pages do not overlap');
    for (const badCursor of ['0', '-1', '1.5', 'not-a-sequence']) {
      assert.equal((await call(`/api/org/activity?before=${badCursor}`, { token: admin })).status, 400, `rejects cursor ${badCursor}`);
    }

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

    // Board editor: admins reshape lanes/rollup with card migrations; agents
    // cannot; invalid shapes are rejected whole.
    const cfg0 = await call(`/api/projects/${parent}/config`, { token: admin });
    assert.equal(cfg0.status, 200);
    assert.ok((cfg0.body['lanes'] as unknown[]).length >= 6, 'default lanes visible');
    const reshape = {
      name: 'parent reshaped',
      lanes: [
        { id: 'todo' },
        { id: 'doing', substates: ['design', 'review'], order: 'strict' },
        { id: 'needs-qa', canonical: 'doing', wip: 2 },
        { id: 'done' },
      ],
      rollup: { blockedWhen: 'never', doingWhen: 'any-doing', elseState: 'todo' },
      migrations: { wishlist: 'todo' },
    };
    assert.equal((await call(`/api/projects/${parent}/config`, { method: 'PUT', token: key, body: JSON.stringify(reshape) })).status, 403, 'non-owners cannot reshape boards');
    assert.equal((await call(`/api/projects/${parent}/config`, { method: 'PUT', token: admin, body: JSON.stringify({ name: 'x', lanes: [{ id: 'weird' }] }) })).status, 400, 'custom lane without canonical rejected');
    const put = await call(`/api/projects/${parent}/config`, { method: 'PUT', token: admin, body: JSON.stringify(reshape) });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const cfg1 = await call(`/api/projects/${parent}/config`, { token: admin });
    assert.deepEqual((cfg1.body['lanes'] as { id: string }[]).map((l) => l.id), ['todo', 'doing', 'needs-qa', 'done']);
    assert.equal((cfg1.body['rollup'] as { doingWhen: string }).doingWhen, 'any-doing');
    const migrated = await call(`/api/projects/${parent}/cards/001`, { token: admin });
    assert.equal(migrated.body['position'], 'doing.design', 'doing card entered the new substate machine');
    assert.match(String(migrated.body['body']), /migrated doing → doing\.design \(board edit\)/, 'migration logged on the card');
    const boardShape = (await call(`/api/projects/${parent}/board`, { token: admin })).body as { lanes: { id: string }[]; findings: unknown[] };
    assert.deepEqual(boardShape.lanes.map((l) => l.id), ['todo', 'doing', 'needs-qa', 'done']);
    assert.equal(boardShape.findings.filter((f) => (f as { severity: string }).severity === 'error').length, 0, 'reshaped board lints clean');

    // Hosted board edits preserve additive board.yaml data they do not own,
    // while a declared capability this manager cannot honor is refused before
    // it can replace the live snapshot.
    const compatProject = (await call('/api/projects', {
      method: 'POST', token: admin, body: JSON.stringify({ space: space2, name: 'compatibility' }),
    })).body['id'] as string;
    const compatConfig = `botflow: 0
name: compatibility
lanes:
  - id: todo
    visual:
      color: blue
  - id: done
rollup:
  future_mode: weighted
vendor:
  flags: [alpha, beta]
`;
    assert.equal((await call(`/api/projects/${compatProject}/import`, {
      method: 'PUT', token: admin, body: JSON.stringify({ config: compatConfig, cards: [] }),
    })).status, 200);
    const compatEdit = await call(`/api/projects/${compatProject}/config`, {
      method: 'PUT', token: admin, body: JSON.stringify({
        name: 'compatibility edited', lanes: [{ id: 'todo' }, { id: 'done' }], rollup: {},
      }),
    });
    assert.equal(compatEdit.status, 200, JSON.stringify(compatEdit.body));
    const compatExport = await call(`/api/projects/${compatProject}/export`, { token: admin });
    const preservedConfig = compatExport.body['config'] as string;
    assert.match(preservedConfig, /visual:\n      color: blue/);
    assert.match(preservedConfig, /future_mode: weighted/);
    assert.match(preservedConfig, /vendor:\n  flags: \[alpha, beta\]/);
    const unsupportedImport = await call(`/api/projects/${compatProject}/import`, {
      method: 'PUT', token: admin,
      body: JSON.stringify({ config: 'botflow: 0\nname: future\nfeatures: [teleportation]\n', cards: [] }),
    });
    assert.equal(unsupportedImport.status, 400);
    assert.match(String(unsupportedImport.body['error']), /unsupported board feature/);
    assert.equal((await call(`/api/projects/${compatProject}/export`, { token: admin })).body['config'], preservedConfig,
      'rejected future snapshot leaves the current board byte-identical');

    // ---- link previews ----
    // A url is not an image, but the page behind it may advertise one. The
    // worker fetches it once, server-side, and proxies the picture: a viewer's
    // browser never contacts the site being previewed, which is what makes
    // this safe to render on a public share page.
    const OG_PORT = await freePort();
    const site = ogFixture(OG_PORT);
    try {
      const withArt = (await call(`/api/projects/${parent}/cards`, { method: 'POST', token: admin, body: JSON.stringify({ title: 'Watch this' }) })).body['id'] as string;
      await call(`/api/projects/${parent}/cards/${withArt}/attach`, { method: 'POST', token: admin, body: JSON.stringify({ url: `http://127.0.0.1:${OG_PORT}/watch` }) });

      /** Poll until this card has previews, since unfurling happens after the
       *  response that triggered it. */
      const previewOf = async (cid: string): Promise<{ url: string; image: string }[]> => {
        for (let i = 0; i < 30; i++) {
          const board = (await call(`/api/projects/${parent}/board`, { token: admin })).body as unknown as
            { lanes: { cards: { id: string; previews?: { url: string; image: string }[] }[] }[] };
          const card = board.lanes.flatMap((l) => l.cards).find((c) => c.id === cid);
          if (card?.previews) return card.previews;
          await new Promise((r) => setTimeout(r, 200));
        }
        return [];
      };
      /** Assert a url yields nothing, by racing it against one that works.
       *  Waiting for an absence would pass just as well if the pipeline were
       *  merely slow; pairing it with a url that must resolve proves the
       *  refusal is specific rather than a timeout. */
      const refuses = async (title: string, bad: string): Promise<void> => {
        const cid = (await call(`/api/projects/${parent}/cards`, { method: 'POST', token: admin, body: JSON.stringify({ title }) })).body['id'] as string;
        await call(`/api/projects/${parent}/cards/${cid}/attach`, { method: 'POST', token: admin, body: JSON.stringify({ url: bad }) });
        await call(`/api/projects/${parent}/cards/${cid}/attach`, { method: 'POST', token: admin, body: JSON.stringify({ url: `http://127.0.0.1:${OG_PORT}/watch?for=${cid}` }) });
        const got = await previewOf(cid);
        assert.equal(got.length, 1, `${title}: exactly the good link previewed`);
        assert.match(got[0]!.url, /\/watch\?for=/, `${title}: and it is the good one`);
      };

      const previews = await previewOf(withArt);
      assert.equal(previews.length, 1, 'the page advertised a picture');
      assert.equal(previews[0]!.url, `http://127.0.0.1:${OG_PORT}/watch`, 'the preview names the link it stands for');
      assert.match(previews[0]!.image, /^\/og\/[a-f0-9]{64}\?p=/, 'and points at this worker, never at the far site');

      // The proxy serves it unauthenticated, because a share page must render
      // it, and returns the real bytes.
      const art = await fetch(U + previews[0]!.image);
      assert.equal(art.status, 200);
      assert.equal(art.headers.get('content-type'), 'image/png');
      assert.equal(art.headers.get('content-security-policy'), 'sandbox');
      const bytes = new Uint8Array(await art.arrayBuffer());
      assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a real png came back');

      // It resolves only hashes this worker already chose to fetch, so it is
      // not an open proxy.
      assert.equal((await fetch(`${U}/og/${'a'.repeat(64)}?p=${parent}`)).status, 404);

      // cover: none outranks a preview. cover is null either way, so coverAuto
      // is what carries the difference.
      await call(`/api/projects/${parent}/cards/${withArt}/edit`, { method: 'POST', token: admin, body: JSON.stringify({ cover: 'none' }) });
      const hidden = (await call(`/api/projects/${parent}/cards/${withArt}`, { token: admin })).body;
      assert.equal(hidden['cover'], null);
      assert.equal(hidden['coverAuto'], false, 'suppressed art is not the same as absent art');

      // A page with no og:image advertises nothing, and a public url that
      // redirects into private space must be refused at the hop rather than
      // only at the start, which is the usual way past a naive guard.
      await refuses('Bare page', `http://127.0.0.1:${OG_PORT}/no-og`);
      await refuses('Redirector', `http://127.0.0.1:${OG_PORT}/redirect-private`);
    } finally {
      await site.close();
    }

    // Card authoring: description + checklist tasks through the API.
    await call(`/api/projects/${parent}/cards/002/describe`, { method: 'POST', token: key, body: JSON.stringify({ text: 'Written by an agent.' }) });
    await call(`/api/projects/${parent}/cards/002/checkadd`, { method: 'POST', token: key, body: JSON.stringify({ text: 'verify the thing' }) });
    await call(`/api/projects/${parent}/cards/002/checkadd`, { method: 'POST', token: key, body: JSON.stringify({ text: 'ship it', section: 'Launch' }) });
    const authored = await call(`/api/projects/${parent}/cards/002`, { token: admin });
    const authoredParsed = authored.body['parsed'] as { description: string | null; checklists: { section: string }[] };
    assert.equal(authoredParsed.description, 'Written by an agent.');
    assert.deepEqual(authoredParsed.checklists.map((cl) => cl.section), ['Checklist', 'Launch']);
    assert.deepEqual(authored.body['checklist'], { done: 0, total: 2 });

    // ---- the members model: scopes, roles, credential forms, renaming ----

    // A space-scoped reader and a project-scoped writer, over the same tree.
    const READER_PW = 'reader-password-1';
    assert.equal((await call('/api/members', { method: 'POST', token: admin, body: JSON.stringify({
      username: 'alpha-agent', kind: 'human', password: READER_PW, role: 'read', scopeKind: 'org' }) })).status, 400,
      'usernames are unique: card logs would otherwise be ambiguous');
    assert.equal((await call('/api/members', { method: 'POST', token: admin, body: JSON.stringify({
      username: 'nowhere', kind: 'human', password: READER_PW, role: 'read', scopeKind: 'project', scopeId: 'p-nope' }) })).status, 400,
      'a grant over a project that does not exist is refused');
    const readerId = (await call('/api/members', { method: 'POST', token: admin, body: JSON.stringify({
      username: 'watcher', display: 'Wendy Watcher', kind: 'human', password: READER_PW,
      role: 'read', scopeKind: 'space', scopeId: space2 }) })).body['id'] as string;
    const reader = (await call('/api/login', { method: 'POST', body: JSON.stringify({ username: 'watcher', password: READER_PW }) })).body['token'] as string;

    // Space scope reaches every project in that space, which is the grant
    // shape the old per-project keys could not express at all.
    assert.equal((await call(`/api/projects/${sibA}/board`, { token: reader })).status, 200, 'space scope reaches one sibling');
    assert.equal((await call(`/api/projects/${sibB}/board`, { token: reader })).status, 200, 'space scope reaches the other');
    assert.equal((await call(`/api/projects/${parent}/board`, { token: reader })).status, 403, 'and stops at the space boundary');

    // Read really means read.
    assert.equal((await call(`/api/projects/${sibA}/cards`, { method: 'POST', token: reader, body: JSON.stringify({ title: 'nope' }) })).status, 403, 'a reader cannot create cards');
    assert.equal((await call(`/api/projects/${sibA}/import`, { method: 'PUT', token: reader, body: JSON.stringify({ config: 'botflow: 0\nlanes:\n  - id: todo\n', cards: [] }) })).status, 403, 'a reader cannot replace a board');
    assert.equal((await call('/api/spaces', { method: 'POST', token: reader, body: JSON.stringify({ name: 'mine' }) })).status, 403, 'a reader is not an owner');
    assert.equal((await call('/api/members', { token: reader })).status, 403, 'a reader cannot read the member directory');

    // The org tree a member bootstraps from is their slice, not the company.
    const readerOrg = (await call('/api/org', { token: reader })).body as {
      spaces: { id: string }[]; me: { role: string; display: string }; directory: { username: string; display: string }[];
    };
    assert.deepEqual(readerOrg.spaces.map((sp) => sp.id), [space2], 'a scoped member sees only their own space');
    assert.equal(readerOrg.me.role, 'read');
    assert.ok(readerOrg.directory.some((d) => d.username === 'alpha-agent'), 'the directory resolves other members by name');

    // A bot authenticates with its own username and password, and produces
    // the same identity as its api key does.
    const basic = `Basic ${Buffer.from(`alpha-agent:${BOT_PW}`).toString('base64')}`;
    const basicWho = await fetch(`${U}/api/whoami`, { headers: { authorization: basic } });
    assert.equal(basicWho.status, 200, 'a bot can use basic auth');
    assert.equal(((await basicWho.json()) as { username: string }).username, 'alpha-agent');
    const badBasic = await fetch(`${U}/api/whoami`, { headers: { authorization: `Basic ${Buffer.from('alpha-agent:wrong').toString('base64')}` } });
    assert.equal(badBasic.status, 401, 'a wrong password is not a way in');

    // Key labels are notes to self: renaming one changes no identity anywhere.
    const keys = (await call(`/api/keys?member=${botId}`, { token: admin })).body as unknown as { id: string; label: string }[];
    const keyId = keys[0]!.id;
    assert.equal((await call(`/api/keys/${keyId}`, { method: 'PATCH', token: admin, body: JSON.stringify({ label: 'CI runner' }) })).status, 200);
    assert.equal(((await call(`/api/keys?member=${botId}`, { token: admin })).body as unknown as { label: string }[])[0]!.label, 'CI runner');
    assert.equal(((await call(`/api/whoami`, { token: key })).body)['username'], 'alpha-agent', 'renaming a key does not rename its member');
    const second2 = await call(`/api/keys?member=${botId}`, { method: 'POST', token: admin, body: JSON.stringify({}) });
    assert.equal(second2.body['label'], 'api key #2', 'default key names do not collide after a rename');
    assert.equal((await call(`/api/keys?member=${botId}`, { method: 'POST', token: reader, body: JSON.stringify({}) })).status, 403,
      'a non-owner cannot provision a key for another member');
    assert.equal((await call(`/api/keys/${keyId}`, { method: 'PATCH', token: reader, body: JSON.stringify({ label: 'stolen' }) })).status, 403, 'you cannot rename someone else\'s key');

    // The bug this whole model exists to fix: a display-name edit must show
    // up on the boards without rewriting one byte of card history.
    // A card the bot creates here and now: an earlier import replaced card
    // 001's body with one carrying no log, which correctly has no author.
    assert.equal(
      ((await call(`/api/projects/${parent}/cards/${own}`, { token: admin })).body)['author'], null,
      'a card imported without a creation entry claims no author',
    );
    const fresh = (await call(`/api/projects/${parent}/cards`, { method: 'POST', token: key, body: JSON.stringify({ title: 'Named by its maker' }) })).body['id'] as string;
    const cardBefore = (await call(`/api/projects/${parent}/cards/${fresh}`, { token: admin })).body;
    assert.equal(cardBefore['author'], 'alpha-agent', 'the card records its creator');
    assert.equal((await call(`/api/members/${botId}`, { method: 'PATCH', token: admin, body: JSON.stringify({ display: 'Renamed Bot' }) })).status, 200);
    const dir = (await call('/api/org', { token: admin })).body['directory'] as { username: string; display: string }[];
    assert.equal(dir.find((d) => d.username === 'alpha-agent')!.display, 'Renamed Bot', 'the rename is live for every board view');
    const cardAfter = (await call(`/api/projects/${parent}/cards/${fresh}`, { token: admin })).body;
    assert.equal(cardAfter['body'], cardBefore['body'], 'and the stored card is byte-identical: history is not rewritten');

    // Disabling a member cuts every credential it holds at once.
    assert.equal((await call(`/api/members/${readerId}`, { method: 'PATCH', token: admin, body: JSON.stringify({ disabled: true }) })).status, 200);
    assert.equal((await call('/api/whoami', { token: reader })).status, 401, 'a disabled member has no sessions');
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

    // Card-scoped share: a capability for exactly one card.
    assert.equal(
      (await call(`/api/projects/${parent}/shares`, { method: 'POST', token: admin, body: JSON.stringify({ label: 'ghost', card: '999' }) })).status,
      400, 'card share requires a real card',
    );
    // Binary uploads: R2-backed, format-truthful (a normal attachment line),
    // capability-served from /files, inline only for safe types.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3]);
    const uploaded = await fetch(`${U}/api/projects/${parent}/cards/001/upload?name=shot.png`, {
      method: 'POST', headers: { 'content-type': 'image/png', authorization: `Bearer ${admin}` }, body: png,
    });
    assert.equal(uploaded.status, 200, JSON.stringify(await uploaded.clone().json().catch(() => ({}))));
    const upUrl = ((await uploaded.json()) as { url: string }).url;
    assert.match(upUrl, new RegExp(`^/files/${parent}/001/[a-f0-9]{32}-shot\\.png$`), '128-bit capability segment');
    const served = await fetch(U + upUrl);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.equal(served.headers.get('content-disposition'), null, 'images render inline');
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), png, 'bytes round-trip');
    const withUpload = await call(`/api/projects/${parent}/cards/001`, { token: admin });
    const uploadAtts = (withUpload.body['parsed'] as { attachments: { url: string; index: number }[] }).attachments;
    assert.ok(uploadAtts.some((a) => a.url === upUrl), 'upload recorded as a markdown attachment line');

    const evil = await fetch(`${U}/api/projects/${parent}/cards/001/upload?name=page.html`, {
      method: 'POST', headers: { 'content-type': 'text/html', authorization: `Bearer ${admin}` }, body: '<script>alert(1)</script>',
    });
    const evilUrl = ((await evil.json()) as { url: string }).url;
    const evilServed = await fetch(U + evilUrl);
    assert.match(evilServed.headers.get('content-disposition') ?? '', /^attachment/, 'html never renders inline');
    assert.equal(evilServed.headers.get('content-security-policy'), 'sandbox');

    // Detach drops the R2 object too.
    const detachIdx = ((await call(`/api/projects/${parent}/cards/001`, { token: admin })).body['parsed'] as { attachments: { url: string; index: number }[] })
      .attachments.find((a) => a.url === evilUrl)!.index;
    await call(`/api/projects/${parent}/cards/001/detach`, { method: 'POST', token: admin, body: JSON.stringify({ index: detachIdx }) });
    assert.equal((await fetch(U + evilUrl)).status, 404, 'detached upload is gone from storage');
    assert.equal((await call('/api/org', { token: admin })).body['uploads'], true, 'org advertises uploads');

    // Detaching a REFERENCE to someone else's /files/ key must never delete
    // their object: only same-card uploads are purged.
    await call(`/api/projects/${stranger}/cards/001/attach`, { method: 'POST', token: admin, body: JSON.stringify({ url: upUrl, label: 'borrowed' }) });
    const strangerCard = (await call(`/api/projects/${stranger}/cards/001`, { token: admin })).body as unknown as { parsed: { attachments: { index: number; url: string }[] } };
    const borrowedIdx = strangerCard.parsed.attachments.find((a) => a.url === upUrl)!.index;
    await call(`/api/projects/${stranger}/cards/001/detach`, { method: 'POST', token: admin, body: JSON.stringify({ index: borrowedIdx }) });
    assert.equal((await fetch(U + upUrl)).status, 200, 'foreign object survives a cross-project detach');

    // Post-import the board holds 001 (own task) and 002 (sneak): scope to 001.
    const cardShare = (await call(`/api/projects/${parent}/shares`, { method: 'POST', token: admin, body: JSON.stringify({ label: 'one card', card: '001' }) })).body['token'] as string;
    assert.equal((await call(`/api/public/${cardShare}/cards/001`)).status, 200, 'the scoped card is visible');
    assert.equal((await call(`/api/public/${cardShare}/board`)).status, 404, 'the board is not');
    assert.equal((await call(`/api/public/${cardShare}/cards/002`)).status, 404, 'sibling cards are not');
    const gateWithCard = (await call('/api/public/gate')).body as { shares: { token: string }[] };
    assert.ok(!gateWithCard.shares.some((s) => s.token === cardShare), 'card shares never list on the gate');
    const shareRows = (await call(`/api/projects/${parent}/shares`, { token: admin })).body as unknown as { token: string; cardId: string | null }[];
    assert.equal(shareRows.find((s) => s.token === cardShare)?.cardId, '001', 'scope visible in the listing');
    const cardPage = await fetch(`${U}/s/${cardShare}`);
    assert.ok((await cardPage.text()).includes('__PUBCARD__="001"'), 'card page carries its scope');
    const themed = await call('/api/settings', {
      method: 'POST', token: admin,
      body: JSON.stringify({ style: 'fieldnotes', accent: 'redpencil', mode: 'dark', density: 'compact', gateShares: false }),
    });
    assert.equal(themed.body['density'], 'compact');
    const exported = (await call('/api/org/export', { token: admin })).body as Record<string, unknown>;
    assert.equal(exported['version'], 3, 'members and member-keyed api keys are a new export shape');
    assert.ok(Array.isArray(exported['keys']) && (exported['keys'] as unknown[]).length === 2, 'both of the bot keys exported');
    const exportedMembers = exported['members'] as { username: string; passHash: string; role: string }[];
    assert.ok(Array.isArray(exportedMembers), 'members exported');
    assert.deepEqual(exportedMembers.map((m) => m.username).sort(), ['alpha-agent', 'root', 'watcher']);
    // Password hashes ride along or a restore locks the owner out of their
    // own company. That is also why the export is a credential.
    assert.match(exportedMembers.find((m) => m.username === 'root')!.passHash, /^pbkdf2\$/);
    assert.ok((exported['keys'] as { username: string }[]).every((k) => k.username === 'alpha-agent'), 'keys name their member, not a project');
    const manifest = exported['uploads'] as { key: string }[];
    assert.ok(manifest.some((u) => upUrl === `/files/${u.key}`), 'export manifests uploaded objects');
    await call('/api/settings', {
      method: 'POST', token: admin,
      body: JSON.stringify({ style: 'harbor', accent: 'pacific', mode: 'light', density: 'relaxed' }),
    });

    await call(`/api/spaces/${space}`, { method: 'DELETE', token: admin });
    assert.equal((await call(`/api/public/${share}/board`)).status, 404, 'share died with the space');
    // Deleting the space took the bot's whole scope with it, so the member is
    // disabled and every credential it holds stops working at once.
    assert.equal((await call(`/api/projects/${parent}/board`, { token: key })).status, 401, 'a member with no scope left cannot authenticate');
    // Including a basic-auth credential that was verified moments ago: the
    // derivation is cached, the member's state never is.
    assert.equal(
      (await fetch(`${U}/api/whoami`, { headers: { authorization: `Basic ${Buffer.from(`alpha-agent:${BOT_PW}`).toString('base64')}` } })).status,
      401,
      'a cached basic-auth credential dies with its scope too',
    );
    // The space-scoped reader loses access on the same deletion, even though
    // no project it named was individually deleted.
    assert.equal((await call('/api/whoami', { token: reader })).status, 401, 'space-scoped members are disabled with their space');

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
    const restoredSettings = await call('/api/settings', { token: admin });
    assert.deepEqual(
      { style: restoredSettings.body['style'], accent: restoredSettings.body['accent'], mode: restoredSettings.body['mode'], density: restoredSettings.body['density'] },
      { style: 'fieldnotes', accent: 'redpencil', mode: 'dark', density: 'compact' },
      'visual system and density survive a restore',
    );

    // The restored member and key hash keep the original bot credential valid.
    const whoami = await call('/api/whoami', { token: key });
    assert.equal(whoami.status, 200, 'exported member and key survive restore');
    assert.equal(whoami.body['username'], 'alpha-agent');
    assert.equal(whoami.body['kind'], 'bot');

    // A version-2 backup predates members, so its project-keyed `keys` block
    // cannot be re-homed. The boards must still restore: refusing the whole
    // payload would strand every card in someone's only backup.
    const legacy = {
      version: 2, name: 'legacy co',
      keys: [{ hash: 'a'.repeat(64), projectId: 'p-old', label: 'old agent', created: '2026-01-01T00:00:00.000Z', revoked: false }],
      spaces: [{ id: 's-old', name: 'legacy space', projects: [{ id: 'p-old', name: 'legacy project', board: { config: 'botflow: 0\nname: legacy project\nlanes:\n  - id: todo\n', cards: [] }, children: [] }] }],
    };
    // A v2 payload's members are not validated (the validator gates on v3), so
    // they must not be applied either: an unvalidated members block would skip
    // every check the validator exists to make.
    const smuggled = {
      ...legacy,
      members: [{ username: 'root', display: 'pwned', kind: 'human', role: 'owner', scopeKind: 'org', scopeId: null,
        passHash: `pbkdf2$100000$${'a'.repeat(32)}$${'b'.repeat(64)}`, disabled: false, created: '2026-01-01T00:00:00.000Z' }],
    };
    assert.equal((await call('/api/org/import', { method: 'PUT', token: admin, body: JSON.stringify(smuggled) })).status, 200);
    assert.equal((await call('/api/org', { token: admin })).status, 200, 'the owner session still works: no password was overwritten');

    const legacyImport = await call('/api/org/import', { method: 'PUT', token: admin, body: JSON.stringify(legacy) });
    assert.equal(legacyImport.status, 200, `a v2 backup still restores: ${JSON.stringify(legacyImport.body)}`);
    const afterLegacy = (await call('/api/org', { token: admin })).body as { spaces: { name: string }[] };
    assert.ok(afterLegacy.spaces.some((sp) => sp.name === 'legacy space'), 'and its boards come back');
    const legacyAudit = (await call('/api/org/activity?limit=20', { token: admin })).body as unknown as { action: string }[];
    assert.ok(legacyAudit.some((a) => a.action === 'import-legacy-keys-dropped'), 'while saying plainly that its keys did not');

    // A restored owner is org-wide by construction: role checks never consult
    // scope, so a row claiming owner+project would gate as owner while the
    // members table showed it as project-scoped.
    const exportedNow = (await call('/api/org/export', { token: admin })).body as Record<string, unknown>;
    const narrowed = {
      ...exportedNow,
      members: (exportedNow['members'] as Record<string, unknown>[]).map((m) =>
        m['role'] === 'owner' ? { ...m, scopeKind: 'project', scopeId: 'p-anything' } : m),
    };
    assert.equal((await call('/api/org/import', { method: 'PUT', token: admin, body: JSON.stringify(narrowed) })).status, 200);
    const owners = ((await call('/api/members', { token: admin })).body as unknown as { role: string; scopeKind: string }[])
      .filter((m) => m.role === 'owner');
    assert.ok(owners.length > 0);
    assert.ok(owners.every((m) => m.scopeKind === 'org'), 'a restored owner is normalized back to org scope');
    const credAudit = (await call('/api/org/activity?limit=30', { token: admin })).body as unknown as { action: string }[];
    assert.ok(credAudit.some((a) => a.action === 'import-credentials'), 'and the restore itemizes what it brought');

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

    // Rotating a credential is how an operator throws someone out. An api key
    // that outlived the reset would leave them holding the access it revoked.
    const evictKey = (await call(`/api/keys?member=${botId}`, { method: 'POST', token: admin, body: JSON.stringify({}) })).body['token'] as string;
    assert.equal((await call('/api/whoami', { token: evictKey })).status, 200, 'the key works to begin with');
    await call(`/api/members/${botId}/password`, { method: 'POST', token: admin, body: JSON.stringify({ password: 'rotated-bot-pw-1' }) });
    assert.equal((await call('/api/whoami', { token: evictKey })).status, 401, 'a password reset revokes that member api keys');

    // A username is the actor string already written into card logs, so
    // removing a member must not free it for someone else to inherit.
    const ghost = (await call('/api/members', { method: 'POST', token: admin, body: JSON.stringify({
      username: 'ghost', kind: 'human', password: 'ghost-pass-1', role: 'read', scopeKind: 'org' }) })).body['id'] as string;
    assert.equal((await call(`/api/members/${ghost}`, { method: 'DELETE', token: admin })).status, 200);
    assert.equal((await call('/api/login', { method: 'POST', body: JSON.stringify({ username: 'ghost', password: 'ghost-pass-1' }) })).status, 401,
      'a removed member cannot log in');
    assert.equal((await call('/api/members', { method: 'POST', token: admin, body: JSON.stringify({
      username: 'ghost', kind: 'human', password: 'different-pw-1', role: 'owner', scopeKind: 'org' }) })).status, 400,
      'and nobody else can take the name and inherit their card history');

    // Changing your own password proves the old one and ends every other
    // session. Runs last: it retires `admin` in favour of `admin2`.
    assert.equal(
      (await call('/api/me/password', { method: 'POST', token: admin, body: JSON.stringify({ current: 'wrong', next: 'brand-new-pw-1' }) })).status,
      403,
      'a borrowed session cannot change the password without the old one',
    );
    const changed = await call('/api/me/password', { method: 'POST', token: admin, body: JSON.stringify({ current: OWNER_PW, next: 'brand-new-pw-1' }) });
    assert.equal(changed.status, 200);
    const admin2 = changed.body['token'] as string;
    assert.equal((await call('/api/org', { token: admin })).status, 401, 'the old session dies with the old password');
    assert.equal((await call('/api/org', { token: admin2 })).status, 200, 'the caller gets a fresh session back');

    // Setup-key recovery resets an owner password and clears every session.
    assert.equal(
      (await call('/api/recover', { method: 'POST', body: JSON.stringify({ username: 'root', password: 'recovered-pw-1', setupKey: 'wrong' }) })).status,
      403,
      'recovery rejects a wrong setup key',
    );
    const recovered = await call('/api/recover', { method: 'POST', body: JSON.stringify({ username: 'root', password: 'recovered-pw-1', setupKey: SETUP_KEY }) });
    assert.equal(recovered.status, 200);
    const admin3 = recovered.body['token'] as string;
    assert.equal((await call('/api/org', { token: admin2 })).status, 401, 'recovery ends every live session');
    assert.equal((await call('/api/org', { token: admin3 })).status, 200);
    // Failed-credential throttle. The bucket is (client, account): under
    // `wrangler dev` workerd sets cf-connecting-ip itself, so every caller
    // here is one client and only the account half of the pair varies. That
    // is enough to prove the scoping that matters, and the flood targets a
    // throwaway account so it cannot strand the owner for the rest of the run.
    await call('/api/members', { method: 'POST', token: admin3, body: JSON.stringify({
      username: 'lockme', kind: 'human', password: 'lockme-pass-1', role: 'read', scopeKind: 'org' }) });
    const guess = (username: string) => call('/api/login', {
      method: 'POST', body: JSON.stringify({ username, password: 'not-the-password' }),
    });
    let blocked = 0;
    for (let i = 0; i < 12; i++) if ((await guess('lockme')).status === 429) blocked++;
    assert.ok(blocked >= 2, `sustained guessing is cut off (saw ${blocked} blocked)`);
    const limited = await guess('lockme');
    assert.equal(limited.status, 429);
    assert.ok((limited.body['retryAfter'] as number) > 0, 'and says how long to wait');
    assert.equal((await call('/api/login', { method: 'POST', body: JSON.stringify({ username: 'lockme', password: 'lockme-pass-1' }) })).status, 429,
      'the block is a real gate, not just wrong-password rejection');

    // Another account from the same client is served normally: the block
    // follows the pair, so a flood aimed at one member cannot lock out the
    // rest of the company.
    assert.equal((await guess('nobody-here')).status, 401, 'another account is unaffected');
    assert.equal((await call('/api/org', { token: admin3 })).status, 200, 'and a live session keeps working');

    // A typo in the owner username must not silently create a SECOND org-wide
    // owner and kill every session while reporting success.
    const beforeTypo = ((await call('/api/members', { token: admin3 })).body as unknown as { username: string }[]).length;
    const typo = await call('/api/recover', { method: 'POST', body: JSON.stringify({ username: 'rooot', password: 'typo-pass-1', setupKey: SETUP_KEY }) });
    assert.equal(typo.status, 409, 'recovery names an existing owner or it does nothing');
    assert.equal(((await call('/api/members', { token: admin3 })).body as unknown as { username: string }[]).length, beforeTypo, 'and no member was added');
    assert.equal((await call('/api/org', { token: admin3 })).status, 200, 'and the live session survives');

    // The company name is set at setup and was unreachable afterwards, which
    // made a one-word field a permanent decision. It is renameable now.
    assert.equal((await call('/api/org/name', { method: 'POST', token: admin3, body: JSON.stringify({ name: '' }) })).status, 400);
    assert.equal((await call('/api/org/name', { method: 'POST', token: admin3, body: JSON.stringify({ name: 'Renamed Co' }) })).status, 200);
    assert.equal(((await call('/api/org', { token: admin3 })).body)['name'], 'Renamed Co');
    assert.ok(((await call('/api/org/activity?limit=10', { token: admin3 })).body as unknown as { action: string }[])
      .some((a) => a.action === 'rename-company'), 'and it is audited');

    // Recovery must refuse a password it would then be unable to verify:
    // setting an unusable hash locks the company instead of recovering it.
    assert.equal(
      (await call('/api/recover', { method: 'POST', body: JSON.stringify({ username: 'root', password: '', setupKey: SETUP_KEY }) })).status,
      409,
      'recovery rejects an empty password',
    );
    assert.equal((await call('/api/org', { token: admin3 })).status, 200, 'and leaves the recovered session alone');
    assert.equal(
      (await call('/api/login', { method: 'POST', body: JSON.stringify({ username: 'root', password: 'recovered-pw-1' }) })).status,
      200,
      'the real password still works',
    );

    const postRotate = (await call('/api/org/activity?limit=10', { token: admin3 })).body as unknown as { action: string }[];
    assert.ok(postRotate.some((a) => a.action === 'password-change'), 'password change audited');
    assert.ok(postRotate.some((a) => a.action === 'recover-owner'), 'recovery audited');
  } finally {
    await stopWorker(child, state);
  }
});

test('recovery on a deployment that was never set up leaves a working company', { timeout: 180_000 }, async () => {
  // The failure this pins down: recovery used to create an owner without an
  // org row, so /api/org answered 500 and /api/setup refused forever with
  // "already initialized". That state has no way out.
  const port = await freePort();
  const state = mkdtempSync(join(tmpdir(), 'botflow-recover-'));
  const child = spawn(
    process.execPath,
    [WRANGLER, 'dev', '--port', String(port), '--persist-to', state, '--var', `SETUP_KEY:${SETUP_KEY}`],
    { cwd: join(import.meta.dirname, '..'), stdio: 'ignore', env: { ...process.env }, detached: true },
  );
  const at = async (path: string, opts: RequestInit & { token?: string } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) {
      up = await fetch(`http://127.0.0.1:${port}/api/public/gate`).then((r) => r.ok, () => false);
      if (!up) await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(up, 'wrangler dev came up');

    assert.equal((await at('/api/recover', { method: 'POST', body: JSON.stringify({ username: 'rescue', password: 'rescue-pass-1', setupKey: 'wrong' }) })).status, 403,
      'a fresh deployment is not a setup-key oracle either');
    assert.equal((await at('/api/recover', { method: 'POST', body: JSON.stringify({ username: 'rescue', password: 'short', setupKey: SETUP_KEY }) })).status, 409,
      'and it will not set a password it could never verify');
    assert.equal((await at('/api/recover', { method: 'POST', body: JSON.stringify({ username: 'Rescue Me', password: 'rescue-pass-1', setupKey: SETUP_KEY }) })).status, 409,
      'nor accept a username that cannot survive a card log');

    const rescued = await at('/api/recover', { method: 'POST', body: JSON.stringify({ username: 'rescue', password: 'rescue-pass-1', setupKey: SETUP_KEY }) });
    assert.equal(rescued.status, 200);
    const token = rescued.body['token'] as string;

    const org = await at('/api/org', { token });
    assert.equal(org.status, 200, 'the recovered company is readable, not a 500');
    assert.equal(org.body['name'], 'company');
    assert.equal((org.body['me'] as { role: string }).role, 'owner');

    // And it is a real company: the owner can log in again and use it.
    assert.equal((await at('/api/login', { method: 'POST', body: JSON.stringify({ username: 'rescue', password: 'rescue-pass-1' }) })).status, 200);
    const space = await at('/api/spaces', { method: 'POST', token, body: JSON.stringify({ name: 'after-rescue' }) });
    assert.equal(space.status, 200, 'and it can be built out normally');
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
