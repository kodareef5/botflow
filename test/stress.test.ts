// Adversarial multi-agent stress: botflow as its own nastiest test case.
// Real processes race real claims on one board, strict lanes resist escape,
// mid-run dep cycles get flagged, branch merges surface dup ids, and a
// hosted manager takes a concurrent claim storm then converges via push/pull.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const ENTRY = join(import.meta.dirname, '..', 'src', 'cli', 'botflow.ts');
const WRANGLER = join(import.meta.dirname, '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');

function run(cwd: string, actor: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [ENTRY, ...args], {
      cwd,
      env: { ...process.env, BOTFLOW_ACTOR: actor, BOTFLOW_DIR: '', BOTFLOW_TOKEN: process.env['STRESS_TOKEN'] ?? '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

function runSync(cwd: string, actor: string, ...args: string[]) {
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, BOTFLOW_ACTOR: actor, BOTFLOW_DIR: '' },
  });
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

function must(cwd: string, actor: string, ...args: string[]): string {
  const res = runSync(cwd, actor, ...args);
  assert.equal(res.code, 0, `botflow ${args.join(' ')}: ${res.stderr || res.stdout}`);
  return res.stdout;
}

test('swarm: four agents work one board to completion without corruption', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-swarm-'));
  try {
    must(dir, 'seed', 'init', '--name', 'swarm');
    const AGENTS = ['ant', 'bee', 'cog', 'doe'];
    // Every agent seeds two cards concurrently: eight distinct seq ids.
    await Promise.all(AGENTS.flatMap((a) => [0, 1].map((i) => run(dir, a, 'card', 'add', `${a} task ${i}`))));

    // Then all four race to claim/log/close whatever is ready until the
    // board drains. Claim conflicts are expected traffic, never corruption.
    const work = async (actor: string): Promise<void> => {
      for (;;) {
        const readyRes = await run(dir, actor, 'ready', '--json');
        if (readyRes.code !== 0) continue;
        const ready = JSON.parse(readyRes.stdout) as { id: string }[];
        if (ready.length === 0) return;
        let won: string | null = null;
        for (const c of ready) {
          const claim = await run(dir, actor, 'card', 'claim', c.id);
          if (claim.code === 0) {
            won = c.id;
            break;
          }
          assert.match(claim.stderr, /cannot claim|locked/, claim.stderr);
        }
        if (won === null) continue;
        await run(dir, actor, 'log', won, `working as ${actor}`);
        const closed = await run(dir, actor, 'card', 'close', won, '--reason', 'swarm done');
        assert.equal(closed.code, 0, closed.stderr);
      }
    };
    await Promise.all(AGENTS.map(work));

    // Aftermath: everything closed, lint clean, no lock/tmp litter, and
    // every card was claimed exactly once and closed exactly once.
    const board = JSON.parse(must(dir, 'audit', 'board', '--json')) as {
      lanes: { id: string; cards: { id: string }[] }[];
    };
    const done = board.lanes.find((l) => l.id === 'done')!.cards.length;
    assert.equal(done, 8, JSON.stringify(board.lanes.map((l) => [l.id, l.cards.length])));
    assert.equal(runSync(dir, 'audit', 'lint').code, 0);

    const cardsDir = join(dir, '.botflow', 'cards');
    assert.deepEqual(readdirSync(cardsDir).filter((f) => !f.endsWith('.md')), []);
    assert.ok(!readdirSync(join(dir, '.botflow')).includes('board.lock'));
    for (const f of readdirSync(cardsDir)) {
      const text = readFileSync(join(cardsDir, f), 'utf8');
      assert.equal((text.match(/: claimed/g) ?? []).length, 1, `${f} claimed once:\n${text}`);
      assert.equal((text.match(/: closed/g) ?? []).length, 1, `${f} closed once:\n${text}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('strict substate lane resists escapes mid-flight', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-strict-'));
  try {
    must(dir, 'seed', 'init', '--name', 'strict');
    writeFileSync(
      join(dir, '.botflow', 'board.yaml'),
      `botflow: 0
name: strict
lanes:
  - id: todo
  - id: doing
    substates: [design, implement, review]
    order: strict
  - id: done
`,
    );
    must(dir, 'seed', 'card', 'add', 'gated work');
    must(dir, 'a1', 'card', 'claim', '001'); // enters doing.design

    const skip = runSync(dir, 'a1', 'card', 'mv', '001', 'doing.review');
    assert.notEqual(skip.code, 0, 'skipping a substate must fail');
    assert.match(skip.stderr, /strict/);

    must(dir, 'a1', 'card', 'mv', '001', 'doing.implement');
    must(dir, 'a1', 'card', 'mv', '001', 'doing.review');
    must(dir, 'a1', 'card', 'close', '001', '--reason', 'went through the gates');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dep cycle introduced mid-run turns up as a lint error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-cycle-'));
  try {
    must(dir, 'seed', 'init', '--name', 'cycles');
    must(dir, 'seed', 'card', 'add', 'first');
    must(dir, 'seed', 'card', 'add', 'second', '--deps', '001');
    assert.equal(runSync(dir, 'seed', 'lint').code, 0);

    must(dir, 'chaos', 'card', 'edit', '001', '--deps', '002'); // closes the loop
    const lint = runSync(dir, 'seed', 'lint');
    assert.equal(lint.code, 1);
    assert.match(lint.stdout, /dep-cycle/);
    const ready = JSON.parse(must(dir, 'seed', 'ready', '--json')) as unknown[];
    assert.equal(ready.length, 0, 'cycle members are never ready');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a seq-id branch merge collision surfaces as dup-id', () => {
  const a = mkdtempSync(join(tmpdir(), 'botflow-merge-a-'));
  const b = mkdtempSync(join(tmpdir(), 'botflow-merge-b-'));
  try {
    must(a, 'seed', 'init', '--name', 'trunk');
    must(a, 'seed', 'card', 'add', 'shared history');
    cpSync(join(a, '.botflow'), join(b, '.botflow'), { recursive: true });

    must(a, 'left', 'card', 'add', 'from branch a'); // both branches mint 002
    must(b, 'right', 'card', 'add', 'from branch b');

    // "Merge": one-card-one-file means both files land without conflict…
    const bFile = readdirSync(join(b, '.botflow', 'cards')).find((f) => f.startsWith('002'))!;
    cpSync(join(b, '.botflow', 'cards', bFile), join(a, '.botflow', 'cards', bFile));

    // …and lint is what catches the id collision.
    const lint = runSync(a, 'merge', 'lint');
    assert.equal(lint.code, 1);
    assert.match(lint.stdout, /dup-id/);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('hosted: concurrent claim storm has one winner, push/pull converges', { timeout: 180_000 }, async () => {
  const PORT = 9001 + Math.floor(Math.random() * 90);
  const U = `http://127.0.0.1:${PORT}`;
  const state = mkdtempSync(join(tmpdir(), 'botflow-stress-state-'));
  const child = spawn(
    process.execPath,
    [WRANGLER, 'dev', '--port', String(PORT), '--persist-to', state, '--var', 'SETUP_KEY:stress-key'],
    { cwd: join(import.meta.dirname, '..'), stdio: 'ignore', env: { ...process.env }, detached: true },
  );
  const dir = mkdtempSync(join(tmpdir(), 'botflow-stress-local-'));
  const call = async (path: string, opts: RequestInit & { token?: string } = {}) => {
    const res = await fetch(U + path, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) {
      up = await fetch(`${U}/api/public/gate`).then((r) => r.ok, () => false);
      if (!up) await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(up, 'wrangler dev came up');

    const setup = await call('/api/setup', { method: 'POST', body: JSON.stringify({ name: 'stressco', setupKey: 'stress-key' }) });
    const admin = setup.body['token'] as string;
    const space = (await call('/api/spaces', { method: 'POST', token: admin, body: JSON.stringify({ name: 'ops' }) })).body['id'] as string;
    const project = (await call('/api/projects', { method: 'POST', token: admin, body: JSON.stringify({ space, name: 'arena' }) })).body['id'] as string;

    // Local board pushed up.
    must(dir, 'seed', 'init', '--name', 'arena');
    must(dir, 'seed', 'card', 'add', 'contested');
    must(dir, 'seed', 'card', 'add', 'background');
    must(dir, 'seed', 'remote', 'add', U, project);
    const pushed = await run(dir, 'seed', 'push', '--token', admin);
    assert.equal(pushed.code, 0, pushed.stderr);

    // Six concurrent hosted claims: the DO serializes, exactly one wins.
    const storm = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        call(`/api/projects/${project}/cards/001/claim`, { method: 'POST', token: admin, body: JSON.stringify({ actor: `stormer-${i}` }) }),
      ),
    );
    assert.deepEqual(
      storm.map((r) => r.status).sort(),
      [200, 409, 409, 409, 409, 409],
      JSON.stringify(storm.map((r) => [r.status, r.body['error']])),
    );
    const events = (await call(`/api/projects/${project}/events?limit=50`, { token: admin })).body as unknown as { action: string }[];
    assert.equal(events.filter((e) => e.action === 'claim').length, 1, 'exactly one claim event');

    // Local and hosted edit the same card, then push + pull converge.
    must(dir, 'local-hand', 'log', '002', 'edited locally');
    await call(`/api/projects/${project}/cards/002/comment`, { method: 'POST', token: admin, body: JSON.stringify({ message: 'edited hosted' }) });
    assert.equal((await run(dir, 'seed', 'push', '--token', admin)).code, 0);
    assert.equal((await run(dir, 'seed', 'pull', '--token', admin)).code, 0);
    const exported = (await call(`/api/projects/${project}/export`, { token: admin })).body as { cards: { path: string; text: string }[] };
    for (const doc of exported.cards) {
      assert.equal(readFileSync(join(dir, '.botflow', doc.path), 'utf8'), doc.text, `${doc.path} converged`);
    }
    assert.equal(runSync(dir, 'seed', 'lint').code, 0);
  } finally {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      if (process.platform === 'win32' || child.pid === undefined) child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1500))]);
    if (child.exitCode === null) {
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    rmSync(state, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
