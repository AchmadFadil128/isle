// SPDX-License-Identifier: GPL-3.0-or-later

// The Shelf page: things to keep close, in three tabs.
//   Clipboard - what you copied (text, links, images, files), searchable
//   Notes     - what you pinned or wrote, to paste again and again
//   Files     - files dropped on the island, to drag out later
// Click a card to copy it. Opened with Super+V, the search field has the
// keyboard: type to search, ← → to choose, Enter to paste, Esc to close.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {icon, iconButton, pillButton, setEnabled} from '../widgets.js';
import {ClipsView} from './clips.js';
import {FilesView} from './files.js';
import {Page} from './page.js';

const TABS = [
    {name: 'clipboard', label: 'Clipboard'},
    {name: 'notes', label: 'Notes'},
    {name: 'files', label: 'Files'},
];
const FILTERS = [
    {kind: 'text', icon: 'isle-text', name: 'Text'},
    {kind: 'link', icon: 'isle-link', name: 'Links'},
    {kind: 'image', icon: 'isle-image', name: 'Images'},
    {kind: 'files', icon: 'isle-file', name: 'Files'},
];
/** How long "Clear all" waits for its confirming click. */
const CONFIRM_MS = 3000;

/** A text field that asks for the keyboard when clicked. */
function field(page, hint, iconName) {
    const entry = new St.Entry({style_class: 'isle-entry isle-shelf-field', hint_text: hint, can_focus: true, x_expand: true});
    entry.set_primary_icon(new St.Icon({gicon: icon(iconName), icon_size: 12, style_class: 'isle-shelf-field-icon'}));
    // Ask before the field takes focus: the grab moves focus itself.
    entry.clutter_text.connect('button-press-event', () => {
        page.emit('request-keyboard', true);
        return Clutter.EVENT_PROPAGATE;
    });
    return entry;
}

export const ShelfPage = GObject.registerClass({
    Signals: {
        // The Files tab came into or out of view; see `helperArea`.
        'helper-area-changed': {},
    },
}, class ShelfPage extends Page {
    _init(daemon, history, settings, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-shelf',
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL, spacing: 8}),
            height,
        });
        this.name = 'shelf';
        this._history = history;
        this._settings = settings;
        this._tab = 'clipboard';
        /** Items copied while the page is open; moved to the front on leaving. */
        this._copied = [];

        this._clips = new ClipsView(daemon, {notes: false});
        this._notes = new ClipsView(daemon, {notes: true});
        this._files = new FilesView(daemon);
        for (const view of [this._clips, this._notes])
            view.connect('activated', (_view, item, paste) => this._onActivated(view, item, paste));

        this.add_child(this._buildBar());
        const content = new St.Widget({layout_manager: new Clutter.BinLayout(), style_class: 'isle-shelf-content', x_expand: true, y_expand: true});
        for (const view of [this._clips, this._notes, this._files])
            content.add_child(view);
        this.add_child(content);

        this.watch(['clipboard'], () => this._updateClips());
        this.watch(['shelf'], () => this._files.update());
        this._settingsChanged = settings.connect('changed::clipboard-history', () => this._updateClips());
        this.connect('destroy', () => settings.disconnect(this._settingsChanged));
        this._updateClips();
        this.showTab('clipboard');
    }

    get headerTitle() {
        return 'Shelf';
    }

    // Building

    _buildBar() {
        const bar = new St.BoxLayout({style_class: 'isle-shelf-bar'});

        const tabs = new St.BoxLayout({style_class: 'isle-segmented'});
        this._tabButtons = new Map();
        for (const {name, label: text} of TABS) {
            const button = new St.Button({style_class: 'isle-segment', label: text, can_focus: true});
            button.connect('clicked', () => this.showTab(name));
            this._tabButtons.set(name, button);
            tabs.add_child(button);
        }
        bar.add_child(tabs);

        // Clipboard: type filters, search and Clear all.
        this._clipboardControls = new St.BoxLayout({style_class: 'isle-shelf-controls', x_expand: true});
        const filters = new St.BoxLayout({style_class: 'isle-segmented isle-segmented-icons'});
        this._filterButtons = new Map();
        for (const filter of FILTERS) {
            const button = new St.Button({
                style_class: 'isle-segment',
                child: new St.Icon({gicon: icon(filter.icon), icon_size: 13}),
                accessible_name: `Only ${filter.name.toLowerCase()}`,
                can_focus: true,
            });
            button.connect('clicked', () => this._setFilter(this._filter === filter.kind ? null : filter.kind));
            this._filterButtons.set(filter.kind, button);
            filters.add_child(button);
        }
        this._filter = null;
        this._clipboardControls.add_child(filters);

        this._search = field(this, 'Search', 'isle-search');
        const text = this._search.clutter_text;
        text.connect('text-changed', () => (this._clips.query = this._search.text));
        text.connect('activate', () => this._clips.activateSelected());
        text.connect('key-press-event', (_text, event) => this._onSearchKey(event));
        // The selection outline only means something while typing.
        text.connect('key-focus-in', () => (this._clips.keyboard = true));
        text.connect('key-focus-out', () => (this._clips.keyboard = false));
        this._clipboardControls.add_child(this._search);

        this._clear = iconButton('isle-trash', 'isle-button-flat isle-shelf-clear', () => this._askToClear(),
            {size: 14, accessibleName: 'Clear the clipboard history'});
        this._confirm = pillButton('Clear all', 'isle-pill-small isle-shelf-confirm', () => this._clearHistory());
        this._confirm.hide();
        this._clipboardControls.add_child(this._clear);
        this._clipboardControls.add_child(this._confirm);
        bar.add_child(this._clipboardControls);

        // Notes: a field to write one.
        this._notesControls = new St.BoxLayout({style_class: 'isle-shelf-controls', x_expand: true});
        this._note = field(this, 'Write a note · Enter to save', 'isle-note');
        this._note.clutter_text.connect('activate', () => this._addNote());
        this._note.clutter_text.connect('key-press-event', (_text, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._note.text = '';
            this.emit('request-keyboard', false);
            return Clutter.EVENT_STOP;
        });
        this._notesControls.add_child(this._note);
        bar.add_child(this._notesControls);
        return bar;
    }

    // Tabs

    /** Switches to tab `name`; with `focusSearch`, the search field takes the keyboard. */
    showTab(name, {focusSearch = false} = {}) {
        const changed = name !== this._tab;
        this._tab = name;
        for (const [tab, button] of this._tabButtons) {
            if (tab === name)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
        this._clips.visible = name === 'clipboard';
        this._notes.visible = name === 'notes';
        this._files.visible = name === 'files';
        this._clipboardControls.visible = name === 'clipboard';
        this._notesControls.visible = name === 'notes';
        if (focusSearch) {
            this._search.text = '';
            this._search.grab_key_focus();
        }
        if (changed)
            this.emit('helper-area-changed');
    }

    /** The Files tab while it is on screen, for the drag-and-drop helper to cover. */
    get helperArea() {
        return this._tab === 'files' ? this._files : null;
    }

    set helperActive(active) {
        this._files.helperActive = active;
    }

    // Clipboard

    _updateClips() {
        const off = !this._settings.get_boolean('clipboard-history');
        this._clips.update({off});
        this._notes.update();
        const unpinned = (this.daemon.state.clipboard ?? []).some(item => !item.pinned);
        setEnabled(this._clear, unpinned);
    }

    _setFilter(kind) {
        this._filter = kind;
        for (const [filterKind, button] of this._filterButtons) {
            if (filterKind === kind)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
        this._syncFilterIcons();
        this._clips.kind = kind;
    }

    /** The icons are drawn white; the ones not chosen are dimmed. */
    _syncFilterIcons() {
        for (const [kind, button] of this._filterButtons)
            button.child.opacity = !this._filter || kind === this._filter ? 255 : 130;
    }

    _onSearchKey(event) {
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Left:
            this._clips.moveSelection(-1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Right:
            this._clips.moveSelection(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Escape:
            // First Esc clears the search; the next one closes the island.
            if (!this._search.text)
                return Clutter.EVENT_PROPAGATE;
            this._search.text = '';
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    async _onActivated(view, item, paste) {
        if (!await this._history.copy(item, {touch: paste}))
            return;
        if (paste) {
            this.emit('request-close');
            this._history.paste();
        } else {
            view.flash(item, 'object-select-symbolic', 'Copied');
            this._copied = [...this._copied.filter(id => id !== item.id), item.id];
        }
    }

    _askToClear() {
        this._clear.hide();
        this._confirm.show();
        this.later('confirm', CONFIRM_MS, () => this._endConfirm());
    }

    _endConfirm() {
        this.cancel('confirm');
        this._confirm.hide();
        this._clear.show();
    }

    _clearHistory() {
        this._endConfirm();
        this.daemon.call('clipboard', 'Clear');
    }

    // Notes

    _addNote() {
        const text = this._note.text.trim();
        if (!text)
            return;
        this._note.text = '';
        this.daemon.call('clipboard', 'AddNote', text);
    }

    // Page

    onActivate() {
        this.daemon.call('shelf', 'Refresh');
    }

    onDeactivate() {
        for (const id of this._copied)
            this.daemon.call('clipboard', 'Touch', id);
        this._copied = [];
        // Each visit starts with an empty search.
        this._search.text = '';
        this._note.text = '';
        this._endConfirm();
    }
});
