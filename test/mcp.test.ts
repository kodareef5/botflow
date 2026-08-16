// MCP round-trip: spawn the real server, run the handshake, list tools, and
// drive a card through its lifecycle over JSON-RPC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

const ENTRY = join(import.meta.dirname, '..', 'src', 'cli', 'botflow.ts');

test('mcp: handshake, tools/list, lifecycle via tools/call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-mcp-'));
  const init = spawnSync(process.execPath, [ENTRY, 'init', '--name', 'mcp-board', '--dir', dir], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);

  const child = spawn(process.execPath, [ENTRY, 'mcp', '--board', dir, '--actor', 'mcp-agent'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  lines.on('line', (line) => {
    const msg = JSON.parse(line) as Record<string, unknown>;
    const id = msg['id'] as number;
    pending.get(id)?.(msg);
    pending.delete(id);
  });

  let nextId = 1;
  const request = (method: string, params?: unknown): Promise<Record<string, unknown>> => {
    const id = nextId++;
    const p = new Promise<Record<string, unknown>>((resolve, reject) => {
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

  try {
    const init2 = (await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })) as { result: { serverInfo: { name: string }; capabilities: { tools: object } } };
    assert.equal(init2.result.serverInfo.name, 'botflow');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const toolsRes = (await request('tools/list')) as { result: { tools: { name: string }[] } };
    const names = toolsRes.result.tools.map((t) => t.name);
    for (const expected of ['prime', 'board', 'ready', 'card_add', 'card_claim', 'card_close', 'card_block']) {
      assert.ok(names.includes(expected), `tool ${expected}`);
    }

    const added = await callTool('card_add', { title: 'From MCP', labels: ['mcp'], priority: 'p1' });
    assert.equal(added.isError, false);
    const { id } = JSON.parse(added.text) as { id: string };
    assert.equal(id, '001');

    const claim = await callTool('card_claim', { id });
    assert.equal(claim.isError, false);
    assert.equal((JSON.parse(claim.text) as { assignee: string }).assignee, 'mcp-agent');

    const block = await callTool('card_block', { id, reason: 'testing the flag' });
    assert.equal(block.isError, false);
    await callTool('card_unblock', { id });
    const close = await callTool('card_close', { id, reason: 'mcp round trip done' });
    assert.equal(close.isError, false);

    const board = await callTool('board', {});
    const parsed = JSON.parse(board.text) as { distribution: Record<string, number> };
    assert.equal(parsed.distribution['done'], 1);

    const bad = await callTool('card_move', { id: '999', to: 'doing' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /no card/);

    const unknown = (await request('nope/nothing')) as { error: { code: number } };
    assert.equal(unknown.error.code, -32601);
  } finally {
    child.kill();
  }
});
