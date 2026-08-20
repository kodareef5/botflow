// Worker API end-to-end: spawns a real `wrangler dev` (isolated state) and
// exercises auth, actor binding, scoping, import/export restore, aggregation,
// sharing, and cascade deletion. Slow (~20s); everything runs in one test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { hashPassword, setupAccess } from '../worker/src/security.ts';

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

async function stopWorker(child: ReturnType<typeof spawn>, state: string, removeState = true): Promise<void> {
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
  if (removeState) rmSync(state, { recursive: true, force: true });
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

function webhookFixture(port: number): {
  requests: { url: string; headers: Record<string, string | string[] | undefined>; body: string }[];
  close: () => Promise<void>;
} {
  const requests: { url: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      requests.push({ url: req.url ?? '/', headers: { ...req.headers }, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead((req.url ?? '').startsWith('/fail') ? 503 : 204);
      res.end();
    });
  });
  server.listen(port, '127.0.0.1');
  return { requests, close: () => new Promise<void>((done) => server.close(() => done())) };
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
      '--var', 'LINK_PREVIEWS:on', '--var', 'UNFURL_ALLOW_PRIVATE:on', '--var', 'EMAIL_BRIDGE_USERNAME:alpha-agent'],
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

    const shell = await fetch(U);
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get('content-security-policy') ?? '', /img-src 'self' data: blob:/);
    assert.equal(shell.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(shell.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(shell.headers.get('x-frame-options'), 'DENY');
    assert.equal(shell.headers.get('cache-control'), 'no-store');

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
    const setupAttempts = await Promise.all([
      call('/api/setup', { method: 'POST', body: JSON.stringify({ name: 'testco', username: 'root', password: OWNER_PW, setupKey: SETUP_KEY }) }),
      call('/api/setup', { method: 'POST', body: JSON.stringify({ name: 'testco', username: 'root', password: OWNER_PW, setupKey: SETUP_KEY }) }),
    ]);
    assert.deepEqual(setupAttempts.map((attempt) => attempt.status).sort(), [200, 409], 'first-run setup installs exactly one owner under a race');
    const setup = setupAttempts.find((attempt) => attempt.status === 200)!;
    const admin = setup.body['token'] as string;
    assert.ok(admin.startsWith('bfu_'), 'setup returns a live session, not a token to copy down');

    // A chunked request has no trustworthy Content-Length. The streaming
    // reader still stops it before JSON parsing or an authorized mutation.
    const oversizedJson = new TextEncoder().encode(JSON.stringify({ padding: 'x'.repeat(70 * 1024) }));
    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversizedJson.subarray(0, 32 * 1024));
        controller.enqueue(oversizedJson.subarray(32 * 1024));
        controller.close();
      },
    });
    const oversizedSettings = await fetch(`${U}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
      body: oversizedStream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    assert.equal(oversizedSettings.status, 413, 'chunked JSON is bounded while it streams');
    assert.equal((await call('/api/settings', { method: 'POST', token: admin, body: '{' })).status, 400, 'malformed JSON cannot reach a mutation');
    assert.equal((await call('/api/settings', { method: 'POST', token: admin, body: '[]' })).status, 400, 'JSON request bodies must be objects');
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
    const compactBoard = (await call(`/api/projects/${parent}/board?flow=0`, { token: admin })).body;
    const metricsBoard = (await call(`/api/projects/${parent}/board?flow=1`, { token: admin })).body;
    assert.equal(Object.hasOwn(compactBoard, 'flow'), false, 'ordinary board polling can omit board-series metrics');
    assert.equal(Object.hasOwn(metricsBoard, 'flow'), true, 'metrics clients retain the compatible full projection');
    const polledCard = (compactBoard['lanes'] as { cards: Record<string, unknown>[] }[]).flatMap((lane) => lane.cards)[0]!;
    assert.ok(polledCard, 'new projects expose their nested project card');
    assert.equal(Object.hasOwn(polledCard, 'body'), false, 'board polling omits raw card bodies');
    assert.equal(Object.hasOwn(polledCard, 'parsed'), false, 'board polling omits embedded card histories');

    // Structured card fields keep their JSON types across the hosted API and
    // invalid types fail instead of being silently coerced.
    const scheduledCreate = await call(`/api/projects/${sibA}/cards`, {
      method: 'POST', token: admin, body: JSON.stringify({
        title: 'Scheduled API card', start: '2026-08-20', due: '2026-08-24T12:30Z',
        reminders: [60, 15], repeat: { every: 2, unit: 'week', from: 'due' }, snooze: '2099-01-01T00:00:00Z',
        estimate: 5, hill: 0, evergreen: true, assignee: 'root', delegate: 'agent-a',
      }),
    });
    assert.equal(scheduledCreate.status, 200);
    const scheduledId = scheduledCreate.body['id'] as string;
    let scheduled = (await call(`/api/projects/${sibA}/cards/${scheduledId}`, { token: admin })).body;
    assert.equal(scheduled['start'], '2026-08-20');
    assert.equal(scheduled['due'], '2026-08-24T12:30Z');
    assert.deepEqual(scheduled['reminders'], [60, 15]);
    assert.deepEqual(scheduled['repeat'], { every: 2, unit: 'week', from: 'due' });
    assert.equal(scheduled['snooze'], '2099-01-01T00:00:00Z');
    assert.equal(scheduled['estimate'], 5);
    assert.equal(scheduled['hill'], 0);
    assert.equal(scheduled['evergreen'], true);
    assert.equal(scheduled['assignee'], 'root');
    assert.equal(scheduled['delegate'], 'agent-a');
    const scheduledEdit = await call(`/api/projects/${sibA}/cards/${scheduledId}/edit`, {
      method: 'POST', token: admin, body: JSON.stringify({ start: null, reminders: [], repeat: null, snooze: null, estimate: null, hill: 73, evergreen: false }),
    });
    assert.equal(scheduledEdit.status, 200);
    scheduled = (await call(`/api/projects/${sibA}/cards/${scheduledId}`, { token: admin })).body;
    assert.equal(scheduled['start'], null);
    assert.deepEqual(scheduled['reminders'], []);
    assert.equal(scheduled['repeat'], null);
    assert.equal(scheduled['snooze'], null);
    assert.equal(scheduled['estimate'], null);
    assert.equal(scheduled['hill'], 73);
    assert.equal(scheduled['evergreen'], false);
    assert.equal((await call(`/api/projects/${sibA}/cards`, {
      method: 'POST', token: admin, body: JSON.stringify({ title: 'Bad types', estimate: true }),
    })).status, 400);
    assert.equal((await call(`/api/projects/${sibA}/cards`, {
      method: 'POST', token: admin, body: JSON.stringify({ title: 'Bad hill', hill: 101 }),
    })).status, 400);
    assert.equal((await call(`/api/projects/${sibA}/cards`, {
      method: 'POST', token: admin, body: JSON.stringify({ title: 'Bad reminders', due: '2026-08-24', reminders: [30.5] }),
    })).status, 400);
    assert.equal((await call(`/api/projects/${sibA}/cards/${scheduledId}/edit`, {
      method: 'POST', token: admin, body: JSON.stringify({ evergreen: 'yes' }),
    })).status, 400);

    // Scheduling is live in the Durable Object too: snooze gates readiness,
    // real activity wakes it, reminders are idempotent, and recurring close
    // commits source plus successor in one transaction.
    const snoozedCreate = await call(`/api/projects/${sibA}/cards`, {
      method: 'POST', token: admin,
      body: JSON.stringify({ title: 'Wake on activity', snooze: '2099-02-01T00:00:00Z' }),
    });
    const snoozedId = snoozedCreate.body['id'] as string;
    const snoozedClaim = await call(`/api/projects/${sibA}/cards/${snoozedId}/claim`, { method: 'POST', token: admin, body: '{}' });
    assert.equal(snoozedClaim.status, 409);
    assert.equal((snoozedClaim.body['conflict'] as { reason: string }).reason, 'snoozed');
    assert.equal((await call(`/api/projects/${sibA}/cards/${snoozedId}/comment`, {
      method: 'POST', token: admin, body: JSON.stringify({ message: 'new evidence arrived' }),
    })).status, 200);
    assert.equal((await call(`/api/projects/${sibA}/cards/${snoozedId}`, { token: admin })).body['snooze'], null,
      'genuine activity wakes a snoozed hosted card');

    const reminderDue = new Date(Date.now() + 30 * 60_000).toISOString();
    const reminderId = (await call(`/api/projects/${sibA}/cards`, {
      method: 'POST', token: admin,
      body: JSON.stringify({ title: 'Reminder target', due: reminderDue, reminders: [60] }),
    })).body['id'] as string;
    assert.equal((await call(`/api/projects/${sibA}/automate`, { method: 'POST', token: admin, body: '{}' })).status, 200);
    assert.equal((await call(`/api/projects/${sibA}/automate`, { method: 'POST', token: admin, body: '{}' })).status, 200);
    const reminded = (await call(`/api/projects/${sibA}/cards/${reminderId}`, { token: admin })).body;
    const reminderLog = ((reminded['parsed'] as { log: { actor: string; text: string }[] }).log)
      .filter((entry) => entry.actor === 'botflow' && entry.text === `reminder 60m for due ${reminderDue}`);
    assert.equal(reminderLog.length, 1, 'manual/alarm automation cannot duplicate the same due-relative reminder');

    const recurringId = (await call(`/api/projects/${sibA}/cards`, {
      method: 'POST', token: admin,
      body: JSON.stringify({ title: 'Weekly audit', due: '2099-03-01', repeat: { every: 1, unit: 'week', from: 'due' } }),
    })).body['id'] as string;
    const recurringClose = await call(`/api/projects/${sibA}/cards/${recurringId}/close`, { method: 'POST', token: admin, body: '{}' });
    assert.equal(recurringClose.status, 200, JSON.stringify(recurringClose.body));
    const successorId = recurringClose.body['created'] as string;
    assert.ok(successorId);
    const successor = (await call(`/api/projects/${sibA}/cards/${successorId}`, { token: admin })).body;
    assert.deepEqual(successor['repeat'], { every: 1, unit: 'week', from: 'due' });
    assert.equal((successor['relationships'] as { type: string; target: string }[])
      .some((relation) => relation.type === 'recurs-from' && relation.target === recurringId), true);
    const recurringReplay = await call(`/api/projects/${sibA}/cards/${recurringId}/close`, { method: 'POST', token: admin, body: '{}' });
    assert.equal(recurringReplay.body['created'], null);
    const recurrenceBoard = (await call(`/api/projects/${sibA}/board`, { token: admin })).body as {
      lanes: { cards: { relationships: { type: string; target: string }[] }[] }[];
    };
    assert.equal(recurrenceBoard.lanes.flatMap((lane) => lane.cards)
      .filter((card) => card.relationships.some((relation) => relation.type === 'recurs-from' && relation.target === recurringId)).length, 1,
      'replayed close converges without creating another successor');

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

    // Scoped admins sit between writers and owners: they inherit ordinary
    // board work and may reshape every board their scope reaches, without
    // receiving company-wide administration or force overrides.
    const PROJECT_ADMIN_PW = 'project-admin-password-1';
    const SPACE_ADMIN_PW = 'space-admin-password-1';
    const invalidOrgAdmin = await call('/api/members', { method: 'POST', token: admin, body: JSON.stringify({
      username: 'org-admin', display: 'Too Broad', kind: 'bot', password: PROJECT_ADMIN_PW,
      role: 'admin', scopeKind: 'org', scopeId: null,
    }) });
    assert.equal(invalidOrgAdmin.status, 400, 'admin cannot become a company-wide owner alias');
    assert.match(String(invalidOrgAdmin.body['error']), /admin.*space or project/i);
    const projectAdminCreate = await call('/api/members', { method: 'POST', token: admin, body: JSON.stringify({
      username: 'project-admin', display: 'Project Admin', kind: 'bot', password: PROJECT_ADMIN_PW,
      role: 'admin', scopeKind: 'project', scopeId: parent,
    }) });
    assert.equal(projectAdminCreate.status, 200, JSON.stringify(projectAdminCreate.body));
    const projectAdminId = projectAdminCreate.body['id'] as string;
    const projectAdmin = (await call('/api/login', {
      method: 'POST', body: JSON.stringify({ username: 'project-admin', password: PROJECT_ADMIN_PW }),
    })).body['token'] as string;
    const projectAdminKey = (await call(`/api/keys?member=${projectAdminId}`, {
      method: 'POST', token: admin, body: JSON.stringify({ label: 'shape bot' }),
    })).body['token'] as string;
    const projectAdminBasic = `Basic ${Buffer.from(`project-admin:${PROJECT_ADMIN_PW}`).toString('base64')}`;
    const spaceAdminCreate = await call('/api/members', { method: 'POST', token: admin, body: JSON.stringify({
      username: 'space-admin', display: 'Space Admin', kind: 'bot', password: SPACE_ADMIN_PW,
      role: 'admin', scopeKind: 'space', scopeId: space2,
    }) });
    assert.equal(spaceAdminCreate.status, 200, JSON.stringify(spaceAdminCreate.body));
    const spaceAdmin = (await call('/api/login', {
      method: 'POST', body: JSON.stringify({ username: 'space-admin', password: SPACE_ADMIN_PW }),
    })).body['token'] as string;
    assert.deepEqual(
      (await call('/api/whoami', { token: projectAdmin })).body,
      {
        username: 'project-admin', display: 'Project Admin', kind: 'bot', role: 'admin',
        scope: { kind: 'project', id: parent }, scopeName: 'parent', org: 'testco',
      },
    );
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
    assert.ok(forceAudit.some((a) => a.action === 'force-override'), 'owner force use lands in the org audit log');

    const parentShape = (await call(`/api/projects/${parent}/config`, { token: projectAdmin })).body;
    assert.equal((await call(`/api/projects/${parent}/config`, {
      method: 'PUT', token: projectAdmin, body: JSON.stringify({ ...parentShape, name: 'parent shaped by scoped admin' }),
    })).status, 200, 'a project admin reshapes its project');
    const childShape = (await call(`/api/projects/${childP}/config`, { token: projectAdmin })).body;
    assert.equal((await call(`/api/projects/${childP}/config`, {
      method: 'PUT', token: projectAdmin, body: JSON.stringify({ ...childShape, name: 'child shaped by scoped admin' }),
    })).status, 200, 'a project admin reshapes descendants');
    const hiddenSibling = await call(`/api/projects/${stranger}/config`, { token: projectAdmin });
    const inventedProject = await call('/api/projects/p-does-not-exist/config', { token: projectAdmin });
    assert.equal(hiddenSibling.status, 404, 'a sibling remains outside project-admin scope');
    assert.deepEqual(hiddenSibling, inventedProject, 'project scope does not reveal whether an id exists');

    for (const pid of [sibA, sibB]) {
      const shape = (await call(`/api/projects/${pid}/config`, { token: spaceAdmin })).body;
      assert.equal((await call(`/api/projects/${pid}/config`, {
        method: 'PUT', token: spaceAdmin, body: JSON.stringify({ ...shape, name: `${String(shape['name'])} shaped` }),
      })).status, 200, 'a space admin reshapes every board in the space');
    }
    assert.equal((await call(`/api/projects/${parent}/config`, { token: spaceAdmin })).status, 404,
      'a space admin stops at the space boundary');
    assert.equal((await call(`/api/projects/${parent}/cards`, {
      method: 'POST', token: projectAdmin, body: JSON.stringify({ title: 'Admin still works cards' }),
    })).status, 200, 'admin inherits write');
    assert.equal((await call(`/api/projects/${parent}/cards`, {
      method: 'POST', token: projectAdmin, body: JSON.stringify({ title: 'No admin force', force: true }),
    })).status, 403, 'admin does not inherit owner force');
    for (const [path, body] of [
      [`/api/projects/${parent}/cards/${own}/claim`, { force: true }],
      [`/api/projects/${parent}/cards/${own}/move`, { to: 'done', force: true }],
      [`/api/projects/${parent}/cards/bulk`, { ids: [own], action: { kind: 'close', force: true } }],
      [`/api/projects/${parent}/buttons/no-such`, { card: own, force: true }],
    ] as const) {
      assert.equal((await call(path, { method: 'POST', token: projectAdmin, body: JSON.stringify(body) })).status, 403,
        `admin force is denied at ${path}`);
    }

    for (const request of [
      call('/api/settings', { token: projectAdmin }),
      call('/api/members', { token: projectAdmin }),
      call(`/api/keys?member=${botId}`, { token: projectAdmin }),
      call('/api/org/export', { token: projectAdmin }),
      call('/api/org/activity', { token: projectAdmin }),
      call(`/api/projects/${parent}/webhooks`, { token: projectAdmin }),
      call(`/api/projects/${parent}/shares`, { token: projectAdmin }),
      call(`/api/projects/${parent}`, { method: 'DELETE', token: projectAdmin }),
      call('/api/spaces', { method: 'POST', token: projectAdmin, body: JSON.stringify({ name: 'not-admin-owned' }) }),
      call('/api/projects', { method: 'POST', token: projectAdmin, body: JSON.stringify({ space, name: 'not-a-root' }) }),
    ]) assert.equal((await request).status, 403, 'company and destructive controls remain owner-only');

    // Role changes are live for an existing session, and an admin can never be
    // updated into org scope through a different endpoint.
    assert.equal((await call(`/api/members/${projectAdminId}`, {
      method: 'PATCH', token: admin, body: JSON.stringify({ scopeKind: 'project', scopeId: childP }),
    })).status, 200);
    assert.equal((await call(`/api/projects/${parent}/config`, { token: projectAdminKey })).status, 404,
      'a project admin cannot reach above its selected project');
    assert.equal((await call(`/api/projects/${childP}/config`, { token: projectAdminKey })).status, 200,
      'the same existing key immediately follows the narrower scope');
    assert.equal((await call(`/api/members/${projectAdminId}`, {
      method: 'PATCH', token: admin, body: JSON.stringify({ scopeKind: 'project', scopeId: parent }),
    })).status, 200);
    assert.equal((await call(`/api/members/${projectAdminId}`, {
      method: 'PATCH', token: admin, body: JSON.stringify({ role: 'admin', scopeKind: 'org', scopeId: null }),
    })).status, 400);
    assert.equal((await call(`/api/members/${projectAdminId}`, {
      method: 'PATCH', token: admin, body: JSON.stringify({ role: 'write' }),
    })).status, 200);
    for (const credential of [
      { token: projectAdmin },
      { token: projectAdminKey },
      { headers: { authorization: projectAdminBasic } },
    ]) assert.equal((await call(`/api/projects/${parent}/config`, {
      method: 'PUT', ...credential, body: JSON.stringify(parentShape),
    })).status, 403, 'demotion takes effect for every existing credential form');
    assert.equal((await call(`/api/members/${projectAdminId}`, {
      method: 'PATCH', token: admin, body: JSON.stringify({ role: 'admin' }),
    })).status, 200);
    assert.equal((await call(`/api/projects/${parent}/config`, {
      method: 'PUT', token: projectAdminKey, body: JSON.stringify(parentShape),
    })).status, 200, 'promotion is immediately live on the existing bot key');

    // Snapshot pushes may still update cards at write level, but changing the
    // exact board.yaml bytes is a shape change. The decision and replacement
    // happen inside one ProjectDO call, so denial leaves both files untouched.
    const snapshot = (await call(`/api/projects/${parent}/export`, { token: admin })).body as {
      config: string; cards: { path: string; text: string }[];
    };
    const unchangedPush = await call(`/api/projects/${parent}/import`, {
      method: 'PUT', token: key, body: JSON.stringify(snapshot),
    });
    assert.equal(unchangedPush.status, 200, JSON.stringify(unchangedPush.body));
    assert.equal(unchangedPush.body['configChanged'], false);
    const changedSnapshot = { ...snapshot, config: `${snapshot.config}\n# shaped through snapshot import\n` };
    const deniedPush = await call(`/api/projects/${parent}/import`, {
      method: 'PUT', token: key, body: JSON.stringify(changedSnapshot),
    });
    assert.equal(deniedPush.status, 403, 'write cannot smuggle a board shape through snapshot import');
    assert.deepEqual((await call(`/api/projects/${parent}/export`, { token: admin })).body, snapshot,
      'a denied shape import changes neither config nor cards');
    const adminPush = await call(`/api/projects/${parent}/import`, {
      method: 'PUT', token: projectAdmin, body: JSON.stringify(changedSnapshot),
    });
    assert.equal(adminPush.status, 200, JSON.stringify(adminPush.body));
    assert.equal(adminPush.body['configChanged'], true);
    assert.equal(((await call(`/api/projects/${parent}/export`, { token: admin })).body)['config'], changedSnapshot.config);
    const importEvents = (await call(`/api/projects/${parent}/events?limit=20`, { token: admin })).body as unknown as {
      actor: string; action: string; detail: string;
    }[];
    assert.ok(importEvents.some((event) => event.actor === 'project-admin' && event.action === 'import' && event.detail.includes('board config changed')),
      'the project event attributes the shape-changing import');
    const shapeAudit = (await call('/api/org/activity?limit=30', { token: admin })).body as unknown as {
      actor: string; action: string; detail: string;
    }[];
    assert.ok(shapeAudit.some((event) => event.actor === 'project-admin' && event.action === 'board-edit' && event.detail.includes('snapshot')),
      'admin snapshot reshapes are visible in the company audit log');

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
        { id: 'needs-qa', canonical: 'doing', wip: 1, wipMode: 'justify' },
        { id: 'review-gate', canonical: 'doing', wip: 1, wipMode: 'deny' },
        { id: 'done' },
        { id: 'archive' },
      ],
      labels: [{ id: 'Type/Bug', color: '#d03b3b' }],
      fields: [
        { id: 'sprint', name: 'Sprint', type: 'number', face: true },
        { id: 'risk', name: 'Risk', type: 'select', options: ['low', 'high'], face: true },
      ],
      templates: [{
        id: 'bug', name: 'Bug report', lane: 'todo', labels: ['Type/Bug'], priority: 'p1', estimate: 3,
        fields: { risk: 'high' }, body: '## Checklist\n- [ ] reproduce {{title}}\n',
      }],
      filters: [{ id: 'todo-work', name: 'Todo work', query: 'lane:todo' }],
      blockers: [{ id: 'external-review', name: 'External review', color: '#b42318' }],
      buttons: [
        { id: 'mark-reviewed', name: 'Mark reviewed', scope: 'card', action: 'label', value: 'reviewed' },
        { id: 'triage-todo', name: 'Triage todo', scope: 'board', filter: 'todo-work', action: 'label', value: 'triaged' },
      ],
      rules: [
        { id: 'qa-label', event: 'enter', lane: 'needs-qa', action: 'label', value: 'qa' },
        { id: 'waiting-label', event: 'block', action: 'label', value: 'waiting' },
      ],
      automation: { archiveDoneAfter: 36_500 },
      rollup: { blockedWhen: 'never', doingWhen: 'any-doing', elseState: 'todo' },
      migrations: { wishlist: 'todo' },
    };
    assert.equal((await call(`/api/projects/${parent}/config`, { method: 'PUT', token: key, body: JSON.stringify(reshape) })).status, 403, 'writers cannot reshape boards');
    assert.equal((await call(`/api/projects/${parent}/config`, { method: 'PUT', token: admin, body: JSON.stringify({ name: 'x', lanes: [{ id: 'weird' }] }) })).status, 400, 'custom lane without canonical rejected');
    const withoutArchive = { ...reshape, lanes: reshape.lanes.filter((lane) => lane.id !== 'archive') };
    assert.equal((await call(`/api/projects/${parent}/config`, { method: 'PUT', token: admin, body: JSON.stringify(withoutArchive) })).status, 400,
      'archive automation cannot be saved without an archive-canonical lane');
    const put = await call(`/api/projects/${parent}/config`, { method: 'PUT', token: admin, body: JSON.stringify(reshape) });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const cfg1 = await call(`/api/projects/${parent}/config`, { token: admin });
    assert.deepEqual((cfg1.body['lanes'] as { id: string }[]).map((l) => l.id), ['todo', 'doing', 'needs-qa', 'review-gate', 'done', 'archive']);
    assert.equal((cfg1.body['rollup'] as { doingWhen: string }).doingWhen, 'any-doing');
    assert.deepEqual(cfg1.body['labels'], reshape.labels);
    assert.deepEqual(cfg1.body['blockers'], reshape.blockers);
    assert.deepEqual(cfg1.body['buttons'], reshape.buttons.map((button) => ({ ...button, filter: 'filter' in button ? button.filter : null })));
    assert.deepEqual(cfg1.body['rules'], reshape.rules.map((rule) => ({ ...rule, lane: 'lane' in rule ? rule.lane : null, filter: null })));
    assert.deepEqual(cfg1.body['automation'], { archiveDoneAfter: 36_500 });
    const normalizedFields = [
      { id: 'sprint', name: 'Sprint', type: 'number', options: [], face: true },
      { id: 'risk', name: 'Risk', type: 'select', options: ['low', 'high'], face: true },
    ];
    assert.deepEqual(cfg1.body['fields'], normalizedFields);
    assert.deepEqual((cfg1.body['templates'] as { id: string; body: string }[]).map((template) => ({ id: template.id, body: template.body })), [
      { id: 'bug', body: '## Checklist\n- [ ] reproduce {{title}}\n' },
    ]);

    // WIP modes, named blockers, event rules, and declarative buttons all
    // execute through the hosted API with the same pure-operation contract.
    assert.equal((await call(`/api/projects/${parent}/cards`, {
      method: 'POST', token: admin, body: JSON.stringify({ title: 'QA occupant', lane: 'needs-qa' }),
    })).status, 200);
    const qaCandidate = (await call(`/api/projects/${parent}/cards`, {
      method: 'POST', token: key, body: JSON.stringify({ title: 'Needs justified QA' }),
    })).body['id'] as string;
    assert.equal((await call(`/api/projects/${parent}/cards/${qaCandidate}/move`, {
      method: 'POST', token: key, body: JSON.stringify({ to: 'needs-qa' }),
    })).status, 400, 'justify mode refuses an unexplained overflow');
    assert.equal((await call(`/api/projects/${parent}/cards/${qaCandidate}/move`, {
      method: 'POST', token: key, body: JSON.stringify({ to: 'needs-qa', wipReason: 'urgent verification' }),
    })).status, 200);
    let qaCard = (await call(`/api/projects/${parent}/cards/${qaCandidate}`, { token: admin })).body;
    assert.ok((qaCard['labels'] as string[]).includes('qa'), 'on-enter rule applied after the move');
    assert.match(String(qaCard['body']), /wip justification for needs-qa: urgent verification/);

    assert.equal((await call(`/api/projects/${parent}/cards/${qaCandidate}/block`, {
      method: 'POST', token: key, body: JSON.stringify({ blocker: 'external-review', reason: 'awaiting approval' }),
    })).status, 200);
    qaCard = (await call(`/api/projects/${parent}/cards/${qaCandidate}`, { token: admin })).body;
    assert.equal(qaCard['blocker'], 'external-review');
    assert.ok((qaCard['labels'] as string[]).includes('waiting'), 'on-block rule applied once');
    assert.equal((await call(`/api/projects/${parent}/cards/${qaCandidate}/move`, {
      method: 'POST', token: key, body: JSON.stringify({ to: 'todo' }),
    })).status, 400, 'named blocker makes a card immobile until cleared');
    const removeLiveBlocker = await call(`/api/projects/${parent}/config`, {
      method: 'PUT', token: admin, body: JSON.stringify({ ...reshape, blockers: [] }),
    });
    assert.equal(removeLiveBlocker.status, 400, 'the editor cannot orphan an active named blocker');
    assert.equal((await call(`/api/projects/${parent}/cards/${qaCandidate}/unblock`, {
      method: 'POST', token: key, body: '{}',
    })).status, 200);

    assert.equal((await call(`/api/projects/${parent}/buttons/mark-reviewed`, {
      method: 'POST', token: key, body: JSON.stringify({ card: qaCandidate }),
    })).status, 200);
    qaCard = (await call(`/api/projects/${parent}/cards/${qaCandidate}`, { token: admin })).body;
    assert.ok((qaCard['labels'] as string[]).includes('reviewed'), 'card button applied its declared action');
    const todoForButton = (await call(`/api/projects/${parent}/cards`, {
      method: 'POST', token: admin, body: JSON.stringify({ title: 'Board button target' }),
    })).body['id'] as string;
    const boardButton = await call(`/api/projects/${parent}/buttons/triage-todo`, { method: 'POST', token: key, body: '{}' });
    assert.equal(boardButton.status, 200, JSON.stringify(boardButton.body));
    assert.ok(((await call(`/api/projects/${parent}/cards/${todoForButton}`, { token: admin })).body['labels'] as string[]).includes('triaged'));

    assert.equal((await call(`/api/projects/${parent}/cards`, {
      method: 'POST', token: admin, body: JSON.stringify({ title: 'Review gate occupant', lane: 'review-gate' }),
    })).status, 200);
    const denyCandidate = (await call(`/api/projects/${parent}/cards`, {
      method: 'POST', token: key, body: JSON.stringify({ title: 'Needs owner override' }),
    })).body['id'] as string;
    assert.equal((await call(`/api/projects/${parent}/cards/${denyCandidate}/move`, {
      method: 'POST', token: key, body: JSON.stringify({ to: 'review-gate' }),
    })).status, 400);
    assert.equal((await call(`/api/projects/${parent}/cards/${denyCandidate}/move`, {
      method: 'POST', token: key, body: JSON.stringify({ to: 'review-gate', force: true, wipReason: 'cannot wait' }),
    })).status, 403, 'members cannot turn a justification into an override');
    assert.equal((await call(`/api/projects/${parent}/cards/${denyCandidate}/move`, {
      method: 'POST', token: admin, body: JSON.stringify({ to: 'review-gate', force: true }),
    })).status, 400, 'owner override still needs a written reason');
    assert.equal((await call(`/api/projects/${parent}/cards/${denyCandidate}/move`, {
      method: 'POST', token: admin, body: JSON.stringify({ to: 'review-gate', force: true, wipReason: 'incident response' }),
    })).status, 200);

    const richAdd = await call(`/api/projects/${parent}/cards`, {
      method: 'POST', token: admin,
      body: JSON.stringify({
        title: 'Structured face', labels: ['Type/Bug'], cover_color: '#F0C040', estimate: 3,
        due: '2026-08-25', fields: { sprint: 14, risk: 'high' },
      }),
    });
    assert.equal(richAdd.status, 200, JSON.stringify(richAdd.body));
    const richId = richAdd.body['id'] as string;
    let rich = await call(`/api/projects/${parent}/cards/${richId}`, { token: admin });
    assert.equal(rich.body['coverColor'], '#f0c040');
    assert.deepEqual((rich.body['labelDetails'] as { group: string; value: string; color: string }[])[0], {
      id: 'Type/Bug', group: 'Type', value: 'Bug', color: '#d03b3b',
    });
    assert.deepEqual(Object.fromEntries((rich.body['faceFields'] as { id: string; value: unknown }[]).map((field) => [field.id, field.value])), { sprint: 14, risk: 'high' });
    assert.equal((await call(`/api/projects/${parent}/cards/${richId}/edit`, {
      method: 'POST', token: admin, body: JSON.stringify({ cover_color: null, fields: { sprint: 15, risk: null } }),
    })).status, 200);
    rich = await call(`/api/projects/${parent}/cards/${richId}`, { token: admin });
    assert.equal(rich.body['coverColor'], null);
    assert.deepEqual(Object.fromEntries((rich.body['fields'] as { id: string; value: unknown }[]).map((field) => [field.id, field.value])), { sprint: 15 });
    const incompatibleFields = await call(`/api/projects/${parent}/config`, {
      method: 'PUT', token: admin,
      body: JSON.stringify({ ...reshape, templates: [], fields: [{ id: 'sprint', name: 'Sprint', type: 'select', options: ['small', 'large'], face: true }] }),
    });
    assert.equal(incompatibleFields.status, 400, 'a registry edit cannot invalidate existing card values');
    assert.match(String(incompatibleFields.body['error']), new RegExp(`card ${richId}`));
    assert.deepEqual((await call(`/api/projects/${parent}/config`, { token: admin })).body['fields'], normalizedFields,
      'a rejected schema edit leaves the registry intact');
    const migrated = await call(`/api/projects/${parent}/cards/001`, { token: admin });
    assert.equal(migrated.body['position'], 'doing.design', 'doing card entered the new substate machine');
    assert.match(String(migrated.body['body']), /migrated doing → doing\.design \(board edit\)/, 'migration logged on the card');
    const boardShape = (await call(`/api/projects/${parent}/board`, { token: admin })).body as { lanes: { id: string }[]; findings: unknown[] };
    assert.deepEqual(boardShape.lanes.map((l) => l.id), ['todo', 'doing', 'needs-qa', 'review-gate', 'done', 'archive']);
    assert.equal(boardShape.findings.filter((f) => (f as { severity: string }).severity === 'error').length, 0, 'reshaped board lints clean');

    // Relations/templates/quick-add/bulk and cross-project dependencies all
    // use the same pure operations as CLI/MCP, with DO transactions around
    // every multi-card write.
    const templatedAdd = await call(`/api/projects/${parent}/cards`, {
      method: 'POST', token: admin, body: JSON.stringify({ title: 'Hosted template', template: 'bug' }),
    });
    assert.equal(templatedAdd.status, 200, JSON.stringify(templatedAdd.body));
    const templatedId = templatedAdd.body['id'] as string;
    let templated = (await call(`/api/projects/${parent}/cards/${templatedId}`, { token: admin })).body;
    assert.equal(templated['priority'], 'p1');
    assert.equal((templated['parsed'] as { checklist: { total: number } }).checklist.total, 1);
    const promoted = await call(`/api/projects/${parent}/cards/${templatedId}/promote`, {
      method: 'POST', token: admin, body: JSON.stringify({ index: 0 }),
    });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
    const promotedId = promoted.body['promoted'] as string;
    templated = (await call(`/api/projects/${parent}/cards/${templatedId}`, { token: admin })).body;
    assert.equal((templated['relations'] as { type: string; target: string }[]).some((relation) => relation.type === 'subtask' && relation.target === promotedId), true);
    const quick = await call(`/api/projects/${parent}/cards/quick`, {
      method: 'POST', token: admin, body: JSON.stringify({ text: 'Quick parent !p1\n  Quick child ~bug' }),
    });
    assert.equal(quick.status, 200, JSON.stringify(quick.body));
    const quickCards = quick.body['cards'] as { id: string }[];
    assert.equal(quickCards.length, 2);
    const bulk = await call(`/api/projects/${parent}/cards/bulk`, {
      method: 'POST', token: admin, body: JSON.stringify({ ids: quickCards.map((card) => card.id), action: { kind: 'label', add: ['batch'] } }),
    });
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
    assert.equal((bulk.body['changed'] as string[]).length, 2);
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
labels:
  - id: Type/Bug
    color: "#d03b3b"
    icon: bug
fields:
  - id: risk
    type: select
    options: [low, high]
    face: true
    width: compact
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
        name: 'compatibility edited', lanes: [{ id: 'todo' }, { id: 'done' }],
        labels: [{ id: 'Type/Bug', color: '#d03b3b' }],
        fields: [{ id: 'risk', type: 'select', options: ['low', 'high'], face: true }], rollup: {},
      }),
    });
    assert.equal(compatEdit.status, 200, JSON.stringify(compatEdit.body));
    const compatExport = await call(`/api/projects/${compatProject}/export`, { token: admin });
    const preservedConfig = compatExport.body['config'] as string;
    assert.match(preservedConfig, /visual:\n      color: blue/);
    assert.match(preservedConfig, /icon: bug/, 'unknown label-map data survives the hosted editor');
    assert.match(preservedConfig, /width: compact/, 'unknown custom-field-map data survives the hosted editor');
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
      assert.equal((await fetch(`${U}/og/${'a'.repeat(64)}?p=p-doesnotexist`)).status, 404,
        'an anonymous image lookup cannot provision a made-up project object');

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

      // YouTube has a deterministic public thumbnail contract, so it does
      // not need to execute or even fetch the watch page. It still enters the
      // same cache and privacy-preserving image proxy as every other preview.
      const youtubeCard = (await call(`/api/projects/${parent}/cards`, { method: 'POST', token: admin, body: JSON.stringify({ title: 'YouTube art' }) })).body['id'] as string;
      const youtubeUrl = 'https://youtu.be/dQw4w9WgXcQ';
      await call(`/api/projects/${parent}/cards/${youtubeCard}/attach`, { method: 'POST', token: admin, body: JSON.stringify({ url: youtubeUrl }) });
      const youtubePreview = await previewOf(youtubeCard);
      assert.equal(youtubePreview.length, 1);
      assert.equal(youtubePreview[0]!.url, youtubeUrl);
      assert.match(youtubePreview[0]!.image, /^\/og\/[a-f0-9]{64}\?p=/, 'YouTube art is proxied, never embedded from YouTube');
    } finally {
      await site.close();
    }

    // ---- hardened outbound webhook + provider-neutral email seams ----
    const WEBHOOK_PORT = await freePort();
    const webhookSite = webhookFixture(WEBHOOK_PORT);
    try {
      const createdWebhook = await call(`/api/projects/${parent}/webhooks`, {
        method: 'POST', token: admin,
        body: JSON.stringify({ name: 'add events', url: `http://127.0.0.1:${WEBHOOK_PORT}/hook`, allowEvents: ['add'], denyEvents: [] }),
      });
      assert.equal(createdWebhook.status, 200, JSON.stringify(createdWebhook.body));
      const hook = createdWebhook.body['webhook'] as { id: string };
      const webhookSecret = createdWebhook.body['secret'] as string;
      assert.match(webhookSecret, /^bfwhsec_[a-f0-9]{64}$/);

      const webhookCard = (await call(`/api/projects/${parent}/cards`, {
        method: 'POST', token: admin, body: JSON.stringify({ title: 'Webhook delivery' }),
      })).body['id'] as string;
      let deliveries: { id: string; status: string; attempts: number }[] = [];
      for (let i = 0; i < 50; i++) {
        const history = await call(`/api/projects/${parent}/webhooks/${hook.id}/deliveries?limit=10`, { token: admin });
        deliveries = history.body['deliveries'] as typeof deliveries;
        if (deliveries[0]?.status === 'delivered') break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.equal(deliveries[0]?.status, 'delivered', 'ProjectDO alarm delivered the queued webhook');
      assert.equal(deliveries[0]?.attempts, 1);
      assert.equal(webhookSite.requests.length, 1);
      const sent = webhookSite.requests[0]!;
      const timestamp = String(sent.headers['x-botflow-timestamp']);
      const expectedSignature = createHmac('sha256', webhookSecret).update(`${timestamp}.${sent.body}`).digest('hex');
      assert.equal(sent.headers['x-botflow-signature-256'], `sha256=${expectedSignature}`);
      assert.equal(sent.headers['x-botflow-event'], 'add');
      assert.equal((JSON.parse(sent.body) as { event: { card_id: string } }).event.card_id, webhookCard);

      await call(`/api/projects/${parent}/cards/${webhookCard}/edit`, {
        method: 'POST', token: admin, body: JSON.stringify({ priority: 'p1' }),
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(webhookSite.requests.length, 1, 'exact allow-list excludes edit events');

      const replay = await call(`/api/projects/${parent}/webhooks/${hook.id}/deliveries/${deliveries[0]!.id}/replay`, {
        method: 'POST', token: admin, body: '{}',
      });
      assert.equal(replay.status, 200);
      for (let i = 0; i < 50 && webhookSite.requests.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(webhookSite.requests.length, 2, 'manual replay is delivered');
      assert.equal(webhookSite.requests[1]!.body, sent.body, 'replay uses the exact frozen event body');
      assert.notEqual(webhookSite.requests[1]!.headers['x-botflow-delivery'], sent.headers['x-botflow-delivery'], 'replay gets a fresh delivery id');
      const firstDeliveryPage = (await call(`/api/projects/${parent}/webhooks/${hook.id}/deliveries?limit=1`, { token: admin })).body as {
        deliveries: { id: string; sequence: number }[]; next: number | null;
      };
      assert.equal(firstDeliveryPage.deliveries.length, 1);
      assert.ok(firstDeliveryPage.next, 'a one-row delivery page advertises its older cursor');
      const secondDeliveryPage = (await call(`/api/projects/${parent}/webhooks/${hook.id}/deliveries?limit=1&before=${firstDeliveryPage.next}`, { token: admin })).body as {
        deliveries: { id: string; sequence: number }[]; next: number | null;
      };
      assert.equal(secondDeliveryPage.deliveries.length, 1);
      assert.notEqual(secondDeliveryPage.deliveries[0]!.id, firstDeliveryPage.deliveries[0]!.id);
      assert.ok(secondDeliveryPage.deliveries[0]!.sequence < firstDeliveryPage.deliveries[0]!.sequence);
      const rotated = await call(`/api/projects/${parent}/webhooks/${hook.id}/rotate`, { method: 'POST', token: admin, body: '{}' });
      assert.match(String(rotated.body['secret']), /^bfwhsec_[a-f0-9]{64}$/);
      assert.notEqual(rotated.body['secret'], webhookSecret);
      assert.equal((await call(`/api/projects/${parent}/webhooks/${hook.id}`, { method: 'DELETE', token: admin })).status, 200);

      const failingWebhook = await call(`/api/projects/${parent}/webhooks`, {
        method: 'POST', token: admin,
        body: JSON.stringify({ name: 'circuit proof', url: `http://127.0.0.1:${WEBHOOK_PORT}/fail`, allowEvents: ['quick-add'] }),
      });
      const failingHookId = (failingWebhook.body['webhook'] as { id: string }).id;
      assert.equal((await call(`/api/projects/${parent}/cards/quick`, {
        method: 'POST', token: admin, body: JSON.stringify({ text: 'Circuit 1\nCircuit 2\nCircuit 3\nCircuit 4\nCircuit 5' }),
      })).status, 200);
      let circuit: { failureCount: number; circuitUntil: string | null } | undefined;
      for (let i = 0; i < 50; i++) {
        const listed = (await call(`/api/projects/${parent}/webhooks`, { token: admin })).body['webhooks'] as unknown as { id: string; failureCount: number; circuitUntil: string | null }[];
        circuit = listed.find((item) => item.id === failingHookId);
        if (circuit?.circuitUntil) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.equal(circuit?.failureCount, 5);
      assert.ok(circuit?.circuitUntil, 'five consecutive failures open the endpoint circuit');
      assert.equal((await call(`/api/projects/${parent}/webhooks/${failingHookId}`, { method: 'DELETE', token: admin })).status, 200);

      const subscription = await call(`/api/projects/${parent}/email/subscriptions`, {
        method: 'POST', token: admin,
        body: JSON.stringify({ name: 'new cards', recipients: ['ops@example.com'], allowEvents: ['add'], denyEvents: [] }),
      });
      assert.equal(subscription.status, 200, JSON.stringify(subscription.body));
      const subscriptionId = (subscription.body['subscription'] as { id: string }).id;
      const inboundRoute = await call(`/api/projects/${parent}/email/routes`, {
        method: 'POST', token: admin, body: JSON.stringify({ name: 'mailbox', kind: 'create', lane: 'todo' }),
      });
      assert.equal(inboundRoute.status, 200, JSON.stringify(inboundRoute.body));
      const route = inboundRoute.body['route'] as { id: string };
      const inboundToken = inboundRoute.body['token'] as string;
      const normalized = { messageId: 'provider-message-1', from: 'Sender <sender@example.com>', subject: 'Arrived by email', text: 'A plain text description.' };
      const inbound = await call(`/api/email/inbound/${parent}/${inboundToken}`, { method: 'POST', body: JSON.stringify(normalized) });
      assert.equal(inbound.status, 202, JSON.stringify(inbound.body));
      const inboundCardId = inbound.body['cardId'] as string;
      const duplicate = await call(`/api/email/inbound/${parent}/${inboundToken}`, { method: 'POST', body: JSON.stringify(normalized) });
      assert.equal(duplicate.status, 202);
      assert.equal(duplicate.body['cardId'], inboundCardId);
      assert.equal(duplicate.body['duplicate'], true, 'provider retry does not create a second card');
      const inboundCard = (await call(`/api/projects/${parent}/cards/${inboundCardId}`, { token: admin })).body as unknown as {
        title: string; author: string; parsed: { description: string };
      };
      assert.equal(inboundCard.title, 'Arrived by email');
      assert.equal(inboundCard.author, 'email-root');
      assert.match(inboundCard.parsed.description, /A plain text description/);

      const claimed = await call(`/api/projects/${parent}/email/outbox/claim`, {
        method: 'POST', token: key, body: JSON.stringify({ limit: 10 }),
      });
      assert.equal(claimed.status, 200);
      const messages = claimed.body['messages'] as unknown as { id: string; leaseToken: string; payload: { schema: string; message: { to: string[] } } }[];
      assert.equal(messages.length, 1);
      assert.equal(messages[0]!.payload.schema, 'botflow.email.outbound.v1');
      assert.deepEqual(messages[0]!.payload.message.to, ['ops@example.com']);
      const ack = await call(`/api/projects/${parent}/email/outbox/${messages[0]!.id}/ack`, {
        method: 'POST', token: key, body: JSON.stringify({ leaseToken: messages[0]!.leaseToken, status: 'sent' }),
      });
      assert.equal(ack.status, 200);
      assert.equal((await call(`/api/projects/${parent}/email/outbox/${messages[0]!.id}/ack`, {
        method: 'POST', token: key, body: JSON.stringify({ leaseToken: messages[0]!.leaseToken, status: 'sent' }),
      })).status, 409, 'a stale lease cannot acknowledge twice');
      const outbox = await call(`/api/projects/${parent}/email/outbox?subscription=${subscriptionId}`, { token: admin });
      assert.equal(((outbox.body['messages'] as unknown as { status: string }[])[0]!).status, 'sent');
      await call(`/api/projects/${parent}/cards`, { method: 'POST', token: admin, body: JSON.stringify({ title: 'Second outbox page' }) });
      const firstOutboxPage = (await call(`/api/projects/${parent}/email/outbox?subscription=${subscriptionId}&limit=1`, { token: admin })).body as {
        messages: { id: string; sequence: number }[]; next: number | null;
      };
      assert.equal(firstOutboxPage.messages.length, 1);
      assert.ok(firstOutboxPage.next, 'a one-row outbox page advertises its older cursor');
      const secondOutboxPage = (await call(`/api/projects/${parent}/email/outbox?subscription=${subscriptionId}&limit=1&before=${firstOutboxPage.next}`, { token: admin })).body as {
        messages: { id: string; sequence: number }[]; next: number | null;
      };
      assert.equal(secondOutboxPage.messages.length, 1);
      assert.notEqual(secondOutboxPage.messages[0]!.id, firstOutboxPage.messages[0]!.id);
      assert.ok(secondOutboxPage.messages[0]!.sequence < firstOutboxPage.messages[0]!.sequence);
      assert.equal((await call(`/api/projects/${parent}/email/routes/${route.id}`, { method: 'DELETE', token: admin })).status, 200);
      assert.equal((await call(`/api/email/inbound/${parent}/${inboundToken}`, { method: 'POST', body: JSON.stringify({ ...normalized, messageId: 'provider-message-2' }) })).status, 404,
        'route revocation is immediate');
      assert.equal((await call(`/api/projects/${parent}/email/subscriptions/${subscriptionId}`, { method: 'DELETE', token: admin })).status, 200);
    } finally {
      await webhookSite.close();
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

    // Card Log and Comments are append-only file-format truth, but the hosted
    // UI reads them through bounded newest-first pages. Their ordinal cursor
    // points into the stable old prefix, so a newer append between requests
    // cannot shift or duplicate the next older page.
    const compactCard = (await call(`/api/projects/${parent}/cards/002?compact=1`, { token: admin })).body as {
      body?: unknown; parsed: { log?: unknown; comments?: unknown; description: string | null };
    };
    assert.equal(compactCard.body, undefined);
    assert.equal(compactCard.parsed.log, undefined);
    assert.equal(compactCard.parsed.comments, undefined);
    assert.equal(compactCard.parsed.description, 'Written by an agent.');

    type CardHistoryPage = {
      items: { sequence: number; when: string; actor: string; text: string }[];
      next: number | null;
      total: number;
    };
    const activityOne = (await call(`/api/projects/${parent}/cards/002/activity?limit=2`, { token: admin })).body as CardHistoryPage;
    assert.equal(activityOne.items.length, 2);
    assert.ok(activityOne.items[0]!.sequence > activityOne.items[1]!.sequence, 'card activity is newest first');
    assert.ok(activityOne.next, 'a full card-activity page advertises an older cursor');
    await call(`/api/projects/${parent}/cards/002/log`, {
      method: 'POST', token: admin, body: JSON.stringify({ message: 'newer than the activity cursor' }),
    });
    const activityTwo = (await call(`/api/projects/${parent}/cards/002/activity?limit=2&before=${activityOne.next}`, { token: admin })).body as CardHistoryPage;
    assert.ok(activityTwo.items.every((entry) => entry.sequence < activityOne.next!));
    assert.deepEqual(activityTwo.items.filter((entry) => activityOne.items.some((first) => first.sequence === entry.sequence)), []);

    for (const message of ['oldest comment page probe', 'middle comment page probe', 'newest comment page probe']) {
      await call(`/api/projects/${parent}/cards/002/comment`, { method: 'POST', token: admin, body: JSON.stringify({ message }) });
    }
    const commentsOne = (await call(`/api/projects/${parent}/cards/002/comments?limit=2`, { token: admin })).body as CardHistoryPage;
    assert.deepEqual(commentsOne.items.map((entry) => entry.text), ['newest comment page probe', 'middle comment page probe']);
    assert.ok(commentsOne.items[0]!.sequence > commentsOne.items[1]!.sequence, 'card comments are newest first');
    await call(`/api/projects/${parent}/cards/002/comment`, { method: 'POST', token: admin, body: JSON.stringify({ message: 'arrived after comment page one' }) });
    const commentsTwo = (await call(`/api/projects/${parent}/cards/002/comments?limit=2&before=${commentsOne.next}`, { token: admin })).body as CardHistoryPage;
    assert.deepEqual(commentsTwo.items.map((entry) => entry.text), ['oldest comment page probe']);
    assert.equal((await call(`/api/projects/${parent}/cards/002/activity?before=not-a-sequence`, { token: admin })).status, 400);
    assert.equal((await call(`/api/projects/${parent}/cards/002/comments?before=0`, { token: admin })).status, 400);

    // Project activity uses an exclusive sequence cursor. An event inserted
    // after page one cannot leak into page two or duplicate a row.
    const eventPageOne = (await call(`/api/projects/${parent}/events?limit=3`, { token: admin })).body as unknown as { seq: number }[];
    assert.equal(eventPageOne.length, 3);
    const eventCursor = eventPageOne.at(-1)!.seq;
    await call(`/api/projects/${parent}/cards/002/comment`, { method: 'POST', token: admin, body: JSON.stringify({ message: 'arrived between activity pages' }) });
    const eventPageTwo = (await call(`/api/projects/${parent}/events?limit=3&before=${eventCursor}`, { token: admin })).body as unknown as { seq: number }[];
    assert.ok(eventPageTwo.length > 0);
    assert.ok(eventPageTwo.every((event) => event.seq < eventCursor));
    assert.deepEqual(eventPageTwo.filter((event) => eventPageOne.some((first) => first.seq === event.seq)), []);
    assert.equal((await call(`/api/projects/${parent}/events?before=not-a-sequence`, { token: admin })).status, 400);

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
    assert.equal((await call(`/api/projects/${parent}/board`, { token: reader })).status, 404, 'and stops at the space boundary');

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
    const oldSecondToken = second2.body['token'] as string;
    const oldSecondId = second2.body['id'] as string;
    const replacement = await call(`/api/keys/${oldSecondId}/replace`, { method: 'POST', token: admin });
    assert.equal(replacement.status, 200);
    assert.equal(replacement.body['label'], 'api key #2', 'replacement retains the deployed key label');
    assert.equal((await call('/api/whoami', { token: oldSecondToken })).status, 401, 'replacement atomically revokes the old secret');
    const replacementToken = replacement.body['token'] as string;
    assert.equal(((await call('/api/whoami', { token: replacementToken })).body)['username'], 'alpha-agent');
    const afterReplace = (await call(`/api/keys?member=${botId}`, { token: admin })).body as unknown as {
      id: string; label: string; revoked: boolean; token?: string;
    }[];
    assert.equal(afterReplace.find((item) => item.id === oldSecondId)?.revoked, true);
    assert.equal(afterReplace.find((item) => item.id === replacement.body['id'])?.revoked, false);
    assert.equal(afterReplace.some((item) => item.token !== undefined), false, 'key listings never reveal token material');
    assert.equal((await call(`/api/keys/${oldSecondId}/replace`, { method: 'POST', token: admin })).status, 400, 'a revoked key cannot be replaced again');
    const replacementId = replacement.body['id'] as string;
    const competingReplacements = await Promise.all([
      call(`/api/keys/${replacementId}/replace`, { method: 'POST', token: admin }),
      call(`/api/keys/${replacementId}/replace`, { method: 'POST', token: admin }),
    ]);
    assert.deepEqual(competingReplacements.map((result) => result.status).sort(), [200, 400],
      'the old-key recheck inside the registry transaction permits exactly one replacement winner');
    assert.equal((await call(`/api/keys?member=${botId}`, { method: 'POST', token: reader, body: JSON.stringify({}) })).status, 403,
      'a non-owner cannot provision a key for another member');
    assert.equal((await call(`/api/keys/${keyId}`, { method: 'PATCH', token: reader, body: JSON.stringify({ label: 'stolen' }) })).status, 403, 'you cannot rename someone else\'s key');
    assert.equal((await call(`/api/keys/${keyId}/replace`, { method: 'POST', token: reader })).status, 403, 'you cannot replace someone else\'s key');
    const keyAudit = (await call('/api/org/activity?limit=100', { token: admin })).body as unknown as { action: string; detail: string }[];
    assert.ok(keyAudit.some((event) => event.action === 'replace-key' && event.detail.includes(oldSecondId)), 'replacement is audited without its secret');

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

    const handoffSource = await call(`/api/projects/${parent}/cards`, {
      method: 'POST', token: admin, body: JSON.stringify({ title: 'Hosted handoff' }),
    });
    const handoffSourceId = handoffSource.body['id'] as string;
    const handoff = await call(`/api/projects/${parent}/cards/${handoffSourceId}/transfer`, {
      method: 'POST', token: admin, body: JSON.stringify({ target: childP, move: false }),
    });
    assert.equal(handoff.status, 200, JSON.stringify(handoff.body));
    const handoffReplay = await call(`/api/projects/${parent}/cards/${handoffSourceId}/transfer`, {
      method: 'POST', token: admin, body: JSON.stringify({ target: childP, move: false }),
    });
    assert.equal(handoffReplay.status, 200);
    assert.equal(handoffReplay.body['target'], handoff.body['target'], 'handoff replay converges on one target card');
    assert.equal(handoffReplay.body['reused'], true);
    const handoffBoard = (await call(`/api/projects/${childP}/board`, { token: admin })).body as { findings: { rule: string; ref: string }[] };
    assert.equal(handoffBoard.findings.some((finding) => finding.rule === 'dangling-relation' && finding.ref === handoff.body['target']), false,
      'the target copied-from link resolves to its ancestor without opening sibling visibility');
    assert.equal((await call(`/api/projects/${childP}/cards/${handoff.body['target'] as string}/close`, { method: 'POST', token: admin, body: '{}' })).status, 200);

    const relationTargetId = handoff.body['target'] as string;
    const hostedLink = await call(`/api/projects/${parent}/cards/${handoffSourceId}/link`, {
      method: 'POST', token: admin,
      body: JSON.stringify({ target: `project:${childP}#${relationTargetId}`, type: 'parent' }),
    });
    assert.equal(hostedLink.status, 200, JSON.stringify(hostedLink.body));
    assert.equal(hostedLink.body['changed'], true);
    const hostedLinkReplay = await call(`/api/projects/${parent}/cards/${handoffSourceId}/link`, {
      method: 'POST', token: admin,
      body: JSON.stringify({ target: `project:${childP}#${relationTargetId}`, type: 'parent' }),
    });
    assert.equal(hostedLinkReplay.status, 200);
    assert.equal(hostedLinkReplay.body['changed'], false, 'cross-project link replay changes neither half');
    const linkedSource = (await call(`/api/projects/${parent}/cards/${handoffSourceId}`, { token: admin })).body as {
      relations: { type: string; target: string }[];
    };
    const linkedTarget = (await call(`/api/projects/${childP}/cards/${relationTargetId}`, { token: admin })).body as {
      relations: { type: string; target: string }[];
    };
    assert.ok(linkedSource.relations.some((relation) => relation.type === 'parent' && relation.target === `project:${childP}#${relationTargetId}`));
    assert.ok(linkedTarget.relations.some((relation) => relation.type === 'subtask' && relation.target === `project:${parent}#${handoffSourceId}`));
    const linkedChildBoard = (await call(`/api/projects/${childP}/board`, { token: admin })).body as { findings: { rule: string; ref: string }[] };
    assert.equal(linkedChildBoard.findings.some((finding) => finding.rule === 'dangling-relation' && finding.ref === relationTargetId), false,
      'authorized inverse relation stays visible as an opaque ancestor endpoint');
    const inverseUnlink = await call(`/api/projects/${childP}/cards/${relationTargetId}/unlink`, {
      method: 'POST', token: admin,
      body: JSON.stringify({ target: `project:${parent}#${handoffSourceId}`, type: 'subtask' }),
    });
    assert.equal(inverseUnlink.status, 200, JSON.stringify(inverseUnlink.body));
    assert.equal(inverseUnlink.body['changed'], true, 'an owner can remove the inverse from either project view');
    assert.equal(((await call(`/api/projects/${parent}/cards/${handoffSourceId}`, { token: admin })).body as { relations: { type: string }[] }).relations
      .some((relation) => relation.type === 'parent'), false);

    const alarmDue = new Date(Date.now() + 2_000).toISOString();
    const alarmSourceId = (await call(`/api/projects/${parent}/cards`, {
      method: 'POST', token: admin,
      body: JSON.stringify({ title: 'Transferred alarm', due: alarmDue, reminders: [0] }),
    })).body['id'] as string;
    const alarmTransfer = await call(`/api/projects/${parent}/cards/${alarmSourceId}/transfer`, {
      method: 'POST', token: admin, body: JSON.stringify({ target: childP, move: false }),
    });
    assert.equal(alarmTransfer.status, 200, JSON.stringify(alarmTransfer.body));
    const alarmTargetId = alarmTransfer.body['target'] as string;
    let targetReminderEvents: { action: string; card_id: string | null }[] = [];
    for (let i = 0; i < 60; i++) {
      targetReminderEvents = (await call(`/api/projects/${childP}/events?limit=100`, { token: admin })).body as unknown as typeof targetReminderEvents;
      if (targetReminderEvents.some((event) => event.action === 'reminder' && event.card_id === alarmTargetId)) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(targetReminderEvents.filter((event) => event.action === 'reminder' && event.card_id === alarmTargetId).length, 1,
      'receiveTransfer schedules the destination reminder without a later board read');
    assert.equal((await call(`/api/projects/${childP}/cards/${alarmTargetId}/close`, {
      method: 'POST', token: admin, body: '{}',
    })).status, 200, 'the scheduling fixture does not leave child rollup work open');

    const crossBase = await call(`/api/projects/${childP}/cards`, {
      method: 'POST', token: admin, body: JSON.stringify({ title: 'Cross-board foundation' }),
    });
    const crossBaseId = crossBase.body['id'] as string;
    assert.equal((await call(`/api/projects/${childP}/cards/${crossBaseId}/close`, { method: 'POST', token: admin, body: '{}' })).status, 200);
    const crossWaiter = await call(`/api/projects/${parent}/cards`, {
      method: 'POST', token: admin, body: JSON.stringify({ title: 'Cross-board waiter', deps: [`project:${childP}#${crossBaseId}`] }),
    });
    const crossWaiterId = crossWaiter.body['id'] as string;
    const crossClaim = await call(`/api/projects/${parent}/cards/${crossWaiterId}/claim`, { method: 'POST', token: admin, body: '{}' });
    assert.equal(crossClaim.status, 200, JSON.stringify(crossClaim.body));

    // A child-scoped writer gets the same refusal for a real and guessed
    // ancestor card through friendly writes. Snapshot import preserves
    // hand-authored refs for repair, but both render unresolved: copied-from
    // transfer provenance remains renderable and is never resolved for state.
    const CHILD_PW = 'child-writer-password';
    const childMember = await call('/api/members', { method: 'POST', token: admin, body: JSON.stringify({
      username: 'child-writer', display: 'Child Writer', kind: 'human', password: CHILD_PW,
      role: 'write', scopeKind: 'project', scopeId: childP,
    }) });
    assert.equal(childMember.status, 200, JSON.stringify(childMember.body));
    const childLogin = await call('/api/login', { method: 'POST', body: JSON.stringify({ username: 'child-writer', password: CHILD_PW }) });
    const childToken = childLogin.body['token'] as string;
    assert.equal((await call(`/api/projects/${parent}/board`, { token: childToken })).status, 404);
    const realRelationProbe = await call(`/api/projects/${childP}/cards/${relationTargetId}/link`, {
      method: 'POST', token: childToken,
      body: JSON.stringify({ target: `project:${parent}#${crossWaiterId}`, type: 'relates' }),
    });
    const fakeRelationProbe = await call(`/api/projects/${childP}/cards/${relationTargetId}/link`, {
      method: 'POST', token: childToken,
      body: JSON.stringify({ target: 'project:not-a-project#does-not-exist', type: 'relates' }),
    });
    assert.equal(realRelationProbe.status, 403);
    assert.equal(fakeRelationProbe.status, 403);
    assert.equal(realRelationProbe.body['error'], fakeRelationProbe.body['error'], 'cross-link refusal does not reveal ancestor project/card existence');
    const realAncestorProbe = await call(`/api/projects/${childP}/cards`, {
      method: 'POST', token: childToken,
      body: JSON.stringify({ title: 'real probe', deps: [`project:${parent}#${crossWaiterId}`] }),
    });
    const fakeAncestorProbe = await call(`/api/projects/${childP}/cards`, {
      method: 'POST', token: childToken,
      body: JSON.stringify({ title: 'fake probe', deps: [`project:${parent}#does-not-exist`] }),
    });
    assert.equal(realAncestorProbe.status, 400);
    assert.equal(fakeAncestorProbe.status, 400);
    assert.equal(realAncestorProbe.body['error'], fakeAncestorProbe.body['error'], 'ancestor existence is not reflected in the refusal');
    const childSnapshot = (await call(`/api/projects/${childP}/export`, { token: childToken })).body as {
      config: string; cards: { path: string; text: string }[];
    };
    const smuggledAncestor = {
      config: childSnapshot.config,
      cards: [
        ...childSnapshot.cards,
        {
          path: 'cards/ancestor-real-probe.md',
          text: `---\nid: ancestor-real-probe\ntitle: real ancestor probe\nlane: todo\ndeps: ["project:${parent}#${crossWaiterId}"]\n---\n`,
        },
        {
          path: 'cards/ancestor-fake-probe.md',
          text: `---\nid: ancestor-fake-probe\ntitle: fake ancestor probe\nlane: todo\ndeps: ["project:${parent}#does-not-exist"]\n---\n`,
        },
      ],
    };
    const smuggledImport = await call(`/api/projects/${childP}/import`, {
      method: 'PUT', token: childToken, body: JSON.stringify(smuggledAncestor),
    });
    assert.equal(smuggledImport.status, 200, JSON.stringify(smuggledImport.body));
    const probeBoard = (await call(`/api/projects/${childP}/board`, { token: childToken })).body as {
      ready: string[];
      findings: { rule: string; ref: string }[];
      lanes: { cards: { id: string; relationships: { source: string; state: string | null }[] }[] }[];
    };
    for (const id of ['ancestor-real-probe', 'ancestor-fake-probe']) {
      const card = probeBoard.lanes.flatMap((lane) => lane.cards).find((candidate) => candidate.id === id)!;
      assert.equal(card.relationships.find((relation) => relation.source === 'dependency')?.state, null);
      assert.equal(probeBoard.ready.includes(id), false);
      assert.ok(probeBoard.findings.some((finding) => finding.rule === 'dangling-dep' && finding.ref === id));
    }
    assert.equal((await call(`/api/projects/${childP}/import`, {
      method: 'PUT', token: childToken, body: JSON.stringify(childSnapshot),
    })).status, 200, 'the repair path can remove the inert hand-authored probes');

    // Discovery/collaboration is one contract across hosted APIs and feeds.
    assert.equal((await call(`/api/projects/${parent}/cards/${crossWaiterId}/watch`, { method: 'POST', token: key, body: '{}' })).status, 200);
    assert.equal((await call(`/api/projects/${parent}/cards/${crossWaiterId}/vote`, { method: 'POST', token: key, body: '{}' })).status, 200);
    assert.equal((await call(`/api/projects/${parent}/cards/${crossWaiterId}/boost`, { method: 'POST', token: key, body: JSON.stringify({ text: 'ship it 🚀' }) })).status, 200);
    assert.equal((await call(`/api/projects/${parent}/cards/${crossWaiterId}/edit`, {
      method: 'POST', token: key, body: JSON.stringify({ due: '2026-08-21' }),
    })).status, 200);
    const savedFilter = await call(`/api/projects/${parent}/filters`, {
      method: 'POST', token: admin, body: JSON.stringify({ id: 'bot-watch', name: 'Bot watch', query: 'watcher:@me' }),
    });
    assert.equal(savedFilter.status, 200, JSON.stringify(savedFilter.body));
    const searched = await call(`/api/projects/${parent}/search?saved=bot-watch`, { token: key });
    assert.equal(searched.status, 200);
    assert.deepEqual((searched.body as unknown as { id: string }[]).map((card) => card.id), [crossWaiterId]);
    assert.equal((await call(`/api/projects/${parent}/lanes/doing/subscribe`, { method: 'POST', token: key, body: '{}' })).status, 200);
    const collabCard = (await call(`/api/projects/${parent}/cards/${crossWaiterId}`, { token: admin })).body as unknown as {
      watchers: string[]; votes: string[]; boostCount: number; audience: string[];
    };
    assert.deepEqual(collabCard.watchers, ['alpha-agent']);
    assert.deepEqual(collabCard.votes, ['alpha-agent']);
    assert.equal(collabCard.boostCount, 1);
    assert.ok(collabCard.audience.includes('alpha-agent'));

    const feedCreated = await call(`/api/projects/${parent}/feeds`, {
      method: 'POST', token: key, body: JSON.stringify({ label: 'bot activity', filter: 'bot-watch' }),
    });
    assert.equal(feedCreated.status, 200, JSON.stringify(feedCreated.body));
    const feedToken = feedCreated.body['token'] as string;
    for (const [format, contentType, needle] of [
      ['atom', 'application/atom+xml', '<feed xmlns="http://www.w3.org/2005/Atom">'],
      ['rss', 'application/rss+xml', '<rss version="2.0">'],
      ['ics', 'text/calendar', 'BEGIN:VCALENDAR'],
    ] as const) {
      const response = await fetch(`${U}/feeds/${feedToken}.${format}`);
      assert.equal(response.status, 200, `${format} feed`);
      assert.match(response.headers.get('content-type') ?? '', new RegExp(`^${contentType.replace(/[+]/g, '\\+')}`));
      const text = await response.text();
      assert.ok(text.includes(needle), `${format} has its root marker`);
      if (format === 'ics') assert.ok(text.includes(`X-BOTFLOW-CARD-ID:${crossWaiterId}`), 'calendar includes matching due card');
    }
    const scopedMarker = 'scoped-event-survives-project-window';
    assert.equal((await call(`/api/projects/${parent}/cards/${crossWaiterId}/comment`, {
      method: 'POST', token: key, body: JSON.stringify({ message: scopedMarker }),
    })).status, 200);
    await Promise.all(Array.from({ length: 105 }, (_, index) => call(`/api/projects/${parent}/cards/001/log`, {
      method: 'POST', token: admin, body: JSON.stringify({ message: `unrelated feed churn ${index}` }),
    })));
    const scopedAtom = await fetch(`${U}/feeds/${feedToken}.atom`).then((response) => response.text());
    assert.ok(scopedAtom.includes(scopedMarker), 'feed scope is applied before the 100-event bound');
    const feeds = (await call(`/api/projects/${parent}/feeds`, { token: key })).body as unknown as { token: string; filterId: string; memberUsername: string }[];
    assert.equal(feeds.find((feed) => feed.token === feedToken)?.filterId, 'bot-watch');
    assert.equal(feeds.find((feed) => feed.token === feedToken)?.memberUsername, 'alpha-agent');
    const disposableFeed = await call(`/api/projects/${parent}/feeds`, { method: 'POST', token: key, body: JSON.stringify({ label: 'revoke me' }) });
    const disposableToken = disposableFeed.body['token'] as string;
    assert.equal((await call(`/api/feeds/${disposableFeed.body['id'] as string}/revoke`, { method: 'POST', token: key, body: '{}' })).status, 200);
    assert.equal((await fetch(`${U}/feeds/${disposableToken}.rss`)).status, 404, 'revocation is immediate');

    // Share link + export/import round trip as a restore.
    const share = (await call(`/api/projects/${parent}/shares`, { method: 'POST', token: admin, body: JSON.stringify({ label: 'peek' }) })).body['token'] as string;
    const publicEventBefore = ((await call(`/api/projects/${parent}/events?limit=1`, { token: admin })).body as unknown as { seq: number }[])[0]?.seq;
    const compactPublicBoard = await call(`/api/public/${share}/board?flow=0`);
    assert.equal(compactPublicBoard.status, 200, 'direct share url remains usable');
    assert.equal(Object.hasOwn(compactPublicBoard.body, 'flow'), false, 'public polling can omit board-series metrics too');
    const firstShareView = ((await call('/api/org/shares', { token: admin })).body as unknown as { token: string; lastViewed: string | null }[])
      .find((item) => item.token === share)?.lastViewed;
    assert.ok(firstShareView, 'first capability read records coarse access metadata');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await call(`/api/public/${share}/board`)).status, 200);
    const secondShareView = ((await call('/api/org/shares', { token: admin })).body as unknown as { token: string; lastViewed: string | null }[])
      .find((item) => item.token === share)?.lastViewed;
    assert.equal(secondShareView, firstShareView, 'hot polling does not write last-viewed on every request');
    const publicEventAfter = ((await call(`/api/projects/${parent}/events?limit=1`, { token: admin })).body as unknown as { seq: number }[])[0]?.seq;
    assert.equal(publicEventAfter, publicEventBefore, 'public projection polling appends no project event');
    const closedGate = (await call('/api/public/gate')).body as { shares: { token: string }[] };
    assert.equal(closedGate.shares.length, 0, 'share directory is off by default');
    const tagSettings = await call('/api/settings', {
      method: 'POST', token: admin, body: JSON.stringify({ cardTagLimit: 4 }),
    });
    assert.equal(tagSettings.body['cardTagLimit'], 4, 'owners can set the compact card tag allowance');
    assert.equal((await call('/api/theme')).body['cardTagLimit'], 4,
      'the public appearance endpoint carries the limit to operators and share pages');
    await call('/api/settings', { method: 'POST', token: admin, body: JSON.stringify({ gateShares: true }) });
    assert.equal((await call('/api/settings', { token: admin })).body['cardTagLimit'], 4,
      'changing an unrelated preference preserves the tag allowance');
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
    assert.equal((await call(`/api/public/${cardShare}/cards/001?compact=1`)).status, 200, 'the scoped card is visible');
    assert.equal((await call(`/api/public/${cardShare}/cards/001/activity?limit=1`)).status, 200, 'its bounded activity is visible');
    assert.equal((await call(`/api/public/${cardShare}/cards/001/comments?limit=1`)).status, 200, 'its bounded comments are visible');
    assert.equal((await call(`/api/public/${cardShare}/board`)).status, 404, 'the board is not');
    assert.equal((await call(`/api/public/${cardShare}/cards/002`)).status, 404, 'sibling cards are not');
    assert.equal((await call(`/api/public/${cardShare}/cards/002/activity?limit=1`)).status, 404, 'sibling activity is not');
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

    // Active integration configuration is a restore concern even though old
    // delivery bodies, retry queues, dedupe records, and health state are not.
    // A never-produced event keeps this proof hermetic: no network delivery
    // can race the export.
    assert.equal((await call(`/api/projects/${parent}/webhooks`, { token: key })).status, 403,
      'a scoped bot cannot read owner-held webhook secrets');
    assert.equal((await call(`/api/projects/${parent}/email/routes`, { token: key })).status, 403,
      'a scoped bot cannot read inbound route configuration');
    const restoreWebhookResult = await call(`/api/projects/${parent}/webhooks`, {
      method: 'POST', token: admin,
      body: JSON.stringify({ name: 'restore-only hook', url: 'https://hooks.example.com/botflow', allowEvents: ['never-event'] }),
    });
    assert.equal(restoreWebhookResult.status, 200, JSON.stringify(restoreWebhookResult.body));
    const restoreWebhook = restoreWebhookResult.body['webhook'] as { id: string };
    const restoreWebhookSecret = restoreWebhookResult.body['secret'] as string;
    const restoreRouteResult = await call(`/api/projects/${parent}/email/routes`, {
      method: 'POST', token: admin,
      body: JSON.stringify({ name: 'restore-only inbox', kind: 'create', lane: 'todo' }),
    });
    assert.equal(restoreRouteResult.status, 200, JSON.stringify(restoreRouteResult.body));
    const restoreRoute = restoreRouteResult.body['route'] as { id: string };
    const restoreRouteToken = restoreRouteResult.body['token'] as string;
    const restoreSubscriptionResult = await call(`/api/projects/${parent}/email/subscriptions`, {
      method: 'POST', token: admin,
      body: JSON.stringify({ name: 'restore-only mail', recipients: ['ops@example.com'], allowEvents: ['never-event'] }),
    });
    assert.equal(restoreSubscriptionResult.status, 200, JSON.stringify(restoreSubscriptionResult.body));
    const restoreSubscription = restoreSubscriptionResult.body['subscription'] as { id: string };

    const exported = (await call('/api/org/export', { token: admin })).body as Record<string, unknown>;
    assert.equal(exported['version'], 5, 'the persisted admin role advances the restore envelope');
    assert.ok(Array.isArray(exported['keys']) && (exported['keys'] as unknown[]).length === 5,
      'active keys and every revoked replacement predecessor are exported for faithful restore');
    const exportedMembers = exported['members'] as { username: string; passHash: string; role: string }[];
    assert.ok(Array.isArray(exportedMembers), 'members exported');
    assert.deepEqual(exportedMembers.map((m) => m.username).sort(),
      ['alpha-agent', 'child-writer', 'project-admin', 'root', 'space-admin', 'watcher']);
    assert.deepEqual(
      exportedMembers.filter((m) => m.role === 'admin').map((m) => {
        const full = m as typeof m & { scopeKind: string; scopeId: string | null };
        return { username: full.username, scopeKind: full.scopeKind, scopeId: full.scopeId };
      }).sort((a, b) => a.username.localeCompare(b.username)),
      [
        { username: 'project-admin', scopeKind: 'project', scopeId: parent },
        { username: 'space-admin', scopeKind: 'space', scopeId: space2 },
      ],
      'v5 preserves each admin grant without widening it',
    );
    // Password hashes ride along or a restore locks the owner out of their
    // own company. That is also why the export is a credential.
    assert.match(exportedMembers.find((m) => m.username === 'root')!.passHash, /^pbkdf2\$/);
    assert.deepEqual((exported['keys'] as { username: string }[]).map((k) => k.username).sort(),
      ['alpha-agent', 'alpha-agent', 'alpha-agent', 'alpha-agent', 'project-admin'],
      'keys name their member, not a project');
    const adminInV4 = structuredClone(exported);
    adminInV4['version'] = 4;
    const rejectedAdminV4 = await call('/api/org/import', { method: 'PUT', token: admin, body: JSON.stringify(adminInV4) });
    assert.equal(rejectedAdminV4.status, 400, 'old envelopes cannot silently acquire a new role meaning');
    assert.match(String(rejectedAdminV4.body['error']), /admin role requires version 5/);
    const exportedCapabilities = exported['shares'] as { token: string; kind?: string; memberUsername?: string; filterId?: string }[];
    const exportedFeed = exportedCapabilities.find((capability) => capability.token === feedToken);
    assert.deepEqual(
      { kind: exportedFeed?.kind, memberUsername: exportedFeed?.memberUsername, filterId: exportedFeed?.filterId },
      { kind: 'feed', memberUsername: 'alpha-agent', filterId: 'bot-watch' },
      'feed capability scope and member survive export',
    );
    const manifest = exported['uploads'] as { key: string }[];
    assert.ok(manifest.some((u) => upUrl === `/files/${u.key}`), 'export manifests uploaded objects');
    const exportedSpaces = exported['spaces'] as {
      projects: { id: string; integrations: {
        schema: string;
        webhooks: { id: string; secret: string; active: boolean }[];
        emailRoutes: { id: string; tokenHash: string; token?: string; active: boolean; lane: string | null }[];
        emailSubscriptions: { id: string; active: boolean }[];
      } }[];
    }[];
    const exportedParent = exportedSpaces.flatMap((item) => item.projects).find((item) => item.id === parent)!;
    assert.equal(exportedParent.integrations.schema, 'botflow.integrations.v1');
    assert.equal(exportedParent.integrations.webhooks.find((item) => item.id === restoreWebhook.id)?.secret, restoreWebhookSecret,
      'webhook signing secret survives in the credential-bearing export');
    const exportedRoute = exportedParent.integrations.emailRoutes.find((item) => item.id === restoreRoute.id)!;
    assert.match(exportedRoute.tokenHash, /^[a-f0-9]{64}$/);
    assert.equal(exportedRoute.token, undefined, 'an export never reveals an inbound route bearer token');
    assert.ok(exportedParent.integrations.emailSubscriptions.some((item) => item.id === restoreSubscription.id));
    assert.ok([
      ...exportedParent.integrations.webhooks,
      ...exportedParent.integrations.emailRoutes,
      ...exportedParent.integrations.emailSubscriptions,
    ].every((item) => item.active), 'revoked integration tombstones are omitted from restore configuration');

    const beforeCredentialFailure = (await call('/api/org', { token: admin })).body as Record<string, unknown>;
    const beforeCredentialSettings = (await call('/api/settings', { token: admin })).body;
    const invalidHash = structuredClone(exported);
    const invalidHashMembers = invalidHash['members'] as Record<string, unknown>[];
    invalidHashMembers.find((member) => member['username'] === 'root')!['passHash'] =
      `pbkdf2$0$${'a'.repeat(32)}$${'b'.repeat(64)}`;
    const invalidHashImport = await call('/api/org/import', { method: 'PUT', token: admin, body: JSON.stringify(invalidHash) });
    assert.equal(invalidHashImport.status, 400);
    assert.match(String(invalidHashImport.body['error']), /malformed member metadata/);
    assert.deepEqual((await call('/api/org', { token: admin })).body['spaces'], beforeCredentialFailure['spaces'],
      'an unusable password hash is rejected before staging registry rows');

    const missingScope = structuredClone(exported);
    const scopedMember = (missingScope['members'] as Record<string, unknown>[]).find((member) => member['username'] === 'watcher')!;
    scopedMember['scopeKind'] = 'project';
    scopedMember['scopeId'] = 'project-not-in-export';
    const missingScopeImport = await call('/api/org/import', { method: 'PUT', token: admin, body: JSON.stringify(missingScope) });
    assert.equal(missingScopeImport.status, 400);
    assert.match(String(missingScopeImport.body['error']), /scope does not name an exported project/);
    assert.deepEqual((await call('/api/org', { token: admin })).body['spaces'], beforeCredentialFailure['spaces']);

    const duplicateKey = structuredClone(exported);
    (duplicateKey['keys'] as Record<string, unknown>[]).push({ ...(duplicateKey['keys'] as Record<string, unknown>[])[0]! });
    const duplicateKeyImport = await call('/api/org/import', { method: 'PUT', token: admin, body: JSON.stringify(duplicateKey) });
    assert.equal(duplicateKeyImport.status, 400);
    assert.match(String(duplicateKeyImport.body['error']), /duplicate api key hash/);

    const ownerless = structuredClone(exported);
    ownerless['name'] = 'must not replace the company';
    ownerless['theme'] = { style: 'harbor', accent: 'pacific', mode: 'light', density: 'relaxed' };
    for (const member of ownerless['members'] as Record<string, unknown>[]) {
      if (member['role'] === 'owner') member['disabled'] = true;
    }
    const ownerlessImport = await call('/api/org/import', { method: 'PUT', token: admin, body: JSON.stringify(ownerless) });
    assert.equal(ownerlessImport.status, 400);
    assert.match(String(ownerlessImport.body['error']), /no live owner/);
    const afterOwnerless = (await call('/api/org', { token: admin })).body as Record<string, unknown>;
    assert.equal(afterOwnerless['name'], beforeCredentialFailure['name'], 'failed restore leaves org metadata unchanged');
    assert.deepEqual(afterOwnerless['spaces'], beforeCredentialFailure['spaces'], 'failed restore removes every staged space');
    assert.deepEqual(await call('/api/settings', { token: admin }).then((result) => result.body), beforeCredentialSettings,
      'theme and preferences remain unchanged');
    assert.equal((await call('/api/whoami', { token: admin })).status, 200, 'failed restore does not revoke the owner session');
    assert.equal((await call('/api/whoami', { token: key })).status, 200, 'failed restore does not alter existing api keys');
    const afterFailedCredentialExport = (await call('/api/org/export', { token: admin })).body as Record<string, unknown>;
    for (const field of ['name', 'theme', 'prefs', 'members', 'keys', 'shares']) {
      assert.deepEqual(afterFailedCredentialExport[field], exported[field], `failed restore preserves registry ${field}`);
    }

    const malformedCurrent = structuredClone(exported);
    const malformedParent = (malformedCurrent['spaces'] as typeof exportedSpaces)
      .flatMap((item) => item.projects).find((item) => item.id === parent)!;
    malformedParent.integrations.webhooks.find((item) => item.id === restoreWebhook.id)!.secret = 'plaintext';
    const beforeMalformedImport = (await call('/api/org', { token: admin })).body['spaces'];
    const malformedImport = await call('/api/org/import', { method: 'PUT', token: admin, body: JSON.stringify(malformedCurrent) });
    assert.equal(malformedImport.status, 400);
    assert.match(String(malformedImport.body['error']), /integrations.*secret is invalid/);
    assert.deepEqual((await call('/api/org', { token: admin })).body['spaces'], beforeMalformedImport,
      'current integration validation finishes before any registry row is created');

    const semanticCurrent = structuredClone(exported);
    const semanticParent = (semanticCurrent['spaces'] as typeof exportedSpaces)
      .flatMap((item) => item.projects).find((item) => item.id === parent)!;
    semanticParent.integrations.emailRoutes.find((item) => item.id === restoreRoute.id)!.lane = 'no-such-lane';
    const semanticImport = await call('/api/org/import', { method: 'PUT', token: admin, body: JSON.stringify(semanticCurrent) });
    assert.equal(semanticImport.status, 400);
    assert.match(String(semanticImport.body['error']), /missing lane or substate/);
    assert.deepEqual((await call('/api/org', { token: admin })).body['spaces'], beforeMalformedImport,
      'a semantically invalid integration target rolls back every project created by that import');
    await call('/api/settings', {
      method: 'POST', token: admin,
      body: JSON.stringify({ style: 'harbor', accent: 'pacific', mode: 'light', density: 'relaxed' }),
    });

    await call(`/api/spaces/${space}`, { method: 'DELETE', token: admin });
    assert.equal((await call(`/api/public/${share}/board`)).status, 404, 'share died with the space');
    assert.equal((await fetch(`${U}/feeds/${feedToken}.atom`)).status, 404, 'member-scoped feed died with project scope');
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
    assert.equal((await call('/api/whoami', { token: projectAdmin })).status, 401, 'a project admin dies with its project scope');
    assert.equal((await call('/api/whoami', { token: projectAdminKey })).status, 401, 'its api key loses access at the same instant');
    assert.equal((await call('/api/whoami', { token: spaceAdmin })).status, 200, 'an admin in another space is unaffected');

    const imported = await call('/api/org/import', { method: 'PUT', token: admin, body: JSON.stringify(exported) });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const org2 = (await call('/api/org', { token: admin })).body as {
      spaces: { id: string; name: string; projects: { id: string; name: string; children: { id: string; name: string }[] }[] }[];
    };
    const restoredSpace = org2.spaces.find((s) => s.name === 'eng')!;
    const restoredParent = restoredSpace.projects.find((p) => p.name === 'parent')!;
    assert.equal(restoredParent.children.length, 1, 'exactly one restored child, no duplicate project card');
    const restoredWebhooks = (await call(`/api/projects/${restoredParent.id}/webhooks`, { token: admin })).body['webhooks'] as unknown as {
      id: string; failureCount: number; circuitUntil: string | null;
    }[];
    assert.deepEqual(
      restoredWebhooks.filter((item) => item.id === restoreWebhook.id).map((item) => ({ failureCount: item.failureCount, circuitUntil: item.circuitUntil })),
      [{ failureCount: 0, circuitUntil: null }],
      'active webhook config survives with clean health state',
    );
    const restoredRoutes = (await call(`/api/projects/${restoredParent.id}/email/routes`, { token: admin })).body['routes'] as unknown as { id: string }[];
    assert.ok(restoredRoutes.some((item) => item.id === restoreRoute.id), 'active inbound route survives');
    const restoredSubscriptions = (await call(`/api/projects/${restoredParent.id}/email/subscriptions`, { token: admin })).body['subscriptions'] as unknown as { id: string }[];
    assert.ok(restoredSubscriptions.some((item) => item.id === restoreSubscription.id), 'active outbound subscription survives');
    const restoredOutbox = (await call(`/api/projects/${restoredParent.id}/email/outbox`, { token: admin })).body['messages'] as unknown[];
    assert.deepEqual(restoredOutbox, [], 'outbox and delivery history reset across remapped project ids');
    const restoredInbound = await call(`/api/email/inbound/${restoredParent.id}/${restoreRouteToken}`, {
      method: 'POST', body: JSON.stringify({
        messageId: 'restored-provider-message-1', from: 'restore@example.com',
        subject: 'Restored route works', text: 'The hash was restored under the new project id.',
      }),
    });
    assert.equal(restoredInbound.status, 202, JSON.stringify(restoredInbound.body));
    assert.equal(restoredInbound.body['duplicate'], false,
      'the original route token authenticates against its restored hash on the new project id');
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

    const restoredMembers = (await call('/api/members', { token: admin })).body as unknown as {
      username: string; role: string; scopeKind: string; scopeId: string | null;
    }[];
    const restoredProjectAdmin = restoredMembers.find((member) => member.username === 'project-admin')!;
    const restoredSpaceAdmin = restoredMembers.find((member) => member.username === 'space-admin')!;
    assert.deepEqual(
      { role: restoredProjectAdmin.role, scopeKind: restoredProjectAdmin.scopeKind, scopeId: restoredProjectAdmin.scopeId },
      { role: 'admin', scopeKind: 'project', scopeId: restoredParent.id },
      'project-admin scope remaps to the restored project',
    );
    const restoredAdminSpace = org2.spaces.find((item) => item.id === restoredSpaceAdmin.scopeId)!;
    assert.ok(restoredAdminSpace && restoredAdminSpace.name === 'ops', 'space-admin scope remaps to the restored space');
    const restoredProjectAdminSession = (await call('/api/login', {
      method: 'POST', body: JSON.stringify({ username: 'project-admin', password: PROJECT_ADMIN_PW }),
    })).body['token'] as string;
    assert.equal((await call('/api/whoami', { token: projectAdminKey })).body['role'], 'admin',
      'the original scoped-admin key hash survives restore');
    const restoredSpaceAdminSession = (await call('/api/login', {
      method: 'POST', body: JSON.stringify({ username: 'space-admin', password: SPACE_ADMIN_PW }),
    })).body['token'] as string;
    const restoredParentConfig = (await call(`/api/projects/${restoredParent.id}/config`, { token: restoredProjectAdminSession })).body;
    assert.equal((await call(`/api/projects/${restoredParent.id}/config`, {
      method: 'PUT', token: restoredProjectAdminSession, body: JSON.stringify(restoredParentConfig),
    })).status, 200, 'restored project admin retains board-shape access');
    const restoredSpaceProject = restoredAdminSpace.projects[0]!;
    const restoredSpaceConfig = (await call(`/api/projects/${restoredSpaceProject.id}/config`, { token: restoredSpaceAdminSession })).body;
    assert.equal((await call(`/api/projects/${restoredSpaceProject.id}/config`, {
      method: 'PUT', token: restoredSpaceAdminSession, body: JSON.stringify(restoredSpaceConfig),
    })).status, 200, 'restored space admin retains board-shape access');
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

    // Version 3 is the immediately previous credential-bearing shape. An
    // unvalidated integrations-looking field is ignored rather than trusted,
    // while all of the version's board data remains restorable.
    const v3Import = await call('/api/org/import', {
      method: 'PUT', token: admin, body: JSON.stringify({
        version: 3, name: 'v3 compatible', members: [], keys: [], shares: [],
        spaces: [{ id: 's-v3', name: 'v3 space', projects: [{
          id: 'p-v3', name: 'v3 project',
          board: { config: 'botflow: 0\nname: v3 project\nlanes:\n  - id: todo\n', cards: [] },
          integrations: { schema: 'untrusted-old-extension', webhooks: [{ secret: 'plaintext' }] },
          children: [],
        }] }],
      }),
    });
    assert.equal(v3Import.status, 200, `a v3 backup still restores: ${JSON.stringify(v3Import.body)}`);
    const v3Project = ((await call('/api/org', { token: admin })).body['spaces'] as unknown as {
      name: string; projects: { id: string; name: string }[];
    }[]).find((item) => item.name === 'v3 space')!.projects.find((item) => item.name === 'v3 project')!;
    assert.deepEqual((await call(`/api/projects/${v3Project.id}/webhooks`, { token: admin })).body['webhooks'], [],
      'pre-v4 extension data is never treated as validated integration configuration');

    const v4Import = await call('/api/org/import', {
      method: 'PUT', token: admin, body: JSON.stringify({
        version: 4, name: 'v4 compatible', members: [], keys: [], shares: [],
        spaces: [{ id: 's-v4', name: 'v4 space', projects: [{
          id: 'p-v4', name: 'v4 project',
          board: { config: 'botflow: 0\nname: v4 project\nlanes:\n  - id: todo\n', cards: [] },
          integrations: { schema: 'botflow.integrations.v1', webhooks: [], emailRoutes: [], emailSubscriptions: [] },
          children: [],
        }] }],
      }),
    });
    assert.equal(v4Import.status, 200, `a v4 backup with the old role set still restores: ${JSON.stringify(v4Import.body)}`);

    // A restored owner is org-wide by construction: role checks never consult
    // scope, so a row claiming owner+project would gate as owner while the
    // members table showed it as project-scoped.
    const exportedNow = (await call('/api/org/export', { token: admin })).body as Record<string, unknown>;
    const narrowed = {
      ...exportedNow,
      // This case is about owner-scope normalization. Reusing a live share
      // token for a second restored tree is a deliberate restore conflict.
      shares: [],
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
            text: `---
id: 001
title: Note about project:old-child and project:old-childish
lane: todo
deps: ["project:old-child#001", "project:old-childish#001"]
relations:
  - type: relates
    target: "project:old-childish#002"
---
mentions project:old-child and project:old-childish in prose
URL https://example.com/project:old-childish must remain literal.
Explicit [[project:old-child#001]] and [[project:old-childish#001]] do remap.
`,
          }] },
          children: [
            { id: 'old-child', name: 'mention-child', children: [] },
            { id: 'old-childish', name: 'mention-childish', children: [] },
          ],
        }] }],
      }),
    });
    assert.equal(mentionImport.status, 200, JSON.stringify(mentionImport.body));
    const org3 = (await call('/api/org', { token: admin })).body as {
      spaces: { name: string; projects: { id: string; children: { id: string; name: string }[] }[] }[];
    };
    const mentionParent = org3.spaces.find((s) => s.name === 'mention-space')!.projects[0]!;
    const mentionChild = mentionParent.children.find((child) => child.name === 'mention-child')!.id;
    const mentionChildish = mentionParent.children.find((child) => child.name === 'mention-childish')!.id;
    const mentionBoard = (await call(`/api/projects/${mentionParent.id}/board`, { token: admin })).body as {
      lanes: { cards: { type: string; child: string | null }[] }[];
    };
    const mentionProjectCards = mentionBoard.lanes.flatMap((lane) => lane.cards).filter((card) => card.type === 'board');
    assert.equal(mentionProjectCards.filter((card) => card.child === mentionChild).length, 1);
    assert.equal(mentionProjectCards.filter((card) => card.child === mentionChildish).length, 1,
      'prefix-related ids each create exactly one correctly remapped project card');
    const mentionNote = (await call(`/api/projects/${mentionParent.id}/cards/001`, { token: admin })).body as Record<string, unknown>;
    assert.equal(mentionNote['title'], 'Note about project:old-child and project:old-childish', 'titles are prose, not rewrite targets');
    assert.deepEqual(mentionNote['deps'], [`project:${mentionChild}#001`, `project:${mentionChildish}#001`]);
    assert.equal((mentionNote['relations'] as { target: string }[])[0]!.target, `project:${mentionChildish}#002`);
    assert.match(String(mentionNote['body']), /mentions project:old-child and project:old-childish in prose/);
    assert.match(String(mentionNote['body']), /https:\/\/example\.com\/project:old-childish/);
    assert.match(String(mentionNote['body']), new RegExp(`\\[\\[project:${mentionChild}#001\\]\\]`));
    assert.match(String(mentionNote['body']), new RegExp(`\\[\\[project:${mentionChildish}#001\\]\\]`));

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

test('legacy RegistryDO and ProjectDO schemas migrate additively without losing auth, shares, or boards', { timeout: 180_000 }, async () => {
  const state = mkdtempSync(join(tmpdir(), 'botflow-upgrade-'));
  const configPath = join(state, 'wrangler.json');
  const legacyPath = join(state, 'legacy-worker.js');
  const legacyPassword = 'legacy-password-1';
  const legacyPassHash = await hashPassword(legacyPassword);
  const legacySession = `bfu_${'1'.repeat(40)}`;
  const legacyKey = `bfk_${'2'.repeat(40)}`;
  const legacyShare = '3'.repeat(40);
  const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
  const legacySource = String.raw`
import { DurableObject } from 'cloudflare:workers';
export class RegistryDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS org(id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, admin_hash TEXT NOT NULL DEFAULT "", created TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, space_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, created TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display TEXT NOT NULL, kind TEXT NOT NULL, role TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT, pass_hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS member_keys(id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, member_id TEXT NOT NULL, label TEXT NOT NULL, created TEXT NOT NULL, last_used TEXT, revoked INTEGER NOT NULL DEFAULT 0);' +
      'CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, created TEXT NOT NULL, expires TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS shares(id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, label TEXT NOT NULL, created TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);'
    );
  }
  seed() {
    this.sql.exec("INSERT OR IGNORE INTO org(id, name, admin_hash, created) VALUES (1, 'legacy company', '', '2026-01-01T00:00:00.000Z')");
    this.sql.exec("INSERT OR IGNORE INTO spaces(id, name, created) VALUES ('legacy-space', 'legacy space', '2026-01-01T00:00:00.000Z')");
    this.sql.exec("INSERT OR IGNORE INTO projects(id, space_id, parent_id, name, created) VALUES ('legacy-project', 'legacy-space', NULL, 'legacy project', '2026-01-01T00:00:00.000Z')");
    this.sql.exec("INSERT OR IGNORE INTO members(id, username, display, kind, role, scope_kind, scope_id, pass_hash, disabled, created) VALUES ('legacy-owner', 'root', 'Legacy Root', 'human', 'owner', 'org', NULL, ?, 0, '2026-01-01T00:00:00.000Z')", ${JSON.stringify(legacyPassHash)});
    this.sql.exec("INSERT OR IGNORE INTO member_keys(id, hash, member_id, label, created, revoked) VALUES ('legacy-key', ?, 'legacy-owner', 'legacy agent', '2026-01-01T00:00:00.000Z', 0)", ${JSON.stringify(digest(legacyKey))});
    this.sql.exec("INSERT OR IGNORE INTO sessions(hash, member_id, created, expires) VALUES (?, 'legacy-owner', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')", ${JSON.stringify(digest(legacySession))});
    this.sql.exec("INSERT OR IGNORE INTO shares(id, token, project_id, label, created, revoked) VALUES ('legacy-share', ?, 'legacy-project', 'legacy public board', '2026-01-01T00:00:00.000Z', 0)", ${JSON.stringify(legacyShare)});
    return { ok: true };
  }
}
export class ProjectDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY, file TEXT NOT NULL, text TEXT NOT NULL, updated_at TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, card_id TEXT, detail TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS unfurls(url TEXT PRIMARY KEY, image TEXT, image_hash TEXT, title TEXT, site TEXT, status TEXT NOT NULL, fetched TEXT NOT NULL);'
    );
  }
  seed() {
    this.sql.exec("INSERT OR IGNORE INTO meta(key, value) VALUES ('config', ?)", 'botflow: 0\nname: legacy project\nlanes:\n  - id: todo\n');
    this.sql.exec("INSERT OR IGNORE INTO cards(id, file, text, updated_at) VALUES ('001', 'cards/001-kept.md', ?, '2026-01-01T00:00:00.000Z')",
      '---\nid: 001\ntitle: Kept through upgrade\nlane: todo\ncreated: 2026-01-01\n---\n## Log\n- 2026-01-01 old: created in todo\n');
    return { ok: true };
  }
}
export default {
  async fetch(req, env) {
    if (new URL(req.url).pathname !== '/seed') return new Response('not found', { status: 404 });
    await env.REGISTRY.get(env.REGISTRY.idFromName('main')).seed();
    await env.PROJECT.get(env.PROJECT.idFromName('legacy-project')).seed();
    return Response.json({ seeded: true });
  },
};
`;
  writeFileSync(legacyPath, legacySource);
  const config = (main: string) => ({
    name: 'botflow-project-upgrade-test', main, compatibility_date: '2026-08-01', compatibility_flags: ['nodejs_compat'],
    migrations: [{ tag: 'v1', new_sqlite_classes: ['RegistryDO', 'ProjectDO'] }],
    durable_objects: { bindings: [
      { name: 'REGISTRY', class_name: 'RegistryDO' },
      { name: 'PROJECT', class_name: 'ProjectDO' },
    ] },
  });
  writeFileSync(configPath, JSON.stringify(config(legacyPath)));
  const legacyPort = await freePort();
  const legacy = spawn(process.execPath, [WRANGLER, 'dev', '--config', configPath, '--port', String(legacyPort), '--persist-to', state], {
    cwd: join(import.meta.dirname, '..'), stdio: 'ignore', env: { ...process.env }, detached: true,
  });
  let current: ReturnType<typeof spawn> | null = null;
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) {
      up = await fetch(`http://127.0.0.1:${legacyPort}/seed`).then((response) => response.ok, () => false);
      if (!up) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.ok(up, 'legacy worker seeded the old schema');
    await stopWorker(legacy, state, false);

    writeFileSync(configPath, JSON.stringify(config(join(import.meta.dirname, '..', 'worker', 'src', 'index.ts'))));
    const currentPort = await freePort();
    current = spawn(
      process.execPath,
      [WRANGLER, 'dev', '--config', configPath, '--port', String(currentPort), '--persist-to', state, '--var', `SETUP_KEY:${SETUP_KEY}`],
      { cwd: join(import.meta.dirname, '..'), stdio: 'ignore', env: { ...process.env }, detached: true },
    );
    const at = async (path: string, opts: RequestInit & { token?: string } = {}) => {
      const response = await fetch(`http://127.0.0.1:${currentPort}${path}`, {
        ...opts,
        headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      });
      return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
    };
    let ready = false;
    for (let i = 0; i < 90 && !ready; i++) {
      ready = await fetch(`http://127.0.0.1:${currentPort}/api/public/gate`).then((response) => response.ok, () => false);
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.ok(ready, 'current worker reopened the persisted namespace');
    assert.equal((await at('/api/org', { token: legacySession })).status, 200, 'a pre-upgrade session survives schema migration');
    assert.equal((await at('/api/whoami', { token: legacyKey })).status, 200, 'a pre-upgrade api key survives schema migration');
    const login = await at('/api/login', { method: 'POST', body: JSON.stringify({ username: 'root', password: legacyPassword }) });
    assert.equal(login.status, 200, 'the existing password hash still authenticates');
    const token = login.body['token'] as string;
    const board = await at('/api/projects/legacy-project/board', { token });
    assert.equal(board.status, 200, JSON.stringify(board.body));
    assert.ok(((board.body['lanes'] as unknown as { cards: { title: string }[] }[])
      .flatMap((lane) => lane.cards)).some((card) => card.title === 'Kept through upgrade'));
    assert.equal((await at(`/api/public/${legacyShare}/board`)).status, 200, 'the old page share defaults to kind=page');
    const shares = (await at('/api/projects/legacy-project/shares', { token })).body as unknown as { token: string; cardId: string | null }[];
    assert.deepEqual(shares.find((share) => share.token === legacyShare), {
      id: 'legacy-share', token: legacyShare, label: 'legacy public board', created: '2026-01-01T00:00:00.000Z', revoked: false, cardId: null,
    });
    assert.equal((await at('/api/projects/legacy-project/feeds', {
      method: 'POST', token, body: JSON.stringify({ label: 'after upgrade feed' }),
    })).status, 200, 'new capability columns and indexes accept writes after migration');
    assert.deepEqual((await at('/api/projects/legacy-project/webhooks', { token })).body['webhooks'], [],
      'new additive tables initialize empty');
    const hook = await at('/api/projects/legacy-project/webhooks', {
      method: 'POST', token,
      body: JSON.stringify({ name: 'after upgrade', url: 'https://hooks.example.com/upgrade', allowEvents: ['never-event'] }),
    });
    assert.equal(hook.status, 200, JSON.stringify(hook.body));
    const route = await at('/api/projects/legacy-project/email/routes', {
      method: 'POST', token, body: JSON.stringify({ name: 'after upgrade', kind: 'create', lane: 'todo' }),
    });
    assert.equal(route.status, 200, JSON.stringify(route.body));
    assert.equal((await at('/api/projects/legacy-project/board', { token })).status, 200,
      'new overlay writes leave the old board readable');
  } finally {
    if (current !== null) await stopWorker(current, state);
    else await stopWorker(legacy, state);
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

    let setupKeyBlocks = 0;
    for (let i = 0; i < 12; i++) {
      const attempt = await at('/api/recover', { method: 'POST', body: JSON.stringify({ username: 'rescue', password: 'another-pass-1', setupKey: 'wrong' }) });
      if (attempt.status === 429) setupKeyBlocks++;
    }
    assert.ok(setupKeyBlocks >= 2, 'setup/recovery key guessing is throttled by the shared credential gate');
  } finally {
    await stopWorker(child, state);
  }
});

test('setup policy: public hosts fail closed while loopback stays zero-config', async () => {
  assert.deepEqual(await setupAccess('manager.example.test', undefined, undefined), {
    ok: false, status: 503, error: 'setup is locked: configure the SETUP_KEY Worker secret, then enter it here',
  });
  assert.deepEqual(await setupAccess('127.0.0.1', undefined, undefined), { ok: true });
  assert.equal((await setupAccess('manager.example.test', 'secret', 'wrong')).ok, false);
  assert.deepEqual(await setupAccess('manager.example.test', 'secret', 'secret'), { ok: true });
});
