// Semantic analysis over a loaded board tree: per-card effective canonical
// states (projection §6, rollup §7), distributions, ready sets, progress, and
// the semantic lint findings load-time parsing can't see.

import type { BoardNode, Canonical, Card, Distribution, Finding, Lane, RollupPolicy, Tree } from './model.ts';
import { distributionTotal, emptyDistribution, finding } from './model.ts';

export interface BoardAnalysis {
  /** Effective canonical state per card id (rollup-aware for board-cards). */
  canonical: Map<string, Canonical>;
  distribution: Distribution;
  /** Card ids whose effective state is todo with all deps done/archive, sorted. */
  ready: string[];
  /** Weighted done fraction over countable cards; null when nothing counts. */
  progress: number | null;
  /** Semantic findings; combine with LoadedBoard.findings for the full lint. */
  findings: Finding[];
}

export interface Analysis {
  boards: Map<string, BoardAnalysis>;
}

export function analyze(tree: Tree): Analysis {
  const memo = new Map<string, BoardAnalysis>();

  const analyzeBoard = (key: string): BoardAnalysis => {
    const done = memo.get(key);
    if (done) return done;
    const node = tree.boards.get(key);
    if (!node) throw new Error(`analyze: unknown board key ${key}`);

    const findings: Finding[] = [];
    const laneById = new Map<string, Lane>(node.board.config.lanes.map((l) => [l.id, l]));
    const canonical = new Map<string, Canonical>();
    const childProgress = new Map<string, number | null>();

    // Pass 1: effective canonical state per card.
    for (const card of node.board.cards) {
      const lane = laneById.get(card.laneId);
      let laneCanonical: Canonical = 'todo';
      if (!lane) {
        findings.push(finding('unknown-lane', card.id, `lane "${card.laneId}" is not defined by the board`));
      } else {
        laneCanonical = lane.canonical;
        if (lane.substates.length > 0) {
          if (card.substate === null) {
            findings.push(finding('bare-substate-lane', card.id, `lane "${lane.id}" has substates; treating as "${lane.id}.${lane.substates[0]}"`));
          } else if (!lane.substates.includes(card.substate)) {
            findings.push(finding('bad-substate', card.id, `"${card.substate}" is not a substate of lane "${lane.id}"`));
          }
        } else if (card.substate !== null) {
          findings.push(finding('bad-substate', card.id, `lane "${lane.id}" has no substates`));
        }
      }

      const laneClosed = laneCanonical === 'done' || laneCanonical === 'archive';
      const flagActive = card.blocked !== null && !laneClosed;
      if (card.blocked !== null && laneClosed) {
        findings.push(finding('blocked-in-done', card.id, `blocked flag on a ${laneCanonical} card is inert`));
      }

      if (card.type === 'task') {
        canonical.set(card.id, flagActive ? 'blocked' : laneCanonical);
        continue;
      }

      // Board-card: roll up the child board's distribution (SPEC §7).
      const childKey = node.childKeyByCard.get(card.id) ?? null;
      if (childKey === null) {
        canonical.set(card.id, flagActive ? 'blocked' : laneCanonical);
        childProgress.set(card.id, null);
        continue;
      }
      const child = analyzeBoard(childKey);
      childProgress.set(card.id, child.progress);
      if (flagActive) {
        canonical.set(card.id, 'blocked');
        continue;
      }
      const countable = distributionTotal(child.distribution) - child.distribution.archive;
      const effective =
        countable === 0 ? laneCanonical : rollupState(child.distribution, countable, node.board.config.rollup);
      canonical.set(card.id, effective);
      if (effective !== laneCanonical) {
        findings.push(finding('rollup-drift', card.id, `lane says ${laneCanonical}, child board rolls up to ${effective}`));
      }
    }

    // Distribution.
    const distribution = emptyDistribution();
    for (const card of node.board.cards) distribution[canonical.get(card.id)!]++;

    // WIP breaches (by lane position, not canonical state).
    for (const lane of node.board.config.lanes) {
      if (lane.wip === null) continue;
      const count = node.board.cards.filter((c) => c.laneId === lane.id).length;
      if (count > lane.wip) {
        findings.push(finding('wip-breach', lane.id, `lane "${lane.id}" holds ${count} cards, wip limit is ${lane.wip}`));
      }
    }

    // Pass 2: deps → dangling-dep findings and the ready set.
    const byId = new Map<string, Card>(node.board.cards.map((c) => [c.id, c]));
    const ready: string[] = [];
    for (const card of node.board.cards) {
      let depsSatisfied = true;
      for (const dep of card.deps) {
        if (!byId.has(dep)) {
          findings.push(finding('dangling-dep', card.id, `dep "${dep}" does not exist`));
          depsSatisfied = false;
          continue;
        }
        const depState = canonical.get(dep)!;
        if (depState !== 'done' && depState !== 'archive') depsSatisfied = false;
      }
      if (canonical.get(card.id) === 'todo' && depsSatisfied) ready.push(card.id);
    }
    ready.sort();

    // Weighted progress (SPEC §7).
    let units = 0;
    let doneWeight = 0;
    for (const card of node.board.cards) {
      const state = canonical.get(card.id)!;
      if (state === 'archive') continue;
      units++;
      if (card.type === 'board') {
        const cp = childProgress.get(card.id) ?? null;
        doneWeight += cp !== null ? cp : state === 'done' ? 1 : 0;
      } else if (state === 'done') {
        doneWeight++;
      }
    }
    const progress = units === 0 ? null : doneWeight / units;

    const analysis: BoardAnalysis = { canonical, distribution, ready, progress, findings };
    memo.set(key, analysis);
    return analysis;
  };

  for (const key of tree.boards.keys()) analyzeBoard(key);
  return { boards: memo };
}

/** Derive a board-card's effective state from a child distribution (SPEC §7).
 *  Also used by the hosted manager to aggregate registry-level hierarchy. */
export function rollupState(dist: Distribution, countable: number, policy: RollupPolicy): Canonical {
  if (policy.blockedWhen === 'any-blocked' && dist.blocked > 0) return 'blocked';
  if (dist.done === countable) return 'done';
  const doing = policy.doingWhen === 'any-doing' ? dist.doing > 0 : dist.doing > 0 || (dist.done > 0 && dist.done < countable);
  if (doing) return 'doing';
  if (dist.wishlist === countable) return 'wishlist';
  return policy.elseState;
}

/** Full lint for one board: load-time findings + semantic findings. */
export function lintBoard(node: BoardNode, analysis: BoardAnalysis): Finding[] {
  return [...node.board.findings, ...analysis.findings];
}
