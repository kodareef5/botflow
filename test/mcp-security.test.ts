// MCP security regressions: JSON-RPC error labeling/correlation, tool
// argument validation, protocol-version reporting, stdin buffer cap, and
// quiet shutdown when the client breaks the pipe mid-reply.
// Harness mirrors test/mcp.test.ts: spawn the real server over stdio.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

const ENTRY = join(import.meta.dirname, '..', 'src', 'cli', 'botflow.ts');

type Msg = Record<string, unknown>;

function initBoard(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-mcpsec-'));
  const init = spawnSync(process.execPath, [ENTRY, 'init', '--name', name, '--dir', dir], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  return dir;
}

function startServer(dir: string, pinActor = false) {
  const child = spawn(process.execPath, [ENTRY, 'mcp', '--board', dir, '--actor', 'sec-test', ...(pinActor ? ['--pin-actor'] : [])], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume(); // drain the startup banner
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (msg: Msg) => void>();
  const orphans: Msg[] = []; // responses with id:null (frame-level errors)
  lines.on('line', (line) => {
    const msg = JSON.parse(line) as Msg;
    const id = msg['id'];
    if (id === null || id === undefined) {
      orphans.push(msg);
    } else {
      pending.get(id as number)?.(msg);
      pending.delete(id as number);
    }
  });

  let nextId = 1;
  const request = (method: string, params?: unknown): Promise<Msg> => {
    const id = nextId++;
    const p = new Promise<Msg>((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 8000);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return p;
  };
  const callTool = async (name: string, args: unknown): Promise<{ text: string; isError: boolean }> => {
    const res = (await request('tools/call', { name, arguments: args })) as {
      result: { content: { text: string }[]; isError: boolean };
    };
    return { text: res.result.content[0]!.text, isError: res.result.isError };
  };
  const nextOrphan = (): Promise<Msg> =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = (): void => {
        const msg = orphans.shift();
        if (msg) return resolve(msg);
        if (Date.now() - started > 8000) return reject(new Error('timeout waiting for id:null response'));
        setTimeout(tick, 10);
      };
      tick();
    });
  return { child, request, callTool, nextOrphan };
}

test('mcp security: initialize reports the server protocol version', async () => {
  const s = startServer(initBoard('sec-version'));
  try {
    const res = (await s.request('initialize', {
      protocolVersion: '2099-01-01',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })) as { result: { protocolVersion: string } };
    assert.equal(res.result.protocolVersion, '2025-06-18');
  } finally {
    s.child.kill();
  }
});

test('mcp security: tools/call argument shapes and error labeling', async () => {
  const s = startServer(initBoard('sec-labels'));
  try {
    // arguments must be a plain object → -32602 invalid params, request id kept.
    for (const bad of ['nope', 42, ['title', 'x']]) {
      const res = (await s.request('tools/call', { name: 'board', arguments: bad })) as {
        id: number;
        error: { code: number };
      };
      assert.equal(res.error.code, -32602, `arguments=${JSON.stringify(bad)}`);
      assert.equal(typeof res.id, 'number');
    }

    // A garbage frame is the only -32700 case, with id:null.
    s.child.stdin.write('this is not json\n');
    const orphan = (await s.nextOrphan()) as { id: null; error: { code: number } };
    assert.equal(orphan.id, null);
    assert.equal(orphan.error.code, -32700);

    // A non-object frame parses but is an invalid request, not a parse error.
    s.child.stdin.write('42\n');
    const scalar = (await s.nextOrphan()) as { id: null; error: { code: number } };
    assert.equal(scalar.error.code, -32600);

    // The server survives all of the above and keeps correlating requests.
    const ping = (await s.request('ping')) as { id: number; result: object };
    assert.equal(typeof ping.id, 'number');
    assert.deepEqual(ping.result, {});
  } finally {
    s.child.kill();
  }
});

test('mcp security: internal tool error is -32603 with the original request id', async () => {
  const dir = initBoard('sec-internal');
  // Read-only board tree: the write fails with a non-UsageError (EACCES).
  assert.equal(spawnSync('chmod', ['-R', 'a-w', join(dir, '.botflow')]).status, 0);
  const s = startServer(dir);
  try {
    const res = (await s.request('tools/call', { name: 'card_add', arguments: { title: 'boom' } })) as {
      id: number;
      error?: { code: number; message: string };
    };
    assert.ok(res.error, `expected an error, got ${JSON.stringify(res)}`);
    assert.equal(res.error.code, -32603);
    assert.equal(res.error.message, 'internal server error', 'host filesystem details stay server-side');
    assert.equal(typeof res.id, 'number', 'request id must survive (no -32700 mislabeling)');
  } finally {
    s.child.kill();
    spawnSync('chmod', ['-R', 'u+w', join(dir, '.botflow')]);
  }
});

test('mcp security: --pin-actor prevents client-supplied attribution spoofing', async () => {
  const s = startServer(initBoard('sec-pin-actor'), true);
  try {
    const added = await s.callTool('card_add', { title: 'pinned', actor: 'ceo' });
    assert.equal(added.isError, false, added.text);
    const id = (JSON.parse(added.text) as { id: string }).id;
    const shown = await s.callTool('card_show', { id });
    const card = JSON.parse(shown.text) as { parsed: { log: { actor: string }[] } };
    assert.equal(card.parsed.log[0]!.actor, 'sec-test');
  } finally {
    s.child.kill();
  }
});

test('mcp security: hostile board_path is rejected via card_add and card_edit', async () => {
  const s = startServer(initBoard('sec-boardpath'));
  try {
    for (const boardPath of ['/etc', '../../..']) {
      const added = await s.callTool('card_add', { title: 'hostile', type: 'board', board_path: boardPath });
      assert.equal(added.isError, true, `card_add board_path=${boardPath}`);
      assert.match(added.text, /board path/);
    }
    const ok = await s.callTool('card_add', { title: 'real card' });
    assert.equal(ok.isError, false);
    const { id } = JSON.parse(ok.text) as { id: string };
    const edited = await s.callTool('card_edit', { id, board_path: '../../..' });
    assert.equal(edited.isError, true);
    assert.match(edited.text, /board path/);
  } finally {
    s.child.kill();
  }
});

test('mcp security: priority, deps/labels, and title are type-checked', async () => {
  const s = startServer(initBoard('sec-args'));
  try {
    // priority must be one of p0..p3 (schema enum) on both add and edit.
    const badPri = await s.callTool('card_add', { title: 'bad priority', priority: 'high' });
    assert.equal(badPri.isError, true);
    assert.match(badPri.text, /invalid priority/);

    const a = await s.callTool('card_add', { title: 'card A' });
    const b = await s.callTool('card_add', { title: 'card B', deps: ['001'], priority: 'p1' });
    assert.equal(a.isError, false);
    assert.equal(b.isError, false, b.text);
    const idB = (JSON.parse(b.text) as { id: string }).id;

    const badPriEdit = await s.callTool('card_edit', { id: idB, priority: 'urgent' });
    assert.equal(badPriEdit.isError, true);
    assert.match(badPriEdit.text, /invalid priority/);
    const goodPriEdit = await s.callTool('card_edit', { id: idB, priority: 'p2' });
    assert.equal(goodPriEdit.isError, false, goodPriEdit.text);

    // deps/labels passed as non-arrays must error, never silently wipe.
    const wipe = await s.callTool('card_edit', { id: idB, deps: '001,002' });
    assert.equal(wipe.isError, true);
    assert.match(wipe.text, /array of strings/);
    const badLabels = await s.callTool('card_edit', { id: idB, labels: { 0: 'x' } });
    assert.equal(badLabels.isError, true);
    assert.match(badLabels.text, /array of strings/);

    const shown = await s.callTool('card_show', { id: idB });
    const detail = JSON.parse(shown.text) as { deps: string[]; priority: string };
    assert.deepEqual(detail.deps, ['001'], 'deps must survive the rejected edit');
    assert.equal(detail.priority, 'p2', 'priority from the accepted edit');

    // title must be a string, not String(obj) → "[object Object]".
    const objTitle = await s.callTool('card_add', { title: { text: 'x' } });
    assert.equal(objTitle.isError, true);
    assert.match(objTitle.text, /invalid title/);
    const editTitle = await s.callTool('card_edit', { id: idB, title: 42 });
    assert.equal(editTitle.isError, true);
    assert.match(editTitle.text, /invalid title/);
  } finally {
    s.child.kill();
  }
});

function exitAfter(child: ChildProcess, ms: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for server exit')), ms);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test('mcp security: an unterminated oversized frame shuts the server down', async () => {
  const child = spawn(process.execPath, [ENTRY, 'mcp', '--board', initBoard('sec-cap')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => (stderr += d));
  child.stdin.on('error', () => {}); // EPIPE here once the server exits is expected
  const exited = exitAfter(child, 15000);
  child.stdin.write(' '.repeat(9 * 1024 * 1024)); // 9 MiB > 8 MiB cap, no newline
  assert.equal(await exited, 1);
  assert.match(stderr, /exceeds/);
});

test('mcp security: client disconnect mid-reply exits quietly (no EPIPE crash)', async () => {
  const child = spawn(process.execPath, [ENTRY, 'mcp', '--board', initBoard('sec-epipe')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => (stderr += d));
  const exited = exitAfter(child, 15000);
  child.stdout.destroy(); // close our read end BEFORE the server replies
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
  child.stdin.end();
  assert.equal(await exited, 0, `stderr: ${stderr}`);
});
