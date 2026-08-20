// MCP server over stdio: newline-delimited JSON-RPC 2.0, zero dependencies.
// Exposes the same verbs as the CLI so MCP-native agents get first-class
// access to the board. Protocol errors → JSON-RPC errors; tool failures →
// result payloads with isError (per MCP convention).

import process from 'node:process';
import type { Readable, Writable } from 'node:stream';

import { analyze, lintBoard } from '../core/analyze.ts';
import { loadTree } from '../core/load.ts';
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
import type { CardRepeat } from '../core/model.ts';
import { boardJson, cardJson, renderPrime, rollupJson } from '../cli/render.ts';
import { cardDetailJson } from '../core/json.ts';
import { queryCards } from '../core/query.ts';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'botflow', version: '0.1.0' };
const PRIORITIES: readonly string[] = ['p0', 'p1', 'p2', 'p3'];
const RELATIONS = ['relates', 'duplicates', 'supersedes', 'parent', 'subtask', 'copied-from', 'copied-to', 'recurs-from', 'recurs-to'] as const;
/** Cap on the pending stdin buffer: a client that never sends '\n' would otherwise grow it until the host OOMs. */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

type Json = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  run: (args: Json) => unknown;
}

const str = { type: 'string' } as const;
const bool = { type: 'boolean' } as const;
const positiveInt = { type: 'integer', minimum: 1 } as const;
const strList = { type: 'array', items: { type: 'string' } } as const;
const fieldMap = { type: 'object', additionalProperties: true } as const;

function schema(required: string[], props: Json): Json {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

function buildTools(root: string, defaultActor: string): Tool[] {
  const actorOf = (args: Json): string => (typeof args['actor'] === 'string' ? (args['actor'] as string) : defaultActor);
  const opt = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  // Arguments arrive off the wire unchecked (the schema is only advisory), so
  // reject wrong shapes loudly instead of coercing: String(obj) would write
  // "[object Object]" and `list(nonArray) ?? []` would silently wipe deps.
  const strOf = (v: unknown, name: string): string => {
    if (typeof v !== 'string') throw new UsageError(`invalid ${name}: expected a string`);
    return v;
  };
  const list = (v: unknown, name: string): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.every((item) => typeof item === 'string')) {
      throw new UsageError(`invalid ${name}: expected an array of strings`);
    }
    return v as string[];
  };
  const priorityOf = (v: unknown): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !PRIORITIES.includes(v)) {
      throw new UsageError(`invalid priority: expected one of ${PRIORITIES.join(', ')}`);
    }
    return v;
  };
  const positiveIntOf = (v: unknown, name: string): number | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) {
      throw new UsageError(`invalid ${name}: expected a positive integer`);
    }
    return v;
  };
  const fieldsOf = (v: unknown): Record<string, unknown> | undefined => {
    if (v === undefined) return undefined;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new UsageError('invalid fields: expected an object');
    return v as Record<string, unknown>;
  };

  const offsetsOf = (v: unknown): number[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
      throw new UsageError('invalid reminders: expected an array of nonnegative integers');
    }
    return v as number[];
  };

  const repeatOf = (v: unknown): CardRepeat | null | undefined => {
    if (v === undefined || v === null) return v;
    if (typeof v !== 'object' || Array.isArray(v)) throw new UsageError('invalid repeat: expected an object or null');
    const value = v as Record<string, unknown>;
    return {
      every: positiveIntOf(value['every'], 'repeat.every')!,
      unit: strOf(value['unit'], 'repeat.unit') as CardRepeat['unit'],
      from: (value['from'] === undefined ? 'due' : strOf(value['from'], 'repeat.from')) as CardRepeat['from'],
      extra: {},
    };
  };

  const view = () => {
    let tree = loadTree(root);
    const board = tree.boards.get('.')!.board;
    if (board.config.mutationBlocked === null && (board.config.automation.archiveDoneAfter !== null || board.cards.some((card) => card.snooze !== null || card.reminders.length > 0))) {
      runAutomation(root);
      tree = loadTree(root);
    }
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
      description: 'Task cards that are unblocked and ready to claim (effective state todo, deps satisfied). Project/board cards are containers and never appear.',
      inputSchema: schema([], {}),
      run: () => {
        const { tree, analysis } = view();
        const node = tree.boards.get('.')!;
        const ba = analysis.boards.get('.')!;
        return ba.ready.map((id) => cardJson(node.board.cards.find((c) => c.id === id)!, node, ba));
      },
    },
    {
      name: 'query_cards',
      description: 'Search the board tree with botflow query syntax, or run one portable saved filter.',
      inputSchema: schema([], { query: str, saved: str, actor: str }),
      run: (args) => {
        const { tree, analysis } = view();
        if (args['query'] !== undefined && args['saved'] !== undefined) throw new UsageError('use query or saved, not both');
        const saved = opt(args['saved']);
        const expression = saved === undefined
          ? (args['query'] === undefined ? '' : strOf(args['query'], 'query'))
          : tree.boards.get('.')!.board.config.savedFilters.find((filter) => filter.id === saved)?.query;
        if (expression === undefined) throw new UsageError(`no saved filter "${saved}"`);
        try {
          return queryCards(tree, analysis, expression, { actor: actorOf(args) }).map((match) => {
            const node = tree.boards.get(match.board)!;
            return { board: match.board, ...cardJson(match.card, node, analysis.boards.get(match.board)!) };
          });
        } catch (err) {
          throw new UsageError((err as Error).message);
        }
      },
    },
    {
      name: 'filters_list',
      description: 'List portable saved card filters from board.yaml.',
      inputSchema: schema([], {}),
      run: () => view().tree.boards.get('.')!.board.config.savedFilters.map(({ id, name, query }) => ({ id, name, query })),
    },
    {
      name: 'filter_save',
      description: 'Create or replace a portable saved card filter.',
      inputSchema: schema(['id', 'query'], { id: str, query: str, name: str, actor: str }),
      run: (args) => {
        const filter = saveFilter(root, strOf(args['id'], 'id'), strOf(args['query'], 'query'), actorOf(args), opt(args['name']));
        return { id: filter.id, name: filter.name, query: filter.query };
      },
    },
    {
      name: 'filter_remove',
      description: 'Remove a portable saved card filter.',
      inputSchema: schema(['id'], { id: str, actor: str }),
      run: (args) => ({ id: removeFilter(root, strOf(args['id'], 'id'), actorOf(args)).id, removed: true }),
    },
    {
      name: 'lane_subscribe',
      description: 'Follow or unfollow every card currently in one lane.',
      inputSchema: schema(['lane'], { lane: str, subscribed: bool, actor: str }),
      run: (args) => {
        const result = subscribeLane(root, strOf(args['lane'], 'lane'), actorOf(args), args['subscribed'] !== false);
        return { lane: result.subscription.lane, watcher: result.subscription.watcher, subscribed: result.active, changed: result.changed };
      },
    },
    {
      name: 'automation_run',
      description: 'Run one bounded pass of due reminders, snooze expiry, and lazy archive sweeps.',
      inputSchema: schema([], {}),
      run: () => {
        const result = runAutomation(root);
        return { actions: result.actions, changed: result.cards.map((card) => card.id), remaining: result.remaining, nextAt: result.nextAt };
      },
    },
    {
      name: 'buttons_list',
      description: 'List safe declarative card and board buttons.',
      inputSchema: schema([], {}),
      run: () => view().tree.boards.get('.')!.board.config.buttons.map(({ id, name, scope, filter, action, value }) => ({ id, name, scope, filter, action, value })),
    },
    {
      name: 'button_run',
      description: 'Invoke a configured safe button. Card buttons require card_id; board buttons use their saved filter and affect at most 100 cards.',
      inputSchema: schema(['id'], { id: str, card_id: str, force: bool, wip_reason: str, actor: str }),
      run: (args) => {
        const result = runButton(root, strOf(args['id'], 'id'), actorOf(args), {
          cardId: opt(args['card_id']),
          force: args['force'] === true,
          wipJustification: opt(args['wip_reason']),
        });
        return { button: result.button.id, changed: result.cards.map((card) => card.id), warnings: result.warnings };
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
        title: str, template: str, lane: str, type: { type: 'string', enum: ['task', 'board'] }, board_path: str,
        labels: strList, priority: { type: 'string', enum: PRIORITIES }, deps: strList,
        assignee: str, delegate: str, start: str, due: str, estimate: positiveInt, evergreen: bool,
        reminders: { type: 'array', items: { type: 'integer', minimum: 0 } }, repeat: fieldMap, snooze: str,
        cover_color: str, fields: fieldMap, force: bool, wip_reason: str, actor: str,
      }),
      run: (args) => {
        const card = addCard(root, {
          title: strOf(args['title'], 'title'),
          template: opt(args['template']),
          lane: opt(args['lane']),
          type: args['type'] === 'board' ? 'board' : 'task',
          boardPath: opt(args['board_path']),
          labels: list(args['labels'], 'labels'),
          priority: priorityOf(args['priority']),
          deps: list(args['deps'], 'deps'),
          assignee: args['assignee'] === undefined ? undefined : strOf(args['assignee'], 'assignee'),
          delegate: args['delegate'] === undefined ? undefined : strOf(args['delegate'], 'delegate'),
          start: args['start'] === undefined ? undefined : strOf(args['start'], 'start'),
          due: args['due'] === undefined ? undefined : strOf(args['due'], 'due'),
          reminders: offsetsOf(args['reminders']),
          repeat: repeatOf(args['repeat']) ?? undefined,
          snooze: args['snooze'] === undefined ? undefined : strOf(args['snooze'], 'snooze'),
          estimate: positiveIntOf(args['estimate'], 'estimate'),
          evergreen: args['evergreen'] === undefined ? undefined : args['evergreen'] === true,
          coverColor: args['cover_color'] === undefined ? undefined : strOf(args['cover_color'], 'cover_color'),
          fields: fieldsOf(args['fields']),
          force: args['force'] === true,
          wipJustification: opt(args['wip_reason']),
          actor: actorOf(args),
        });
        return { id: card.id, file: card.file, lane: card.laneId };
      },
    },
    {
      name: 'card_promote',
      description: 'Promote an unchecked checklist item to a card, inheriting card context and creating inverse parent/subtask relations.',
      inputSchema: schema(['id', 'index'], {
        id: str, index: { type: 'integer', minimum: 0 }, title: str, template: str, lane: str,
        labels: strList, priority: { type: 'string', enum: PRIORITIES }, assignee: str, delegate: str,
        start: str, due: str, estimate: positiveInt, evergreen: bool, cover_color: str, fields: fieldMap, actor: str,
      }),
      run: (args) => {
        const index = positiveIntOf(Number(args['index']) + 1, 'index')! - 1;
        const result = promoteCard(root, strOf(args['id'], 'id'), index, actorOf(args), {
          title: opt(args['title']), template: opt(args['template']), lane: opt(args['lane']),
          labels: list(args['labels'], 'labels'), priority: priorityOf(args['priority']),
          assignee: opt(args['assignee']), delegate: opt(args['delegate']), start: opt(args['start']), due: opt(args['due']),
          estimate: positiveIntOf(args['estimate'], 'estimate'),
          evergreen: args['evergreen'] === undefined ? undefined : args['evergreen'] === true,
          coverColor: opt(args['cover_color']), fields: fieldsOf(args['fields']),
        });
        return { source: result.source.id, promoted: result.promoted.id, index, file: result.promoted.file };
      },
    },
    {
      name: 'card_link',
      description: 'Create a typed same-board relation and its natural inverse.',
      inputSchema: schema(['id', 'target', 'type'], { id: str, target: str, type: { type: 'string', enum: RELATIONS }, actor: str }),
      run: (args) => {
        const type = strOf(args['type'], 'type');
        if (!(RELATIONS as readonly string[]).includes(type)) throw new UsageError(`invalid relation type "${type}"`);
        const result = linkCards(root, strOf(args['id'], 'id'), strOf(args['target'], 'target'), type as typeof RELATIONS[number], actorOf(args));
        return { id: result.source.id, target: result.target.id, type, changed: result.changed };
      },
    },
    {
      name: 'card_unlink',
      description: 'Remove a typed same-board relation and its natural inverse.',
      inputSchema: schema(['id', 'target', 'type'], { id: str, target: str, type: { type: 'string', enum: RELATIONS }, actor: str }),
      run: (args) => {
        const type = strOf(args['type'], 'type');
        if (!(RELATIONS as readonly string[]).includes(type)) throw new UsageError(`invalid relation type "${type}"`);
        const result = unlinkCards(root, strOf(args['id'], 'id'), strOf(args['target'], 'target'), type as typeof RELATIONS[number], actorOf(args));
        return { id: result.source.id, target: result.target.id, type, changed: result.changed };
      },
    },
    {
      name: 'card_merge',
      description: 'Merge a duplicate into a canonical card: transfer attachments, rewire inbound refs, archive but retain history.',
      inputSchema: schema(['duplicate', 'canonical'], { duplicate: str, canonical: str, actor: str }),
      run: (args) => {
        const result = mergeDuplicateCards(root, strOf(args['duplicate'], 'duplicate'), strOf(args['canonical'], 'canonical'), actorOf(args));
        return { duplicate: result.duplicate.id, canonical: result.canonical.id, attachmentsMoved: result.attachmentsMoved, referencesRewired: result.referencesRewired };
      },
    },
    {
      name: 'card_quick_add',
      description: 'Create cards from newline-separated quick-add text. *label @assignee !p1 today/tomorrow ^estimate ~template; indentation creates subtasks; quotes disable parsing.',
      inputSchema: schema(['text'], { text: str, actor: str }),
      run: (args) => quickAddCards(root, strOf(args['text'], 'text'), actorOf(args)).map((card) => ({ id: card.id, title: card.title, file: card.file })),
    },
    {
      name: 'card_transfer',
      description: 'Copy or safely move a card to a descendant local board, rebasing references. A move archives source history; replay converges on the existing target.',
      inputSchema: schema(['id', 'target_board'], { id: str, target_board: str, lane: str, move: bool, actor: str }),
      run: (args) => {
        const result = transferCard(root, strOf(args['target_board'], 'target_board'), strOf(args['id'], 'id'), actorOf(args), { move: args['move'] === true, lane: opt(args['lane']) });
        return { source: result.source.id, target: result.target.id, targetBoard: result.targetRoot, moved: result.moved, reused: result.reused };
      },
    },
    {
      name: 'card_bulk',
      description: 'Atomically move, close, or label a set of cards; any invalid member rejects the complete batch.',
      inputSchema: schema(['ids', 'action'], {
        ids: strList, action: { type: 'string', enum: ['move', 'close', 'label'] }, to: str, force: bool,
        reason: str, wip_reason: str, add_labels: strList, remove_labels: strList, actor: str,
      }),
      run: (args) => {
        const ids = list(args['ids'], 'ids') ?? [];
        const action = strOf(args['action'], 'action');
        const op = action === 'move'
          ? { kind: 'move' as const, to: strOf(args['to'], 'to'), force: args['force'] === true, wipJustification: opt(args['wip_reason']) }
          : action === 'close'
            ? { kind: 'close' as const, reason: opt(args['reason']), force: args['force'] === true, wipJustification: opt(args['wip_reason']) }
            : action === 'label'
              ? { kind: 'label' as const, add: list(args['add_labels'], 'add_labels'), remove: list(args['remove_labels'], 'remove_labels') }
              : (() => { throw new UsageError('action must be move, close, or label'); })();
        const result = bulkCards(root, ids, op, actorOf(args));
        return { changed: result.cards.map((card) => card.id), warnings: result.warnings };
      },
    },
    {
      name: 'card_move',
      description: 'Move a card to lane[.substate]. Strict lanes advance one substate at a time unless force.',
      inputSchema: schema(['id', 'to'], { id: str, to: str, force: bool, wip_reason: str, actor: str }),
      run: (args) => {
        const res = moveCard(root, strOf(args['id'], 'id'), strOf(args['to'], 'to'), actorOf(args), args['force'] === true, opt(args['wip_reason']));
        return { id: res.card.id, from: res.from, to: res.to, warnings: res.warnings };
      },
    },
    {
      name: 'card_claim',
      description:
        'Atomically claim a ready card and move it into doing. By default sets accountable assignee; delegate:true sets the executing agent without replacing assignee. Same-role races have one winner; force overrides.',
      inputSchema: schema(['id'], { id: str, actor: str, force: bool, delegate: bool, wip_reason: str }),
      run: (args) => {
        const res = claimCard(root, strOf(args['id'], 'id'), actorOf(args), args['force'] === true, args['delegate'] === true ? 'delegate' : 'assign', opt(args['wip_reason']));
        if (res.alreadyYours) return { id: res.card.id, at: res.to, assignee: res.card.assignee, delegate: res.card.delegate, alreadyYours: true };
        return { id: res.card.id, from: res.from, to: res.to, assignee: res.card.assignee, delegate: res.card.delegate, warnings: res.warnings };
      },
    },
    {
      name: 'card_close',
      description: 'Close a card, clear blocking, and materialize one successor when repeat is configured.',
      inputSchema: schema(['id'], { id: str, reason: str, force: bool, wip_reason: str, actor: str }),
      run: (args) => {
        const res = closeCard(root, strOf(args['id'], 'id'), actorOf(args), opt(args['reason']), opt(args['wip_reason']), args['force'] === true);
        return { id: res.card.id, from: res.from, to: res.to, created: res.created?.id ?? null };
      },
    },
    {
      name: 'card_block',
      description: 'Set the blocked flag with a reason. Use instead of silently stalling.',
      inputSchema: schema(['id', 'reason'], { id: str, reason: str, blocker: str, actor: str }),
      run: (args) => {
        const card = blockCard(root, strOf(args['id'], 'id'), actorOf(args), strOf(args['reason'], 'reason'), opt(args['blocker']));
        return { id: card.id, blocked: card.blocked, blocker: card.blocker };
      },
    },
    {
      name: 'card_unblock',
      description: 'Clear the blocked flag.',
      inputSchema: schema(['id'], { id: str, actor: str }),
      run: (args) => {
        const card = unblockCard(root, strOf(args['id'], 'id'), actorOf(args));
        return { id: card.id, blocked: null };
      },
    },
    {
      name: 'card_snooze',
      description: 'Snooze a card until a UTC date/datetime; pass until:null to wake it explicitly.',
      inputSchema: schema(['id', 'until'], { id: str, until: { type: ['string', 'null'] }, actor: str }),
      run: (args) => {
        const card = snoozeCard(root, strOf(args['id'], 'id'), actorOf(args), args['until'] === null ? null : strOf(args['until'], 'until'));
        return { id: card.id, snooze: card.snooze };
      },
    },
    {
      name: 'card_edit',
      description: 'Edit card fields. Pass null for nullable fields to clear them.',
      inputSchema: schema(['id'], {
        id: str, title: str, labels: strList, priority: { type: ['string', 'null'], enum: [...PRIORITIES, null] },
        assignee: { type: ['string', 'null'] }, delegate: { type: ['string', 'null'] }, deps: strList,
        start: { type: ['string', 'null'] }, due: { type: ['string', 'null'] },
        reminders: { type: ['array', 'null'], items: { type: 'integer', minimum: 0 } },
        repeat: { type: ['object', 'null'] }, snooze: { type: ['string', 'null'] },
        estimate: { type: ['integer', 'null'], minimum: 1 }, evergreen: bool, board_path: str,
        cover: { type: ['string', 'null'] }, cover_color: { type: ['string', 'null'] }, fields: fieldMap, actor: str,
      }),
      run: (args) => {
        const patch: EditPatch = {};
        if ('title' in args) patch.title = strOf(args['title'], 'title');
        if ('labels' in args) patch.labels = list(args['labels'], 'labels') ?? [];
        if ('priority' in args) patch.priority = args['priority'] === null ? null : priorityOf(args['priority']) ?? null;
        if ('assignee' in args) patch.assignee = args['assignee'] === null ? null : strOf(args['assignee'], 'assignee');
        if ('delegate' in args) patch.delegate = args['delegate'] === null ? null : strOf(args['delegate'], 'delegate');
        if ('deps' in args) patch.deps = list(args['deps'], 'deps') ?? [];
        if ('start' in args) patch.start = args['start'] === null ? null : strOf(args['start'], 'start');
        if ('due' in args) patch.due = args['due'] === null ? null : strOf(args['due'], 'due');
        if ('reminders' in args) patch.reminders = args['reminders'] === null ? [] : offsetsOf(args['reminders'])!;
        if ('repeat' in args) patch.repeat = repeatOf(args['repeat']);
        if ('snooze' in args) patch.snooze = args['snooze'] === null ? null : strOf(args['snooze'], 'snooze');
        if ('estimate' in args) patch.estimate = args['estimate'] === null ? null : positiveIntOf(args['estimate'], 'estimate')!;
        if ('evergreen' in args) {
          if (typeof args['evergreen'] !== 'boolean') throw new UsageError('invalid evergreen: expected a boolean');
          patch.evergreen = args['evergreen'];
        }
        if ('board_path' in args) patch.boardPath = opt(args['board_path']);
        if ('cover' in args) patch.cover = args['cover'] === null ? null : strOf(args['cover'], 'cover');
        if ('cover_color' in args) patch.coverColor = args['cover_color'] === null ? null : strOf(args['cover_color'], 'cover_color');
        if ('fields' in args) patch.fields = fieldsOf(args['fields']);
        const card = editCard(root, strOf(args['id'], 'id'), patch, actorOf(args));
        return { id: card.id, edited: Object.keys(patch) };
      },
    },
    {
      name: 'card_comment',
      description: 'Append a comment to the card’s Comments section (discourse; separate from the Log).',
      inputSchema: schema(['id', 'message'], { id: str, message: str, actor: str }),
      run: (args) => {
        const card = commentCard(root, strOf(args['id'], 'id'), actorOf(args), strOf(args['message'], 'message'));
        return { id: card.id, commented: true };
      },
    },
    {
      name: 'card_watch',
      description: 'Follow or unfollow one card. Idempotent; followers do not alter assignment.',
      inputSchema: schema(['id'], { id: str, watching: bool, actor: str }),
      run: (args) => {
        const result = watchCard(root, strOf(args['id'], 'id'), actorOf(args), args['watching'] !== false);
        return { id: result.card.id, watching: result.active, changed: result.changed };
      },
    },
    {
      name: 'card_vote',
      description: 'Add or withdraw the actor’s one current vote on a card.',
      inputSchema: schema(['id'], { id: str, voting: bool, actor: str }),
      run: (args) => {
        const result = voteCard(root, strOf(args['id'], 'id'), actorOf(args), args['voting'] !== false);
        return { id: result.card.id, voted: result.active, changed: result.changed };
      },
    },
    {
      name: 'card_boost',
      description: 'Append a 1–12 Unicode-character boost to a card.',
      inputSchema: schema(['id', 'text'], { id: str, text: str, actor: str }),
      run: (args) => ({ id: boostCard(root, strOf(args['id'], 'id'), actorOf(args), strOf(args['text'], 'text')).id, boosted: true }),
    },
    {
      name: 'card_describe',
      description: 'Replace the card’s Description section (empty text clears it).',
      inputSchema: schema(['id'], { id: str, text: str, actor: str }),
      run: (args) => {
        const card = describeCard(root, strOf(args['id'], 'id'), actorOf(args), args['text'] === undefined ? '' : strOf(args['text'], 'text'));
        return { id: card.id, described: true };
      },
    },
    {
      name: 'card_item',
      description: 'Add an unchecked checklist task to the card (section defaults to "Checklist").',
      inputSchema: schema(['id', 'text'], { id: str, text: str, section: str, actor: str }),
      run: (args) => {
        const card = checklistAddCard(root, strOf(args['id'], 'id'), actorOf(args), strOf(args['text'], 'text'), args['section'] === undefined ? undefined : strOf(args['section'], 'section'));
        return { id: card.id, added: true };
      },
    },
    {
      name: 'card_check',
      description: 'Check or uncheck a checklist item by its 0-based global index (see card_show parsed.checklists).',
      inputSchema: schema(['id', 'index'], { id: str, index: { type: 'integer' }, checked: bool, actor: str }),
      run: (args) => {
        const checked = args['checked'] !== false;
        const card = checkCard(root, strOf(args['id'], 'id'), actorOf(args), Number(args['index']), checked);
        return { id: card.id, index: Number(args['index']), checked };
      },
    },
    {
      name: 'card_attach',
      description: 'Attach a link (or image url: images show in the card gallery and can be cover art).',
      inputSchema: schema(['id', 'url'], { id: str, url: str, label: str, actor: str }),
      run: (args) => {
        const card = attachCard(root, strOf(args['id'], 'id'), actorOf(args), strOf(args['url'], 'url'), opt(args['label']));
        return { id: card.id, attached: strOf(args['url'], 'url') };
      },
    },
    {
      name: 'log_append',
      description: 'Append a line to the card’s append-only Log section: narrate what you did.',
      inputSchema: schema(['id', 'message'], { id: str, message: str, actor: str }),
      run: (args) => {
        const card = addLogEntry(root, strOf(args['id'], 'id'), actorOf(args), strOf(args['message'], 'message'));
        return { id: card.id, logged: true };
      },
    },
  ];
}

export function startMcpServer(root: string, defaultActor: string, input: Readable, output: Writable): void {
  const tools = buildTools(root, defaultActor);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const send = (msg: Json): void => void output.write(JSON.stringify(msg) + '\n');

  // A client that exits before reading a reply breaks the pipe (EPIPE). The
  // mutation already landed by then, so there is nothing to roll back — shut
  // down quietly instead of crashing with an unhandled stream error.
  output.on('error', () => process.exit(0));

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
        // Report the version this server speaks, whatever the client offered
        // (no negotiation: any client version is accepted).
        send({
          jsonrpc: '2.0',
          id,
          result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
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
        const args = params['arguments'] ?? {};
        if (typeof args !== 'object' || args === null || Array.isArray(args)) {
          send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'invalid params: arguments must be an object' } });
          return;
        }
        try {
          const value = tool.run(args as Json);
          const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
        } catch (err) {
          // UsageError is the caller's fault → MCP isError result; anything
          // else is a server fault → JSON-RPC internal error, request id kept.
          if (err instanceof UsageError) {
            send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true } });
          } else {
            const message = err instanceof Error ? err.message : String(err);
            send({ jsonrpc: '2.0', id, error: { code: -32603, message: `internal error: ${message}` } });
          }
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
    if (buffer.length > MAX_BUFFER_BYTES) {
      process.stderr.write(`botflow mcp: message exceeds ${MAX_BUFFER_BYTES} bytes; shutting down\n`);
      process.exit(1);
    }
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl === -1) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === '') continue;
      // Frame-level failure (-32700) stays separate from request handling.
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
        send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
        continue;
      }
      handle(msg as Json);
    }
  });
}
