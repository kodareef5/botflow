// MCP server over stdio: newline-delimited JSON-RPC 2.0, zero dependencies.
// Exposes the same verbs as the CLI so MCP-native agents get first-class
// access to the board. Protocol errors → JSON-RPC errors; tool failures →
// result payloads with isError (per MCP convention).

import type { Readable, Writable } from 'node:stream';

import { analyze, lintBoard } from '../core/analyze.ts';
import { loadTree } from '../core/load.ts';
import {
  UsageError,
  addCard,
  addLogEntry,
  attachCard,
  blockCard,
  checkCard,
  claimCard,
  closeCard,
  commentCard,
  editCard,
  moveCard,
  unblockCard,
  type EditPatch,
} from '../core/mutate.ts';
import { boardJson, cardJson, renderPrime, rollupJson } from '../cli/render.ts';
import { cardDetailJson } from '../core/json.ts';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'botflow', version: '0.1.0' };

type Json = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  run: (args: Json) => unknown;
}

const str = { type: 'string' } as const;
const bool = { type: 'boolean' } as const;
const strList = { type: 'array', items: { type: 'string' } } as const;

function schema(required: string[], props: Json): Json {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

function buildTools(root: string, defaultActor: string): Tool[] {
  const actorOf = (args: Json): string => (typeof args['actor'] === 'string' ? (args['actor'] as string) : defaultActor);
  const list = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : undefined);
  const opt = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  const view = () => {
    const tree = loadTree(root);
    return { tree, analysis: analyze(tree) };
  };

  return [
    {
      name: 'prime',
      description: 'Workflow context: lanes, rules, current state, ready work, and how to use the other tools. Call this first.',
      inputSchema: schema([], {}),
      run: () => {
        const { tree, analysis } = view();
        return renderPrime(tree, analysis, root);
      },
    },
    {
      name: 'board',
      description: 'Full board state as JSON. Pass rollup:true for the nested-boards aggregate view.',
      inputSchema: schema([], { rollup: bool }),
      run: (args) => {
        const { tree, analysis } = view();
        return args['rollup'] === true ? rollupJson(tree, analysis) : boardJson(tree, analysis);
      },
    },
    {
      name: 'ready',
      description: 'Cards that are unblocked and ready to claim (effective state todo, deps satisfied).',
      inputSchema: schema([], {}),
      run: () => {
        const { tree, analysis } = view();
        const node = tree.boards.get('.')!;
        const ba = analysis.boards.get('.')!;
        return ba.ready.map((id) => cardJson(node.board.cards.find((c) => c.id === id)!, node, ba));
      },
    },
    {
      name: 'lint',
      description: 'Board findings (errors, warnings, info) across the board tree.',
      inputSchema: schema([], {}),
      run: () => {
        const { tree, analysis } = view();
        const all: unknown[] = [];
        for (const [key, node] of tree.boards) {
          for (const f of lintBoard(node, analysis.boards.get(key)!)) all.push({ ...f, board: key });
        }
        return all;
      },
    },
    {
      name: 'card_show',
      description: 'One card in full, including its markdown body.',
      inputSchema: schema(['id'], { id: str }),
      run: (args) => {
        const { tree, analysis } = view();
        const node = tree.boards.get('.')!;
        const card = node.board.cards.find((c) => c.id === args['id']);
        if (!card) throw new UsageError(`no card "${args['id'] as string}"`);
        return cardDetailJson(card, node, analysis.boards.get('.')!);
      },
    },
    {
      name: 'card_add',
      description: 'Create a card. type "board" with board_path makes a nested-board card.',
      inputSchema: schema(['title'], {
        title: str, lane: str, type: { type: 'string', enum: ['task', 'board'] }, board_path: str,
        labels: strList, priority: { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'] }, deps: strList,
        assignee: str, actor: str,
      }),
      run: (args) => {
        const card = addCard(root, {
          title: String(args['title']),
          lane: opt(args['lane']),
          type: args['type'] === 'board' ? 'board' : 'task',
          boardPath: opt(args['board_path']),
          labels: list(args['labels']),
          priority: opt(args['priority']),
          deps: list(args['deps']),
          assignee: opt(args['assignee']),
          actor: actorOf(args),
        });
        return { id: card.id, file: card.file, lane: card.laneId };
      },
    },
    {
      name: 'card_move',
      description: 'Move a card to lane[.substate]. Strict lanes advance one substate at a time unless force.',
      inputSchema: schema(['id', 'to'], { id: str, to: str, force: bool, actor: str }),
      run: (args) => {
        const res = moveCard(root, String(args['id']), String(args['to']), actorOf(args), args['force'] === true);
        return { id: res.card.id, from: res.from, to: res.to, warnings: res.warnings };
      },
    },
    {
      name: 'card_claim',
      description:
        'Atomically claim a card: succeeds only if it is ready (todo, unblocked, deps done) and unassigned, then sets assignee to the actor and moves it into doing. Anything else is a conflict error; force overrides.',
      inputSchema: schema(['id'], { id: str, actor: str, force: bool }),
      run: (args) => {
        const res = claimCard(root, String(args['id']), actorOf(args), args['force'] === true);
        if (res.alreadyYours) return { id: res.card.id, at: res.to, assignee: res.card.assignee, alreadyYours: true };
        return { id: res.card.id, from: res.from, to: res.to, assignee: res.card.assignee, warnings: res.warnings };
      },
    },
    {
      name: 'card_close',
      description: 'Close a card: move to done, clear any blocked flag, log the reason.',
      inputSchema: schema(['id'], { id: str, reason: str, actor: str }),
      run: (args) => {
        const res = closeCard(root, String(args['id']), actorOf(args), opt(args['reason']));
        return { id: res.card.id, from: res.from, to: res.to };
      },
    },
    {
      name: 'card_block',
      description: 'Set the blocked flag with a reason. Use instead of silently stalling.',
      inputSchema: schema(['id', 'reason'], { id: str, reason: str, actor: str }),
      run: (args) => {
        const card = blockCard(root, String(args['id']), actorOf(args), String(args['reason']));
        return { id: card.id, blocked: card.blocked };
      },
    },
    {
      name: 'card_unblock',
      description: 'Clear the blocked flag.',
      inputSchema: schema(['id'], { id: str, actor: str }),
      run: (args) => {
        const card = unblockCard(root, String(args['id']), actorOf(args));
        return { id: card.id, blocked: null };
      },
    },
    {
      name: 'card_edit',
      description: 'Edit card fields. Pass null priority/assignee to clear them.',
      inputSchema: schema(['id'], {
        id: str, title: str, labels: strList, priority: { type: ['string', 'null'] },
        assignee: { type: ['string', 'null'] }, deps: strList, board_path: str,
        cover: { type: ['string', 'null'] }, actor: str,
      }),
      run: (args) => {
        const patch: EditPatch = {};
        if ('title' in args) patch.title = String(args['title']);
        if ('labels' in args) patch.labels = list(args['labels']) ?? [];
        if ('priority' in args) patch.priority = args['priority'] === null ? null : opt(args['priority']) ?? null;
        if ('assignee' in args) patch.assignee = args['assignee'] === null ? null : opt(args['assignee']) ?? null;
        if ('deps' in args) patch.deps = list(args['deps']) ?? [];
        if ('board_path' in args) patch.boardPath = opt(args['board_path']);
        if ('cover' in args) patch.cover = args['cover'] === null ? null : String(args['cover']);
        const card = editCard(root, String(args['id']), patch, actorOf(args));
        return { id: card.id, edited: Object.keys(patch) };
      },
    },
    {
      name: 'card_comment',
      description: 'Append a comment to the card’s Comments section (discourse; separate from the Log).',
      inputSchema: schema(['id', 'message'], { id: str, message: str, actor: str }),
      run: (args) => {
        const card = commentCard(root, String(args['id']), actorOf(args), String(args['message']));
        return { id: card.id, commented: true };
      },
    },
    {
      name: 'card_check',
      description: 'Check or uncheck a checklist item by its 0-based global index (see card_show parsed.checklists).',
      inputSchema: schema(['id', 'index'], { id: str, index: { type: 'integer' }, checked: bool, actor: str }),
      run: (args) => {
        const checked = args['checked'] !== false;
        const card = checkCard(root, String(args['id']), actorOf(args), Number(args['index']), checked);
        return { id: card.id, index: Number(args['index']), checked };
      },
    },
    {
      name: 'card_attach',
      description: 'Attach a link (or image url: images show in the card gallery and can be cover art).',
      inputSchema: schema(['id', 'url'], { id: str, url: str, label: str, actor: str }),
      run: (args) => {
        const card = attachCard(root, String(args['id']), actorOf(args), String(args['url']), opt(args['label']));
        return { id: card.id, attached: String(args['url']) };
      },
    },
    {
      name: 'log_append',
      description: 'Append a line to the card’s append-only Log section: narrate what you did.',
      inputSchema: schema(['id', 'message'], { id: str, message: str, actor: str }),
      run: (args) => {
        const card = addLogEntry(root, String(args['id']), actorOf(args), String(args['message']));
        return { id: card.id, logged: true };
      },
    },
  ];
}

export function startMcpServer(root: string, defaultActor: string, input: Readable, output: Writable): void {
  const tools = buildTools(root, defaultActor);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const send = (msg: Json): void => void output.write(JSON.stringify(msg) + '\n');

  const handle = (msg: Json): void => {
    const id = msg['id'];
    const method = msg['method'];
    const isRequest = id !== undefined && id !== null;
    if (typeof method !== 'string') {
      if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'invalid request' } });
      return;
    }
    switch (method) {
      case 'initialize':
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion:
              typeof (msg['params'] as Json | undefined)?.['protocolVersion'] === 'string'
                ? ((msg['params'] as Json)['protocolVersion'] as string)
                : PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        });
        return;
      case 'ping':
        send({ jsonrpc: '2.0', id, result: {} });
        return;
      case 'tools/list':
        send({
          jsonrpc: '2.0',
          id,
          result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
        });
        return;
      case 'tools/call': {
        const params = (msg['params'] ?? {}) as Json;
        const tool = byName.get(String(params['name']));
        if (!tool) {
          send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool "${String(params['name'])}"` } });
          return;
        }
        try {
          const value = tool.run((params['arguments'] ?? {}) as Json);
          const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
        } catch (err) {
          if (!(err instanceof UsageError)) throw err;
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true } });
        }
        return;
      }
      default:
        // Notifications (initialized, cancelled, …) need no reply; unknown requests do.
        if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  };

  let buffer = '';
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl === -1) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === '') continue;
      try {
        handle(JSON.parse(line) as Json);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      }
    }
  });
}
