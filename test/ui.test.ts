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
    'onkeydown=boardKeys',
    "e.key==='ArrowDown'",
    '_restoreFocus',
    ".card:focus-visible",
  ]) {
    assert.ok(page.includes(needle), `page is missing: ${needle}`);
  }
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
