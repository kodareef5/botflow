// JSON shapes of boards: shared by the CLI (--json), the local viewer, the
// MCP server, and the hosted manager. Pure: no filesystem, no node-only APIs.

import type { Analysis, BoardAnalysis } from './analyze.ts';
import { lintBoard } from './analyze.ts';
import { parseBody } from './body.ts';
import type { BoardNode, Card, Tree } from './model.ts';
import { boardFlowMetrics, cardFlowMetrics } from './metrics.ts';

export function cardJson(card: Card, node: BoardNode, ba: BoardAnalysis, nowValue: number | Date = Date.now()): Record<string, unknown> {
  const parsed = parseBody(card.body);
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
    assignee: card.assignee,
    delegate: card.delegate,
    priority: card.priority,
    deps: card.deps,
    start: card.start,
    due: card.due,
    estimate: card.estimate,
    evergreen: card.evergreen,
    blocked: card.blocked,
    cover: card.cover === 'none' ? null : (card.cover ?? parsed.images[0] ?? null),
    // Whether a viewer may supply art of its own. `cover` alone cannot say:
    // it is null both when art is suppressed and when none was found, and a
    // viewer that substituted a picture in the first case would be overriding
    // an explicit `cover: none`.
    coverAuto: card.cover === null,
    checklist: parsed.checklist.total > 0 ? parsed.checklist : null,
    comments: parsed.comments.length,
    attachments: parsed.attachments.length,
    // Who made this card, read back off the creation entry opAdd always
    // writes first. Derived, not stored: no frontmatter key, no spec change,
    // and it answers for every card that already exists. The `created` check
    // matters: a log whose first line is a claim or a move belongs to whoever
    // did that, and reporting them as the author would be a plain lie. Null
    // when the card carries no creation entry at all.
    author: /^created\b/.test(parsed.log[0]?.text ?? '') ? (parsed.log[0]?.actor ?? null) : null,
    created: card.created,
    updated: card.updated,
    metrics: cardFlowMetrics(card, node.board, ba.canonical.get(card.id) ?? 'todo', nowValue),
    file: card.file,
  };
}

/** Detail view: cardJson plus the raw body and its structured parse. */
export function cardDetailJson(card: Card, node: BoardNode, ba: BoardAnalysis, nowValue: number | Date = Date.now()): Record<string, unknown> {
  return { ...cardJson(card, node, ba, nowValue), body: card.body, parsed: parseBody(card.body) };
}

export function boardJson(tree: Tree, analysis: Analysis, key = '.', nowValue: number | Date = Date.now()): Record<string, unknown> {
  const node = tree.boards.get(key)!;
  const ba = analysis.boards.get(key)!;
  return {
    name: node.board.config.name,
    key,
    ids: node.board.config.ids,
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
      estimate: node.board.cards.filter((c) => c.laneId === lane.id).reduce((sum, card) => sum + (card.estimate ?? 0), 0),
      cards: node.board.cards.filter((c) => c.laneId === lane.id).map((c) => cardJson(c, node, ba, nowValue)),
    })),
    flow: boardFlowMetrics(node.board, nowValue),
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
