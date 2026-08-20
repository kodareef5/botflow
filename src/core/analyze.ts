// Semantic analysis: per-card effective canonical states (projection §6,
// rollup §7), distributions, ready sets, progress, and the semantic lint
// findings load-time parsing can't see.
//
// The per-board core (analyzeBoard) takes a child-resolver, so the same rules
// run over a filesystem tree (analyze), a lone board (analyzeSingle), or a
// hosted board whose children are sibling Durable Objects injecting their
// distributions (analyzeSingle with a children map).

import type { BoardNode, Canonical, Card, Distribution, Finding, Lane, LoadedBoard, RollupPolicy, Tree } from './model.ts';
import { distributionTotal, emptyDistribution, finding } from './model.ts';
import { parseBody } from './body.ts';
import { parseCardReference, resolveTreeCardReference } from './refs.ts';
import { isSnoozed } from './scheduling.ts';

export interface BoardAnalysis {
  /** Effective canonical state per card id (rollup-aware for board-cards). */
  canonical: Map<string, Canonical>;
  distribution: Distribution;
  /** Task-card ids whose effective state is todo with all deps done/archive,
   *  sorted. Board-cards are containers, never claimable work, never listed. */
  ready: string[];
  /** Weighted done fraction over countable cards; null when nothing counts. */
  progress: number | null;
  /** Optional estimate-weighted projection; never replaces structural progress. */
  effort: { total: number; completed: number; progress: number | null };
  /** Resolved effective state for each dependency ref; null is dangling. */
  dependencyStates: Map<string, Map<string, Canonical | null>>;
  /** Card ids that participate in a local or resolved cross-board dependency cycle. */
  cycleMembers: Set<string>;
  /** Semantic findings; combine with LoadedBoard.findings for the full lint. */
  findings: Finding[];
}

export interface Analysis {
  boards: Map<string, BoardAnalysis>;
}

/** What a resolved child board contributes to its parent's rollup. */
export interface ExternalChild {
  distribution: Distribution;
  progress: number | null;
}

type ChildLookup = (card: Card) => ExternalChild | null;
export interface ExternalReference { state: Canonical }
type ReferenceLookup = (reference: string) => ExternalReference | null;

/** Analyze one board given a resolver for its board-cards' children.
 *  A null resolution = unresolved (missing path, cycle, hosted ref):
 *  the card falls back to its own lane and no drift is reported. */
export function analyzeBoard(
  board: LoadedBoard,
  lookup: ChildLookup,
  referenceLookup?: ReferenceLookup,
  nowValue: number | Date = Date.now(),
): BoardAnalysis {
  const findings: Finding[] = [];
  const laneById = new Map<string, Lane>(board.config.lanes.map((l) => [l.id, l]));
  const canonical = new Map<string, Canonical>();
  const childProgress = new Map<string, number | null>();

  // Pass 1: effective canonical state per card.
  for (const card of board.cards) {
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
    if (card.blocker !== null && !board.config.blockers.some((blocker) => blocker.id === card.blocker)) {
      findings.push(finding('unknown-blocker', card.id, `blocker "${card.blocker}" is not defined by the board`));
    }

    if (card.type === 'task') {
      canonical.set(card.id, flagActive ? 'blocked' : laneCanonical);
    } else {
      // Board-card: roll up the child board's distribution (SPEC §7).
      const child = lookup(card);
      if (child === null) {
        canonical.set(card.id, flagActive ? 'blocked' : laneCanonical);
        childProgress.set(card.id, null);
      } else {
        childProgress.set(card.id, child.progress);
        if (flagActive) {
          canonical.set(card.id, 'blocked');
        } else {
          const countable = distributionTotal(child.distribution) - child.distribution.archive;
          const effective =
            countable === 0 ? laneCanonical : rollupState(child.distribution, countable, board.config.rollup);
          canonical.set(card.id, effective);
          if (effective !== laneCanonical) {
            findings.push(finding('rollup-drift', card.id, `lane says ${laneCanonical}, child board rolls up to ${effective}`));
          }
        }
      }
    }
    for (const boost of parseBody(card.body).boosts) {
      if (boost.text.trim() === '' || Array.from(boost.text).length > 12) {
        findings.push(finding('boost-value', card.id, 'boost text must be 1–12 Unicode characters'));
      }
    }
  }

  // Distribution.
  const distribution = emptyDistribution();
  for (const card of board.cards) distribution[canonical.get(card.id)!]++;

  // WIP breaches (by lane position, not canonical state).
  for (const lane of board.config.lanes) {
    if (lane.wip === null) continue;
    const count = board.cards.filter((c) => c.laneId === lane.id).length;
    if (count > lane.wip) {
      findings.push(finding('wip-breach', lane.id, `lane "${lane.id}" holds ${count} cards, wip limit is ${lane.wip}`));
    }
  }

  // Pass 2: deps → dangling-dep findings and the ready set.
  const byId = new Map<string, Card>(board.cards.map((c) => [c.id, c]));
  const ready: string[] = [];
  const dependencyStates = new Map<string, Map<string, Canonical | null>>();
  for (const card of board.cards) {
    let depsSatisfied = true;
    const states = new Map<string, Canonical | null>();
    dependencyStates.set(card.id, states);
    for (const dep of card.deps) {
      const parsed = parseCardReference(dep)!;
      const local = parsed.boardRef === null ? byId.get(parsed.cardId) : undefined;
      const external = parsed.boardRef === null ? null : (referenceLookup?.(dep) ?? null);
      if (local === undefined && external === null) {
        states.set(dep, null);
        findings.push(finding('dangling-dep', card.id, `dep "${dep}" does not exist`));
        depsSatisfied = false;
        continue;
      }
      const depState = local === undefined ? external!.state : canonical.get(local.id)!;
      states.set(dep, depState);
      if (depState !== 'done' && depState !== 'archive') depsSatisfied = false;
    }
    // Only task cards are claimable work: a board-card is a container whose
    // state is a rollup view, so it never sits in the work queue (SPEC §5).
    if (card.type === 'task' && canonical.get(card.id) === 'todo' && depsSatisfied && !isSnoozed(card, nowValue)) ready.push(card.id);
  }
  ready.sort();

  for (const card of board.cards) {
    for (const relation of card.relations) {
      const parsed = parseCardReference(relation.target)!;
      if (parsed.boardRef === null) {
        if (!byId.has(parsed.cardId)) findings.push(finding('dangling-relation', card.id, `relation target "${relation.target}" does not exist`));
      } else if ((referenceLookup?.(relation.target) ?? null) === null) {
        findings.push(finding('dangling-relation', card.id, `relation target "${relation.target}" does not exist`));
      }
    }
  }

  // Pass 3: dependency cycles (SPEC §10). A dep cycle makes every member
  // permanently non-ready with no visible reason: that is an error, not a
  // curiosity. Each cycle is reported once, on one member, listing the loop.
  // Iterative DFS: a recursive walk overflows the call stack on dep chains
  // of tens of thousands of cards.
  const color = new Map<string, 1 | 2>(); // 1 = in current path, 2 = done
  const path: string[] = [];
  const seenCycles = new Set<string>();
  const cycleMembers = new Set<string>();
  const reportCycle = (dep: string): void => {
    const cycle = path.slice(path.indexOf(dep));
    for (const member of cycle) cycleMembers.add(member);
    const key = [...cycle].sort().join('>');
    if (!seenCycles.has(key)) {
      seenCycles.add(key);
      findings.push(finding('dep-cycle', cycle[0]!, `dependency cycle: ${[...cycle, dep].join(' → ')}`));
    }
  };
  const stack: { id: string; deps: string[]; next: number }[] = [];
  const push = (id: string): void => {
    color.set(id, 1);
    path.push(id);
    stack.push({ id, deps: byId.get(id)!.deps, next: 0 });
  };
  for (const card of board.cards) {
    if (color.has(card.id)) continue;
    push(card.id);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      let descend: string | null = null;
      while (frame.next < frame.deps.length) {
        const dep = frame.deps[frame.next++]!;
        const parsed = parseCardReference(dep)!;
        if (parsed.boardRef !== null || !byId.has(parsed.cardId)) continue; // external/global or dangling
        const state = color.get(parsed.cardId);
        if (state === undefined) {
          descend = parsed.cardId;
          break;
        }
        if (state === 1) reportCycle(parsed.cardId);
      }
      if (descend !== null) {
        push(descend);
      } else {
        stack.pop();
        path.pop();
        color.set(frame.id, 2);
      }
    }
  }

  // Weighted progress (SPEC §7).
  let units = 0;
  let doneWeight = 0;
  let estimateTotal = 0;
  let estimateDone = 0;
  for (const card of board.cards) {
    const state = canonical.get(card.id)!;
    if (state === 'archive') continue;
    units++;
    let fraction = 0;
    if (card.type === 'board') {
      const cp = childProgress.get(card.id) ?? null;
      fraction = cp !== null ? cp : state === 'done' ? 1 : 0;
      doneWeight += fraction;
    } else if (state === 'done') {
      fraction = 1;
      doneWeight++;
    }
    if (card.estimate !== null) {
      estimateTotal += card.estimate;
      estimateDone += card.estimate * fraction;
    }
  }
  const progress = units === 0 ? null : doneWeight / units;
  const effort = {
    total: estimateTotal,
    completed: estimateDone,
    progress: estimateTotal === 0 ? null : estimateDone / estimateTotal,
  };

  return { canonical, distribution, ready: ready.filter((id) => !cycleMembers.has(id)), progress, effort, dependencyStates, cycleMembers, findings };
}

export function analyze(tree: Tree, nowValue: number | Date = Date.now()): Analysis {
  const memo = new Map<string, BoardAnalysis>();
  const stateMemo = new Map<string, Canonical>();

  const effectiveState = (key: string, card: Card): Canonical => {
    const memoKey = `${key}\u0000${card.id}`;
    const known = stateMemo.get(memoKey);
    if (known !== undefined) return known;
    const node = tree.boards.get(key)!;
    const laneCanonical = node.board.config.lanes.find((lane) => lane.id === card.laneId)?.canonical ?? 'todo';
    const flagged = card.blocked !== null && laneCanonical !== 'done' && laneCanonical !== 'archive';
    if (flagged || card.type === 'task') {
      const state = flagged ? 'blocked' : laneCanonical;
      stateMemo.set(memoKey, state);
      return state;
    }
    const childKey = node.childKeyByCard.get(card.id) ?? null;
    if (childKey === null) {
      stateMemo.set(memoKey, laneCanonical);
      return laneCanonical;
    }
    const child = tree.boards.get(childKey)!;
    const distribution = emptyDistribution();
    for (const childCard of child.board.cards) distribution[effectiveState(childKey, childCard)]++;
    const countable = distributionTotal(distribution) - distribution.archive;
    const state = countable === 0 ? laneCanonical : rollupState(distribution, countable, node.board.config.rollup);
    stateMemo.set(memoKey, state);
    return state;
  };

  const analyzeNode = (key: string): BoardAnalysis => {
    const done = memo.get(key);
    if (done) return done;
    const node = tree.boards.get(key);
    if (!node) throw new Error(`analyze: unknown board key ${key}`);
    const analysis = analyzeBoard(node.board, (card) => {
      const childKey = node.childKeyByCard.get(card.id) ?? null;
      if (childKey === null) return null;
      const child = analyzeNode(childKey);
      return { distribution: child.distribution, progress: child.progress };
    }, (reference) => {
      const target = resolveTreeCardReference(tree, key, reference);
      return target === null ? null : { state: effectiveState(target.key, target.card) };
    }, nowValue);
    memo.set(key, analysis);
    return analysis;
  };

  for (const key of tree.boards.keys()) analyzeNode(key);
  reportCrossBoardDependencyCycles(tree, memo);
  return { boards: memo };
}

/** Analyze a lone board, optionally injecting resolved children by card id
 *  (how hosted project boards roll up sibling projects). */
export function analyzeSingle(
  board: LoadedBoard,
  children?: Map<string, ExternalChild | null>,
  references?: Map<string, ExternalReference | null>,
  nowValue: number | Date = Date.now(),
): BoardAnalysis {
  return analyzeBoard(board, (card) => children?.get(card.id) ?? null, (reference) => references?.get(reference) ?? null, nowValue);
}

function reportCrossBoardDependencyCycles(tree: Tree, analyses: Map<string, BoardAnalysis>): void {
  const graph = new Map<string, string[]>();
  const nodeKey = (board: string, card: string): string => `${board}\u0000${card}`;
  for (const [key, node] of tree.boards) {
    for (const card of node.board.cards) {
      const edges: string[] = [];
      for (const dep of card.deps) {
        const target = resolveTreeCardReference(tree, key, dep);
        if (target !== null) edges.push(nodeKey(target.key, target.card.id));
      }
      graph.set(nodeKey(key, card.id), edges);
    }
  }
  const color = new Map<string, 1 | 2>();
  const path: string[] = [];
  const reported = new Set<string>();
  const stack: { id: string; edges: string[]; next: number }[] = [];
  const display = (id: string): string => {
    const [board, card] = id.split('\u0000');
    return board === '.' ? card! : `${board}#${card}`;
  };
  const push = (id: string): void => {
    color.set(id, 1); path.push(id); stack.push({ id, edges: graph.get(id) ?? [], next: 0 });
  };
  for (const id of graph.keys()) {
    if (color.has(id)) continue;
    push(id);
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      let descend: string | null = null;
      while (frame.next < frame.edges.length) {
        const edge = frame.edges[frame.next++]!;
        const state = color.get(edge);
        if (state === undefined) { descend = edge; break; }
        if (state !== 1) continue;
        const cycle = path.slice(path.indexOf(edge));
        const boards = new Set(cycle.map((member) => member.split('\u0000')[0]));
        if (boards.size < 2) continue; // analyzeBoard already reported local cycles
        const key = [...cycle].sort().join('>');
        if (reported.has(key)) continue;
        reported.add(key);
        for (const member of cycle) {
          const [memberBoard, memberCard] = member.split('\u0000');
          const memberAnalysis = analyses.get(memberBoard!);
          if (memberAnalysis !== undefined) {
            memberAnalysis.cycleMembers.add(memberCard!);
            memberAnalysis.ready = memberAnalysis.ready.filter((candidate) => candidate !== memberCard);
          }
        }
        const [sourceBoard, sourceCard] = cycle[0]!.split('\u0000');
        analyses.get(sourceBoard!)!.findings.push(finding('dep-cycle', sourceCard!, `dependency cycle: ${[...cycle, edge].map(display).join(' → ')}`));
      }
      if (descend !== null) push(descend);
      else { stack.pop(); path.pop(); color.set(frame.id, 2); }
    }
  }
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
