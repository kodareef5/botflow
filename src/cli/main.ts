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
import { queryCards } from '../core/query.ts';
import { loadRemote, pull, push, remoteAdd } from './remote.ts';

import { analyze, lintBoard } from '../core/analyze.ts';
import { discoverBoardRoot, loadTree, resolveBoardRoot } from '../core/load.ts';
import type { CardRepeat, Finding, RelationType } from '../core/model.ts';
import {
  UsageError,
  addCard,
  addLogEntry,
  attachCard,
  blockCard,
  boostCard,
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
  runAutomation,
  runButton,
  bulkCards,
  transferCard,
  initBoard,
  moveCard,
  removeFilter,
  saveFilter,
  snoozeCard,
  subscribeLane,
  unblockCard,
  voteCard,
  watchCard,
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
  query <expression> | --saved <id>     search this board tree; qualifiers include
                                        state:, lane:, assignee:, label:, is:
  filter list | save <id> <query>       list or maintain portable saved filters
  filter rm <id>
  lane subscribe <lane> [--off]         follow/unfollow activity in a lane
  automate                              run one bounded reminder/snooze/sweep pass
  button list | run <id> [--card id]    list or invoke safe board/card buttons
  lint [--json]                         check the board; exit 1 on errors
  card add <title> [--template id] [--lane l] [--labels a,b] [--priority p0-p3] [--deps 1,2]
           [--type board --board-path <dir>] [--assignee name] [--delegate agent]
           [--start YYYY-MM-DD] [--due YYYY-MM-DD] [--estimate n] [--hill 0-100] [--evergreen]
           [--reminders 1440,60,0] [--repeat 1:week:due] [--snooze UTC-date]
           [--cover-color #RRGGBB] [--field id=value ...]
  card show <id> [--json]
  card mv <id> <lane[.substate]> [--force] [--wip-reason text]
  card claim <id> [--delegate] [--force] take a ready card into doing as assignee
                                        or, with --delegate, as executing agent;
                                        conflicts (assigned/blocked/snoozed/not-ready/deps)
                                        refuse unless --force
  card close <id> [--reason r]          move to done, clear blocked flag; recurring
                                        tasks materialize one next instance
  card block <id> --reason <r> [--blocker id] set freeform/named blocked flag
  card unblock <id>
  card snooze <id> --until <UTC-date> | --off
  card edit <id> [--title t] [--labels a,b] [--priority p|none]
           [--assignee name|none] [--delegate name|none] [--deps 1,2]
           [--start date|none] [--due date|none] [--estimate n|none] [--hill 0-100|none]
           [--reminders offsets|none] [--repeat every:unit:from|none]
           [--snooze UTC-date|none]
           [--evergreen true|false] [--board-path <dir>]
           [--cover <url>|none|auto] [--cover-color #RRGGBB|none]
           [--field id=value ...]              empty value clears a custom field
  card comment <id> <text…>             append to the Comments section
  card watch <id> [--off]               follow/unfollow a card
  card vote <id> [--off]                add/withdraw your vote
  card boost <id> <text>                append a 1–12 character boost
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

function reminderOffsets(value: string | undefined): number[] | undefined {
  if (value === undefined || value === 'none' || value === '') return value === undefined ? undefined : [];
  return value.split(',').map((part) => Number(part.trim()));
}

function repeatValue(value: string | undefined): CardRepeat | null | undefined {
  if (value === undefined) return undefined;
  if (value === 'none') return null;
  const [everyText, unit, from = 'due', tail] = value.split(':');
  const every = Number(everyText);
  if (tail !== undefined || !Number.isSafeInteger(every) || every <= 0 || !['day', 'week', 'month'].includes(unit ?? '') || !['due', 'completion'].includes(from)) {
    throw new UsageError('--repeat must be none or <positive-int>:<day|week|month>:<due|completion>');
  }
  return { every, unit: unit as CardRepeat['unit'], from: from as CardRepeat['from'], extra: {} };
}

/** The four read surfaces promised by SPEC §6b run lazy automation only when
 * this supported board actually has timed work. Unsupported boards remain
 * inspectable read-only. */
function lazyAutomation(root: string): void {
  const board = loadTree(root).boards.get('.')!.board;
  if (board.config.mutationBlocked !== null) return;
  const timed = board.config.automation.archiveDoneAfter !== null
    || board.cards.some((card) => card.snooze !== null || card.reminders.length > 0);
  if (timed) runAutomation(root);
}

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
      lazyAutomation(root);
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
      lazyAutomation(root);
      const tree = loadTree(root);
      const analysis = analyze(tree);
      values['json'] ? emitJson(boardJson(tree, analysis)) : out(renderPrime(tree, analysis, root));
      return 0;
    }
    case 'ready': {
      const { values } = parse(rest, COMMON);
      const root = getRoot(values);
      lazyAutomation(root);
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
    case 'query': {
      const { values, positionals } = parse(rest, { ...COMMON, saved: { type: 'string' } });
      const root = getRoot(values);
      lazyAutomation(root);
      const tree = loadTree(root);
      const analysis = analyze(tree);
      const saved = values['saved'] as string | undefined;
      if (saved !== undefined && positionals.length > 0) throw new UsageError('use either a query expression or --saved, not both');
      const expression = saved === undefined
        ? positionals.join(' ')
        : tree.boards.get('.')!.board.config.savedFilters.find((filter) => filter.id === saved)?.query;
      if (expression === undefined) throw new UsageError(`no saved filter "${saved}"`);
      let matches: ReturnType<typeof queryCards>;
      try {
        matches = queryCards(tree, analysis, expression, { actor: getActor(values) });
      } catch (err) {
        throw new UsageError((err as Error).message);
      }
      if (values['json']) {
        emitJson(matches.map((match) => {
          const node = tree.boards.get(match.board)!;
          return { board: match.board, ...cardJson(match.card, node, analysis.boards.get(match.board)!) };
        }));
      } else if (matches.length === 0) {
        out('no matching cards');
      } else {
        out(matches.map((match) => `${match.board === '.' ? match.card.id : `${match.board}#${match.card.id}`}  ${match.state.padEnd(7)}  ${match.card.title}`).join('\n'));
      }
      return 0;
    }
    case 'filter': {
      const { values, positionals } = parse(rest, { ...COMMON, name: { type: 'string' } });
      const [sub, id, ...queryWords] = positionals;
      const root = getRoot(values);
      if (sub === 'list') {
        const filters = loadTree(root).boards.get('.')!.board.config.savedFilters;
        values['json'] ? emitJson(filters.map(({ id: filterId, name, query }) => ({ id: filterId, name, query }))) : out(filters.length === 0 ? 'no saved filters' : filters.map((filter) => `${filter.id}  ${filter.name}  ${filter.query}`).join('\n'));
        return 0;
      }
      if (sub === 'save' && id) {
        const filter = saveFilter(root, id, queryWords.join(' '), getActor(values), values['name'] as string | undefined);
        values['json'] ? emitJson({ id: filter.id, name: filter.name, query: filter.query }) : out(`✓ filter ${filter.id} saved`);
        return 0;
      }
      if ((sub === 'rm' || sub === 'remove') && id) {
        const filter = removeFilter(root, id, getActor(values));
        values['json'] ? emitJson({ id: filter.id, removed: true }) : out(`✓ filter ${filter.id} removed`);
        return 0;
      }
      throw new UsageError('usage: botflow filter list | save <id> <query…> [--name n] | rm <id>');
    }
    case 'lane': {
      const { values, positionals } = parse(rest, { ...COMMON, off: { type: 'boolean', default: false } });
      const [sub, lane] = positionals;
      if (sub !== 'subscribe' || !lane) throw new UsageError('usage: botflow lane subscribe <lane> [--off]');
      const result = subscribeLane(getRoot(values), lane, getActor(values), values['off'] !== true);
      values['json']
        ? emitJson({ lane, watcher: result.subscription.watcher, subscribed: result.active, changed: result.changed })
        : out(`${result.changed ? '✓' : '='} @${result.subscription.watcher} ${result.active ? 'subscribed to' : 'unsubscribed from'} ${lane}`);
      return 0;
    }
    case 'automate': {
      const { values } = parse(rest, COMMON);
      const result = runAutomation(getRoot(values));
      values['json']
        ? emitJson({ actions: result.actions, changed: result.cards.map((card) => card.id), remaining: result.remaining, nextAt: result.nextAt })
        : out(result.actions.length === 0 ? 'automation current · nothing due' : `✓ ${result.actions.length} automation action(s) applied${result.remaining ? ' · more work remains' : ''}`);
      return 0;
    }
    case 'button': {
      const { values, positionals } = parse(rest, {
        ...COMMON,
        card: { type: 'string' },
        force: { type: 'boolean', default: false },
        'wip-reason': { type: 'string' },
      });
      const [sub, id] = positionals;
      const root = getRoot(values);
      if (sub === 'list') {
        const buttons = loadTree(root).boards.get('.')!.board.config.buttons.map(({ id: buttonId, name, scope, filter, action, value }) => ({ id: buttonId, name, scope, filter, action, value }));
        values['json'] ? emitJson(buttons) : out(buttons.length === 0 ? 'no buttons configured' : buttons.map((button) => `${button.id}  ${button.scope}  ${button.name} (${button.action}${button.value === null ? '' : ` ${button.value}`})`).join('\n'));
        return 0;
      }
      if (sub !== 'run' || !id) throw new UsageError('usage: botflow button list | run <id> [--card id]');
      const result = runButton(root, id, getActor(values), {
        cardId: values['card'] as string | undefined,
        force: values['force'] === true,
        wipJustification: values['wip-reason'] as string | undefined,
      });
      values['json']
        ? emitJson({ button: result.button.id, changed: result.cards.map((card) => card.id), warnings: result.warnings })
        : out(`✓ ${result.button.name}: ${result.cards.length} card(s) changed${result.warnings.map((warning) => `\n⚠ ${warning}`).join('')}`);
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
        reminders: { type: 'string' },
        repeat: { type: 'string' },
        snooze: { type: 'string' },
        estimate: { type: 'string' },
        hill: { type: 'string' },
        evergreen: { type: 'boolean' },
        'cover-color': { type: 'string' },
        field: { type: 'string', multiple: true },
        force: { type: 'boolean', default: false },
        'wip-reason': { type: 'string' },
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
        reminders: reminderOffsets(values['reminders'] as string | undefined),
        repeat: repeatValue(values['repeat'] as string | undefined) ?? undefined,
        snooze: values['snooze'] as string | undefined,
        estimate: values['estimate'] === undefined ? undefined : Number(values['estimate']),
        hill: values['hill'] === undefined ? undefined : Number(values['hill']),
        evergreen: values['evergreen'] === true ? true : undefined,
        coverColor: values['cover-color'] as string | undefined,
        fields: fieldAssignments(root, values['field'] as string[] | undefined),
        force: values['force'] === true,
        wipJustification: values['wip-reason'] as string | undefined,
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
      const { values, positionals } = parse(rest, { ...COMMON, force: { type: 'boolean', default: false }, 'wip-reason': { type: 'string' } });
      const [id, spec] = positionals;
      if (!id || !spec) throw new UsageError('usage: botflow card mv <id> <lane[.substate]>');
      const res = moveCard(getRoot(values), id, spec, getActor(values), values['force'] as boolean, values['wip-reason'] as string | undefined);
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
        'wip-reason': { type: 'string' },
        force: { type: 'boolean', default: false },
        delegate: { type: 'boolean', default: false },
      });
      const id = positionals[0];
      if (!id) throw new UsageError(`usage: botflow card ${sub} <id>`);
      const root = getRoot(values);
      const actor = getActor(values);
      const res =
        sub === 'claim'
          ? claimCard(root, id, actor, values['force'] as boolean, values['delegate'] === true ? 'delegate' : 'assign', values['wip-reason'] as string | undefined)
          : closeCard(root, id, actor, values['reason'] as string | undefined, values['wip-reason'] as string | undefined, values['force'] === true);
      if (res.alreadyYours) {
        values['json']
          ? emitJson({ id: res.card.id, from: res.from, to: res.to, assignee: res.card.assignee, delegate: res.card.delegate, alreadyYours: true, warnings: [] })
          : out(`= ${res.card.id} already yours (${res.to})`);
        return 0;
      }
      const holder = values['delegate'] === true ? res.card.delegate : res.card.assignee;
      values['json']
        ? emitJson({ id: res.card.id, from: res.from, to: res.to, assignee: res.card.assignee, delegate: res.card.delegate, created: res.created?.id ?? null, warnings: res.warnings })
        : out(`✓ ${res.card.id} ${res.from} → ${res.to}${sub === 'claim' ? ` (@${holder})` : ''}${res.warnings.map((w) => `\n⚠ ${w}`).join('')}`);
      return 0;
    }
    case 'block': {
      const { values, positionals } = parse(rest, { ...COMMON, reason: { type: 'string' }, blocker: { type: 'string' } });
      const id = positionals[0];
      const reason = values['reason'] as string | undefined;
      if (!id || !reason) throw new UsageError('usage: botflow card block <id> --reason <why>');
      const card = blockCard(getRoot(values), id, getActor(values), reason, values['blocker'] as string | undefined);
      values['json'] ? emitJson({ id: card.id, blocked: card.blocked, blocker: card.blocker }) : out(`⛔ ${card.id} blocked${card.blocker ? ` [${card.blocker}]` : ''}: ${reason}`);
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
    case 'snooze': {
      const { values, positionals } = parse(rest, { ...COMMON, until: { type: 'string' }, off: { type: 'boolean', default: false } });
      const id = positionals[0];
      const until = values['until'] as string | undefined;
      if (!id || (values['off'] !== true && until === undefined) || (values['off'] === true && until !== undefined)) {
        throw new UsageError('usage: botflow card snooze <id> --until <UTC-date> | --off');
      }
      const card = snoozeCard(getRoot(values), id, getActor(values), values['off'] === true ? null : until!);
      values['json'] ? emitJson({ id: card.id, snooze: card.snooze }) : out(`✓ ${card.id} ${card.snooze === null ? 'awake' : `snoozed until ${card.snooze}`}`);
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
        reminders: { type: 'string' },
        repeat: { type: 'string' },
        snooze: { type: 'string' },
        estimate: { type: 'string' },
        hill: { type: 'string' },
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
      if (values['reminders'] !== undefined) patch.reminders = reminderOffsets(values['reminders'] as string)!;
      if (values['repeat'] !== undefined) patch.repeat = repeatValue(values['repeat'] as string);
      if (values['snooze'] !== undefined) patch.snooze = noneable(values['snooze'] as string);
      if (values['estimate'] !== undefined) {
        const value = values['estimate'] as string;
        patch.estimate = value === 'none' ? null : Number(value);
      }
      if (values['hill'] !== undefined) {
        const value = values['hill'] as string;
        patch.hill = value === 'none' ? null : Number(value);
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
    case 'watch':
    case 'vote': {
      const { values, positionals } = parse(rest, { ...COMMON, off: { type: 'boolean', default: false } });
      const id = positionals[0];
      if (!id) throw new UsageError(`usage: botflow card ${sub} <id> [--off]`);
      const active = values['off'] !== true;
      const result = sub === 'watch'
        ? watchCard(getRoot(values), id, getActor(values), active)
        : voteCard(getRoot(values), id, getActor(values), active);
      values['json']
        ? emitJson({ id, [sub === 'watch' ? 'watching' : 'voted']: result.active, changed: result.changed })
        : out(`${result.changed ? '✓' : '='} ${id} ${sub === 'watch' ? (active ? 'watched' : 'unwatched') : (active ? 'voted' : 'vote withdrawn')}`);
      return 0;
    }
    case 'boost': {
      const { values, positionals } = parse(rest, COMMON);
      const [id, ...words] = positionals;
      if (!id || words.length === 0) throw new UsageError('usage: botflow card boost <id> <text>');
      const card = boostCard(getRoot(values), id, getActor(values), words.join(' '));
      values['json'] ? emitJson({ id: card.id, boosted: words.join(' ') }) : out(`✓ ${card.id} boosted ${words.join(' ')}`);
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
        'wip-reason': { type: 'string' },
        'add-labels': { type: 'string' },
        'remove-labels': { type: 'string' },
      });
      const [idList, action, arg] = positionals;
      const ids = csv(idList);
      if (!ids || !action) throw new UsageError('usage: botflow card bulk <ids> mv <lane> | close | label');
      const bulkAction = action === 'mv' && arg
        ? { kind: 'move' as const, to: arg, force: values['force'] === true, wipJustification: values['wip-reason'] as string | undefined }
        : action === 'close'
          ? { kind: 'close' as const, reason: values['reason'] as string | undefined, force: values['force'] === true, wipJustification: values['wip-reason'] as string | undefined }
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
