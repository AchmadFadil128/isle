// SPDX-License-Identifier: GPL-3.0-or-later

// Cards for the Shelf page's Clipboard tab, pinned first, then newest. Click to copy; on hover: pin,
// a hand-off (text to Tasks, images and files to Files) and ×. The keyboard can select and paste.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import * as Format from '../format.js';
import {icon, iconButton, label} from '../widgets.js';

/** isled keeps 20 recent items and up to 10 pinned ones. */
const MAX_CARDS = 30;
const MAX_PINNED = 10;
/** The Files tab holds this many files. */
const SHELF_CAPACITY = 6;
/** Cards drawn at once (about a screenful); the rest follow a few per frame so opening never stutters. */
const FIRST_CARDS = 6;
const CARDS_PER_IDLE = 6;
/** How long "Copied" and friends stay on a card. */
const FEEDBACK_MS = 900;
/** Looks like code: braces, semicolons at line ends, arrows, tags, indents. */
const CODE_PATTERN = /[{};]\s*$|=>|<\/?[a-z][\w-]*>|^\s{2,}\S|\b(function|const|def|class|import|return)\b/m;

/** The app that an item was copied from, if it is still installed. */
function appFor(appId) {
    return appId ? Shell.AppSystem.get_default().lookup_app(appId) : null;
}

function hostOf(url) {
    try {
        return GLib.Uri.parse(url, GLib.UriFlags.NONE).get_host() ?? url;
    } catch {
        return url;
    }
}

/** Whether `item` matches the search `query` (already lower case). */
function matches(item, query) {
    if (!query)
        return true;
    const app = appFor(item.app_id)?.get_name() ?? '';
    return `${item.preview}\n${app}`.toLowerCase().includes(query);
}

/** Signals: `activated` (item, paste): a card was chosen; `paste` when by keyboard. */
export const ClipsView = GObject.registerClass({
    Signals: {
        'activated': {param_types: [GObject.TYPE_JSOBJECT, GObject.TYPE_BOOLEAN]},
    },
}, class ClipsView extends St.Widget {
    _init(daemon) {
        super._init({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._daemon = daemon;
        this._kind = null;
        this._pending = 0;
        this.connect('destroy', () => this._cancelPending());
        this._query = '';
        this._selected = 0;
        this._keyboard = false;
        this._shown = [];
        this._cards = [];
        /** A card's "Copied" (or similar), kept across redraws while it shows. */
        this._flashing = null;

        this._strip = new St.BoxLayout({style_class: 'isle-clips'});
        this._scroll = new St.ScrollView({
            style_class: 'isle-clips-scroll',
            hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.NEVER,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(this._strip);
        // The wheel scrolls the cards sideways when they overflow, rather
        // than flipping the page.
        this._scroll.connect('scroll-event', (_actor, event) => this._onScroll(event));
        this.add_child(this._scroll);

        this._empty = new St.BoxLayout({
            ...VERTICAL,
            style_class: 'isle-empty',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._emptyIcon = new St.Icon({icon_size: 24, style_class: 'isle-empty-icon'});
        this._emptyTitle = label('', 'isle-empty-title', {x_align: Clutter.ActorAlign.CENTER});
        this._emptyHint = label('', 'isle-empty-hint', {x_align: Clutter.ActorAlign.CENTER});
        this._empty.add_child(this._emptyIcon);
        this._empty.add_child(this._emptyTitle);
        this._empty.add_child(this._emptyHint);
        this.add_child(this._empty);
    }

    /** Shows only items of `kind` ('text', 'link', 'image', 'files'), or all. */
    set kind(kind) {
        this._kind = kind;
        this._selected = 0;
        this.update();
    }

    set query(query) {
        this._query = query.trim().toLowerCase();
        this._selected = 0;
        this.update();
    }

    /** Redraws the cards; `off` means clipboard history is switched off, for the empty state. */
    update({off = false} = {}) {
        this._off = off;
        // Pinned items stay at the front, the rest newest first (as isled
        // sends them).
        const all = this._daemon.state.clipboard ?? [];
        const items = [...all.filter(item => item.pinned), ...all.filter(item => !item.pinned)]
            .filter(item => !this._kind || item.kind === this._kind)
            .filter(item => matches(item, this._query));
        this._shown = items.slice(0, MAX_CARDS);
        this._selected = Math.min(this._selected, Math.max(0, this._shown.length - 1));

        this._cancelPending();
        this._strip.destroy_all_children();
        this._cards = [];
        this._addCards(FIRST_CARDS);
        if (this._cards.length < this._shown.length) {
            this._pending = GLib.idle_add(GLib.PRIORITY_LOW, () => {
                this._addCards(CARDS_PER_IDLE);
                if (this._cards.length < this._shown.length)
                    return GLib.SOURCE_CONTINUE;
                this._pending = 0;
                return GLib.SOURCE_REMOVE;
            });
        }

        this._scroll.visible = this._shown.length > 0;
        this._empty.visible = this._shown.length === 0;
        this._updateEmpty();
    }

    /** Draws up to `count` more of the shown items. */
    _addCards(count) {
        const end = Math.min(this._shown.length, this._cards.length + count);
        for (let index = this._cards.length; index < end; index++) {
            const card = this._card(this._shown[index], index);
            this._cards.push(card);
            this._strip.add_child(card);
        }
        this._syncSelection();
    }

    _cancelPending() {
        if (this._pending)
            GLib.source_remove(this._pending);
        this._pending = 0;
    }

    _updateEmpty() {
        const searching = this._query || this._kind;
        if (searching) {
            this._emptyIcon.gicon = icon('isle-search');
            this._emptyTitle.text = 'Nothing found';
            this._emptyHint.text = 'Try other words or another filter';
        } else if (this._off) {
            this._emptyIcon.gicon = icon('isle-clipboard');
            this._emptyTitle.text = 'Clipboard history is off';
            this._emptyHint.text = 'Turn it on in Isle’s settings';
        } else {
            this._emptyIcon.gicon = icon('isle-clipboard');
            this._emptyTitle.text = 'Nothing copied yet';
            this._emptyHint.text = 'Text, links, images and files you copy show up here';
        }
    }

    // Keyboard

    /** Whether the keyboard drives the selection, which then shows. */
    set keyboard(keyboard) {
        this._keyboard = keyboard;
        this._syncSelection();
    }

    /** Moves the keyboard selection by `step` cards. */
    moveSelection(step) {
        if (this._shown.length === 0)
            return;
        this._selected = Math.min(this._shown.length - 1, Math.max(0, this._selected + step));
        // Arrowing faster than the cards are drawn.
        if (this._selected >= this._cards.length)
            this._addCards(this._selected + 1 - this._cards.length);
        this._syncSelection();
        // Keep the selected card in view.
        // Cards just drawn have no position yet; all are the same width.
        const first = this._cards[0];
        const spacing = this._strip.get_theme_node().get_length('spacing');
        const width = first.width;
        const x = this._selected * (width + spacing);
        const adjustment = this._scroll.hadjustment;
        if (x < adjustment.value)
            adjustment.ease(x, {duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        else if (x + width > adjustment.value + adjustment.page_size)
            adjustment.ease(x + width - adjustment.page_size, {duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    /** Chooses the selected card, as Enter does. */
    activateSelected() {
        const item = this._shown[this._selected];
        if (item)
            this.emit('activated', item, true);
    }

    _syncSelection() {
        this._cards.forEach((card, index) => {
            if (this._keyboard && index === this._selected)
                card.add_style_pseudo_class('selected');
            else
                card.remove_style_pseudo_class('selected');
        });
    }

    _onScroll(event) {
        const adjustment = this._scroll.hadjustment;
        if (adjustment.upper <= adjustment.page_size)
            return Clutter.EVENT_PROPAGATE;
        let delta = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            delta = -1;
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            delta = 1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = event.get_scroll_delta();
            delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
            break;
        }
        }
        adjustment.value += delta * adjustment.step_increment * 1.5;
        return Clutter.EVENT_STOP;
    }

    // Cards

    _card(item, index) {
        const card = new St.Widget({
            style_class: `isle-clip isle-clip-${item.kind}`,
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            x_expand: false,
            y_expand: false,
            // Long text must not spill out of the card.
            clip_to_allocation: true,
        });
        card.set_pivot_point(0.5, 0.5);
        card.add_child(this._body(item));
        const actions = this._actions(item, card);
        card.add_child(actions);
        card.add_child(this._header(item));

        const feedback = new St.BoxLayout({
            style_class: 'isle-clip-feedback',
            x_expand: true,
            y_expand: true,
            opacity: 0,
            visible: false,
        });
        const feedbackBox = new St.BoxLayout({...VERTICAL, x_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        card._feedbackIcon = new St.Icon({icon_size: 18, x_align: Clutter.ActorAlign.CENTER});
        card._feedbackLabel = label('', 'isle-clip-feedback-label', {x_align: Clutter.ActorAlign.CENTER});
        feedbackBox.add_child(card._feedbackIcon);
        feedbackBox.add_child(card._feedbackLabel);
        feedback.add_child(feedbackBox);
        card.add_child(feedback);
        card._feedback = feedback;

        card.connect('notify::hover', () => actions.ease({opacity: card.hover ? 255 : 0, duration: 120}));
        card.connect('button-release-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._selected = index;
            this._syncSelection();
            this.emit('activated', item, false);
            return Clutter.EVENT_STOP;
        });
        card._item = item;
        // The list redrew (e.g. the item was pinned) while it flashed.
        if (this._flashing?.id === item.id && Date.now() < this._flashing.until)
            this._showFlash(card, false);
        return card;
    }

    /** Shows "Copied" (or similar) over the card for a moment. */
    flash(item, iconName, text) {
        this._flashing = {id: item.id, iconName, text, until: Date.now() + FEEDBACK_MS};
        const card = this._cards.find(candidate => candidate._item.id === item.id);
        if (card)
            this._showFlash(card, true);
    }

    _showFlash(card, fadeIn) {
        const {iconName, text, until} = this._flashing;
        card._feedbackIcon.gicon = icon(iconName);
        card._feedbackLabel.text = text;
        const feedback = card._feedback;
        feedback.remove_all_transitions();
        feedback.show();
        feedback.opacity = fadeIn ? 0 : 255;
        feedback.ease({
            opacity: 255,
            duration: fadeIn ? 120 : 0,
            onComplete: () => feedback.ease({
                opacity: 0,
                delay: Math.max(0, until - Date.now()),
                duration: 200,
                onComplete: () => feedback.hide(),
            }),
        });
    }

    /** Pin, app icon and age in the top-left corner. */
    _header(item) {
        const header = new St.BoxLayout({
            style_class: 'isle-clip-header',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        const app = appFor(item.app_id);
        if (item.pinned)
            header.add_child(new St.Icon({gicon: icon('isle-pin-fill'), icon_size: 11, style_class: 'isle-clip-pin', y_align: Clutter.ActorAlign.CENTER}));
        if (app)
            header.add_child(new St.Icon({gicon: app.get_icon(), icon_size: 13, y_align: Clutter.ActorAlign.CENTER}));
        const age = GLib.DateTime.new_from_unix_local(Math.floor(item.at_ms / 1000));
        header.add_child(label(Format.ago(age), 'isle-clip-age', {y_align: Clutter.ActorAlign.CENTER}));
        return header;
    }

    _body(item) {
        switch (item.kind) {
        case 'image': {
            const body = new St.Widget({style_class: 'isle-clip-thumb', x_expand: true, y_expand: true});
            if (item.thumb)
                body.style = `background-image: url("${GLib.filename_to_uri(item.thumb, null).replace(/"/g, '%22')}");`;
            const size = new St.Bin({
                style_class: 'isle-clip-badge',
                child: label(`${item.width}×${item.height}`, 'isle-clip-badge-label'),
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.END,
            });
            const layers = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
            layers.add_child(body);
            if (item.width && item.height)
                layers.add_child(size);
            return layers;
        }
        case 'files': {
            const box = new St.BoxLayout({...VERTICAL, style_class: 'isle-clip-body', x_expand: true, y_expand: true});
            const names = item.preview.split('\n');
            const [type] = Gio.content_type_guess(names[0], null);
            box.add_child(new St.Icon({gicon: Gio.content_type_get_icon(type), icon_size: 28, style_class: 'isle-clip-file-icon', x_align: Clutter.ActorAlign.START}));
            const name = label(names[0], 'isle-clip-file-name');
            name.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
            box.add_child(name);
            if (names.length > 1)
                box.add_child(label(`+${names.length - 1} more`, 'isle-clip-subtle'));
            return box;
        }
        case 'link': {
            const box = new St.BoxLayout({...VERTICAL, style_class: 'isle-clip-body', x_expand: true, y_expand: true});
            const link = item.preview.trim();
            const host = label(hostOf(link), 'isle-clip-host');
            host.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            const url = label(link.replace(/^https?:\/\//i, ''), 'isle-clip-url');
            url.clutter_text.line_wrap = true;
            url.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            url.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(host);
            box.add_child(url);
            return box;
        }
        default: {
            const box = new St.BoxLayout({...VERTICAL, style_class: 'isle-clip-body', x_expand: true, y_expand: true});
            const code = CODE_PATTERN.test(item.preview);
            // Leading blank lines and long runs of spaces waste the card.
            const shown = code ? item.preview.replace(/^\s*\n/, '') : item.preview.replace(/\s+/g, ' ').trim();
            const text = label(shown.slice(0, 160), code ? 'isle-clip-text isle-clip-code' : 'isle-clip-text');
            text.clutter_text.line_wrap = true;
            text.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(text);
            return box;
        }
        }
    }

    // Puts a copy of a clipboard image on the shelf under a readable name: the history's file goes when
    // the item is pruned, the copy stays until taken off the shelf (isled then deletes it).
    _shelveImage(item) {
        const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'isle', 'shelf']);
        GLib.mkdir_with_parents(dir, 0o700);
        const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d at %H.%M.%S');
        const target = Gio.File.new_for_path(GLib.build_filenamev([dir, `Clipboard image ${stamp}.png`]));
        Gio.File.new_for_path(item.image).copy_async(target, Gio.FileCopyFlags.OVERWRITE,
            GLib.PRIORITY_DEFAULT, null, null, (source, result) => {
                try {
                    source.copy_finish(result);
                    this._daemon.call('shelf', 'Add', [target.get_uri()]);
                } catch (e) {
                    console.warn(`Isle: could not put the image on the shelf: ${e.message}`);
                }
            });
    }

    /** Pin, a hand-off and × in the top-right corner, shown on hover. */
    _actions(item, card) {
        const actions = new St.BoxLayout({
            style_class: 'isle-clip-actions',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            opacity: 0,
        });
        // St.Button stops the release it handles, so a click on one of these
        // never also copies the card.
        const button = (iconName, accessibleName, onClick) =>
            iconButton(iconName, 'isle-clip-action', onClick, {size: 11, accessibleName});

        // Pinned items stay at the front and survive Clear all.
        actions.add_child(button(item.pinned ? 'isle-pin-fill' : 'isle-pin',
            item.pinned ? 'Unpin' : 'Pin',
            () => {
                const pinned = (this._daemon.state.clipboard ?? []).filter(other => other.pinned).length;
                if (!item.pinned && pinned >= MAX_PINNED) {
                    this.flash(item, 'isle-pin', 'Pins full · unpin one');
                    return;
                }
                this._daemon.call('clipboard', 'SetPinned', item.id, !item.pinned);
                if (!item.pinned)
                    this.flash(item, 'isle-pin-fill', 'Pinned');
            }));

        if (item.kind === 'image' || item.kind === 'files') {
            actions.add_child(button('isle-shelf', 'Add to the Files tab', () => {
                const shelf = this._daemon.state.shelf ?? [];
                const fresh = item.kind === 'image'
                    ? 1
                    : item.uris.filter(uri => !shelf.some(file => file.uri === uri)).length;
                if (shelf.length + fresh > SHELF_CAPACITY) {
                    this.flash(item, 'isle-shelf', 'Files is full');
                    return;
                }
                if (item.kind === 'image')
                    this._shelveImage(item);
                else
                    this._daemon.call('shelf', 'Add', item.uris);
                this.flash(item, 'isle-shelf', 'Added to Files');
            }));
        } else {
            actions.add_child(button('isle-tasks', 'Add to Tasks', () => {
                const title = item.preview.split('\n').find(line => line.trim())?.trim().slice(0, 120);
                if (!title)
                    return;
                this._daemon.call('todo', 'Add', title);
                this.flash(item, 'isle-tasks', 'Added to Tasks');
            }));
        }

        actions.add_child(button('isle-close-symbolic', 'Remove', () => {
            // Removed at once; the card shrinks away until the list redraws.
            this._daemon.call('clipboard', 'Remove', item.id);
            card.reactive = false;
            card.ease({opacity: 0, scale_x: 0.9, scale_y: 0.9, duration: 150});
        }));
        return actions;
    }
});
