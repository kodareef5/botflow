// JSON shapes of boards: shared by the CLI (--json), the local viewer, the
// MCP server, and the hosted manager. Pure: no filesystem, no node-only APIs.

import type { Analysis, BoardAnalysis } from './analyze.ts';
import { lintBoard } from './analyze.ts';
import { parseBody } from './body.ts';
import type { BoardNode, Card, Tree } from './model.ts';
import { boardFlowMetrics, cardFlowMetrics, FlowProjectionCache } from './metrics.ts';
import { cardCustomFields, labelColor, scopedLabel } from './presentation.ts';
import { textCardReferences } from './refs.ts';
import { collaborationAudience } from './query.ts';

export function cardJson(
  card: Card,
  node: BoardNode,
  ba: BoardAnalysis,
  nowValue: number | Date = Date.now(),
  flowCache: FlowProjectionCache = new FlowProjectionCache(),
  parsedValue?: ReturnType<typeof parseBody>,
): Record<string, unknown> {
  const parsed = parsedValue ?? parseBody(card.body);
  const fields = cardCustomFields(card, node.board.config);
  const checklistPreview = parsed.checklists.flatMap((checklist) => checklist.items
    .filter((item) => !item.checked)
    .map((item) => ({ ...item, section: checklist.section })));
  const storedRelations = card.relations.map((relation) => ({ type: relation.type, target: relation.target, ...relation.extra }));
  const relationshipKeys = new Set(storedRelations.map((relation) => `${relation.type}\u0000${relation.target}`));
  const relationships: Record<string, unknown>[] = storedRelations.map((relation) => ({ ...relation, source: 'stored', active: true }));
  for (const dep of card.deps) {
    const state = ba.dependencyStates.get(card.id)?.get(dep) ?? null;
    const resolved = state === 'done' || state === 'archive';
    relationships.push({ type: resolved ? 'relates' : 'blocks', target: dep, source: resolved ? 'resolved-dependency' : 'dependency', active: !resolved, state });
  }
  const text = [parsed.description ?? '', ...parsed.comments.map((entry) => entry.text)].join('\n');
  for (const target of textCardReferences(text)) {
    const key = `relates\u0000${target}`;
    if (relationshipKeys.has(key)) continue;
    relationshipKeys.add(key);
    relationships.push({ type: 'relates', target, source: 'text', active: true });
  }
  return {
    id: card.id,
    title: card.title,
    lane: card.laneId,
    substate: card.substate,
    position: card.substate === null ? card.laneId : `${card.laneId}.${card.substate}`,
    state: ba.canonical.get(card.id),
    type: card.type,
    board: card.boardPath,
    child: card.type === 'board' ? (node.childKeyByCard.get(card.id) ?? null) : undefined,
    labels: card.labels,
    labelDetails: card.labels.map((id) => {
      const scoped = scopedLabel(id);
      return { id, group: scoped?.group ?? null, value: scoped?.value ?? id, color: labelColor(node.board.config, id) };
    }),
    assignee: card.assignee,
    delegate: card.delegate,
    watchers: card.watchers,
    votes: card.votes,
    voteCount: card.votes.length,
    mentions: parsed.mentions,
    boostCount: parsed.boosts.length,
    audience: collaborationAudience(card, node.board),
    priority: card.priority,
    deps: card.deps,
    relations: storedRelations,
    relationships,
    start: card.start,
    due: card.due,
    reminders: card.reminders,
    repeat: card.repeat === null ? null : { every: card.repeat.every, unit: card.repeat.unit, from: card.repeat.from, ...card.repeat.extra },
    snooze: card.snooze,
    estimate: card.estimate,
    hill: card.hill,
    evergreen: card.evergreen,
    blocked: card.blocked,
    blocker: card.blocker,
    cover: card.cover === 'none' ? null : (card.cover ?? parsed.images[0] ?? null),
    coverColor: card.coverColor,
    // Whether a viewer may supply art of its own. `cover` alone cannot say:
    // it is null both when art is suppressed and when none was found, and a
    // viewer that substituted a picture in the first case would be overriding
    // an explicit `cover: none`.
    coverAuto: card.cover === null,
    checklist: parsed.checklist.total > 0 ? parsed.checklist : null,
    checklistPreview,
    comments: parsed.comments.length,
    attachments: parsed.attachments.length,
    descriptionPresent: parsed.description !== null,
    fields,
    faceFields: fields.filter((field) => field.face),
    // Who made this card, read back off the creation entry opAdd always
    // writes first. Derived, not stored: no frontmatter key, no spec change,
    // and it answers for every card that already exists. The `created` check
    // matters: a log whose first line is a claim or a move belongs to whoever
    // did that, and reporting them as the author would be a plain lie. Null
    // when the card carries no creation entry at all.
    author: /^created\b/.test(parsed.log[0]?.text ?? '') ? (parsed.log[0]?.actor ?? null) : null,
    created: card.created,
    updated: card.updated,
    metrics: cardFlowMetrics(
      card, node.board, ba.canonical.get(card.id) ?? 'todo', nowValue,
      flowCache.get(card, node.board, parsed.log),
    ),
    file: card.file,
  };
}

/** Detail view: cardJson plus the raw body and its structured parse. */
export function cardDetailJson(
  card: Card,
  node: BoardNode,
  ba: BoardAnalysis,
  nowValue: number | Date = Date.now(),
  flowCache: FlowProjectionCache = new FlowProjectionCache(),
): Record<string, unknown> {
  const parsed = parseBody(card.body);
  return { ...cardJson(card, node, ba, nowValue, flowCache, parsed), body: card.body, parsed };
}

export interface BoardJsonOptions {
  /** Board-series metrics are compatibility-defaulted on, but ordinary
   * polling views can omit them and request them only for the metrics tab. */
  includeFlow?: boolean;
  /** Hosted/project detail responses need the structured body in each card. */
  detail?: boolean;
}

export function boardJson(
  tree: Tree,
  analysis: Analysis,
  key = '.',
  nowValue: number | Date = Date.now(),
  options: BoardJsonOptions = {},
): Record<string, unknown> {
  const node = tree.boards.get(key)!;
  const ba = analysis.boards.get(key)!;
  const flowCache = new FlowProjectionCache();
  return {
    name: node.board.config.name,
    key,
    ids: node.board.config.ids,
    features: node.board.config.features,
    labels: node.board.config.labelDefinitions.map(({ id, color }) => ({ id, color })),
    fields: node.board.config.customFields.map(({ id, name, type, options, face }) => ({ id, name, type, options, face })),
    templates: node.board.config.templates.map(({ id, name, lane, labels, priority, assignee, delegate, start, due, estimate, evergreen, coverColor, fields, body }) => ({
      id, name, lane, labels, priority, assignee, delegate, start, due, estimate, evergreen, coverColor, fields, body,
    })),
    filters: node.board.config.savedFilters.map(({ id, name, query }) => ({ id, name, query })),
    subscriptions: node.board.config.subscriptions.map(({ lane, watcher }) => ({ lane, watcher })),
    blockers: node.board.config.blockers.map(({ id, name, color }) => ({ id, name, color })),
    buttons: node.board.config.buttons.map(({ id, name, scope, filter, action, value }) => ({ id, name, scope, filter, action, value })),
    rules: node.board.config.rules.map(({ id, event, lane, filter, action, value }) => ({ id, event, lane, filter, action, value })),
    automation: { archiveDoneAfter: node.board.config.automation.archiveDoneAfter },
    cards: node.board.cards.length,
    progress: ba.progress,
    effort: ba.effort,
    distribution: ba.distribution,
    ready: ba.ready,
    lanes: node.board.config.lanes.map((lane) => ({
      id: lane.id,
      name: lane.name,
      canonical: lane.canonical,
      substates: lane.substates,
      order: lane.order,
      wip: lane.wip,
      wipMode: lane.wipMode,
      subscribers: node.board.config.subscriptions.filter((item) => item.lane === lane.id).map((item) => item.watcher),
      estimate: node.board.cards.filter((c) => c.laneId === lane.id).reduce((sum, card) => sum + (card.estimate ?? 0), 0),
      cards: node.board.cards.filter((c) => c.laneId === lane.id).map((c) => options.detail
        ? cardDetailJson(c, node, ba, nowValue, flowCache)
        : cardJson(c, node, ba, nowValue, flowCache)),
    })),
    flow: options.includeFlow === false ? undefined : boardFlowMetrics(node.board, nowValue, 30, flowCache),
    findings: lintBoard(node, ba),
  };
}

export function rollupJson(tree: Tree, analysis: Analysis, key = '.'): Record<string, unknown> {
  const node = tree.boards.get(key)!;
  const ba = analysis.boards.get(key)!;
  return {
    name: node.board.config.name,
    key,
    progress: ba.progress,
    effort: ba.effort,
    distribution: ba.distribution,
    boards: node.board.cards
      .filter((c) => c.type === 'board')
      .map((c) => {
        const childKey = node.childKeyByCard.get(c.id) ?? null;
        return {
          id: c.id,
          title: c.title,
          state: ba.canonical.get(c.id),
          child: childKey === null ? null : rollupJson(tree, analysis, childKey),
        };
      }),
  };
}
