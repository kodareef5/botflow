// The botflow CLI. Agents are the primary users: every command is plain,
// deterministic, and takes --json. See `botflow help`.

import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { parseArgs, type ParseArgsConfig } from 'node:util';

import { DEFAULT_PORT, serveBoard } from '../viewer/serve.ts';
import { viewerData, viewerHtml } from '../viewer/page.ts';
import { startMcpServer } from '../mcp/server.ts';
import { instantiate, setupAgentFiles } from '../core/template.ts';
import { cardDetailJson } from '../core/json.ts';
import { parseCustomFieldText } from '../core/presentation.ts';
import { loadRemote, pull, push, remoteAdd } from './remote.ts';

import { analyze, lintBoard } from '../core/analyze.ts';
import { discoverBoardRoot, loadTree, resolveBoardRoot } from '../core/load.ts';
import type { Finding, RelationType } from '../core/model.ts';
import {
  UsageError,
  addCard,
  addLogEntry,
  attachCard,
  blockCard,
  checkCard,
  claimCard,
  closeCard,
  checklistAddCard,
  commentCard,
  describeCard,
  detachCard,
  editCard,
  linkCards,
  unlinkCards,
  promoteCard,
  mergeDuplicateCards,
  quickAddCards,
  bulkCards,
  transferCard,
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

const HELP = `botflow ${VERSION} · git-native kanban for AI agents

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
  push | pull [--token t]               snapshot-sync with the hosted manager;
                                        pull refuses over uncommitted board
                                        changes unless --force
  ready [--json]                        unblocked todo cards
  lint [--json]                         check the board; exit 1 on errors
  card add <title> [--template id] [--lane l] [--labels a,b] [--priority p0-p3] [--deps 1,2]
           [--type board --board-path <dir>] [--assignee name] [--delegate agent]
           [--start YYYY-MM-DD] [--due YYYY-MM-DD] [--estimate n] [--evergreen]
           [--cover-color #RRGGBB] [--field id=value ...]
  card show <id> [--json]
  card mv <id> <lane[.substate]> [--force]
  card claim <id> [--delegate] [--force] take a ready card into doing as assignee
                                        or, with --delegate, as executing agent;
                                        conflicts (assigned/blocked/not-ready/deps)
                                        refuse unless --force
  card close <id> [--reason r]          move to done, clear blocked flag
  card block <id> --reason <r>          set the blocked flag
  card unblock <id>
  card edit <id> [--title t] [--labels a,b] [--priority p|none]
           [--assignee name|none] [--delegate name|none] [--deps 1,2]
           [--start date|none] [--due date|none] [--estimate n|none]
           [--evergreen true|false] [--board-path <dir>]
           [--cover <url>|none|auto] [--cover-color #RRGGBB|none]
           [--field id=value ...]              empty value clears a custom field
  card comment <id> <text…>             append to the Comments section
  card describe <id> <text…>            set the Description (empty clears)
  card item <id> <text…> [--section s]  add an unchecked checklist task
  card check <id> <n> [--off]           check/uncheck checklist item n (1-based)
  card promote <id> <n> [--lane l]      turn checklist item n into a related card
  card link <id> <target> --type <kind> add a typed relation and its inverse
  card unlink <id> <target> --type <kind>
  card merge <duplicate> <canonical>    archive a duplicate and rewire references
  card copy <id> --to-board <path>      copy to a descendant board; rebase references
  card move-to <id> --to-board <path>   safe descendant copy, then archive source
  card quick <multiline text>           quick-add; indentation creates subtasks
  card bulk <ids> mv <lane> | close | label [--add-labels a,b] [--remove-labels a,b]
  card attach <id> <url> [--label l]    add a link/image attachment
  card detach <id> <n>                  remove attachment n (1-based)
  log <id> <message…>                   append a Log entry

global: --board <path> (or BOTFLOW_DIR) picks the board; --actor <name>
(or BOTFLOW_ACTOR, USER) identifies you; --json for machine output.
`;

type Values = Record<string, string | string[] | boolean | undefined>;

function parse(args: string[], options: ParseArgsConfig['options']): { values: Values; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({ args, options, allowPositionals: true, strict: true });
    return { values: values as Values, positionals };
  } catch (err) {
    throw new UsageError(`${(err as Error).message.split('.')[0]} · see \`botflow help\``);
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
  if (!root) throw new UsageError('no botflow board found here · run `botflow init` (or pass --board)');
  return root;
}

function getActor(values: Values): string {
  return (values['actor'] as string | undefined) ?? process.env['BOTFLOW_ACTOR'] ?? process.env['USER'] ?? 'anon';
}

const csv = (v: string | undefined): string[] | undefined =>
  v === undefined ? undefined : v === '' ? [] : v.split(',').map((s) => s.trim()).filter((s) => s !== '');

function fieldAssignments(root: string, entries: string[] | undefined): Record<string, unknown> | undefined {
  if (entries === undefined) return undefined;
  const definitions = loadTree(root).boards.get('.')!.board.config.customFields;
  const fields: Record<string, unknown> = {};
  for (const entry of entries) {
    const equals = entry.indexOf('=');
    if (equals < 1) throw new UsageError(`--field must be id=value (got "${entry}")`);
    const id = entry.slice(0, equals);
    if (Object.hasOwn(fields, id)) throw new UsageError(`custom field "${id}" was provided more than once`);
    const definition = definitions.find((field) => field.id === id);
    if (definition === undefined) throw new UsageError(`unknown custom field "${id}"`);
    try {
      fields[id] = parseCustomFieldText(definition, entry.slice(equals + 1));
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
  }
  return fields;
}

/** Card text is repo-carried, so it arrives from whoever can commit: titles,
 *  labels and log lines all reach the terminal verbatim. Escape sequences in
 *  that text would let a hostile card repaint the screen, hide lines, or fake
 *  output on anyone who runs `botflow board`. Strip C0/DEL here, the single
 *  place human-facing text leaves the CLI, keeping tab and newline. JSON goes
 *  out through this too and is unaffected: JSON.stringify has already escaped
 *  those bytes as \uXXXX, so there is nothing raw left to strip. */
const out = (s: string): void => {
  const safe = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  void process.stdout.write(safe.endsWith('\n') ? safe : safe + '\n');
};
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
        (running) => out(`▤ botflow viewer (read-only) · ${running.url}  (board: ${root})`),
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
      else if (cards.length === 0) out('nothing ready · `botflow board` for the full picture');
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
      const { values } = parse(rest, { ...COMMON, token: { type: 'string' }, force: { type: 'boolean', default: false } });
      const root = getRoot(values);
      const token = (values['token'] as string | undefined) ?? process.env['BOTFLOW_TOKEN'];
      if (!token) throw new UsageError('a token is required: --token or BOTFLOW_TOKEN');
      if (cmd === 'push') {
        void push(root, token, getActor(values)).then(
          (res) => out(`✓ pushed · ${res.imported} cards imported (${res.findings} findings on remote)`),
          (err: Error) => {
            process.stderr.write(`botflow: ${err.message}\n`);
            process.exitCode = 1;
          },
        );
      } else {
        void pull(root, token, values['force'] as boolean).then(
          (res) => out(`✓ pulled · ${res.written} cards written, ${res.removed} removed`),
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
      if (res.boardRoot) out(`  board: ${res.boardRoot} · start with \`botflow prime\``);
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
      out(touched.length > 0 ? `✓ wired botflow into ${touched.join(', ')}` : 'already wired · nothing to do');
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
      throw new UsageError(`unknown command "${cmd}" · see \`botflow help\``);
  }
}

function runCard(argv: string[]): number {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'add': {
      const { values, positionals } = parse(rest, {
        ...COMMON,
        lane: { type: 'string' },
        template: { type: 'string' },
        type: { type: 'string' },
        'board-path': { type: 'string' },
        labels: { type: 'string' },
        priority: { type: 'string' },
        deps: { type: 'string' },
        assignee: { type: 'string' },
        delegate: { type: 'string' },
        start: { type: 'string' },
        due: { type: 'string' },
        estimate: { type: 'string' },
        evergreen: { type: 'boolean' },
        'cover-color': { type: 'string' },
        field: { type: 'string', multiple: true },
      });
      const title = positionals.join(' ').trim();
      if (title === '') throw new UsageError('usage: botflow card add <title> [flags]');
      const type = values['type'] as string | undefined;
      if (type !== undefined && type !== 'task' && type !== 'board') throw new UsageError('--type must be task or board');
      const root = getRoot(values);
      const card = addCard(root, {
        title,
        template: values['template'] as string | undefined,
        lane: values['lane'] as string | undefined,
        type: type as 'task' | 'board' | undefined,
        boardPath: values['board-path'] as string | undefined,
        labels: csv(values['labels'] as string | undefined),
        priority: values['priority'] as string | undefined,
        deps: csv(values['deps'] as string | undefined),
        assignee: values['assignee'] as string | undefined,
        delegate: values['delegate'] as string | undefined,
        start: values['start'] as string | undefined,
        due: values['due'] as string | undefined,
        estimate: values['estimate'] === undefined ? undefined : Number(values['estimate']),
        evergreen: values['evergreen'] === true ? true : undefined,
        coverColor: values['cover-color'] as string | undefined,
        fields: fieldAssignments(root, values['field'] as string[] | undefined),
        actor: getActor(values),
      });
      const pos = card.substate === null ? card.laneId : `${card.laneId}.${card.substate}`;
      values['json']
        ? emitJson({ id: card.id, title: card.title, position: pos, file: card.file })
        : out(`✓ ${card.id} created in ${pos} · ${card.file}`);
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
      if (values['json']) emitJson(cardDetailJson(card, node, ba));
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
      const { values, positionals } = parse(rest, {
        ...COMMON,
        reason: { type: 'string' },
        force: { type: 'boolean', default: false },
        delegate: { type: 'boolean', default: false },
      });
      const id = positionals[0];
      if (!id) throw new UsageError(`usage: botflow card ${sub} <id>`);
      const root = getRoot(values);
      const actor = getActor(values);
      const res =
        sub === 'claim'
          ? claimCard(root, id, actor, values['force'] as boolean, values['delegate'] === true ? 'delegate' : 'assign')
          : closeCard(root, id, actor, values['reason'] as string | undefined);
      if (res.alreadyYours) {
        values['json']
          ? emitJson({ id: res.card.id, from: res.from, to: res.to, assignee: res.card.assignee, delegate: res.card.delegate, alreadyYours: true, warnings: [] })
          : out(`= ${res.card.id} already yours (${res.to})`);
        return 0;
      }
      const holder = values['delegate'] === true ? res.card.delegate : res.card.assignee;
      values['json']
        ? emitJson({ id: res.card.id, from: res.from, to: res.to, assignee: res.card.assignee, delegate: res.card.delegate, warnings: res.warnings })
        : out(`✓ ${res.card.id} ${res.from} → ${res.to}${sub === 'claim' ? ` (@${holder})` : ''}${res.warnings.map((w) => `\n⚠ ${w}`).join('')}`);
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
        delegate: { type: 'string' },
        deps: { type: 'string' },
        start: { type: 'string' },
        due: { type: 'string' },
        estimate: { type: 'string' },
        evergreen: { type: 'string' },
        'board-path': { type: 'string' },
        cover: { type: 'string' },
        'cover-color': { type: 'string' },
        field: { type: 'string', multiple: true },
      });
      const id = positionals[0];
      if (!id) throw new UsageError('usage: botflow card edit <id> [flags]');
      const noneable = (v: string | undefined): string | null | undefined => (v === 'none' ? null : v);
      const patch: EditPatch = {};
      if (values['title'] !== undefined) patch.title = values['title'] as string;
      if (values['labels'] !== undefined) patch.labels = csv(values['labels'] as string)!;
      if (values['priority'] !== undefined) patch.priority = noneable(values['priority'] as string);
      if (values['assignee'] !== undefined) patch.assignee = noneable(values['assignee'] as string);
      if (values['delegate'] !== undefined) patch.delegate = noneable(values['delegate'] as string);
      if (values['deps'] !== undefined) patch.deps = csv(values['deps'] as string)!;
      if (values['start'] !== undefined) patch.start = noneable(values['start'] as string);
      if (values['due'] !== undefined) patch.due = noneable(values['due'] as string);
      if (values['estimate'] !== undefined) {
        const value = values['estimate'] as string;
        patch.estimate = value === 'none' ? null : Number(value);
      }
      if (values['evergreen'] !== undefined) {
        const value = values['evergreen'];
        if (value !== 'true' && value !== 'false') throw new UsageError('--evergreen must be true or false');
        patch.evergreen = value === 'true';
      }
      if (values['board-path'] !== undefined) patch.boardPath = values['board-path'] as string;
      if (values['cover'] !== undefined) {
        const c = values['cover'] as string;
        patch.cover = c === 'auto' ? null : c; // 'none' suppresses; a url sets art
      }
      if (values['cover-color'] !== undefined) patch.coverColor = noneable(values['cover-color'] as string);
      const root = getRoot(values);
      if (values['field'] !== undefined) patch.fields = fieldAssignments(root, values['field'] as string[]);
      const card = editCard(root, id, patch, getActor(values));
      values['json'] ? emitJson({ id: card.id, edited: Object.keys(patch) }) : out(`✓ ${card.id} edited (${Object.keys(patch).join(', ')})`);
      return 0;
    }
    case 'comment': {
      const { values, positionals } = parse(rest, COMMON);
      const [id, ...words] = positionals;
      if (!id || words.length === 0) throw new UsageError('usage: botflow card comment <id> <text…>');
      const card = commentCard(getRoot(values), id, getActor(values), words.join(' '));
      values['json'] ? emitJson({ id: card.id, commented: true }) : out(`✓ ${card.id} commented`);
      return 0;
    }
    case 'describe': {
      const { values, positionals } = parse(rest, COMMON);
      const [id, ...words] = positionals;
      if (!id) throw new UsageError('usage: botflow card describe <id> <text…>  (empty text clears)');
      const card = describeCard(getRoot(values), id, getActor(values), words.join(' '));
      values['json'] ? emitJson({ id: card.id, described: true }) : out(`✓ ${card.id} description ${words.length ? 'set' : 'cleared'}`);
      return 0;
    }
    case 'item': {
      const { values, positionals } = parse(rest, { ...COMMON, section: { type: 'string' } });
      const [id, ...words] = positionals;
      if (!id || words.length === 0) throw new UsageError('usage: botflow card item <id> <text…> [--section name]');
      const card = checklistAddCard(getRoot(values), id, getActor(values), words.join(' '), values['section'] as string | undefined);
      values['json'] ? emitJson({ id: card.id, added: true }) : out(`✓ ${card.id} task added`);
      return 0;
    }
    case 'check': {
      const { values, positionals } = parse(rest, { ...COMMON, off: { type: 'boolean', default: false } });
      const [id, n] = positionals;
      const index = Number(n) - 1;
      if (!id || !Number.isInteger(index) || index < 0) throw new UsageError('usage: botflow card check <id> <n> [--off]');
      const checked = !(values['off'] as boolean);
      const card = checkCard(getRoot(values), id, getActor(values), index, checked);
      values['json'] ? emitJson({ id: card.id, item: index + 1, checked }) : out(`✓ ${card.id} item ${index + 1} ${checked ? 'checked' : 'unchecked'}`);
      return 0;
    }
    case 'promote': {
      const { values, positionals } = parse(rest, {
        ...COMMON,
        title: { type: 'string' },
        template: { type: 'string' },
        lane: { type: 'string' },
        labels: { type: 'string' },
        priority: { type: 'string' },
        assignee: { type: 'string' },
        delegate: { type: 'string' },
        start: { type: 'string' },
        due: { type: 'string' },
        estimate: { type: 'string' },
        evergreen: { type: 'boolean' },
        'cover-color': { type: 'string' },
        field: { type: 'string', multiple: true },
      });
      const [id, n] = positionals;
      const index = Number(n) - 1;
      if (!id || !Number.isInteger(index) || index < 0) throw new UsageError('usage: botflow card promote <id> <n> [flags]');
      const root = getRoot(values);
      const result = promoteCard(root, id, index, getActor(values), {
        title: values['title'] as string | undefined,
        template: values['template'] as string | undefined,
        lane: values['lane'] as string | undefined,
        labels: csv(values['labels'] as string | undefined),
        priority: values['priority'] as string | undefined,
        assignee: values['assignee'] as string | undefined,
        delegate: values['delegate'] as string | undefined,
        start: values['start'] as string | undefined,
        due: values['due'] as string | undefined,
        estimate: values['estimate'] === undefined ? undefined : Number(values['estimate']),
        evergreen: values['evergreen'] === true ? true : undefined,
        coverColor: values['cover-color'] as string | undefined,
        fields: fieldAssignments(root, values['field'] as string[] | undefined),
      });
      values['json']
        ? emitJson({ source: result.source.id, promoted: result.promoted.id, item: index + 1, file: result.promoted.file })
        : out(`✓ ${result.source.id} item ${index + 1} → ${result.promoted.id} · ${result.promoted.file}`);
      return 0;
    }
    case 'link':
    case 'unlink': {
      const { values, positionals } = parse(rest, { ...COMMON, type: { type: 'string' } });
      const [source, target] = positionals;
      const type = values['type'] as RelationType | undefined;
      if (!source || !target || !type) throw new UsageError(`usage: botflow card ${sub} <id> <target> --type <kind>`);
      const result = sub === 'link'
        ? linkCards(getRoot(values), source, target, type, getActor(values))
        : unlinkCards(getRoot(values), source, target, type, getActor(values));
      values['json']
        ? emitJson({ source, target, type, changed: result.changed })
        : out(`${result.changed ? '✓' : '='} ${source} ${sub === 'link' ? 'linked' : 'unlinked'} ${type} ${target}${result.changed ? '' : ' (already)'}`);
      return 0;
    }
    case 'merge': {
      const { values, positionals } = parse(rest, COMMON);
      const [duplicate, canonical] = positionals;
      if (!duplicate || !canonical) throw new UsageError('usage: botflow card merge <duplicate> <canonical>');
      const result = mergeDuplicateCards(getRoot(values), duplicate, canonical, getActor(values));
      const summary = { duplicate, canonical, attachmentsMoved: result.attachmentsMoved, referencesRewired: result.referencesRewired };
      values['json'] ? emitJson(summary) : out(`✓ ${duplicate} merged into ${canonical} · ${result.attachmentsMoved} attachment(s), ${result.referencesRewired} reference(s)`);
      return 0;
    }
    case 'quick': {
      const { values, positionals } = parse(rest, COMMON);
      const text = positionals.join(' ');
      if (text.trim() === '') throw new UsageError('usage: botflow card quick <multiline text>');
      const cards = quickAddCards(getRoot(values), text, getActor(values));
      values['json']
        ? emitJson(cards.map((card) => ({ id: card.id, title: card.title, file: card.file })))
        : out(cards.map((card) => `✓ ${card.id} ${card.title}`).join('\n'));
      return 0;
    }
    case 'copy':
    case 'move-to': {
      const { values, positionals } = parse(rest, { ...COMMON, 'to-board': { type: 'string' }, lane: { type: 'string' } });
      const id = positionals[0];
      const target = values['to-board'] as string | undefined;
      if (!id || !target) throw new UsageError(`usage: botflow card ${sub} <id> --to-board <path> [--lane l]`);
      const result = transferCard(getRoot(values), target, id, getActor(values), { move: sub === 'move-to', lane: values['lane'] as string | undefined });
      const summary = { source: result.source.id, target: result.target.id, targetBoard: result.targetRoot, moved: result.moved, reused: result.reused };
      values['json'] ? emitJson(summary) : out(`${result.reused ? '=' : '✓'} ${id} ${sub === 'move-to' ? 'moved' : 'copied'} → ${result.target.id} on ${result.targetRoot}${result.reused ? ' (existing transfer)' : ''}`);
      return 0;
    }
    case 'bulk': {
      const { values, positionals } = parse(rest, {
        ...COMMON,
        force: { type: 'boolean', default: false },
        reason: { type: 'string' },
        'add-labels': { type: 'string' },
        'remove-labels': { type: 'string' },
      });
      const [idList, action, arg] = positionals;
      const ids = csv(idList);
      if (!ids || !action) throw new UsageError('usage: botflow card bulk <ids> mv <lane> | close | label');
      const bulkAction = action === 'mv' && arg
        ? { kind: 'move' as const, to: arg, force: values['force'] === true }
        : action === 'close'
          ? { kind: 'close' as const, reason: values['reason'] as string | undefined }
          : action === 'label'
            ? { kind: 'label' as const, add: csv(values['add-labels'] as string | undefined), remove: csv(values['remove-labels'] as string | undefined) }
            : null;
      if (bulkAction === null) throw new UsageError('usage: botflow card bulk <ids> mv <lane> | close | label');
      const result = bulkCards(getRoot(values), ids, bulkAction, getActor(values));
      values['json']
        ? emitJson({ changed: result.cards.map((card) => card.id), warnings: result.warnings })
        : out(`✓ ${result.cards.length}/${ids.length} card(s) changed${result.warnings.map((warning) => `\n⚠ ${warning}`).join('')}`);
      return 0;
    }
    case 'attach': {
      const { values, positionals } = parse(rest, { ...COMMON, label: { type: 'string' } });
      const [id, url] = positionals;
      if (!id || !url) throw new UsageError('usage: botflow card attach <id> <url> [--label l]');
      const card = attachCard(getRoot(values), id, getActor(values), url, values['label'] as string | undefined);
      values['json'] ? emitJson({ id: card.id, attached: url }) : out(`✓ ${card.id} attached ${url}`);
      return 0;
    }
    case 'detach': {
      const { values, positionals } = parse(rest, COMMON);
      const [id, n] = positionals;
      const index = Number(n) - 1;
      if (!id || !Number.isInteger(index) || index < 0) throw new UsageError('usage: botflow card detach <id> <n>');
      const card = detachCard(getRoot(values), id, getActor(values), index);
      values['json'] ? emitJson({ id: card.id, detached: index + 1 }) : out(`✓ ${card.id} attachment ${index + 1} removed`);
      return 0;
    }
    default:
      throw new UsageError(`unknown card command "${sub ?? ''}" · see \`botflow help\``);
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
