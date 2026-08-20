// Text and JSON renderings of boards for terminals and agents.

import type { Analysis, BoardAnalysis } from '../core/analyze.ts';
import type { BoardNode, Tree } from '../core/load.ts';
import type { Card, Finding, Lane } from '../core/model.ts';
import { CANONICAL_STATES } from '../core/model.ts';
import { lintBoard } from '../core/analyze.ts';
import { parseBody } from '../core/body.ts';
import { cardFlowMetrics } from '../core/metrics.ts';

export const pct = (p: number | null): string => (p === null ? '·' : `${Math.round(p * 100)}%`);

function cardAnnotations(card: Card, node: BoardNode, ba: BoardAnalysis, readySet: Set<string>, now: number): string {
  const parts: string[] = [];
  const parsed = parseBody(card.body);
  const metrics = cardFlowMetrics(card, node.board, ba.canonical.get(card.id) ?? 'todo', now);
  if (parsed.checklist.total > 0) parts.push(`✓${parsed.checklist.done}/${parsed.checklist.total}`);
  if (parsed.comments.length > 0) parts.push(`🗨${parsed.comments.length}`);
  if (card.type === 'board') {
    const child = node.childKeyByCard.get(card.id);
    parts.push(`⇒ ${child ?? card.boardPath ?? '?'}`);
    parts.push(`[${ba.canonical.get(card.id)}]`);
  }
  if (card.assignee) parts.push(`@${card.assignee}`);
  if (card.delegate) parts.push(`delegate @${card.delegate}`);
  if (card.priority) parts.push(card.priority);
  if (card.estimate !== null) parts.push(`est ${card.estimate}`);
  if (card.due !== null && metrics.due !== null) parts.push(`due ${card.due} (${metrics.due.status})`);
  if (card.labels.length > 0) parts.push(card.labels.map((l) => `#${l}`).join(' '));
  if (card.blocked) parts.push(`⛔ ${card.blocked}`);
  if (card.deps.length > 0) parts.push(`deps→${card.deps.join(',')}`);
  if (metrics.stagnation.dots > 0) parts.push(`${'●'.repeat(metrics.stagnation.dots)} ${metrics.stagnation.days}d in lane`);
  if (metrics.stalled) parts.push(`⚠ stalled ${metrics.idleDays}d`);
  if (readySet.has(card.id)) parts.push('▶ ready');
  return parts.length > 0 ? '  ' + parts.join(' · ') : '';
}

function laneHeader(lane: Lane, count: number, estimate: number): string {
  const wip = lane.wip !== null ? `${count}/${lane.wip}${count > lane.wip ? ' WIP breach!' : ''}` : String(count);
  const sub = lane.substates.length > 0 ? ` [${lane.substates.join(' → ')}${lane.order === 'strict' ? ', strict' : ''}]` : '';
  const canon = lane.canonical === lane.id ? '' : ` (→${lane.canonical})`;
  return `━━ ${lane.name}${canon}${sub} · ${wip}${estimate > 0 ? ` · est ${estimate}` : ''}`;
}

export function renderBoard(tree: Tree, analysis: Analysis): string {
  const node = tree.boards.get('.')!;
  const ba = analysis.boards.get('.')!;
  const readySet = new Set(ba.ready);
  const now = Date.now();
  const lines: string[] = [];
  const findings = lintBoard(node, ba);
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;

  lines.push(`▤ ${node.board.config.name} · ${node.board.cards.length} cards · structural ${pct(ba.progress)}${ba.effort.progress === null ? '' : ` · effort ${pct(ba.effort.progress)}`}`);
  if (errors + warnings > 0) lines.push(`  lint: ${errors} error(s), ${warnings} warning(s), run \`botflow lint\``);
  lines.push('');

  const known = new Set(node.board.config.lanes.map((l) => l.id));
  for (const lane of node.board.config.lanes) {
    const laneCards = node.board.cards.filter((c) => c.laneId === lane.id);
    lines.push(laneHeader(lane, laneCards.length, laneCards.reduce((sum, card) => sum + (card.estimate ?? 0), 0)));
    const emit = (card: Card) => lines.push(`  ${card.id}  ${card.title}${cardAnnotations(card, node, ba, readySet, now)}`);
    if (lane.substates.length > 0) {
      for (const sub of lane.substates) {
        const subCards = laneCards.filter((c) => c.substate === sub || (sub === lane.substates[0] && c.substate === null));
        if (subCards.length === 0) continue;
        lines.push(`   · ${sub}`);
        for (const card of subCards) emit(card);
      }
      for (const card of laneCards.filter((c) => c.substate !== null && !lane.substates.includes(c.substate))) emit(card);
    } else {
      for (const card of laneCards) emit(card);
    }
    lines.push('');
  }
  const orphans = node.board.cards.filter((c) => !known.has(c.laneId));
  if (orphans.length > 0) {
    lines.push('━━ (unknown lane)');
    for (const card of orphans) lines.push(`  ${card.id}  ${card.title}  · lane "${card.laneId}"`);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

export function renderRollup(tree: Tree, analysis: Analysis): string {
  const lines: string[] = [];
  const visit = (key: string, prefix: string): void => {
    const node = tree.boards.get(key)!;
    const ba = analysis.boards.get(key)!;
    const boardCards = node.board.cards.filter((c) => c.type === 'board');
    boardCards.forEach((card, i) => {
      const last = i === boardCards.length - 1;
      const branch = last ? '└─' : '├─';
      const childKey = node.childKeyByCard.get(card.id) ?? null;
      const eff = ba.canonical.get(card.id)!;
      const childBa = childKey !== null ? analysis.boards.get(childKey)! : null;
      const lane = node.board.config.lanes.find((l) => l.id === card.laneId);
      const drift = lane && lane.canonical !== eff ? ` (lane ${lane.id}, drift)` : '';
      lines.push(
        `${prefix}${branch} ${card.id} ${card.title} ⇒ ${childKey ?? `${card.boardPath} (unresolved)`} · ${eff} ${pct(childBa?.progress ?? null)}${drift}`,
      );
      if (childKey !== null) visit(childKey, prefix + (last ? '   ' : '│  '));
    });
  };
  const root = tree.boards.get('.')!;
  const rootBa = analysis.boards.get('.')!;
  lines.push(`${root.board.config.name} · ${pct(rootBa.progress)} · ${distLine(rootBa)}`);
  visit('.', '');
  return lines.join('\n') + '\n';
}

function distLine(ba: BoardAnalysis): string {
  return CANONICAL_STATES.filter((s) => ba.distribution[s] > 0)
    .map((s) => `${s} ${ba.distribution[s]}`)
    .join(' · ');
}

export function renderLint(findings: Finding[]): string {
  if (findings.length === 0) return 'clean, no findings\n';
  const rank = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...findings].sort((a, b) => rank[a.severity] - rank[b.severity] || a.rule.localeCompare(b.rule));
  return sorted.map((f) => `${f.severity.padEnd(7)} ${f.rule.padEnd(20)} ${f.ref.padEnd(12)} ${f.message}`).join('\n') + '\n';
}

export function renderCard(card: Card, node: BoardNode, ba: BoardAnalysis): string {
  const lines: string[] = [];
  const pos = card.substate === null ? card.laneId : `${card.laneId}.${card.substate}`;
  lines.push(`${card.id}  ${card.title}`);
  lines.push(`  lane: ${pos} · state: ${ba.canonical.get(card.id)}${card.type === 'board' ? ` · board ⇒ ${card.boardPath}` : ''}`);
  const meta: string[] = [];
  if (card.assignee) meta.push(`assignee ${card.assignee}`);
  if (card.delegate) meta.push(`delegate ${card.delegate}`);
  if (card.priority) meta.push(card.priority);
  if (card.estimate !== null) meta.push(`estimate ${card.estimate}`);
  if (card.start) meta.push(`start ${card.start}`);
  if (card.due) meta.push(`due ${card.due}`);
  if (card.evergreen) meta.push('evergreen');
  if (card.labels.length > 0) meta.push(`labels ${card.labels.join(',')}`);
  if (card.deps.length > 0) meta.push(`deps ${card.deps.join(',')}`);
  if (card.blocked) meta.push(`BLOCKED: ${card.blocked}`);
  if (card.created) meta.push(`created ${card.created}`);
  if (card.updated) meta.push(`updated ${card.updated}`);
  if (meta.length > 0) lines.push(`  ${meta.join(' · ')}`);
  const metrics = cardFlowMetrics(card, node.board, ba.canonical.get(card.id) ?? 'todo');
  const flow = [
    metrics.currentLaneDays === null ? null : `current lane ${metrics.currentLaneDays}d`,
    metrics.cumulativeLaneDays === null ? null : `cumulative lane ${metrics.cumulativeLaneDays}d`,
    metrics.cycleDays === null ? null : `cycle ${metrics.cycleDays}d`,
    metrics.leadDays === null ? null : `lead ${metrics.leadDays}d`,
    metrics.blockedDays !== null && metrics.blockedDays > 0 ? `blocked ${metrics.blockedDays}d` : null,
    metrics.stalled ? `STALLED ${metrics.idleDays}d` : null,
  ].filter((item): item is string => item !== null);
  if (flow.length > 0) lines.push(`  flow: ${flow.join(' · ')}`);
  lines.push(`  file: ${card.file}`);
  if (card.body.trim() !== '') {
    lines.push('');
    lines.push(card.body.trim());
  }
  return lines.join('\n') + '\n';
}

export function renderPrime(tree: Tree, analysis: Analysis, root: string): string {
  const node = tree.boards.get('.')!;
  const ba = analysis.boards.get('.')!;
  const config = node.board.config;
  const lines: string[] = [];
  lines.push(`# botflow board: ${config.name}`);
  lines.push(`root: ${root}`);
  lines.push('');
  lines.push('## Lanes');
  for (const lane of config.lanes) {
    const bits: string[] = [];
    if (lane.canonical !== lane.id) bits.push(`→ ${lane.canonical}`);
    if (lane.substates.length > 0) bits.push(`substates ${lane.substates.join(' → ')}${lane.order === 'strict' ? ' (strict: one step at a time)' : ''}`);
    if (lane.wip !== null) bits.push(`wip ${lane.wip}`);
    lines.push(`- ${lane.id}${bits.length > 0 ? `  (${bits.join(', ')})` : ''}`);
  }
  lines.push('');
  lines.push(`## State: ${node.board.cards.length} cards · progress ${pct(ba.progress)}`);
  lines.push(`- distribution: ${distLine(ba) || 'empty'}`);
  if (ba.effort.progress !== null) lines.push(`- estimated effort: ${ba.effort.completed}/${ba.effort.total} (${pct(ba.effort.progress)})`);
  const findings = lintBoard(node, ba);
  const errors = findings.filter((f) => f.severity === 'error');
  if (errors.length > 0) lines.push(`- ⚠ ${errors.length} lint error(s): run \`botflow lint\` and fix before other work`);
  lines.push('');
  lines.push('## Ready to claim');
  if (ba.ready.length === 0) lines.push('- (nothing unblocked in todo)');
  for (const id of ba.ready) {
    const card = node.board.cards.find((c) => c.id === id)!;
    lines.push(`- ${id}  ${card.title}${card.priority ? ` (${card.priority})` : ''}`);
  }
  lines.push('');
  lines.push('## Workflow');
  lines.push('1. `botflow ready` → pick a card (respect priority p0 > p3)');
  lines.push('2. `botflow card claim <id> --actor <you>`: claims only ready unassigned cards;');
  lines.push('   a conflict means someone holds it or it is not ready: pick another card');
  lines.push('3. work; narrate with `botflow log <id> "<what happened>"`');
  lines.push('4. advance with `botflow card mv <id> <lane[.substate]>`');
  lines.push('5. stuck? `botflow card block <id> --reason "<why>"`: never park silently');
  lines.push('6. finish with `botflow card close <id> --reason "<summary>"`');
  lines.push('');
  lines.push('Rules: keep moves legal (strict lanes advance one substate), respect wip limits,');
  lines.push('append to `## Log` only, run `botflow lint` after bulk edits. `--json` everywhere.');
  lines.push('Progress is structural: every card is one unit; a sub-board fills its unit by its own fraction.');
  return lines.join('\n') + '\n';
}

export { boardJson, cardJson, rollupJson } from '../core/json.ts';
