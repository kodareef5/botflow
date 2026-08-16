// The botflow CLI. Agents are the primary users: every command is plain,
// deterministic, and takes --json. See `botflow help`.

import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { parseArgs, type ParseArgsConfig } from 'node:util';

import { DEFAULT_PORT, serveBoard } from '../viewer/serve.ts';
import { viewerData, viewerHtml } from '../viewer/page.ts';
import { startMcpServer } from '../mcp/server.ts';
import { instantiate, setupAgentFiles } from '../core/template.ts';
import { loadRemote, pull, push, remoteAdd } from './remote.ts';

import { analyze, lintBoard } from '../core/analyze.ts';
import { discoverBoardRoot, loadTree, resolveBoardRoot } from '../core/load.ts';
import type { Finding } from '../core/model.ts';
import {
  UsageError,
  addCard,
  addLogEntry,
  blockCard,
  claimCard,
  closeCard,
  editCard,
  initBoard,
  moveCard,
  unblockCard,
  type EditPatch,
} from '../core/mutate.ts';
import {
  boardJson,
  cardJson,
  renderBoard,
  renderCard,
  renderLint,
  renderPrime,
  renderRollup,
  rollupJson,
} from './render.ts';

const VERSION = '0.1.0';

const HELP = `botflow ${VERSION} — git-native kanban for AI agents

usage: botflow <command> [args]

  init [--name <n>] [--dir <d>]         create a .botflow board
  prime                                 print workflow context (run me first)
  board [--rollup] [--json]             render the board
  board --html [--out <file>]           self-contained HTML snapshot
  serve [--port ${DEFAULT_PORT}]                     read-only local web view
  mcp                                   MCP server on stdio (same verbs as tools)
  new <src>[#branch] <dir> [--name n]   instantiate a workspace template
  setup [agents|claude|codex]           wire the playbook into AGENTS.md/CLAUDE.md
  remote add <url> <project-id>         link this board to a hosted manager project
  push | pull [--token t]               snapshot-sync with the hosted manager
  ready [--json]                        unblocked todo cards
  lint [--json]                         check the board; exit 1 on errors
  card add <title> [--lane l] [--labels a,b] [--priority p0-p3] [--deps 1,2]
           [--type board --board-path <dir>] [--assignee name]
  card show <id> [--json]
  card mv <id> <lane[.substate]> [--force]
  card claim <id>                       assign to --actor and move to doing
  card close <id> [--reason r]          move to done, clear blocked flag
  card block <id> --reason <r>          set the blocked flag
  card unblock <id>
  card edit <id> [--title t] [--labels a,b] [--priority p|none]
           [--assignee name|none] [--deps 1,2] [--board-path <dir>]
  log <id> <message…>                   append a Log entry

global: --board <path> (or BOTFLOW_DIR) picks the board; --actor <name>
(or BOTFLOW_ACTOR, USER) identifies you; --json for machine output.
`;

type Values = Record<string, string | boolean | undefined>;

function parse(args: string[], options: ParseArgsConfig['options']): { values: Values; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({ args, options, allowPositionals: true, strict: true });
    return { values: values as Values, positionals };
  } catch (err) {
    throw new UsageError(`${(err as Error).message.split('.')[0]} — see \`botflow help\``);
  }
}

const COMMON = {
  board: { type: 'string' },
  actor: { type: 'string' },
  json: { type: 'boolean', default: false },
} satisfies ParseArgsConfig['options'];

function getRoot(values: Values): string {
  const explicit = (values['board'] as string | undefined) ?? process.env['BOTFLOW_DIR'];
  if (explicit) {
    const root = resolveBoardRoot(explicit);
    if (!root) throw new UsageError(`no board at ${explicit}`);
    return root;
  }
  const root = discoverBoardRoot(process.cwd());
  if (!root) throw new UsageError('no botflow board found here — run `botflow init` (or pass --board)');
  return root;
}

function getActor(values: Values): string {
  return (values['actor'] as string | undefined) ?? process.env['BOTFLOW_ACTOR'] ?? process.env['USER'] ?? 'anon';
}

const csv = (v: string | undefined): string[] | undefined =>
  v === undefined ? undefined : v === '' ? [] : v.split(',').map((s) => s.trim()).filter((s) => s !== '');

const out = (s: string): void => void process.stdout.write(s.endsWith('\n') ? s : s + '\n');
const emitJson = (v: unknown): void => out(JSON.stringify(v, null, 2));

export function run(argv: string[]): number {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(HELP);
      return 0;
    case '--version':
    case 'version':
      out(VERSION);
      return 0;
    case 'init': {
      const { values } = parse(rest, { name: { type: 'string' }, dir: { type: 'string' } });
      const root = initBoard((values['dir'] as string | undefined) ?? process.cwd(), values['name'] as string | undefined);
      out(`✓ board created at ${root}`);
      out('  next: `botflow prime`, then `botflow card add "<first task>"`');
      return 0;
    }
    case 'board': {
      const { values } = parse(rest, {
        ...COMMON,
        rollup: { type: 'boolean', default: false },
        html: { type: 'boolean', default: false },
        out: { type: 'string' },
      });
      const root = getRoot(values);
      const tree = loadTree(root);
      const analysis = analyze(tree);
      if (values['html']) {
        const name = tree.boards.get('.')!.board.config.name;
        const html = viewerHtml(viewerData(tree, analysis), { live: false, title: name });
        const target = values['out'] as string | undefined;
        if (target) {
          writeFileSync(target, html);
          out(`✓ wrote ${target}`);
        } else {
          out(html);
        }
      } else if (values['rollup']) {
        values['json'] ? emitJson(rollupJson(tree, analysis)) : out(renderRollup(tree, analysis));
      } else {
        values['json'] ? emitJson(boardJson(tree, analysis)) : out(renderBoard(tree, analysis));
      }
      return 0;
    }
    case 'serve': {
      const { values } = parse(rest, { ...COMMON, port: { type: 'string' } });
      const root = getRoot(values);
      const port = values['port'] !== undefined ? Number(values['port']) : DEFAULT_PORT;
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port must be 0–65535');
      void serveBoard(root, port).then(
        (running) => out(`▤ botflow viewer (read-only) — ${running.url}  (board: ${root})`),
        (err: Error) => {
          process.stderr.write(`botflow: serve failed: ${err.message}\n`);
          process.exitCode = 1;
        },
      );
      return 0;
    }
    case 'prime': {
      const { values } = parse(rest, COMMON);
      const root = getRoot(values);
      const tree = loadTree(root);
      const analysis = analyze(tree);
      values['json'] ? emitJson(boardJson(tree, analysis)) : out(renderPrime(tree, analysis, root));
      return 0;
    }
    case 'ready': {
      const { values } = parse(rest, COMMON);
      const root = getRoot(values);
      const tree = loadTree(root);
      const analysis = analyze(tree);
      const node = tree.boards.get('.')!;
      const ba = analysis.boards.get('.')!;
      const cards = ba.ready.map((id) => node.board.cards.find((c) => c.id === id)!);
      if (values['json']) emitJson(cards.map((c) => cardJson(c, node, ba)));
      else if (cards.length === 0) out('nothing ready — `botflow board` for the full picture');
      else out(cards.map((c) => `${c.id}  ${c.title}${c.priority ? ` (${c.priority})` : ''}`).join('\n'));
      return 0;
    }
    case 'lint': {
      const { values } = parse(rest, COMMON);
      const root = getRoot(values);
      const tree = loadTree(root);
      const analysis = analyze(tree);
      const all: (Finding & { board: string })[] = [];
      for (const [key, node] of tree.boards) {
        for (const f of lintBoard(node, analysis.boards.get(key)!)) all.push({ ...f, board: key });
      }
      if (values['json']) emitJson(all);
      else out(renderLint(all));
      return all.some((f) => f.severity === 'error') ? 1 : 0;
    }
    case 'card':
      return runCard(rest);
    case 'remote': {
      const { values, positionals } = parse(rest, COMMON);
      const [sub, url, project] = positionals;
      if (sub === 'add' && url && project) {
        remoteAdd(getRoot(values), url, project);
        out(`✓ remote set: ${url} project ${project} (token via BOTFLOW_TOKEN or --token)`);
        return 0;
      }
      if (sub === 'show') {
        const remote = loadRemote(getRoot(values));
        values['json'] ? emitJson(remote) : out(`${remote.url}  project ${remote.project}`);
        return 0;
      }
      throw new UsageError('usage: botflow remote add <url> <project-id> | botflow remote show');
    }
    case 'push':
    case 'pull': {
      const { values } = parse(rest, { ...COMMON, token: { type: 'string' } });
      const root = getRoot(values);
      const token = (values['token'] as string | undefined) ?? process.env['BOTFLOW_TOKEN'];
      if (!token) throw new UsageError('a token is required: --token or BOTFLOW_TOKEN');
      if (cmd === 'push') {
        void push(root, token, getActor(values)).then(
          (res) => out(`✓ pushed — ${res.imported} cards imported (${res.findings} findings on remote)`),
          (err: Error) => {
            process.stderr.write(`botflow: ${err.message}\n`);
            process.exitCode = 1;
          },
        );
      } else {
        void pull(root, token).then(
          (res) => out(`✓ pulled — ${res.written} cards written, ${res.removed} removed`),
          (err: Error) => {
            process.stderr.write(`botflow: ${err.message}\n`);
            process.exitCode = 1;
          },
        );
      }
      return 0;
    }
    case 'new': {
      const { values, positionals } = parse(rest, { name: { type: 'string' } });
      const [spec, dest] = positionals;
      if (!spec || !dest) throw new UsageError('usage: botflow new <repo-or-path>[#branch] <dir> [--name n]');
      const res = instantiate(spec, dest, values['name'] as string | undefined);
      out(`✓ workspace instantiated at ${res.dest}`);
      if (res.boardRoot) out(`  board: ${res.boardRoot} — start with \`botflow prime\``);
      for (const w of res.warnings) out(`⚠ ${w}`);
      return 0;
    }
    case 'setup': {
      const { positionals } = parse(rest, {});
      const target = positionals[0] ?? 'agents';
      if (target !== 'agents' && target !== 'claude' && target !== 'codex') {
        throw new UsageError('usage: botflow setup [agents|claude|codex]');
      }
      const touched = setupAgentFiles(process.cwd(), target);
      out(touched.length > 0 ? `✓ wired botflow into ${touched.join(', ')}` : 'already wired — nothing to do');
      return 0;
    }
    case 'mcp': {
      const { values } = parse(rest, COMMON);
      const root = getRoot(values);
      process.stderr.write(`botflow mcp server on stdio (board: ${root})\n`);
      startMcpServer(root, getActor(values), process.stdin, process.stdout);
      return 0;
    }
    case 'log': {
      const { values, positionals } = parse(rest, COMMON);
      const [id, ...words] = positionals;
      if (!id || words.length === 0) throw new UsageError('usage: botflow log <id> <message…>');
      const card = addLogEntry(getRoot(values), id, getActor(values), words.join(' '));
      values['json'] ? emitJson({ id: card.id, logged: true }) : out(`✓ ${card.id} logged`);
      return 0;
    }
    default:
      throw new UsageError(`unknown command "${cmd}" — see \`botflow help\``);
  }
}

function runCard(argv: string[]): number {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'add': {
      const { values, positionals } = parse(rest, {
        ...COMMON,
        lane: { type: 'string' },
        type: { type: 'string' },
        'board-path': { type: 'string' },
        labels: { type: 'string' },
        priority: { type: 'string' },
        deps: { type: 'string' },
        assignee: { type: 'string' },
      });
      const title = positionals.join(' ').trim();
      if (title === '') throw new UsageError('usage: botflow card add <title> [flags]');
      const type = values['type'] as string | undefined;
      if (type !== undefined && type !== 'task' && type !== 'board') throw new UsageError('--type must be task or board');
      const card = addCard(getRoot(values), {
        title,
        lane: values['lane'] as string | undefined,
        type: type as 'task' | 'board' | undefined,
        boardPath: values['board-path'] as string | undefined,
        labels: csv(values['labels'] as string | undefined),
        priority: values['priority'] as string | undefined,
        deps: csv(values['deps'] as string | undefined),
        assignee: values['assignee'] as string | undefined,
        actor: getActor(values),
      });
      const pos = card.substate === null ? card.laneId : `${card.laneId}.${card.substate}`;
      values['json']
        ? emitJson({ id: card.id, title: card.title, position: pos, file: card.file })
        : out(`✓ ${card.id} created in ${pos} — ${card.file}`);
      return 0;
    }
    case 'show': {
      const { values, positionals } = parse(rest, COMMON);
      const id = positionals[0];
      if (!id) throw new UsageError('usage: botflow card show <id>');
      const root = getRoot(values);
      const tree = loadTree(root);
      const analysis = analyze(tree);
      const node = tree.boards.get('.')!;
      const ba = analysis.boards.get('.')!;
      const card = node.board.cards.find((c) => c.id === id);
      if (!card) throw new UsageError(`no card "${id}"`);
      if (values['json']) emitJson({ ...cardJson(card, node, ba), body: card.body });
      else out(renderCard(card, node, ba));
      return 0;
    }
    case 'mv': {
      const { values, positionals } = parse(rest, { ...COMMON, force: { type: 'boolean', default: false } });
      const [id, spec] = positionals;
      if (!id || !spec) throw new UsageError('usage: botflow card mv <id> <lane[.substate]>');
      const res = moveCard(getRoot(values), id, spec, getActor(values), values['force'] as boolean);
      values['json']
        ? emitJson({ id: res.card.id, from: res.from, to: res.to, warnings: res.warnings })
        : out(`✓ ${res.card.id} ${res.from} → ${res.to}${res.warnings.map((w) => `\n⚠ ${w}`).join('')}`);
      return 0;
    }
    case 'claim':
    case 'close': {
      const { values, positionals } = parse(rest, { ...COMMON, reason: { type: 'string' } });
      const id = positionals[0];
      if (!id) throw new UsageError(`usage: botflow card ${sub} <id>`);
      const root = getRoot(values);
      const actor = getActor(values);
      const res =
        sub === 'claim' ? claimCard(root, id, actor) : closeCard(root, id, actor, values['reason'] as string | undefined);
      values['json']
        ? emitJson({ id: res.card.id, from: res.from, to: res.to, assignee: res.card.assignee, warnings: res.warnings })
        : out(`✓ ${res.card.id} ${res.from} → ${res.to}${sub === 'claim' ? ` (@${res.card.assignee})` : ''}${res.warnings.map((w) => `\n⚠ ${w}`).join('')}`);
      return 0;
    }
    case 'block': {
      const { values, positionals } = parse(rest, { ...COMMON, reason: { type: 'string' } });
      const id = positionals[0];
      const reason = values['reason'] as string | undefined;
      if (!id || !reason) throw new UsageError('usage: botflow card block <id> --reason <why>');
      const card = blockCard(getRoot(values), id, getActor(values), reason);
      values['json'] ? emitJson({ id: card.id, blocked: card.blocked }) : out(`⛔ ${card.id} blocked: ${reason}`);
      return 0;
    }
    case 'unblock': {
      const { values, positionals } = parse(rest, COMMON);
      const id = positionals[0];
      if (!id) throw new UsageError('usage: botflow card unblock <id>');
      const card = unblockCard(getRoot(values), id, getActor(values));
      values['json'] ? emitJson({ id: card.id, blocked: null }) : out(`✓ ${card.id} unblocked`);
      return 0;
    }
    case 'edit': {
      const { values, positionals } = parse(rest, {
        ...COMMON,
        title: { type: 'string' },
        labels: { type: 'string' },
        priority: { type: 'string' },
        assignee: { type: 'string' },
        deps: { type: 'string' },
        'board-path': { type: 'string' },
      });
      const id = positionals[0];
      if (!id) throw new UsageError('usage: botflow card edit <id> [flags]');
      const noneable = (v: string | undefined): string | null | undefined => (v === 'none' ? null : v);
      const patch: EditPatch = {};
      if (values['title'] !== undefined) patch.title = values['title'] as string;
      if (values['labels'] !== undefined) patch.labels = csv(values['labels'] as string)!;
      if (values['priority'] !== undefined) patch.priority = noneable(values['priority'] as string);
      if (values['assignee'] !== undefined) patch.assignee = noneable(values['assignee'] as string);
      if (values['deps'] !== undefined) patch.deps = csv(values['deps'] as string)!;
      if (values['board-path'] !== undefined) patch.boardPath = values['board-path'] as string;
      const card = editCard(getRoot(values), id, patch, getActor(values));
      values['json'] ? emitJson({ id: card.id, edited: Object.keys(patch) }) : out(`✓ ${card.id} edited (${Object.keys(patch).join(', ')})`);
      return 0;
    }
    default:
      throw new UsageError(`unknown card command "${sub ?? ''}" — see \`botflow help\``);
  }
}

/** Execute the CLI against argv, mapping UsageError to exit code 1. */
export function main(argv: string[]): void {
  try {
    process.exitCode = run(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`botflow: ${err.message}\n`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}
