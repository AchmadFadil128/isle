// SPDX-License-Identifier: GPL-3.0-or-later

// The assistant's rules that need no GNOME: `node --experimental-default-type=module --test tests/extension/*.test.js`.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {describeActions, failed, outcomeOf, slotsFor} from '../../gnome-extension/src/actionRules.js';

test('an action says what it did, or why it could not', () => {
    assert.deepEqual(outcomeOf(undefined), {ok: true, detail: ''});
    assert.deepEqual(outcomeOf('Files is open'), {ok: true, detail: 'Files is open'});
    // A D-Bus call that answered (an array) did it; one that failed answers null.
    assert.deepEqual(outcomeOf([]), {ok: true, detail: ''});
    assert.deepEqual(outcomeOf(null), {ok: false, detail: ''});
    assert.deepEqual(outcomeOf(false), {ok: false, detail: ''});
    assert.deepEqual(outcomeOf(failed('no such window is open')), {ok: false, detail: 'no such window is open'});
});

test('steps in progress read as people would say them', () => {
    assert.equal(describeActions([{type: 'open_app', app: 'Files'}]), 'Opening Files…');
    assert.equal(describeActions([{type: 'window'}, {type: 'arrange'}]), 'Moving the window and 1 more…');
    assert.equal(describeActions([]), 'Working…');
    assert.equal(describeActions([{type: 'teleport'}]), 'Working on it…');
});

test('windows are laid out over the whole screen', () => {
    assert.deepEqual(slotsFor('halves', 2), [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]]);
    assert.equal(slotsFor('', 4).length, 4);
    assert.deepEqual(slotsFor('', 1), [[0, 0, 1, 1]]);
    // Past four, a grid of three columns, every share inside the screen.
    const grid = slotsFor('grid', 7);
    assert.equal(grid.length, 7);
    for (const [x, y, width, height] of grid)
        assert.ok(x + width <= 1 + 1e-9 && y + height <= 1 + 1e-9);
});
