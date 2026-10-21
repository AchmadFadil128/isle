// SPDX-License-Identifier: GPL-3.0-or-later

// Clipboard history: hands each copy to isled, which keeps the list (Clipboard1 in docs/dbus-api.md),
// and puts items back or pastes them. Lives here: only GNOME Shell can read every app's clipboard on Wayland.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {clutterBackend} from './compat.js';

const CLIPBOARD = St.ClipboardType.CLIPBOARD;
/** Set by password managers (KeePassXC and others) on secrets they copy. */
const SECRET_HINT = 'x-kde-passwordManagerHint';
/** How Files puts copied files on the clipboard. */
const FILES_TYPE = 'x-special/gnome-copied-files';
const URI_LIST_TYPE = 'text/uri-list';
const IMAGE_TYPE = 'image/png';
/** Larger copies are not kept (isled refuses them too). */
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
/** Time for the window in front to get the keyboard back before pasting. */
const PASTE_DELAY_MS = 120;
/** Terminals paste with Ctrl+Shift+V. Matched against the window's class and app id. */
const TERMINALS = ['terminal', 'console', 'kgx', 'ptyxis', 'kitty', 'alacritty', 'wezterm', 'konsole',
    'xterm', 'rxvt', 'tilix', 'terminator', 'foot', 'blackbox', 'ghostty', 'warp', 'tabby', 'hyper',
    'guake', 'tilda'];
/** Keyboard layouts whose keys give Latin letters (Dvorak and Colemak are variants of these). */
const LATIN_LAYOUTS = ['us', 'gb', 'id', 'de', 'fr', 'es', 'it', 'pt', 'br', 'nl', 'be', 'ch', 'at', 'se', 'no',
    'dk', 'fi', 'is', 'pl', 'cz', 'sk', 'hu', 'ro', 'hr', 'si', 'tr', 'ee', 'lv', 'lt', 'ie', 'ca', 'latam', 'au',
    'za', 'nz', 'ph', 'my', 'vn', 'epo'];

export function isTerminal(window) {
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    const names = [window.get_wm_class(), window.get_wm_class_instance(), app?.get_id()]
        .map(name => name?.toLowerCase() ?? '').join(' ');
    return TERMINALS.some(name => names.includes(name));
}

/** The input source in use, [type, id] as GNOME keeps them: the most recently used one comes first. */
function currentInputSource() {
    const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.input-sources'});
    const [first] = settings.get_value('mru-sources').deep_unpack();
    return first ?? settings.get_value('sources').deep_unpack()[0] ?? ['xkb', 'us'];
}

/** Whether the keyboard layout in use types Latin letters (an input method counts as not). */
export function onLatinLayout() {
    try {
        const [type, id] = currentInputSource();
        return type === 'xkb' && LATIN_LAYOUTS.includes(id.split(/[+(]/)[0]);
    } catch {
        return true;
    }
}

/** File URIs on the clipboard as Files or a URI list describes them. */
function parseUris(text, mimetype) {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    // Files starts its list with "copy" or "cut".
    const uris = mimetype === FILES_TYPE ? lines.slice(1) : lines.filter(line => !line.startsWith('#'));
    return uris.filter(uri => uri.startsWith('file://'));
}

/** Linux input key codes for Ctrl, Shift and V, for layouts whose V key types something else. */
const KEY_LEFTCTRL = 29;
const KEY_LEFTSHIFT = 42;
const KEY_V = 47;

export class ClipboardHistory {
    constructor(daemon, settings) {
        this._daemon = daemon;
        this._settings = settings;
        this._clipboard = St.Clipboard.get_default();
        /** Set while we put something on the clipboard ourselves. */
        this._ownCopy = false;
        this._timeouts = new Set();
        // Made now: a new virtual device joins the seat a moment later, and drops the first paste.
        this._keyboard = clutterBackend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        this._selection = global.display.get_selection();
        this._ownerChanged = this._selection.connect('owner-changed', (_selection, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._onCopied();
        });
    }

    get enabled() {
        return this._settings.get_boolean('clipboard-history');
    }

    _onCopied() {
        if (this._ownCopy) {
            this._ownCopy = false;
            return;
        }
        if (!this.enabled)
            return;
        const mimetypes = this._clipboard.get_mimetypes(CLIPBOARD);
        if (mimetypes.length === 0 || mimetypes.includes(SECRET_HINT))
            return;
        const app = Shell.WindowTracker.get_default().focus_app;
        // Windows without a desktop file get made-up ids ("window:5").
        const appId = app && !app.is_window_backed() ? app.get_id() : '';
        if (this._settings.get_strv('clipboard-ignored-apps').includes(appId))
            return;

        const filesType = [FILES_TYPE, URI_LIST_TYPE].find(type => mimetypes.includes(type));
        if (filesType)
            this._clipboard.get_content(CLIPBOARD, filesType, (_clipboard, bytes) => this._addFiles(bytes, filesType, appId));
        else if (mimetypes.includes(IMAGE_TYPE))
            this._clipboard.get_content(CLIPBOARD, IMAGE_TYPE, (_clipboard, bytes) => this._addImage(bytes, appId));
        else
            this._clipboard.get_text(CLIPBOARD, (_clipboard, text) => this._addText(text, appId));
    }

    _addFiles(bytes, mimetype, appId) {
        const uris = bytes ? parseUris(new TextDecoder().decode(bytes.get_data() ?? []), mimetype) : [];
        if (uris.length > 0)
            this._daemon.call('clipboard', 'AddFiles', uris, appId);
        else // e.g. a link dragged from a browser; keep it as text
            this._clipboard.get_text(CLIPBOARD, (_clipboard, text) => this._addText(text, appId));
    }

    _addImage(bytes, appId) {
        const size = bytes?.get_size() ?? 0;
        if (size > 0 && size <= MAX_IMAGE_BYTES)
            this._daemon.call('clipboard', 'AddImage', bytes.get_data(), appId);
    }

    _addText(text, appId) {
        if (!text?.trim())
            return;
        // The limit is in bytes; only long texts need counting.
        if (text.length * 3 > MAX_TEXT_BYTES && new TextEncoder().encode(text).length > MAX_TEXT_BYTES)
            return;
        this._daemon.call('clipboard', 'AddText', text, appId);
    }

    // Puts `item` (from `Daemon.state.clipboard`) back on the clipboard. `touch: false` leaves it in place
    // in the history, for callers that move it later so cards don't jump under the pointer.
    async copy(item, {touch = true} = {}) {
        let bytes = null, mimetype = null, text = null;
        switch (item.kind) {
        case 'image':
            try {
                bytes = GLib.Bytes.new(GLib.file_get_contents(item.image)[1]);
                mimetype = IMAGE_TYPE;
            } catch (e) {
                console.warn(`Isle: could not read ${item.image}: ${e.message}`);
                return false;
            }
            break;
        case 'files':
            bytes = GLib.Bytes.new(new TextEncoder().encode(['copy', ...item.uris].join('\n')));
            mimetype = FILES_TYPE;
            break;
        default: {
            const result = await this._daemon.call('clipboard', 'GetText', item.id);
            text = result?.[0];
            if (text === undefined || this._destroyed)
                return false;
        }
        }

        this._ownCopy = true;
        if (text !== null)
            this._clipboard.set_text(CLIPBOARD, text);
        else
            this._clipboard.set_content(CLIPBOARD, mimetype, bytes);
        // If the clipboard did not change hands (same content), don't skip
        // the user's next copy.
        this._later(500, () => (this._ownCopy = false));
        if (touch)
            this._daemon.call('clipboard', 'Touch', item.id);
        return true;
    }

    /** Pastes into the window in front, once it has the keyboard again (call after the island lets go). */
    paste() {
        this._later(PASTE_DELAY_MS, () => {
            // Only into an app window: otherwise the keys would land in the wrong place. The item stays copied.
            const focus = global.stage.get_key_focus();
            if (!global.display.focus_window || (focus && focus !== global.stage))
                return;
            this.pressPaste(isTerminal(global.display.focus_window));
        });
    }

    /** The shared virtual keyboard, for typing into the window in front. */
    get keyboard() {
        return this._keyboard;
    }

    // Presses Ctrl+V (Ctrl+Shift+V in a terminal): by symbol on a Latin layout (right on Dvorak, or
    // with Ctrl and Caps Lock swapped), by key code on others, where the V key types another letter.
    pressPaste(terminal) {
        const time = GLib.get_monotonic_time();
        if (onLatinLayout()) {
            const keys = terminal ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v] : [Clutter.KEY_Control_L, Clutter.KEY_v];
            keys.forEach(key => this._keyboard.notify_keyval(time, key, Clutter.KeyState.PRESSED));
            [...keys].reverse().forEach(key => this._keyboard.notify_keyval(time, key, Clutter.KeyState.RELEASED));
        } else {
            const codes = terminal ? [KEY_LEFTCTRL, KEY_LEFTSHIFT, KEY_V] : [KEY_LEFTCTRL, KEY_V];
            codes.forEach(code => this._keyboard.notify_key(time, code, Clutter.KeyState.PRESSED));
            [...codes].reverse().forEach(code => this._keyboard.notify_key(time, code, Clutter.KeyState.RELEASED));
        }
    }

    _later(ms, callback) {
        if (this._destroyed)
            return;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    destroy() {
        this._destroyed = true;
        this._selection.disconnect(this._ownerChanged);
        this._timeouts.forEach(id => GLib.source_remove(id));
        this._timeouts.clear();
        this._keyboard?.run_dispose();
        this._keyboard = null;
    }
}
