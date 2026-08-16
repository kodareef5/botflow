// JSON shapes of boards — shared by the CLI (--json), the local viewer, the
// MCP server, and the hosted manager. Pure: no filesystem, no node-only APIs.

import type { Analysis, BoardAnalysis } from './analyze.ts';
import { lintBoard } from './analyze.ts';
import { parseBody } from './body.ts';
import type { BoardNode, Card, Tree } from './model.ts';

export function cardJson(card: Card, node: BoardNode, ba: BoardAnalysis): Record<string, unknown> {
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
    priority: card.priority,
    deps: card.deps,
    blocked: card.blocked,
    cover: card.cover === 'none' ? null : (card.cover ?? parsed.images[0] ?? null),
    checklist: parsed.checklist.total > 0 ? parsed.checklist : null,
    comments: parsed.comments.length,
    attachments: parsed.attachments.length,
    created: card.created,
    updated: card.updated,
    file: card.file,
  };
}

/** Detail view: cardJson plus the raw body and its structured parse. */
export function cardDetailJson(card: Card, node: BoardNode, ba: BoardAnalysis): Record<string, unknown> {
  return { ...cardJson(card, node, ba), body: card.body, parsed: parseBody(card.body) };
}

export function boardJson(tree: Tree, analysis: Analysis, key = '.'): Record<string, unknown> {
  const node = tree.boards.get(key)!;
  const ba = analysis.boards.get(key)!;
  return {
    name: node.board.config.name,
    key,
    ids: node.board.config.ids,
    cards: node.board.cards.length,
    progress: ba.progress,
    distribution: ba.distribution,
    ready: ba.ready,
    lanes: node.board.config.lanes.map((lane) => ({
      id: lane.id,
      name: lane.name,
      canonical: lane.canonical,
      substates: lane.substates,
      order: lane.order,
      wip: lane.wip,
      cards: node.board.cards.filter((c) => c.laneId === lane.id).map((c) => cardJson(c, node, ba)),
    })),
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
