import assert from 'node:assert/strict';
import { contrastRatio, hexToOklch, oklchToHex, shade } from '../../src/ui/theme/color';
import { THEME_PRESETS } from '../../src/ui/theme/theme-presets';
import {
  DEFAULT_APPEARANCE,
  applyPreset,
  choiceFor,
  exportTheme,
  importTheme,
  normalizeAppearance,
  parseTheme,
  patchRecipe,
  presetRecipe,
  themeVariables,
} from '../../src/ui/theme/themes';
import type { ThemeVariant } from '../../src/ui/theme/theme-types';

const tokens = (presetId: string, variant: ThemeVariant, contrast?: number) => {
  const recipe = presetRecipe(presetId, variant);
  return themeVariables({ presetId, recipe: contrast === undefined ? recipe : { ...recipe, contrast } }, variant);
};
const solid = /^#[0-9a-f]{6}$/;
const alphaOf = (value: string) => Number(/rgba\([^)]*,\s*([\d.]+)\)$/.exec(value)?.[1]);
const lightness = (hex: string) => hexToOklch(hex).l;

// OKLCH round trip stays within one step per channel.
for (const hex of ['#000000', '#ffffff', '#2563eb', '#cc7d5e', '#1e1e2e', '#1eff5a']) {
  const back = oklchToHex(hexToOklch(hex));
  const delta = Math.max(...[1, 3, 5].map((i) => Math.abs(Number.parseInt(hex.slice(i, i + 2), 16) - Number.parseInt(back.slice(i, i + 2), 16))));
  assert.ok(delta <= 1, `${hex} round-trips (${back})`);
}

// Every preset × variant produces a complete, legible set of tokens.
let checked = 0;
for (const preset of THEME_PRESETS) {
  for (const variant of ['light', 'dark'] as const) {
    if (!preset.variants[variant]) continue;
    const vars = tokens(preset.id, variant);
    const recipe = presetRecipe(preset.id, variant);
    for (const key of ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--app-chrome-bg', '--accent', '--popover-bg']) {
      assert.match(vars[key], solid, `${preset.id}/${variant} ${key} is a solid color`);
    }
    assert.ok(contrastRatio(vars['--accent-foreground'], vars['--accent']) >= 3, `${preset.id}/${variant} text on accent reads`);
    assert.ok(contrastRatio(vars['--code-token-function'], recipe.surface) >= 4.4, `${preset.id}/${variant} accent text reads on the surface`);
    assert.ok(contrastRatio(recipe.ink, vars['--bg-primary']) >= 4.5, `${preset.id}/${variant} body text reads on the canvas`);
    checked += 1;
  }
}
assert.ok(checked >= 34, `checked every preset variant (${checked})`);

// Layers keep their order: raised surfaces sit further toward the ink than the panel.
for (const variant of ['light', 'dark'] as const) {
  const vars = tokens('aegis', variant);
  const toward = variant === 'dark' ? 1 : -1;
  assert.ok((lightness(vars['--bg-tertiary']) - lightness(vars['--bg-secondary'])) * toward > 0, `${variant}: raised is a step past the panel`);
  assert.ok((lightness(vars['--code-block-bg']) - lightness(vars['--bg-tertiary'])) * toward > 0, `${variant}: code blocks are a step past raised`);
}

// Contrast moves the whole hierarchy in one direction.
for (const variant of ['light', 'dark'] as const) {
  const low = tokens('aegis', variant, 10);
  const high = tokens('aegis', variant, 90);
  assert.ok(alphaOf(high['--border']) > alphaOf(low['--border']), `${variant}: borders strengthen`);
  assert.ok(alphaOf(high['--text-muted']) > alphaOf(low['--text-muted']), `${variant}: muted text strengthens`);
  const gap = (vars: Record<string, string>) => Math.abs(lightness(vars['--bg-tertiary']) - lightness(presetRecipe('aegis', variant).surface));
  assert.ok(gap(high) > gap(low), `${variant}: raised layers separate further`);
}

// Window material: translucent sidebars mix with transparency, opaque ones are solid.
assert.match(tokens('aegis', 'light')['--app-sidebar-surface'], /^color-mix\(in srgb, #[0-9a-f]{6} 74%, transparent\)$/);
assert.match(tokens('linear', 'light')['--app-sidebar-surface'], solid);
assert.notEqual(tokens('aegis', 'dark')['--app-sidebar-surface'], tokens('absolutely', 'dark')['--app-sidebar-surface']);
assert.notEqual(tokens('aegis', 'light')['--sidebar-item-hover'], tokens('absolutely', 'light')['--sidebar-item-hover']);

// Signals drive status and code colors; skill chips use the skill color.
const catppuccin = tokens('catppuccin', 'dark');
assert.equal(catppuccin['--success'], '#a6e3a1');
assert.equal(catppuccin['--error'], '#f38ba8');
assert.match(catppuccin['--composer-skill-chip-bg'], /^rgba\(245, 194, 231,/);

// Saved state: old preset ids map to their new names; unknown or unsupported ids fall back.
const migrated = normalizeAppearance({ codeThemeIds: { light: 'codex', dark: 'dp-code' } });
assert.deepEqual(migrated.codeThemeIds, { light: 'aegis', dark: 'harbor' });
assert.equal(normalizeAppearance({ codeThemeIds: { light: 'tokyo-night', dark: 'nope' } }).codeThemeIds.light, 'aegis');
const partial = normalizeAppearance({ chromeThemes: { dark: { surface: '#ABCDEF', ink: 'bad', contrast: 400 } } });
assert.equal(partial.chromeThemes.dark.surface, '#abcdef');
assert.equal(partial.chromeThemes.dark.ink, presetRecipe('aegis', 'dark').ink);
assert.equal(partial.chromeThemes.dark.contrast, 100);

// Presets keep the user's fonts; edits merge.
let state = patchRecipe(DEFAULT_APPEARANCE, 'dark', { fonts: { ui: '"Inter"', code: null } });
state = applyPreset(state, 'dark', 'sentry');
assert.equal(state.codeThemeIds.dark, 'sentry');
assert.equal(state.chromeThemes.dark.surface, presetRecipe('sentry', 'dark').surface);
assert.equal(state.chromeThemes.dark.fonts.ui, '"Inter"');

// Share strings: ours round-trip; Codex-style strings (plain or URI-encoded) import.
const shared = exportTheme('dark', choiceFor(state, 'dark'));
assert.ok(shared.startsWith('aegis-theme-v1:'));
assert.deepEqual(choiceFor(importTheme(DEFAULT_APPEARANCE, 'dark', shared), 'dark'), choiceFor(state, 'dark'));
const foreign = { codeThemeId: 'linear', variant: 'light', theme: { surface: '#fcfcfd', ink: '#1b1b1b', accent: '#5e6ad2', accentSource: 'custom', contrast: 52, opaqueWindows: true, fonts: { ui: 'Inter', code: null }, semanticColors: { diffAdded: '#00a240', diffRemoved: '#ba2623', skill: '#924ff7' } } };
for (const text of [`codex-theme-v1:${JSON.stringify(foreign)}`, `codex-theme-v1:${encodeURIComponent(JSON.stringify(foreign))}`]) {
  const parsed = parseTheme(text);
  assert.equal(parsed.choice.presetId, 'linear');
  assert.equal(parsed.choice.recipe.contrast, 52);
  assert.equal(parsed.choice.recipe.semanticColors.skill, '#924ff7');
}
assert.throws(() => importTheme(DEFAULT_APPEARANCE, 'dark', `codex-theme-v1:${JSON.stringify(foreign)}`), /light theme/);
assert.throws(() => parseTheme('something else'), /aegis-theme-v1/);
assert.throws(() => parseTheme('aegis-theme-v1:{not json'), /valid JSON/);

// Mixing a near-grey surface toward paper or ink keeps its own hue: white and
// black report hue 0 (red), which used to tint popovers and panels pink.
for (const surface of ['#f0f1f5', '#f4f1ea', '#eef3ee']) {
  const source = hexToOklch(surface);
  for (const mixed of [shade(surface, '#ffffff', 0.7), shade(surface, '#000000', 0.1)]) {
    const result = hexToOklch(mixed);
    if (result.c < 1e-3) continue;
    // Hex rounding moves a faint hue by up to ~30°; the pink drift was 70°-150°.
    const drift = Math.abs(((result.h - source.h + 540) % 360) - 180);
    assert.ok(drift < 45, `${surface} -> ${mixed} keeps its hue (drift ${drift.toFixed(1)}°)`);
  }
}
// Light popovers follow a tinted theme: close to its sheet, not plain white.
{
  const light = tokens('aegis', 'light');
  const sheet = hexToOklch(light['--bg-primary']);
  const popover = hexToOklch(light['--popover-bg']);
  assert.notEqual(light['--popover-bg'], '#ffffff');
  assert.ok(popover.l >= sheet.l && popover.l - sheet.l < 0.03, 'popover sits just above the sheet');
}
// A grey surface still takes a colored target's hue.
assert.ok(hexToOklch(shade('#f5f5f5', '#3b82f6', 0.3)).c > 0.02);

// Glass is a preset of its own: a pure white light sheet, frosted window in both variants.
for (const variant of ['light', 'dark'] as const) {
  assert.equal(presetRecipe('glass', variant).glassWindow, true, `glass/${variant} asks for the frosted window`);
  assert.equal(presetRecipe('aegis', variant).glassWindow, false, `aegis/${variant} stays solid`);
  const glassed = applyPreset(DEFAULT_APPEARANCE, variant, 'glass');
  assert.equal(choiceFor(glassed, variant).recipe.glassWindow, true);
  assert.equal(choiceFor(normalizeAppearance(JSON.parse(JSON.stringify(glassed))), variant).recipe.glassWindow, true, 'glass survives saving');
  assert.equal(importTheme(DEFAULT_APPEARANCE, variant, exportTheme(variant, choiceFor(glassed, variant))).chromeThemes[variant].glassWindow, true, 'glass survives sharing');
  assert.ok(alphaOf(tokens('glass', variant)['--app-glass-chrome']) < 1, `glass/${variant} chrome tint is see-through`);
}
assert.equal(tokens('glass', 'light')['--bg-primary'], '#ffffff', 'glass light sheet is pure white');

console.log('theme variables: checks passed');
