import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';

import { DEFAULT_THEME, STYLES, validTheme } from '../worker/src/themes.ts';
import { uiHtml } from '../worker/src/ui.ts';

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

test('worker theme catalog contains five complete visual systems', () => {
  assert.deepEqual(STYLES.map((style) => style.id), ['harbor', 'phosphor', 'fieldnotes', 'mochi', 'blockparty']);

  for (const style of STYLES) {
    assert.equal(style.accents.length, 4, `${style.name} has four authored accents`);
    assert.equal(new Set(style.accents.map((accent) => accent.id)).size, 4, `${style.name} accent ids are unique`);
    assert.notDeepEqual(style.light, style.dark, `${style.name} has separate light and dark palettes`);
    assert.notDeepEqual(style.densities.compact, style.densities.relaxed, `${style.name} has two designed densities`);
    assert.notEqual(style.densities.compact.columnWidth, style.densities.relaxed.columnWidth);
    assert.notEqual(style.densities.compact.cardPad, style.densities.relaxed.cardPad);
    for (const mode of ['light', 'dark'] as const) {
      assert.ok(contrast(style[mode].muted, style[mode].page) >= 4.5, `${style.name} ${mode} muted text is readable`);
      for (const accent of style.accents) {
        assert.ok(contrast(accent[mode].acc, accent[mode].accInk) >= 4.5, `${style.name} ${accent.name} ${mode} is readable`);
      }
    }
  }
});

test('theme validation defaults stale choices and preserves valid density', () => {
  assert.deepEqual(validTheme({}), DEFAULT_THEME);
  assert.deepEqual(validTheme({ style: 'vapor', accent: 'hotline', density: 'compact' }), {
    ...DEFAULT_THEME,
    density: 'compact',
  });
  assert.deepEqual(validTheme({ style: 'mochi', accent: 'matcha', mode: 'dark', density: 'compact' }), {
    style: 'mochi', accent: 'matcha', mode: 'dark', density: 'compact', custom: null,
  });
  assert.deepEqual(validTheme({ style: 'fieldnotes', accent: 'custom', custom: '#A1B2C3' }), {
    style: 'fieldnotes', accent: 'custom', mode: 'system', density: 'relaxed', custom: '#a1b2c3',
  });
});

test('manager HTML embeds the new previews and parseable browser scripts', () => {
  const html = uiHtml(null);
  assert.match(html, /pv-harbor/);
  assert.match(html, /pv-fieldnotes/);
  assert.match(html, /data-density/);
  assert.match(html, /name="theme-color"/);
  assert.doesNotMatch(html, /pv-vapor/);

  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
  assert.equal(scripts.length, 2);
  for (const source of scripts) assert.doesNotThrow(() => new Script(source));
});
