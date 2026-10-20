// SPDX-License-Identifier: GPL-3.0-or-later

// Clipboard history: watches what is copied and hands it to isled, which
// keeps the list (see Clipboard1 in docs/dbus-api.md); puts an item back on
// the clipboard; and pastes it into the window in front.
//
// Only GNOME Shell can read the clipboard of every app on Wayland, so this
// lives in the extension. It is event driven: Mutter reports each new owner
// of the clipboard, and nothing polls.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

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
/** Terminals paste with Ctrl+Shift+V. Matched against the window class. */
const TERMINALS = ['terminal', 'console', 'kgx', 'kitty', 'alacritty', 'wezterm', 'foot',
    'konsole', 'tilix', 'terminator', 'ptyxis', 'xterm', 'blackbox', 'ghostty'];

/** File URIs on the clipboard as Files or a URI list describes them. */
function parseUris(text, mimetype) {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    // Files starts its list with "copy" or "cut".
    const uris = mimetype === FILES_TYPE ? lines.slice(1) : lines.filter(line => !line.startsWith('#'));
    return uris.filter(uri => uri.startsWith('file://'));
}

export class ClipboardHistory {
    constructor(daemon, settings) {
        this._daemon = daemon;
        this._settings = settings;
        this._clipboard = St.Clipboard.get_default();
        /** Set while we put something on the clipboard ourselves. */
        this._ownCopy = false;
        this._timeouts = new Set();

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
        if (!text?.trim() || text.length > MAX_TEXT_BYTES)
            return;
        this._daemon.call('clipboard', 'AddText', text, appId);
    }

    /**
     * Puts `item` (from `Daemon.state.clipboard`) back on the clipboard.
     * Unless `touch` is false, the item also moves to the front of the
     * history; callers that keep the history on screen do that later, so
     * cards don't jump under the pointer.
     */
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
            if (text === undefined)
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

    /**
     * Pastes into the window in front, once it has the keyboard again (call
     * after the island lets go of it).
     */
    paste() {
        this._later(PASTE_DELAY_MS, () => {
            // Only into an app window: with none in front, or something of
            // the shell's own still holding the keyboard, the keys would land
            // in the wrong place. The item stays copied either way.
            const focus = global.stage.get_key_focus();
            if (!global.display.focus_window || (focus && focus !== global.stage))
                return;
            const windowClass = global.display.focus_window?.get_wm_class()?.toLowerCase() ?? '';
            const terminal = TERMINALS.some(name => windowClass.includes(name));
            const keys = terminal
                ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
                : [Clutter.KEY_Control_L, Clutter.KEY_v];
            this._keyboard ??= Clutter.get_default_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            // Virtual devices take monotonic microseconds.
            const time = GLib.get_monotonic_time();
            keys.forEach(key => this._keyboard.notify_keyval(time, key, Clutter.KeyState.PRESSED));
            [...keys].reverse().forEach(key => this._keyboard.notify_keyval(time, key, Clutter.KeyState.RELEASED));
        });
    }

    _later(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    destroy() {
        this._selection.disconnect(this._ownerChanged);
        this._timeouts.forEach(id => GLib.source_remove(id));
        this._timeouts.clear();
        this._keyboard?.run_dispose();
        this._keyboard = null;
    }
}
