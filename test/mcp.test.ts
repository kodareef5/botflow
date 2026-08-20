// MCP round-trip: spawn the real server, run the handshake, list tools, and
// drive a card through its lifecycle over JSON-RPC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';

const ENTRY = join(import.meta.dirname, '..', 'src', 'cli', 'botflow.ts');

test('mcp: handshake, tools/list, lifecycle via tools/call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'botflow-mcp-'));
  const init = spawnSync(process.execPath, [ENTRY, 'init', '--name', 'mcp-board', '--dir', dir], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const targetDir = join(dir, '.botflow', 'child');
  const initTarget = spawnSync(process.execPath, [ENTRY, 'init', '--name', 'mcp-child', '--dir', targetDir], { encoding: 'utf8' });
  assert.equal(initTarget.status, 0, initTarget.stderr);
  writeFileSync(join(dir, '.botflow', 'board.yaml'), `botflow: 0
name: mcp-board
features: [scoped-labels, custom-fields, cover-colors, relations, templates, automation, named-blockers]
fields:
  - id: sprint
    type: number
    face: true
  - id: risk
    type: select
    options: [low, high]
templates:
  - id: bug
    name: Bug report
    priority: p1
    estimate: 3
    fields:
      risk: high
    body: "## Checklist\\n- [ ] reproduce {{title}}\\n"
blockers:
  - id: external-review
    name: External review
    color: "#b42318"
buttons:
  - id: reviewed
    name: Mark reviewed
    scope: card
    action: label
    value: reviewed
rules:
  - id: waiting-label
    event: block
    action: label
    value: waiting
lanes:
  - id: wishlist
  - id: todo
  - id: doing
  - id: blocked
  - id: done
  - id: archive
`);

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
    for (const expected of [
      'prime', 'board', 'ready', 'card_add', 'card_claim', 'card_close', 'card_block',
      'card_promote', 'card_link', 'card_unlink', 'card_merge', 'card_quick_add', 'card_bulk', 'card_transfer',
      'query_cards', 'filters_list', 'filter_save', 'filter_remove', 'lane_subscribe', 'card_watch', 'card_vote', 'card_boost',
      'automation_run', 'buttons_list', 'button_run', 'card_snooze',
    ]) {
      assert.ok(names.includes(expected), `tool ${expected}`);
    }

    const added = await callTool('card_add', {
      title: 'From MCP', labels: ['Type/Bug'], priority: 'p1', start: '2026-08-20',
      due: '2026-08-24T12:30Z', reminders: [60, 15], repeat: { every: 2, unit: 'week', from: 'due' },
      estimate: 5, hill: 0, evergreen: true, cover_color: '#f0c040',
      fields: { sprint: 14, risk: 'high' },
    });
    assert.equal(added.isError, false);
    const { id } = JSON.parse(added.text) as { id: string };
    assert.equal(id, '001');
    assert.equal((await callTool('card_watch', { id })).isError, false);
    assert.equal((await callTool('card_vote', { id })).isError, false);
    assert.equal((await callTool('card_boost', { id, text: 'ship it 🚀' })).isError, false);
    assert.equal((await callTool('lane_subscribe', { lane: 'doing' })).isError, false);
    assert.equal((await callTool('filter_save', { id: 'mine', query: 'watcher:@me', name: 'Watching' })).isError, false);
    const queried = JSON.parse((await callTool('query_cards', { saved: 'mine' })).text) as { id: string }[];
    assert.deepEqual(queried.map((card) => card.id), ['001']);
    const scheduled = JSON.parse((await callTool('card_show', { id })).text) as Record<string, unknown>;
    assert.equal(scheduled['start'], '2026-08-20');
    assert.equal(scheduled['due'], '2026-08-24T12:30Z');
    assert.deepEqual(scheduled['reminders'], [60, 15]);
    assert.deepEqual(scheduled['repeat'], { every: 2, unit: 'week', from: 'due' });
    assert.equal(scheduled['estimate'], 5);
    assert.equal(scheduled['hill'], 0);
    assert.equal(scheduled['evergreen'], true);
    assert.equal(scheduled['coverColor'], '#f0c040');
    assert.deepEqual(Object.fromEntries((scheduled['fields'] as { id: string; value: unknown }[]).map((field) => [field.id, field.value])), { sprint: 14, risk: 'high' });
    assert.deepEqual(scheduled['watchers'], ['mcp-agent']);
    assert.deepEqual(scheduled['votes'], ['mcp-agent']);
    assert.equal(scheduled['boostCount'], 1);
    assert.equal((await callTool('card_snooze', { id, until: '2099-01-01T00:00:00Z' })).isError, false);
    assert.ok(!(JSON.parse((await callTool('ready', {})).text) as { id: string }[]).some((card) => card.id === id));
    assert.equal((await callTool('card_snooze', { id, until: null })).isError, false);
    const editedPresentation = await callTool('card_edit', { id, hill: 72, cover_color: null, fields: { sprint: 15, risk: null } });
    assert.equal(editedPresentation.isError, false);
    const rescheduled = JSON.parse((await callTool('card_show', { id })).text) as Record<string, unknown>;
    assert.equal(rescheduled['coverColor'], null);
    assert.equal(rescheduled['hill'], 72);
    assert.deepEqual(Object.fromEntries((rescheduled['fields'] as { id: string; value: unknown }[]).map((field) => [field.id, field.value])), { sprint: 15 });
    assert.equal((await callTool('card_edit', { id, hill: 101 })).isError, true);

    const claim = await callTool('card_claim', { id });
    assert.equal(claim.isError, false);
    assert.equal((JSON.parse(claim.text) as { assignee: string }).assignee, 'mcp-agent');

    const block = await callTool('card_block', { id, reason: 'testing the flag', blocker: 'external-review' });
    assert.equal(block.isError, false);
    let blockedDetail = JSON.parse((await callTool('card_show', { id })).text) as Record<string, unknown>;
    assert.equal(blockedDetail['blocker'], 'external-review');
    assert.ok((blockedDetail['labels'] as string[]).includes('waiting'));
    await callTool('card_unblock', { id });
    assert.equal((await callTool('button_run', { id: 'reviewed', card_id: id })).isError, false);
    blockedDetail = JSON.parse((await callTool('card_show', { id })).text) as Record<string, unknown>;
    assert.ok((blockedDetail['labels'] as string[]).includes('reviewed'));
    assert.equal((JSON.parse((await callTool('buttons_list', {})).text) as unknown[]).length, 1);
    assert.equal((await callTool('automation_run', {})).isError, false);
    const close = await callTool('card_close', { id, reason: 'mcp round trip done' });
    assert.equal(close.isError, false);
    assert.ok((JSON.parse(close.text) as { created: string | null }).created, 'recurring close creates a successor');

    const board = await callTool('board', {});
    const parsed = JSON.parse(board.text) as { distribution: Record<string, number> };
    assert.equal(parsed.distribution['done'], 1);

    const bad = await callTool('card_move', { id: '999', to: 'doing' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /no card/);

    const delegated = await callTool('card_add', { title: 'Delegated from MCP' });
    const delegatedId = (JSON.parse(delegated.text) as { id: string }).id;
    const delegateClaim = await callTool('card_claim', { id: delegatedId, delegate: true });
    assert.equal(delegateClaim.isError, false);
    const delegateResult = JSON.parse(delegateClaim.text) as { assignee: string | null; delegate: string | null };
    assert.equal(delegateResult.assignee, null);
    assert.equal(delegateResult.delegate, 'mcp-agent');

    const templated = await callTool('card_add', { title: 'Templated MCP', template: 'bug' });
    assert.equal(templated.isError, false);
    const templatedId = (JSON.parse(templated.text) as { id: string }).id;
    const templatedDetail = JSON.parse((await callTool('card_show', { id: templatedId })).text) as Record<string, unknown>;
    assert.equal(templatedDetail['priority'], 'p1');
    assert.equal(templatedDetail['estimate'], 3);
    const promoted = await callTool('card_promote', { id: templatedId, index: 0 });
    assert.equal(promoted.isError, false);
    const promotedId = (JSON.parse(promoted.text) as { promoted: string }).promoted;

    const canonical = await callTool('card_add', { title: 'Canonical MCP' });
    const canonicalId = (JSON.parse(canonical.text) as { id: string }).id;
    assert.equal((await callTool('card_link', { id: templatedId, target: canonicalId, type: 'relates' })).isError, false);
    assert.equal((await callTool('card_unlink', { id: templatedId, target: canonicalId, type: 'relates' })).isError, false);

    const quick = await callTool('card_quick_add', { text: 'Quick MCP *batch\n  Quick child !p2' });
    assert.equal(quick.isError, false);
    const quickIds = (JSON.parse(quick.text) as { id: string }[]).map((card) => card.id);
    assert.equal(quickIds.length, 2);
    const bulk = await callTool('card_bulk', { ids: quickIds, action: 'label', add_labels: ['mcp-bulk'] });
    assert.equal(bulk.isError, false);
    assert.deepEqual((JSON.parse(bulk.text) as { changed: string[] }).changed, quickIds);

    const duplicate = await callTool('card_add', { title: 'Duplicate MCP' });
    const duplicateId = (JSON.parse(duplicate.text) as { id: string }).id;
    const merged = await callTool('card_merge', { duplicate: duplicateId, canonical: canonicalId });
    assert.equal(merged.isError, false);
    assert.equal((JSON.parse((await callTool('card_show', { id: duplicateId })).text) as Record<string, unknown>)['state'], 'archive');

    const transferred = await callTool('card_transfer', { id: templatedId, target_board: targetDir });
    assert.equal(transferred.isError, false);
    assert.equal((JSON.parse(transferred.text) as { target: string }).target, '001');
    const linted = JSON.parse((await callTool('lint', {})).text) as { severity: string }[];
    assert.equal(linted.some((finding) => finding.severity === 'error'), false);
    assert.ok(promotedId, 'promoted relation target remains part of the source tree');

    const unknown = (await request('nope/nothing')) as { error: { code: number } };
    assert.equal(unknown.error.code, -32601);
  } finally {
    child.kill();
  }
});
