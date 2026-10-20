// SPDX-License-Identifier: GPL-3.0-or-later

// Isle: a dynamic island for the GNOME top bar. The extension only draws;
// isled (the Rust daemon) tracks media, timers and system state over D-Bus.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Controller} from './src/controller.js';
import {setIconDir} from './src/widgets.js';

export default class IsleExtension extends Extension {
    enable() {
        setIconDir(this.dir.get_child('icons'));
        this._controller = new Controller(this);
    }

    disable() {
        this._controller?.destroy();
        this._controller = null;
    }
}
