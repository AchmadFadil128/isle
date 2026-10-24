// SPDX-License-Identifier: GPL-3.0-or-later

// Formatting that needs GLib but not GNOME Shell: `gjs -m tests/extension/format.gjs.js`.

import {answerPlain, shortcutLabel, weekendDays} from '../../gnome-extension/src/format.js';

let failures = 0;
function check(what, actual, expected) {
    if (JSON.stringify(actual) === JSON.stringify(expected))
        return;
    failures++;
    printerr(`FAIL ${what}: ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
}

check('Super+I', shortcutLabel('<Super>i'), 'Super+I');
check('Ctrl+Alt+Space', shortcutLabel('<Primary><Alt>space'), 'Ctrl+Alt+Space');
check('no shortcut', shortcutLabel(''), '');
check('weekend in Indonesia', weekendDays('id_ID.UTF-8'), [0, 6]);
check('weekend in Saudi Arabia', weekendDays('ar_SA.UTF-8'), [5, 6]);
check('weekend with no region', weekendDays('C.UTF-8'), [0, 6]);
check('bold in an answer', answerPlain('Playing **Late Night Blue** by The Harbor Trio.'), 'Playing Late Night Blue by The Harbor Trio.');
check('code and a list', answerPlain('Run `sudo apt update`:\n- first\n- second'), 'Run sudo apt update: • first • second');
check('plain stays', answerPlain('Two things today.'), 'Two things today.');

if (failures)
    imports.system.exit(1);
print('format: all passed');
