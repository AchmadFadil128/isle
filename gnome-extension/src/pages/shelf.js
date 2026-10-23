// SPDX-License-Identifier: GPL-3.0-or-later

// The Shelf page: Clipboard (copy history; Super+V to search, ← → Enter to paste)
// and Files (dropped files to drag or copy into any app).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Thumbnails} from '../thumbnails.js';
import {icon, iconButton, label, pillButton, setEnabled} from '../widgets.js';
import {ClipsView} from './clips.js';
import {FilesView, SHELF_CAPACITY} from './files.js';
import {Page} from './page.js';

const TABS = [
    {name: 'clipboard', label: 'Clipboard'},
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
/** Crossfade between tabs. */
const TAB_FADE_MS = 150;
/** How long the island glows after a file lands on the shelf. */
const GLOW_MS = 2200;

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
        this._filter = null;
        /** Items copied while the page is open; moved to the front on leaving. */
        this._copied = [];
        /** Views that changed while the page was closed, redrawn on opening. */
        this._stale = new Set();
        /** A file is being dragged towards the island. */
        this._dropping = false;
        /** The files on the shelf last time it changed, to tell new ones. */
        this._shelved = null;
        /** The colour the island glows in after a file landed, or null. */
        this._glow = null;

        this._clips = new ClipsView(daemon);
        this._clips.connect('activated', (_view, item, paste) => this._onActivated(item, paste));
        this._thumbnails = new Thumbnails();
        this._files = new FilesView(daemon, this._thumbnails);
        // The helper window must match the tab exactly, so it follows every
        // change of size or place (sync only reads them; nothing relayouts).
        this._files.connect('notify::allocation', () => {
            if (this._tab === 'files')
                this.emit('helper-area-changed');
        });

        this.add_child(this._buildBar());
        const content = new St.Widget({layout_manager: new Clutter.BinLayout(), style_class: 'isle-shelf-content', x_expand: true, y_expand: true});
        content.add_child(this._clips);
        content.add_child(this._files);
        this.add_child(content);

        // Copies arrive all day; the cards are only drawn while they can be seen.
        this.watch(['clipboard'], () => this._refresh('clips'));
        this.watch(['shelf'], () => {
            this._noticeNewFiles();
            this._refresh('files');
        });
        this._settingsChanged = settings.connect('changed::clipboard-history', () => this._refresh('clips'));
        this.connect('destroy', () => {
            this._destroyed = true;
            settings.disconnect(this._settingsChanged);
            this._thumbnails.destroy();
        });
        this._updateClips();
        this._updateFilesHint();
        this.showTab('clipboard');
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

        // Clipboard: type filters, search (a button that opens into a field)
        // and Clear all.
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
        this._clipboardControls.add_child(filters);

        this._search = new St.Entry({style_class: 'isle-entry isle-shelf-field', hint_text: 'Search', can_focus: true, x_expand: true});
        this._search.set_primary_icon(new St.Icon({gicon: icon('isle-search'), icon_size: 12, style_class: 'isle-shelf-field-icon'}));
        const text = this._search.clutter_text;
        // Ask for the keyboard before the field takes focus: the grab moves focus itself.
        text.connect('button-press-event', () => {
            this.emit('request-keyboard', true);
            return Clutter.EVENT_PROPAGATE;
        });
        text.connect('text-changed', () => {
            if (!this._clearingSearch)
                this._clips.query = this._search.text;
        });
        text.connect('activate', () => this._clips.activateSelected());
        text.connect('key-press-event', (_text, event) => this._onSearchKey(event));
        // The selection outline only means something while typing.
        text.connect('key-focus-in', () => (this._clips.keyboard = true));
        text.connect('key-focus-out', () => {
            this._clips.keyboard = false;
            if (!this._search.text)
                this._closeSearch();
        });
        this._search.hide();
        // Keeps the buttons at the end while the field is closed.
        this._searchSpacer = new St.Widget({x_expand: true});
        this._searchButton = iconButton('isle-search', 'isle-button-round isle-button-small',
            () => this._openSearch(), {size: 13, accessibleName: 'Search the clipboard history'});
        this._clipboardControls.add_child(this._searchSpacer);
        this._clipboardControls.add_child(this._search);
        this._clipboardControls.add_child(this._searchButton);

        this._clear = iconButton('isle-trash', 'isle-button-round isle-button-small', () => this._askToClear(),
            {size: 14, accessibleName: 'Clear the clipboard history'});
        this._confirm = pillButton('Clear all', 'isle-pill-small isle-shelf-confirm', () => this._clearHistory());
        this._confirm.hide();
        this._clipboardControls.add_child(this._clear);
        this._clipboardControls.add_child(this._confirm);
        bar.add_child(this._clipboardControls);

        // Files: what the tab is for.
        this._filesHint = label('', 'isle-shelf-hint', {
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        bar.add_child(this._filesHint);
        return bar;
    }

    // Search

    /** Opens the search field in place of its button, ready to type. */
    _openSearch() {
        this._searchSpacer.hide();
        this._searchButton.hide();
        this._search.show();
        this.emit('request-keyboard', true);
        this._search.grab_key_focus();
    }

    _closeSearch() {
        this._search.hide();
        this._searchSpacer.show();
        this._searchButton.show();
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
        const shown = name === 'clipboard' ? this._clips : this._files;
        const hidden = shown === this._clips ? this._files : this._clips;
        hidden.hide();
        if (changed && this.mapped) {
            shown.opacity = 0;
            shown.show();
            shown.ease({
                opacity: 255,
                duration: TAB_FADE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                // Laid out and settled: the helper can measure the tab now.
                onComplete: () => this.emit('helper-area-changed'),
            });
        } else {
            shown.opacity = 255;
            shown.show();
        }
        this._clipboardControls.visible = name === 'clipboard';
        this._filesHint.visible = name === 'files';
        if (name !== 'files' && this._glow) {
            this.cancel('glow');
            this._setGlow(null);
        }
        // Files are dragged with the pointer, which apps (the drag-and-drop
        // helper included) only get while the island lets go of the keyboard.
        if (name === 'files')
            this.emit('request-keyboard', false);
        if (focusSearch) {
            this._search.text = '';
            this._openSearch();
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

    /** Whether the drag-and-drop helper is installed. */
    set helperAvailable(available) {
        this._files.helperAvailable = available;
    }

    get tint() {
        return this._glow;
    }

    get tintStyle() {
        return 'glow';
    }

    // Updates

    /** Redraws a view now if the page is open, else when it is next warmed up or opens. */
    _refresh(view) {
        if (!this.active) {
            this._stale.add(view);
            // Also while still on screen, fading out as the island closes.
            this.markCold({force: true});
            return;
        }
        if (view === 'clips') {
            this._updateClips();
        } else {
            this._files.update();
            this._updateFilesHint();
        }
    }

    /** A file is on its way to the island: say whether it can land. */
    set dropping(dropping) {
        this._dropping = dropping;
        this._files.dropping = dropping;
        this._updateFilesHint();
    }

    /** Says what the Files tab is for, and when it is full. */
    _updateFilesHint() {
        const count = (this.daemon.state.shelf ?? []).length;
        const full = count >= SHELF_CAPACITY;
        let text;
        if (this._dropping)
            text = full ? 'Full · remove a file first' : 'Drop to keep it on the shelf';
        else if (this._glow)
            text = 'Added · click to copy, or drag it into any app';
        else if (full)
            text = 'Full · remove a file to add another';
        else if (count === 0)
            text = 'Drop files here, then drag them into any app';
        else
            text = `${count} of ${SHELF_CAPACITY} · click to copy, or drag into any app`;
        this._filesHint.text = text;
        if (this._dropping || this._glow)
            this._filesHint.add_style_class_name('active');
        else
            this._filesHint.remove_style_class_name('active');
    }

    /** Glows the island in the colour of a file that just landed, while Files is shown. */
    async _noticeNewFiles() {
        const items = this.daemon.state.shelf;
        if (!items) {
            // isled went away; what it lists when back is not new.
            this._shelved = null;
            return;
        }
        const uris = items.map(item => item.uri);
        const known = this._shelved;
        this._shelved = uris;
        // Newest first: the first new one is the latest.
        const landed = known && uris.find(uri => !known.includes(uri));
        if (!landed || !this.active || this._tab !== 'files')
            return;
        const shown = await this._thumbnails.get(landed);
        if (!shown || this._destroyed || !this.active || this._tab !== 'files')
            return;
        this._setGlow(shown.color);
        this.later('glow', GLOW_MS, () => this._setGlow(null));
    }

    _setGlow(color) {
        this._glow = color;
        this._updateFilesHint();
        this.emit('tint-changed');
    }

    /** While the screen is shared or recorded, the clipboard history stays out of sight. */
    set sharing(sharing) {
        if (sharing === Boolean(this._sharing))
            return;
        this._sharing = sharing;
        this._updateClips();
        this.markCold();
    }

    _updateClips() {
        const off = !this._settings.get_boolean('clipboard-history');
        this._clips.update({off, hidden: Boolean(this._sharing)});
        const unpinned = (this.daemon.state.clipboard ?? []).some(item => !item.pinned);
        setEnabled(this._clear, unpinned);
    }

    // Clipboard

    _setFilter(kind) {
        this._filter = kind;
        for (const [filterKind, button] of this._filterButtons) {
            if (filterKind === kind)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
            // The icons are drawn white; the ones not chosen are dimmed.
            button.child.opacity = !kind || filterKind === kind ? 255 : 130;
        }
        this._clips.kind = kind;
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

    async _onActivated(item, paste) {
        // The extension may have stopped while the item was fetched.
        if (!await this._history.copy(item, {touch: paste}) || this._destroyed)
            return;
        if (paste) {
            this.emit('request-close');
            this._history.paste();
        } else {
            this._clips.flash(item, 'isle-check-symbolic', 'Copied');
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

    // Page

    /** Redraws the views that changed while closed. */
    _flushStale() {
        const clips = this._stale.delete('clips');
        if (clips)
            this._updateClips();
        if (this._stale.delete('files')) {
            this._files.update();
            this._updateFilesHint();
        }
        return clips;
    }

    warmUp() {
        this._flushStale();
    }

    onActivate() {
        if (!this._flushStale())
            this._clips.refreshAges();
        this.daemon.call('shelf', 'Refresh');
    }

    onDeactivate() {
        this._glow = null;
        this._updateFilesHint();
        // Skipping any removed or cleared since.
        const items = this.daemon.state.clipboard ?? [];
        for (const id of this._copied.filter(copied => items.some(item => item.id === copied)))
            this.daemon.call('clipboard', 'Touch', id);
        this._copied = [];
        // Each visit starts with an empty search; the cards follow out of sight (see `warmUp`).
        if (this._search.text) {
            this._clearingSearch = true;
            this._search.text = '';
            this._clearingSearch = false;
            this._clips.clearQuery();
            this._refresh('clips');
        }
        this._closeSearch();
        this._endConfirm();
    }
});
