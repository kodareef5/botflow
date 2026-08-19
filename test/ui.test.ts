// Manager UI invariants. The page ships as one inline script, so these tests
// (1) syntax-check the exact JS the browser will run, (2) smoke-check the
// accessibility and keyboard wiring, and (3) extract the DOM-morphing
// reconciler and exercise it against a minimal DOM: node identity must
// survive polls or scroll/focus die with it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { uiHtml } from '../worker/src/ui.ts';

const page = uiHtml(null);
const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);

test('ui: every inline script parses as real JavaScript', () => {
  assert.ok(scripts.length >= 2);
  for (const src of scripts) {
    // Throws SyntaxError on bad JS; the page must never ship one.
    new Function(src.replace(/^window\.__THEMES__=/, 'var __t=')); // eslint-disable-line no-new-func
  }
});

test('ui: keyboard and aria wiring is present', () => {
  for (const needle of [
    'tabindex="0" role="button" aria-label=',            // cards + project rows focusable
    'role="dialog" aria-modal="true" tabindex="-1"',      // dialogs are dialogs
    'role="tablist"',
    'aria-selected=',
    'role="checkbox" aria-checked=',
    'data-addcard=',                                     // create a card from a lane footer
    'aria-label="add a card to ',                        // and it says which lane
    'autocomplete="current-password"',                   // login is a real credential form
    'type="password"',
    'onkeydown=boardKeys',
    "e.key==='ArrowDown'",
    '_restoreFocus',
    ".card:focus-visible",
  ]) {
    assert.ok(page.includes(needle), `page is missing: ${needle}`);
  }
});

test('ui: company activity is fetched in cursor-paginated pages', () => {
  const app = scripts.join('\n');
  assert.match(app, /const AUDIT_PAGE_SIZE=25/);
  assert.match(app, /\/api\/org\/activity\?limit='\+\(AUDIT_PAGE_SIZE\+1\)\+cursor/,
    'the browser fetches only one page plus a has-more sentinel');
  assert.match(app, /'&before='\+encodeURIComponent\(before\)/, 'older pages use the server cursor');
  assert.match(app, /items:list\.slice\(0,AUDIT_PAGE_SIZE\)/, 'the sentinel row is not rendered');
  assert.match(app, /data-audit-prev/);
  assert.match(app, /data-audit-next/);
  assert.doesNotMatch(app, /\/api\/org\/activity\?limit=50/, 'settings no longer loads its activity history in one batch');
});

// ---- a minimal DOM for the reconciler ----
type Attr = { name: string; value: string };
class MiniNode {
  nodeType: number;
  tagName: string;
  data: string;
  attributes: Attr[] = [];
  childNodes: MiniNode[] = [];
  parent: MiniNode | null = null;
  constructor(kind: string | null, text?: string) {
    if (kind === null) {
      this.nodeType = 3;
      this.tagName = '';
      this.data = text ?? '';
    } else {
      this.nodeType = 1;
      this.tagName = kind.toUpperCase();
      this.data = '';
    }
  }
  get id(): string {
    return this.getAttribute('id') ?? '';
  }
  get dataset(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const a of this.attributes) {
      if (a.name.startsWith('data-')) out[a.name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = a.value;
    }
    return out;
  }
  getAttribute(n: string): string | null {
    return this.attributes.find((a) => a.name === n)?.value ?? null;
  }
  setAttribute(n: string, v: string): void {
    const a = this.attributes.find((x) => x.name === n);
    if (a) a.value = v;
    else this.attributes.push({ name: n, value: v });
  }
  removeAttribute(n: string): void {
    this.attributes = this.attributes.filter((a) => a.name !== n);
  }
  hasAttribute(n: string): boolean {
    return this.attributes.some((a) => a.name === n);
  }
  insertBefore(node: MiniNode, ref: MiniNode | null): MiniNode {
    if (node.parent) node.parent.childNodes = node.parent.childNodes.filter((c) => c !== node);
    node.parent = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i === -1) this.childNodes.push(node);
    else this.childNodes.splice(i, 0, node);
    return node;
  }
  appendChild(node: MiniNode): MiniNode {
    return this.insertBefore(node, null);
  }
  removeChild(node: MiniNode): MiniNode {
    this.childNodes = this.childNodes.filter((c) => c !== node);
    node.parent = null;
    return node;
  }
  get lastChild(): MiniNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  cloneNode(deep: boolean): MiniNode {
    const c = this.nodeType === 3 ? new MiniNode(null, this.data) : new MiniNode(this.tagName);
    c.attributes = this.attributes.map((a) => ({ ...a }));
    if (deep) for (const k of this.childNodes) c.appendChild(k.cloneNode(true));
    return c;
  }
  get outerHTML(): string {
    if (this.nodeType === 3) return this.data;
    const at = [...this.attributes].sort((a, b) => a.name.localeCompare(b.name)).map((a) => ` ${a.name}="${a.value}"`).join('');
    return `<${this.tagName}${at}>${this.childNodes.map((c) => c.outerHTML).join('')}</${this.tagName}>`;
  }
}

function el(tag: string, attrs: Record<string, string>, ...kids: (MiniNode | string)[]): MiniNode {
  const n = new MiniNode(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const k of kids) n.appendChild(typeof k === 'string' ? new MiniNode(null, k) : k);
  return n;
}

function loadMorph(): { morphChildren: (a: MiniNode, b: MiniNode) => void } {
  const js = scripts[1]!;
  const start = js.indexOf('function nodeKey');
  const end = js.indexOf('function patchView');
  assert.ok(start !== -1 && end > start, 'morph block found in page JS');
  const ctx: Record<string, unknown> = {};
  runInNewContext(`${js.slice(start, end)}; exports={nodeKey,morphChildren,morphNode}`, ctx);
  return (ctx as { exports: { morphChildren: (a: MiniNode, b: MiniNode) => void } }).exports;
}

function renderCols(readOnly = false): string {
  const js = scripts[1]!;
  const start = js.indexOf('function colsHtml');
  const end = js.indexOf('/** A lost claim', start);
  assert.ok(start !== -1 && end > start, 'column renderer found in page JS');
  const ctx: Record<string, unknown> = {
    RO: readOnly,
    esc: (s: unknown) => String(s),
    cardHtml: () => '<article data-card="001"></article>',
    board: {
      lanes: [{ id: 'todo', name: 'To do', cards: [{ id: '001' }], substates: [], wip: null }],
    },
  };
  runInNewContext(`${js.slice(start, end)}; result=colsHtml(board)`, ctx);
  return String(ctx['result']);
}

function loadMemberHelpers(): {
  scopeLabel: (member: Record<string, unknown>) => string;
  memberFields: (member: Record<string, unknown> | null) => string;
  memberRow: (member: Record<string, unknown>) => string;
} {
  const js = scripts[1]!;
  const start = js.indexOf('function scopeLabel');
  const end = js.indexOf('function provisionBotKey', start);
  assert.ok(start !== -1 && end > start, 'member rendering helpers found in page JS');
  const project = { id: 'p-build', name: 'Build', children: [] };
  const ctx: Record<string, unknown> = {
    ORG: { spaces: [{ id: 's-ops', name: 'Operations', projects: [project] }] },
    ME: { username: 'owner' },
    findAny: (id: string) => id === project.id ? project : null,
    esc: (s: unknown) => String(s ?? ''),
  };
  runInNewContext(`${js.slice(start, end)}; exports={scopeLabel,memberFields,memberRow}`, ctx);
  return ctx['exports'] as {
    scopeLabel: (member: Record<string, unknown>) => string;
    memberFields: (member: Record<string, unknown> | null) => string;
    memberRow: (member: Record<string, unknown>) => string;
  };
}

test('ui: identity, role flags and the name directory refresh together', () => {
  const app = scripts.join('\n');
  // A rename is only visible because the UI resolves usernames through the
  // directory at render time, so every path that reloads the org has to
  // rebuild it. Reassigning ORG alone leaves renamed members showing their
  // old name until a full page load.
  assert.match(app, /function adoptOrg\(org\)\{/, 'org adoption lives in one place');
  for (const derived of ['ME=', 'CAN_WRITE=', 'IS_OWNER=', 'RO=', 'DIR=']) {
    assert.ok(app.slice(app.indexOf('function adoptOrg(')).slice(0, 400).includes(derived),
      `adoptOrg refreshes ${derived}`);
  }
  assert.match(app, /async function reloadOrg\(\)\{adoptOrg\(await api\('\/api\/org'\)\)/, 'reloadOrg goes through it');
  assert.ok(!/\bORG=await api\('\/api\/org'\)/.test(app), 'nothing assigns ORG behind adoptOrg\'s back');

  // Creating a member must not default to the most powerful role.
  const roles = /\[([^\]]*'owner'[^\]]*)\]\.map\(r=>'<option value="'\+r/.exec(app);
  assert.ok(roles, 'the role select is built from a list');
  assert.ok(!roles[1]!.trimStart().startsWith("'owner'"), 'owner is not the default-selected first option');
});

test('ui: a card can be moved, claimed, closed and blocked from the board', () => {
  const app = scripts.join('\n');
  // Every verb the API exposes has a way in from the browser.
  for (const hook of ['data-claim', 'data-close', 'data-block', 'data-unblock', 'data-addcard'])
    assert.ok(app.includes(hook), `${hook} is wired`);

  // Drag is pointer-based, so one code path serves mouse, pen and touch. Touch
  // needs the hold, or every column scroll would start a drag instead.
  assert.match(app, /onpointerdown=boardPointerDown/);
  assert.match(app, /HOLD_MS/, 'touch presses must be held before they lift a card');
  assert.match(app, /setPointerCapture/);
  assert.match(app, /dragghost/);

  // A drop must not also open the card: pointerup still produces a click.
  assert.match(app, /DRAG_ENDED/, 'the click after a drop is suppressed');
  assert.match(app, /function boardClicks\(e\)\{\s*if\(Date\.now\(\)-DRAG_ENDED/);

  // The poll must not reconcile a card out from under the pointer mid-drag.
  assert.match(app, /!MODAL&&!DRAG&&!PRESS/, 'polling pauses while a card is in the air');

  // Legality is computed from the lane rules before the drop, not discovered
  // afterwards from a failed request.
  assert.match(app, /function dropRules\(/);
  assert.match(app, /order==='strict'/);
});

test('ui: each writable lane ends with an add-card footer', () => {
  const html = renderCols();
  const headingEnd = html.indexOf('</h3>');
  const deckEnd = html.indexOf('</div>', html.indexOf('class="deck"'));
  const footer = html.indexOf('<footer class="lanefoot">');
  assert.ok(headingEnd !== -1 && footer > deckEnd, 'the add action follows the deck instead of floating in the heading');
  assert.ok(!html.slice(0, headingEnd).includes('data-addcard'), 'the lane heading has no add-card control');
  assert.match(html, /<button type="button" class="laneadd" data-addcard="todo"/);
  assert.match(html, />\+ add card<\/button><\/footer>/);
  assert.ok(!renderCols(true).includes('lanefoot'), 'read-only boards do not advertise a write action');

  // Hover is an enhancement: keyboard focus reveals the same stable footer,
  // and devices without hover keep it discoverable.
  assert.match(page, /\.col:hover \.lanefoot,\.col:focus-within \.lanefoot/);
  assert.match(page, /@media \(hover:none\)\{\.lanefoot\{/);
  assert.doesNotMatch(page, /\.lanefoot\{[^}]*display:none/);
});

test('ui: a link preview can become cover art without overriding cover: none', () => {
  const app = scripts.join('\n');
  // cover is null both when art is suppressed and when there simply is none,
  // so the decision cannot be made from cover alone.
  assert.match(app, /function coverOf\(c\)\{/);
  assert.match(app, /if\(!c\.coverAuto\)return null/, 'cover: none outranks a preview');
  assert.match(app, /if\(c\.cover\)return c\.cover/, 'an explicit cover still wins');
  // Card face and modal both go through it, so they cannot disagree.
  assert.match(app, /coverOf\(c\)\)\)/);
  // A preview tile stands for its link, so it opens the page, not the picture.
  assert.match(app, /\{img:v\.image,href:v\.url,kind:'link'\}/);
  assert.match(app, /data-cover="'\+esc\(t\.img\)/, 'and can still be pinned as the cover');
});

test('ui: setup asks only for what the deployment needs', () => {
  const app = scripts.join('\n');
  // The setup key exists to stop a stranger claiming a public deployment
  // first. Where it would be ignored, the field is not rendered at all.
  assert.match(app, /cfg\.needsKey\?'<input id="skey"/);
  assert.match(app, /cfg\.locked/, 'a public deployment with no secret says so instead of offering a dead form');
  // Company name is optional at setup because it is renameable afterwards.
  assert.match(app, /company name \(optional, you can change it later\)/);
  assert.match(app, /id="orgsave"/);
  // And the header reflects a rename without a reload.
  assert.match(app, /const name=\$\('#horg'\);if\(name\)name\.textContent=ORG\.name/);
});

test('ui: ordinary settings clicks cannot masquerade as theme choices', () => {
  const app = scripts.join('\n');
  const start = app.indexOf("main.querySelector('.settings').onclick");
  const handler = app.slice(start, app.indexOf('\n  };', start));
  assert.ok(start !== -1, 'settings click delegation is present');
  // <html> carries both data-style and data-density so the active theme can
  // drive CSS. closest() may walk out of settings and find either attribute,
  // turning an ordinary click into a save + full settings render. Every
  // delegated lookup must therefore be bounded by the panel.
  assert.match(handler, /const panel=e\.currentTarget/);
  assert.match(handler, /panel\.contains\(node\)/,
    'delegated matches outside settings are rejected');
  for (const selector of [
    "'.stile[data-style]'",
    "'[data-accent]'",
    "'[data-mode]'",
    "'[data-density]'",
  ]) assert.ok(handler.includes(`within(${selector})`), `${selector} is panel-bounded`);
  assert.doesNotMatch(handler, /const (?:tile|pill|mode|density)=e\.target\.closest/,
    'theme control lookup cannot bypass the panel boundary');
});

test('ui: the member directory consumes the flat identity scope contract', () => {
  const { scopeLabel, memberFields, memberRow } = loadMemberHelpers();
  assert.equal(scopeLabel({ scopeKind: 'org', scopeId: null }), 'whole company');
  assert.equal(scopeLabel({ scopeKind: 'space', scopeId: 's-ops' }), 'space: Operations');
  assert.equal(scopeLabel({ scopeKind: 'project', scopeId: 'p-build' }), 'project: Build');
  const fields = memberFields({ display: 'Builder', role: 'write', scopeKind: 'project', scopeId: 'p-build' });
  assert.match(fields, /value="project:p-build" selected/,
    'editing a member selects the scope returned by /api/members');

  const common = { display: 'Agent', username: 'agent', role: 'write', scopeKind: 'project', scopeId: 'p-build', keys: 0, disabled: false };
  const bot = memberRow({ ...common, memberId: 'm-bot', kind: 'bot' });
  const human = memberRow({ ...common, memberId: 'm-human', kind: 'human' });
  assert.match(bot, /data-keym="m-bot"/, 'owners get an explicit key action for bots');
  assert.match(bot, /aria-label="create API key for agent"/);
  assert.doesNotMatch(human, /data-keym=/, 'human accounts keep key creation in their own account panel');

  const app = scripts.join('\n');
  assert.match(app, /api\('\/api\/keys\?member='\+encodeURIComponent\(m\.memberId\),\{method:'POST'/,
    'the bot key flow provisions the selected member, not the logged-in owner');
  assert.match(app, /The bot does not need to log in/);
  assert.match(app, /Copy this key now\. It is never shown again/);
});

test('ui: a card can be moved without a pointer', () => {
  const app = scripts.join('\n');
  // Shift+Arrow rather than a grab mode: Enter and Space are already spent on
  // opening a card, and a modeless binding needs no way to escape from it.
  assert.match(app, /e\.shiftKey&&e\.key\.startsWith\('Arrow'\)/);
  assert.match(app, /async function keyboardMove\(el,dir\)/);
  // Plain arrows must keep navigating: the move binding has to come first and
  // return, or focus movement and card movement would fight.
  const keys = app.slice(app.indexOf('function boardKeys(e)'));
  assert.ok(keys.indexOf('shiftKey') < keys.indexOf("e.key==='Enter'"), 'shift is handled before the open binding');
  // Focus has to survive the move or a run of moves strands the keyboard.
  assert.match(app, /if\(again\)again\.focus\(\)/);
  assert.match(app, /await refreshBoard\(\)\}\}/, 'reloadOrg awaits the re-render focus depends on');
  // Announced, not silent: toast carries role=status.
  assert.match(app, /toast\(id\+' moved to '\+to\)/);
  assert.match(app, /role','status'/);
  // Discoverable by assistive tech without adding visual noise.
  assert.match(app, /aria-keyshortcuts="Shift\+ArrowLeft/);
  // The same legality rules the drag uses, so the two paths cannot disagree.
  assert.match(app, /dropRules\(BOARD,c\)\.get/);
});

test('ui: a lost claim explains itself, and only owners may override', () => {
  const app = scripts.join('\n');
  assert.match(app, /function conflictHtml\(/);
  // Every conflict the coordination model can produce is spelled out.
  for (const reason of ['assigned', 'blocked', 'deps', 'not-ready'])
    assert.ok(app.includes(`'${reason}'`), `${reason} conflicts are explained`);
  // The holder is rendered through the directory, so a member reads as their
  // display name rather than the raw username stored on the card.
  assert.match(app, /who\(conflict\.holder\)/);
  // force is the owner's override in both places it can be reached.
  assert.match(app, /IS_OWNER\?'<button class="danger" data-force>/);
  assert.match(app, /Override the lane rules/);
  // And the error body has to survive the api() helper for any of it to work.
  assert.match(app, /e\.body=body/);
});

test('morph: keyed cards keep node identity across reorder and update', () => {
  const { morphChildren } = loadMorph();
  const live = el('div', {}, el('div', { 'data-card': '001', class: 'card' }, 'one'), el('div', { 'data-card': '002', class: 'card' }, 'two'));
  const a = live.childNodes[0]!;
  const b = live.childNodes[1]!;
  const next = el('div', {}, el('div', { 'data-card': '002', class: 'card sel' }, 'two v2'), el('div', { 'data-card': '001', class: 'card' }, 'one'));
  morphChildren(live, next);
  assert.equal(live.childNodes[0], b, '002 moved first, same node object');
  assert.equal(live.childNodes[1], a, '001 second, same node object');
  assert.equal(b.getAttribute('class'), 'card sel', 'attributes updated in place');
  assert.equal(b.childNodes[0]!.data, 'two v2', 'text updated in place');
});

test('morph: insertion, removal, and unkeyed positional updates', () => {
  const { morphChildren } = loadMorph();
  const live = el('div', {}, el('div', { id: 'bstats' }, 'stats'), el('div', { id: 'bcols' }, el('section', {}, 'lane a'), el('section', {}, 'lane b')));
  const stats = live.childNodes[0]!;
  const cols = live.childNodes[1]!;
  const laneA = cols.childNodes[0]!;
  const next = el(
    'div',
    {},
    el('div', { id: 'bstats' }, 'stats v2'),
    el('div', { class: 'err' }, '1 lint error(s)'),
    el('div', { id: 'bcols' }, el('section', {}, 'lane a v2'), el('section', {}, 'lane b'), el('section', {}, 'lane c')),
  );
  morphChildren(live, next);
  assert.equal(live.childNodes.length, 3);
  assert.equal(live.childNodes[0], stats, 'keyed #bstats survives');
  assert.equal(live.childNodes[0]!.childNodes[0]!.data, 'stats v2');
  assert.equal(live.childNodes[1]!.getAttribute('class'), 'err', 'error banner inserted mid-list');
  assert.equal(live.childNodes[2], cols, 'keyed #bcols survives the shift');
  assert.equal(cols.childNodes[0], laneA, 'positional section kept identity');
  assert.equal(cols.childNodes[0]!.childNodes[0]!.data, 'lane a v2');
  assert.equal(cols.childNodes.length, 3, 'new lane appended');

  // And back to two lanes: the extra one is trimmed, keyed nodes still live.
  const back = el('div', {}, el('div', { id: 'bstats' }, 'stats v2'), el('div', { id: 'bcols' }, el('section', {}, 'lane a v2'), el('section', {}, 'lane b')));
  morphChildren(live, back);
  assert.equal(live.childNodes.length, 2);
  assert.equal(live.childNodes[1], cols);
  assert.equal(cols.childNodes.length, 2);
});

test('morph: a card moving between lanes leaves and reappears without corrupting others', () => {
  const { morphChildren } = loadMorph();
  const mk = (lanes: Record<string, string[]>) =>
    el('div', {}, el('div', { id: 'bcols' }, ...Object.entries(lanes).map(([lane, ids]) => el('section', { class: 'col', 'data-lane': lane }, ...ids.map((i) => el('div', { 'data-card': i }, i))))));
  const live = mk({ todo: ['001', '002'], doing: [] });
  const kept = live.childNodes[0]!.childNodes[0]!.childNodes[0]!; // card 001
  morphChildren(live, mk({ todo: ['001'], doing: ['002'] }));
  const cols = live.childNodes[0]!.childNodes;
  assert.equal(cols[0]!.childNodes.length, 1);
  assert.equal(cols[0]!.childNodes[0], kept, 'unmoved card keeps identity');
  assert.equal(cols[1]!.childNodes.length, 1);
  assert.equal(cols[1]!.childNodes[0]!.dataset['card'], '002');
});
