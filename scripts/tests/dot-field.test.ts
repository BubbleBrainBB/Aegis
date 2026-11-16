// The dot-matrix backdrop without a window: the two presets and how their
// recipes survive saving, editing and sharing; the picture model (grid size,
// what is lit where, that it changes over time and repeats for the same
// moment); and the look each kind of cell is drawn with.
import assert from 'node:assert/strict';
import { DOT_PITCH, DotFieldModel, dotStyle } from '../../src/ui/theme/dot-field';
import { applyPreset, DEFAULT_APPEARANCE, exportTheme, choiceFor, importTheme, normalizeAppearance, patchRecipe, availablePresets, themeVariables } from '../../src/ui/theme/themes';

// Presets: Aurora is dark only, Hano light only.
assert.ok(availablePresets('dark').some((p) => p.id === 'aurora'));
assert.ok(!availablePresets('light').some((p) => p.id === 'aurora'));
assert.ok(availablePresets('light').some((p) => p.id === 'hano'));
assert.ok(!availablePresets('dark').some((p) => p.id === 'hano'));

// Picking one sets the backdrop; a recipe without one has no backdrop keys at all,
// so appearances saved before this existed are unchanged.
assert.equal(choiceFor(DEFAULT_APPEARANCE, 'dark').recipe.backdrop, undefined);
assert.ok(!('backdrop' in choiceFor(DEFAULT_APPEARANCE, 'dark').recipe));
let state = applyPreset(DEFAULT_APPEARANCE, 'dark', 'aurora');
state = applyPreset(state, 'light', 'hano');
assert.equal(choiceFor(state, 'dark').recipe.backdrop, 'aurora');
assert.equal(choiceFor(state, 'light').recipe.backdrop, 'contour');
assert.equal(choiceFor(state, 'dark').presetId, 'aurora');

// It survives a save and load, and unknown values are dropped.
assert.deepEqual(normalizeAppearance(JSON.parse(JSON.stringify(state))), state);
const odd = JSON.parse(JSON.stringify(state));
odd.chromeThemes.dark.backdrop = 'lava';
assert.equal(choiceFor(normalizeAppearance(odd), 'dark').recipe.backdrop, undefined);

// Strength and motion: only kept when they differ from full strength and moving.
state = patchRecipe(state, 'dark', { backdropStrength: 40, backdropMotion: false });
assert.equal(choiceFor(state, 'dark').recipe.backdropStrength, 40);
assert.equal(choiceFor(state, 'dark').recipe.backdropMotion, false);
assert.equal(themeVariables(choiceFor(state, 'dark'), 'dark')['--app-field-strength'], '0.4');
state = patchRecipe(state, 'dark', { backdropStrength: 100, backdropMotion: true });
assert.ok(!('backdropStrength' in choiceFor(state, 'dark').recipe));
assert.ok(!('backdropMotion' in choiceFor(state, 'dark').recipe));
assert.equal(themeVariables(choiceFor(state, 'dark'), 'dark')['--app-field-strength'], '1');
state = patchRecipe(state, 'dark', { backdropStrength: 250 });
assert.ok(!('backdropStrength' in choiceFor(state, 'dark').recipe), 'out of range falls back to full strength');

// Sharing carries it; another preset drops it; an edit can remove it.
const shared = exportTheme('dark', choiceFor(state, 'dark'));
assert.equal(choiceFor(importTheme(DEFAULT_APPEARANCE, 'dark', shared), 'dark').recipe.backdrop, 'aurora');
assert.equal(choiceFor(applyPreset(state, 'dark', 'linear'), 'dark').recipe.backdrop, undefined);
assert.equal(choiceFor(patchRecipe(state, 'dark', { backdrop: undefined }), 'dark').recipe.backdrop, undefined);
// Any dark theme can take the aurora, keeping its own colours.
const linear = patchRecipe(applyPreset(DEFAULT_APPEARANCE, 'dark', 'linear'), 'dark', { backdrop: 'aurora' });
assert.equal(choiceFor(linear, 'dark').recipe.backdrop, 'aurora');
assert.equal(choiceFor(linear, 'dark').recipe.surface, '#0f0f11');

// The model: one cell per pitch, covering the window.
const sky = new DotFieldModel('aurora', 1440, 900);
assert.deepEqual([sky.cols, sky.rows], [1440 / DOT_PITCH, 900 / DOT_PITCH]);
assert.deepEqual([new DotFieldModel('aurora', 1001, 701).cols, new DotFieldModel('aurora', 1001, 701).rows], [167, 117], 'a partial cell at the edge is still drawn');
const keysAt = (model: DotFieldModel, t: number) => {
  model.compute(t);
  return Array.from({ length: model.cols * model.rows }, (_, cell) => model.key(cell, t));
};
const share = (keys: number[], from: number, to: number, model: DotFieldModel, test: (key: number) => boolean) => {
  let hit = 0;
  let all = 0;
  for (let r = Math.floor(from * model.rows); r < Math.floor(to * model.rows); r += 1) {
    for (let c = 0; c < model.cols; c += 1) {
      all += 1;
      if (test(keys[r * model.cols + c])) hit += 1;
    }
  }
  return hit / all;
};
const isDot = (key: number) => key > 0 && key < 1000;
const isStar = (key: number) => key >= 1000;

// Aurora: light hangs in the upper part, the lower part is dark with a few stars.
const night = keysAt(sky, 0);
assert.ok(share(night, 0, 0.2, sky, isDot) > 0.5, 'the top of the window is mostly lit');
assert.ok(share(night, 0.7, 1, sky, isDot) < 0.01, 'the bottom is not');
const stars = share(night, 0.7, 1, sky, isStar);
assert.ok(stars > 0.003 && stars < 0.03, `a sparse scatter of stars below (${stars})`);
assert.ok(night.every((key) => Number.isInteger(key) && key >= 0), 'every cell has a drawable key');
// It changes over time, slowly, and the same moment always looks the same.
const later = keysAt(sky, 5);
const changed = later.filter((key, cell) => key !== night[cell]).length / later.length;
assert.ok(changed > 0.02 && changed < 0.6, `the picture drifts (${changed})`);
const step = keysAt(sky, 5 + 1 / 12).filter((key, cell) => key !== later[cell]).length / later.length;
assert.ok(step < 0.12, `one frame redraws a small share of the cells (${step})`);
assert.deepEqual(keysAt(new DotFieldModel('aurora', 1440, 900), 5), later, 'the same moment draws the same picture');

// Contour: lines across the whole window in three inks by height, nothing else drawn over them.
const map = new DotFieldModel('contour', 1440, 900);
const lines = keysAt(map, 0);
const inked = share(lines, 0, 1, map, isDot);
assert.ok(inked > 0.25 && inked < 0.85, `lines, not a filled page (${inked})`);
assert.ok(!lines.some(isStar));
for (const [from, to] of [[0, 0.5], [0.5, 1]]) assert.ok(share(lines, from, to, map, isDot) > 0.2, 'both halves of the window carry lines');
assert.deepEqual([...new Set(lines.filter(Boolean).map((key) => Math.floor(key / 16)))].sort(), [0, 1, 2], 'low, middle and high ground each have an ink');
const linesLater = keysAt(map, 5);
const drift = linesLater.filter((key, cell) => key !== lines[cell]).length / lines.length;
assert.ok(drift > 0.05, `the lines travel (${drift})`);
assert.deepEqual(keysAt(new DotFieldModel('contour', 1440, 900), 5), linesLater);
const frameShare = keysAt(map, 5 + 1 / 12).filter((key, cell) => key !== linesLater[cell]).length / lines.length;
assert.ok(frameShare < 0.2, `one frame redraws a small share of the cells (${frameShare})`);

// How keys are drawn: a dot stays inside its cell, so clearing the cell clears the dot.
for (const [kind, keys] of [['aurora', night], ['contour', lines]] as const) {
  for (const key of new Set(keys)) {
    if (!key) continue;
    const style = dotStyle(kind, key);
    assert.ok(style.radius > 0 && style.radius < DOT_PITCH / 2, `${kind} key ${key} fits its cell`);
    assert.match(style.fill, /^rgba\(\d+,\d+,\d+,[01](\.\d+)?\)$/);
  }
}
// Brighter means bigger: the aurora's five sizes, the contour lines' ten.
assert.ok(dotStyle('aurora', 5).radius > dotStyle('aurora', 1).radius);
assert.ok(dotStyle('contour', 10).radius > dotStyle('contour', 1).radius);
// A backdrop this build does not know (the waves of an earlier draft) is dropped, not shown as something else.
const old = JSON.parse(JSON.stringify(state));
old.chromeThemes.light.backdrop = 'waves';
assert.equal(choiceFor(normalizeAppearance(old), 'light').recipe.backdrop, undefined);

console.log('Dot field: presets, recipe fields through save/edit/share, model coverage, contour lines, motion and repeatability, dot styles passed');
