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

test('ui: project and integration histories have bounded cursor pages in both directions', () => {
  const app = scripts.join('\n');
  assert.match(app, /const PROJECT_EVENT_PAGE_SIZE=50/);
  assert.match(app, /\/events\?limit='\+\(PROJECT_EVENT_PAGE_SIZE\+1\)\+cursor/,
    'project activity fetches one bounded page plus a sentinel');
  for (const control of [
    'data-event-prev', 'data-event-next',
    'data-delivery-prev', 'data-delivery-next',
    'data-outbox-prev', 'data-outbox-next', 'data-emailhistory',
  ]) assert.ok(app.includes(control), `${control} is wired`);
  assert.doesNotMatch(app, /\/events\?limit=200/, 'the old fixed project-event batch is gone');
  assert.doesNotMatch(app, /webhookDeliveriesModal\(hook,Number/,
    'older webhook pages reuse one dialog and retain their newer-page stack');
});

test('ui: card activity and chat load bounded newest-first server pages', () => {
  const app = scripts.join('\n');
  assert.match(app, /const CARD_HISTORY_PAGE_SIZE=25/);
  assert.match(app, /cardReadApi\(cid\)/, 'modal detail uses the compact response without embedded histories');
  assert.match(app, /cardHistoryApi\(c\.id,kind\)\+'\?limit='\+CARD_HISTORY_PAGE_SIZE\+cursor/,
    'each card history tab asks the server for one bounded page');
  for (const control of ['data-cardhistory-prev', 'data-cardhistory-next']) {
    assert.ok(app.includes(control), `${control} is wired`);
  }
  assert.doesNotMatch(app, /c\.parsed&&c\.parsed\.log/, 'activity no longer renders an embedded full Log');
  assert.doesNotMatch(app, /c\.parsed&&c\.parsed\.comments/, 'chat no longer renders an embedded full Comments section');
});

test('ui: ordinary board polls omit flow series until the metrics view needs them', () => {
  const app = scripts.join('\n');
  assert.match(app, /const flow=LAYOUT==='metrics'\?'1':'0'/,
    'the authenticated poll derives its payload shape from the active view');
  assert.match(app, /\/board\?flow='\+flow/);
  assert.match(app, /LAYOUT==='metrics'&&BOARD&&!BOARD\.flow\)refreshBoard\(\)/,
    'switching to metrics fetches the omitted series');
  assert.match(app, /\/api\/public\/'\+PUB\+'\/board\?flow='/,
    'public polling uses the same metrics-only contract');
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

function renderCols(readOnly = false, searchIds: Set<string> | null = null): string {
  const js = scripts[1]!;
  const start = js.indexOf('function colsHtml');
  const end = js.indexOf('/** A lost claim', start);
  assert.ok(start !== -1 && end > start, 'column renderer found in page JS');
  const ctx: Record<string, unknown> = {
    RO: readOnly,
    SEARCH_IDS: searchIds,
    ME: { username: 'owner' },
    esc: (s: unknown) => String(s),
    cardHtml: () => '<article data-card="001"></article>',
    board: {
      lanes: [{ id: 'todo', name: 'To do', cards: [{ id: '001' }, { id: '002' }], substates: [], wip: 1 }],
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
  const start = js.indexOf('function memberScope');
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

function loadHillQueue(): {
  saveHill: (card: { id: string; hill: number }, value: number) => void;
  pendingTimers: Map<number, () => Promise<void>>;
  requests: { path: string; body: { hill: number } }[];
} {
  const js = scripts[1]!;
  const start = js.indexOf('function saveHill');
  const end = js.indexOf('// A press on a card', start);
  assert.ok(start !== -1 && end > start, 'Hill save queue found in page JS');
  const pendingTimers = new Map<number, () => Promise<void>>();
  const requests: { path: string; body: { hill: number } }[] = [];
  let timerId = 0;
  const context: Record<string, unknown> = {
    HILL_PENDING: new Map(),
    SEL: 'p-build',
    VIEW: 'board',
    document: { querySelectorAll: () => [] },
    setTimeout: (fn: () => Promise<void>) => { const id = ++timerId; pendingTimers.set(id, fn); return id; },
    clearTimeout: (id: number) => pendingTimers.delete(id),
    api: async (path: string, options: { body: string }) => { requests.push({ path, body: JSON.parse(options.body) as { hill: number } }); return {}; },
    refreshBoard: async () => {},
    toast: () => {},
  };
  runInNewContext(`${js.slice(start, end)}; exports={saveHill}`, context);
  return {
    saveHill: (context['exports'] as { saveHill: (card: { id: string; hill: number }, value: number) => void }).saveHill,
    pendingTimers,
    requests,
  };
}

function loadChecklistKeyTarget(): (target: { closest: (selector: string) => unknown }) => unknown {
  const js = scripts[1]!;
  const start = js.indexOf('function checklistKeyTarget');
  const end = js.indexOf('function wireCardModal', start);
  assert.ok(start !== -1 && end > start, 'checklist keyboard target helper found');
  const context: Record<string, unknown> = {};
  runInNewContext(`${js.slice(start, end)}; exports=checklistKeyTarget`, context);
  return context['exports'] as (target: { closest: (selector: string) => unknown }) => unknown;
}

function loadDialogTrap(document: { activeElement: unknown }): (event: Record<string, unknown>, root: Record<string, unknown>) => void {
  const js = scripts[1]!;
  const start = js.indexOf('function trapDialogTab');
  const end = js.indexOf('function overlay', start);
  assert.ok(start !== -1 && end > start, 'dialog focus trap found');
  const context: Record<string, unknown> = { document };
  runInNewContext(`${js.slice(start, end)}; exports=trapDialogTab`, context);
  return context['exports'] as (event: Record<string, unknown>, root: Record<string, unknown>) => void;
}

async function exerciseReloadOrg(view: string): Promise<string[]> {
  const js = scripts[1]!;
  const start = js.indexOf('async function reloadOrg()');
  const end = js.indexOf('function renderHeader()', start);
  assert.ok(start !== -1 && end > start, 'org refresh helper found');
  const calls: string[] = [];
  const context: Record<string, unknown> = {
    VIEW: view,
    BOARD: { cards: 1 },
    TOKEN: 'token',
    localStorage: { removeItem: () => calls.push('remove-token') },
    api: async () => ({ name: 'Acme' }),
    adoptOrg: () => calls.push('adopt'),
    renderSide: () => calls.push('side'),
    renderHeader: () => calls.push('header'),
    refreshBoard: async () => calls.push('board'),
    gate: () => calls.push('gate'),
  };
  runInNewContext(`${js.slice(start, end)}; exports=reloadOrg`, context);
  await (context['exports'] as () => Promise<void>)();
  return calls;
}

test('ui: identity, role flags and the name directory refresh together', () => {
  const app = scripts.join('\n');
  // A rename is only visible because the UI resolves usernames through the
  // directory at render time, so every path that reloads the org has to
  // rebuild it. Reassigning ORG alone leaves renamed members showing their
  // old name until a full page load.
  assert.match(app, /function adoptOrg\(org\)\{/, 'org adoption lives in one place');
  for (const derived of ['ME=', 'CAN_WRITE=', 'CAN_SHAPE=', 'IS_OWNER=', 'RO=', 'DIR=']) {
    assert.ok(app.slice(app.indexOf('function adoptOrg(')).slice(0, 400).includes(derived),
      `adoptOrg refreshes ${derived}`);
  }
  const reload = app.slice(app.indexOf('async function reloadOrg()'), app.indexOf('function renderHeader()'));
  assert.match(reload, /org=await api\('\/api\/org'\)/, 'reloadOrg fetches the org once');
  assert.match(reload, /adoptOrg\(org\)/, 'reloadOrg goes through the shared adoption path');
  assert.match(reload, /if\(VIEW==='board'&&BOARD\)/, 'only a real board view triggers a board refresh');
  assert.doesNotMatch(app, /::settings/, 'settings is an explicit view, never a fake project id');
  assert.ok(!/\bORG=await api\('\/api\/org'\)/.test(app), 'nothing assigns ORG behind adoptOrg\'s back');

  // Creating a member must not default to the most powerful role.
  const roles = /\[([^\]]*'owner'[^\]]*)\]\.map\(r=>'<option value="'\+r/.exec(app);
  assert.ok(roles, 'the role select is built from a list');
  assert.ok(!roles[1]!.trimStart().startsWith("'owner'"), 'owner is not the default-selected first option');
  assert.match(app, /CAN_WRITE=!!ME&&\['write','admin','owner'\]\.includes\(ME\.role\)/,
    'unknown roles fail closed instead of inheriting write');
  assert.match(app, /CAN_SHAPE=!!ME&&\['admin','owner'\]\.includes\(ME\.role\)/,
    'board-shape controls have their own capability');
  assert.match(app, /CAN_SHAPE\?'<button id="editboard"/,
    'admins see the board editor without receiving owner settings');
});

test('ui: an org refresh cannot redraw settings as a board', async () => {
  assert.deepEqual(await exerciseReloadOrg('settings'), ['adopt', 'side', 'header']);
  assert.deepEqual(await exerciseReloadOrg('board'), ['adopt', 'side', 'header', 'board']);
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

test('ui: nested projects become wormhole drop targets during a card drag', () => {
  const app = scripts.join('\n');
  assert.match(app, /function handoffTargets\(\)/, 'the dialog and gesture share one descendant scope');
  assert.match(app, /data-wormhole=/, 'nested projects render as explicit handoff targets');
  assert.match(app, /const wormhole=el\.closest\('\[data-wormhole\]'\)/, 'hit testing recognizes a wormhole before a lane');
  assert.match(app, /JSON\.stringify\(\{target:t\.wormhole,move:true\}\)/, 'dropping performs a safe move transfer');
  assert.match(page, /\.dragmode \.wormrail\{display:flex\}/, 'the rail appears only while a card is lifted');
  assert.match(page, /wormholes · move card to/, 'the destructive move semantics are visible');
});

test('ui: structure operations and relationship presentation are reachable', () => {
  const app = scripts.join('\n');
  for (const hook of [
    'id="quickcard"', 'id="bulkcard"', 'data-promote=', 'data-linkcard', 'data-unlinkcard=',
    'data-mergecard', 'data-transfercard', 'data-template', 'id="addtemplate"',
  ]) assert.ok(app.includes(hook), `manager structure surface missing ${hook}`);
  assert.match(app, /function drawRelations\(b\)/);
  assert.match(app, /marker\.setAttribute\('id','rel-arrow'\)/);
  assert.match(app, /r\.active===false\?' · resolved'/, 'resolved dependency edges remain visible as history');
  assert.match(app, /r\.source==='stored'/, 'only stored links offer unlink controls');
});

test('ui: each writable lane ends with an add-card footer', () => {
  const html = renderCols();
  const headingEnd = html.indexOf('</h3>');
  const deckEnd = html.indexOf('</div>', html.indexOf('class="deck"'));
  const footer = html.indexOf('<footer class="lanefoot">');
  assert.ok(headingEnd !== -1 && footer > deckEnd, 'the add action follows the deck instead of floating in the heading');
  assert.ok(!html.slice(0, headingEnd).includes('data-addcard'), 'the lane heading has no add-card control');
  assert.match(html, /<button type="button" class="laneadd" data-addcard="todo"/);
  assert.match(html, />\+ add card<\/button>/);
  assert.match(html, /data-lanesub="todo"/);
  assert.match(html, /aria-pressed="false"/);
  assert.ok(!renderCols(true).includes('lanefoot'), 'read-only boards do not advertise a write action');

  // Hover is an enhancement: keyboard focus reveals the same stable footer,
  // and devices without hover keep it discoverable.
  assert.match(page, /\.col:hover \.lanefoot,\.col:focus-within \.lanefoot/);
  assert.match(page, /@media \(hover:none\)\{\.lanefoot\{/);
  assert.doesNotMatch(page, /\.lanefoot\{[^}]*display:none/);
});

test('ui: filtering cards never falsifies the lane WIP count', () => {
  const html = renderCols(false, new Set(['001']));
  assert.match(html, />2\/1<\/span>/, 'WIP uses the two actual lane cards');
  assert.equal((html.match(/<article data-card="001"><\/article>/g) ?? []).length, 1,
    'the deck still renders only the matching card');
});

test('ui: server search and saved filters do not replace a focused query input', () => {
  const app = scripts.join('\n');
  for (const needle of [
    'role="search"', 'id="cardsearch"', 'id="savedsearch"', 'id="savefilter"', 'id="delfilter"',
    "'/search?'", "'/filters'", 'function runSearch()', 'function syncSearchControls(b)',
  ]) assert.ok(app.includes(needle), `search surface missing ${needle}`);
  assert.match(app, /input\.oninput=.*SEARCH_TIMER=setTimeout\(runSearch,180\)/s, 'typing is debounced');
  assert.match(app, /if\(e\.key==='Enter'\)\{e\.preventDefault\(\)/, 'enter searches without submitting a surrounding page form');
  assert.match(app, /function paintBoard\(\)\{\s*const v=\$\('#view'\)/, 'search only redraws the board content');
  assert.doesNotMatch(app.slice(app.indexOf('function boardHtml('), app.indexOf('async function refreshBoard(')), /cardsearch/,
    'the polled/morphed board subtree never owns the focused search input');
  assert.match(app, /SEARCH_IDS=new Set\(cards\.map\(c=>c\.id\)\)/, 'the server is authoritative for result membership');
});

test('ui: collaboration controls, lane subscriptions, and personal feeds are reachable', () => {
  const app = scripts.join('\n');
  for (const hook of [
    'data-watch', 'data-vote', 'data-boost', 'data-feedcard', 'data-lanesub=',
    'data-rfeed=', 'data-dfeed=', 'data-copyfeed=', "['atom','Atom']", "['rss','RSS']", "['ics','iCal']",
  ]) assert.ok(app.includes(hook), `collaboration/feed surface missing ${hook}`);
  assert.match(app, /cardApi\(c\.id\)\+'\/watch'/);
  assert.match(app, /cardApi\(c\.id\)\+'\/vote'/);
  assert.match(app, /cardApi\(c\.id\)\+'\/boost'/);
  assert.match(app, /\[\.\.\.d\.text\]\.length>12/, 'boosts enforce the Unicode code-point limit before sending');
  assert.match(app, /\/subscribe'\,\{method:'POST'/, 'lane following reaches the scoped API');
  assert.match(app, /const tabs=\['board','activity','feeds'\]/, 'feeds are personal and available without owner status');
  assert.match(app, /Slack can subscribe to RSS; calendar apps use iCal/);
  assert.match(app, /Revocation is immediate/);
});

test('ui: owners can administer hardened webhook and email integrations', () => {
  const app = scripts.join('\n');
  assert.match(app, /\['sharing','integrations'\]/, 'integrations is owner-only beside public sharing');
  for (const endpoint of [
    '/webhooks', '/email/routes', '/email/subscriptions', '/email/outbox?limit=25',
  ]) assert.ok(app.includes(endpoint), `integration UI reaches ${endpoint}`);
  for (const control of [
    'data-whdeliveries', 'data-replaydelivery', 'data-whrotate', 'data-whrevoke',
    'data-errevoke', 'data-esrevoke', 'data-copyintegration',
  ]) assert.ok(app.includes(control), `${control} is wired`);
  assert.match(app, /Webhook signing secret/);
  assert.match(app, /Inbound bridge endpoint/);
  assert.match(app, /not shown again in this screen/);
  assert.match(app, /SPF\/DKIM/, 'provider responsibility is visible, not hidden in implementation notes');
});

test('ui: relation authoring offers the current project and authorized descendants', () => {
  const app = scripts.join('\n');
  assert.match(app, /projects=\[\{id:SEL,name:\(here&&here\.name\)\|\|'this project'\}\]\.concat\(handoffTargets\(\)\)/);
  assert.match(app, /const target=d\.project===SEL\?d\.target:'project:'\+d\.project\+'#'\+d\.target/);
  assert.match(app, /JSON\.stringify\(\{target,type:d\.type\}\)/);
  assert.match(app, /data-unlinkcard/);
});

test('ui: a link preview can become cover art without overriding cover: none', () => {
  const app = scripts.join('\n');
  // cover is null both when art is suppressed and when there simply is none,
  // so the decision cannot be made from cover alone.
  assert.match(app, /function coverOf\(c\)\{/);
  assert.match(app, /if\(!c\.coverAuto\)return null/, 'cover: none outranks a preview');
  assert.match(app, /if\(c\.cover\)return imageOk\(c\.cover\)\?c\.cover:null/,
    'a same-origin explicit cover wins while remote tracking images stay blocked');
  assert.match(app, /ps\.find\(x=>youtubeLink\(x\.url\)\)\|\|ps\[0\]/, 'YouTube art wins over a generic earlier link');
  // Card face and modal both go through it, so they cannot disagree.
  assert.match(app, /coverOf\(c\)\)\)/);
  // A preview tile stands for its link, so it opens the page, not the picture.
  assert.match(app, /\{img:v\.image,href:v\.url,kind:'link'\}/);
  assert.match(app, /data-cover="'\+esc\(t\.img\)/, 'and can still be pinned as the cover');
});

test('ui: compact cards and editors expose structured presentation data', () => {
  const app = scripts.join('\n');
  for (const needle of [
    'c.labelDetails||[]', 'c.faceFields||[]', 'c.descriptionPresent', 'c.checklistPreview||[]',
    'c.coverColor', 'metrics.agingLevel', 'metrics.dueChanges', 'function dueFace(c)', 'lane.estimate',
    'function customFormFields(', 'function customPayload(', 'data-labeldef', 'data-fielddef',
  ]) assert.ok(page.includes(needle) || app.includes(needle), `structured card UI missing: ${needle}`);
  assert.match(app, /const shown=items\.slice\(0,10\);shown\.splice\(tagIndex,0,\.\.\.cardTagBadges\(c\)\)/,
    'non-tag badges remain bounded without consuming the configured tag allowance');
  assert.match(app, /checklistPreview\.slice\(0,2\)/, 'only a compact unfinished checklist preview reaches the face');
  assert.match(app, /ME\.kind==='bot'\?c\.delegate:c\.assignee/, 'bot ownership follows delegation rather than overwriting accountability');
});

test('ui: card tag limit renders an exact accessible overflow summary', () => {
  const app = scripts.join('\n');
  const start = app.indexOf('function labelBadge(');
  const end = app.indexOf('function blockerOf(', start);
  assert.ok(start !== -1 && end > start, 'card tag rendering helpers found');
  const context: Record<string, unknown> = {
    THEME: { cardTagLimit: 2 },
    esc: (value: unknown) => String(value),
  };
  runInNewContext(`${app.slice(start, end)};rendered=cardTagBadges({labelDetails:[
    {id:'Group/one',group:'Group',value:'one',color:null},
    {id:'Group/two',group:'Group',value:'two',color:null},
    {id:'Group/three',group:'Group',value:'three',color:null},
    {id:'plain',group:null,value:'plain',color:null}
  ]}).join('')`, context);
  const rendered = context['rendered'] as string;
  assert.equal((rendered.match(/class="lbl"/g) ?? []).length, 2);
  assert.match(rendered, /class="moretags"/);
  assert.match(rendered, /title="#three, #plain"/);
  assert.match(rendered, />\+2 more<\/span>/);
  assert.match(app, /id="cardtaglimit"/);
  assert.match(app, /How many tags each card shows before \+N more\./);
});

test('ui: alternate views share card data, supported axes mutate their source field, and Hill dots stay manual', () => {
  const app = scripts.join('\n');
  for (const hook of [
    'id="boardlayout"', "['kanban','table','swimlane','calendar','timeline','grouped','metrics','hill']",
    'function tableHtml(', 'function groupedHtml(', 'function swimlaneHtml(', 'function calendarHtml(',
    'function timelineHtml(', 'function metricsHtml(', 'function hillHtml(', 'function visibleCards(',
    'data-axis-value=', 'function assignAxisUi(', 'data-hill=', 'function saveHill(',
    'cumulative flow', 'average cycle days', 'Manual uncertainty',
  ]) assert.ok(app.includes(hook), `view UI missing ${hook}`);
  assert.match(app, /patch\.fields=\{\[axis\.field\.id\]:next\}/, 'grouping by a custom axis edits that declared field');
  assert.match(app, /patch\.labels=.*axis\.group/, 'grouping by a scoped label edits the scoped label value');
  assert.match(app, /body:JSON\.stringify\(\{hill:value\}\)/, 'a Hill drag persists only its explicit final position');
  assert.match(app, /plotted=cards\.filter\(c=>c\.hill!=null\)/, 'unplotted work does not collapse into one inaccessible dot');
  assert.match(app, /data-hill-init=/, 'an unplotted active card has an explicit keyboard-accessible starting action');
  assert.match(app, /completionDates=filtered\?cards\.map/, 'filtered metrics derive completion counts from the visible cards');
  assert.match(app, /Cumulative flow and WIP breaches remain whole-board measures/, 'metrics identify the historical aggregates that cannot be filtered client-side');
  assert.match(app, /if\(LAYOUT==='kanban'\)requestAnimationFrame/, 'dependency strings are drawn only where card geometry is unambiguous');
});

test('ui: emitted calendar JavaScript recognizes ISO card dates', () => {
  const app = scripts.join('\n');
  const start = app.indexOf('function isoDay(');
  const end = app.indexOf('function utcDay(', start);
  assert.ok(start !== -1 && end > start, 'date projection helper found');
  const context: Record<string, unknown> = {};
  runInNewContext(`${app.slice(start, end)};valid=isoDay('2026-08-20');invalid=isoDay('August 20')`, context);
  assert.equal(context['valid'], '2026-08-20');
  assert.equal(context['invalid'], null);
});

test('ui: scheduling, WIP policy, named blockers, and safe automation are reachable', () => {
  const app = scripts.join('\n');
  for (const hook of [
    'id="automate"', 'data-boardbutton=', 'data-cardbutton=', 'data-snooze', 'data-wake',
    'data-blockerdef', 'data-buttondef', 'data-ruledef', 'id="archiveafter"', 'class="lwipmode"',
  ]) assert.ok(app.includes(hook), `automation UI missing ${hook}`);
  assert.match(app, /reminders before due \(minutes, comma separated\)/);
  assert.match(app, /repeat every \(empty for no recurrence\)/);
  assert.match(app, /snooze until \(YYYY-MM-DD or UTC datetime\)/);
  assert.match(app, /function moveCardUi\(/, 'pointer and keyboard moves share WIP prompting');
  assert.match(app, /written WIP justification/);
  assert.match(app, /owner override justification/);
  assert.match(app, /if\(c\.blocker\)\{toast\(c\.id\+' is blocked by '/,
    'named blockers stop a card before a drag mutation is attempted');
  assert.match(app, /\/buttons\/'\+encodeURIComponent\(id\)/);
  assert.match(app, /\/automate'.*method:'POST'/s);
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
  const save = app.slice(app.indexOf('const save=async next=>'), app.indexOf("api('/api/settings')", app.indexOf('const save=async next=>')));
  assert.match(save, /const controls=\$\('#themecontrols'\).*patchView\(controls,themeControlsHtml\(\)\)/,
    'a theme save patches only its controls');
  assert.doesNotMatch(save, /renderSettings\(/, 'theme saves do not replace company drafts or member controls');
});

test('ui: the member directory consumes the flat identity scope contract', () => {
  const { scopeLabel, memberFields, memberRow } = loadMemberHelpers();
  assert.equal(scopeLabel({ scopeKind: 'org', scopeId: null }), 'whole company');
  assert.equal(scopeLabel({ scopeKind: 'space', scopeId: 's-ops' }), 'space: Operations');
  assert.equal(scopeLabel({ scopeKind: 'project', scopeId: 'p-build' }), 'project: Build');
  assert.equal(scopeLabel({ scope: { kind: 'space', id: 's-ops' } }), 'space: Operations',
    'legacy nested scope rows remain readable');
  assert.equal(scopeLabel({ scopeKind: 'project' }), 'scope unavailable',
    'one malformed row gets a safe label instead of crashing the directory');
  const fields = memberFields({ display: 'Builder', role: 'write', scopeKind: 'project', scopeId: 'p-build' });
  assert.match(fields, /value="project:p-build" selected/,
    'editing a member selects the scope returned by /api/members');
  const adminFields = memberFields({ display: 'Shaper', role: 'admin', scopeKind: 'space', scopeId: 's-ops' });
  assert.match(adminFields, /value="admin" selected/, 'admin is available in the owner-managed role picker');
  assert.match(adminFields, /value="space:s-ops" selected/);
  assert.doesNotMatch(adminFields, /value="org"/, 'the UI cannot submit an org-scoped admin');

  const common = { display: 'Agent', username: 'agent', role: 'write', scopeKind: 'project', scopeId: 'p-build', keys: 0, disabled: false };
  const bot = memberRow({ ...common, memberId: 'm-bot', kind: 'bot' });
  const human = memberRow({ ...common, memberId: 'm-human', kind: 'human' });
  assert.match(bot, /data-keym="m-bot"/, 'owners get an explicit key action for bots');
  assert.match(bot, /aria-label="manage API keys for agent"/);
  assert.doesNotMatch(human, /data-keym=/, 'human accounts keep key creation in their own account panel');

  const app = scripts.join('\n');
  assert.match(app, /function wireMemberFields\(\)/, 'member scope options react to role changes');
  assert.match(app, /role\.value==='admin'/, 'switching to admin removes company scope');
  assert.ok((app.match(/wireMemberFields\(\)/g) ?? []).length >= 3,
    'the role/scope invariant is wired for both create and edit forms');
  assert.match(app, /const endpoint='\/api\/keys\?member='\+encodeURIComponent\(m\.memberId\)/);
  assert.match(app, /api\(endpoint,\{method:'POST'/,
    'the bot key flow provisions the selected member, not the logged-in owner');
  for (const control of ['data-renbotkey', 'data-repbotkey', 'data-revbotkey']) {
    assert.ok(app.includes(control), `${control} is available to an owner managing a bot`);
  }
  assert.match(app, /\/replace',\{method:'POST'/, 'key replacement has a first-class API action');
  assert.match(app, /The bot does not need to log in/);
  assert.match(app, /It is never shown again/);
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
  assert.match(app, /if\(VIEW==='board'&&BOARD\)\{BOARD=null;await refreshBoard\(\)\}/,
    'reloadOrg awaits the re-render focus depends on');
  // Announced, not silent: toast carries role=status.
  assert.match(app, /toast\(id\+' moved to '\+to\)/);
  assert.match(app, /role','status'/);
  // Discoverable by assistive tech without adding visual noise.
  assert.match(app, /aria-keyshortcuts="Shift\+ArrowLeft/);
  // The same legality rules the drag uses, so the two paths cannot disagree.
  assert.match(app, /dropRules\(BOARD,c\)\.get/);
});

test('ui: rapid Hill keyboard changes coalesce against the pending value', async () => {
  const { saveHill, pendingTimers, requests } = loadHillQueue();
  const card = { id: '001', hill: 38 };
  saveHill(card, 39);
  saveHill(card, 40);
  saveHill(card, 41);
  assert.equal(pendingTimers.size, 1, 'debouncing leaves one pending write');
  await [...pendingTimers.values()][0]!();
  assert.deepEqual(requests, [{ path: '/api/projects/p-build/cards/001/edit', body: { hill: 41 } }]);
  assert.equal(card.hill, 41);
});

test('ui: a focused promote button is not also its checklist checkbox', () => {
  const checklistKeyTarget = loadChecklistKeyTarget();
  const row = { kind: 'row' };
  const rowTarget = { closest: (selector: string) => selector === '[data-check]' ? row : null };
  const promoteTarget = { closest: (selector: string) => selector === 'button,a,input,textarea,select' ? { kind: 'button' } : row };
  assert.equal(checklistKeyTarget(rowTarget), row, 'Enter on the checkbox row toggles it');
  assert.equal(checklistKeyTarget(promoteTarget), null, 'Enter on promote belongs only to the button');
});

test('ui: modal Tab and Shift+Tab remain inside the dialog', () => {
  const focused: string[] = [];
  const first = { disabled: false, offsetParent: {}, focus: () => focused.push('first') };
  const last = { disabled: false, offsetParent: {}, focus: () => focused.push('last') };
  const document = { activeElement: last };
  const trap = loadDialogTrap(document);
  const root = { querySelectorAll: () => [first, last], contains: (node: unknown) => node === first || node === last };
  let prevented = 0;
  trap({ key: 'Tab', shiftKey: false, preventDefault: () => prevented++ }, root);
  assert.deepEqual(focused, ['first']);
  document.activeElement = first;
  trap({ key: 'Tab', shiftKey: true, preventDefault: () => prevented++ }, root);
  assert.deepEqual(focused, ['first', 'last']);
  assert.equal(prevented, 2);
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

test('morph: the rendered relation overlay never displaces or replaces lane columns', () => {
  const { morphChildren } = loadMorph();
  const live = el('div', {},
    el('svg', { id: 'relation-overlay', class: 'relsvg' }),
    el('section', { class: 'col', 'data-lane': 'todo' }, 'todo'),
    el('section', { class: 'col', 'data-lane': 'done' }, 'done'));
  const overlay = live.childNodes[0]!;
  const todo = live.childNodes[1]!;
  const done = live.childNodes[2]!;
  const next = el('div', {},
    el('svg', { id: 'relation-overlay', class: 'relsvg' }),
    el('section', { class: 'col', 'data-lane': 'todo' }, 'todo v2'),
    el('section', { class: 'col', 'data-lane': 'done' }, 'done'));
  morphChildren(live, next);
  assert.equal(live.childNodes[0], overlay, 'overlay remains the keyed first child');
  assert.equal(live.childNodes[1], todo, 'first lane keeps identity and focus state');
  assert.equal(live.childNodes[2], done, 'second lane keeps identity and scroll state');
  assert.equal(todo.childNodes[0]!.data, 'todo v2');
});

test('morph: changed board-button labels preserve the focused button node', () => {
  const { morphChildren } = loadMorph();
  const live = el('span', {}, el('button', { 'data-morph-key': 'board-button:ship', 'data-boardbutton': 'ship' }, 'ship'));
  const button = live.childNodes[0]!;
  const next = el('span', {}, el('button', { 'data-morph-key': 'board-button:ship', 'data-boardbutton': 'ship', title: 'close done' }, 'ship now'));
  morphChildren(live, next);
  assert.equal(live.childNodes[0], button);
  assert.equal(button.childNodes[0]!.data, 'ship now');
  assert.equal(button.getAttribute('title'), 'close done');
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
