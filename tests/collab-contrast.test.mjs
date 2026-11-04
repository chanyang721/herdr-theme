import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { collabColor, onCollab, contrast, COLLAB_CONTRAST } from '../mods/sixfold-desk/collab.js';

// The tokens the app resolves for a theme file, as herdr-app's settings.rs `resolve` does
// for the ones the collaboration colour is drawn over: `surface` is the palette background
// unless overridden; `selected` is a translucent overlay on it unless overridden.
const hex = value => { const h = value.slice(1, 7); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const light = value => { const [r, g, b] = hex(value).map(c => c / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5; };
function tokens(file) {
  const bg = file.background;
  const colors = file.colors ?? {};
  const isLight = light(bg);
  return {
    background: colors.background ?? bg,
    surface: colors.surface ?? bg,
    selected: colors.selected ?? (isLight ? '#00000012' : '#ffffff17'),
    foreground: colors.foreground ?? (isLight ? '#1b1b1e' : '#eeeeef'),
  };
}
// An overlay's opaque result on the surface, for the ratio check below.
function flatten(value, base) {
  const h = value.slice(1);
  if (h.length !== 8) return hex(value);
  const a = parseInt(h.slice(6, 8), 16) / 255, top = hex(value), under = hex(base);
  return top.map((c, i) => Math.round(c * a + under[i] * (1 - a)));
}

test('every shipped theme reads the partner name at 4.5:1 or more, on a plain and a selected header', async () => {
  const dir = new URL('../themes/', import.meta.url);
  const names = (await readdir(dir)).filter(name => name.endsWith('.json'));
  assert(names.length >= 4, 'sixfold-night, sixfold-day, win98, atom-one-dark at least');
  for (const name of names) {
    const t = tokens(JSON.parse(await readFile(new URL(name, dir), 'utf8')));
    for (const ground of [t.surface, t.selected]) {
      const color = collabColor(t, ground);
      const ratio = contrast(hex(color), flatten(ground, t.surface));
      assert(ratio >= COLLAB_CONTRAST, `${name} on ${ground}: ${color} is ${ratio.toFixed(2)}:1`);
    }
    const badge = collabColor(t);
    assert(contrast(hex(onCollab(badge)), hex(badge)) >= COLLAB_CONTRAST, `${name}: badge text`);
  }
});

test('win98 grey gets a darker periwinkle, not the light one', () => {
  const t = { background: '#000000', surface: '#c0c0c0', foreground: '#000000' };
  const color = collabColor(t);
  assert.notEqual(color, '#A9B8FF');
  assert(contrast(hex(color), hex('#c0c0c0')) >= COLLAB_CONTRAST);
});
