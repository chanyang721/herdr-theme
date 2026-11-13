import test from 'node:test';
import assert from 'node:assert/strict';
import {peekMode} from '../mods/sixfold-desk/arrival-model.js';

// A new alert peeks into any card on screen. Before, only a card whose alerts sat on its merged meta
// line took a peek; a card with a separate alerts row (where Slack usually arrives) got the small popup.
test('a card with a separate alerts row takes a Slack and a Linear peek, like a merged card', () => {
  assert.deepEqual(peekMode({card: {merged: false, linear: false}, source: 'slack'}), ['peek', '']);
  assert.deepEqual(peekMode({card: {merged: false, linear: true}, source: 'linear'}), ['peek', '']);
  assert.deepEqual(peekMode({card: {merged: true, linear: true}, source: 'slack'}), ['peek', '']);
});

test('the quiet and popup rules stay: no sidebar, motion off, off screen, open search or popover, no Linear chip', () => {
  const card = {merged: false, linear: true};
  assert.deepEqual(peekMode({host: false, card}), ['', 'no sidebar']);
  assert.deepEqual(peekMode({motion: false, card}), ['', 'motion off']);
  assert.deepEqual(peekMode({card: null}), ['', 'card not on screen']);
  assert.deepEqual(peekMode({card, issuesOpen: true}), ['quiet', 'an issue search is open']);
  assert.deepEqual(peekMode({card, popoverOpen: true}), ['quiet', 'an alert popover is open']);
  assert.deepEqual(peekMode({card: {merged: false, linear: false}, source: 'linear'}), ['', 'no Linear chip']);
});
