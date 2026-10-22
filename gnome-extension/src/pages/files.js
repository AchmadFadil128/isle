// SPDX-License-Identifier: GPL-3.0-or-later

// The shelf's Files tab. The `isle-shelf` helper draws it over this view for drag and
// drop; both look the same tile for tile, so the hand-over cannot be seen.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import {icon, iconButton, label} from '../widgets.js';

/** The shelf holds this many files (as isled enforces). */
export const SHELF_CAPACITY = 6;

// Sizes in pixels; keep them in step with the helper's tile.rs.
const TILE_WIDTH = 84;
const PREVIEW_SIZE = 52;
const ICON_SIZE = 46;
const REMOVE_SIZE = 18;
const NAME_WIDTH = 76;
/** The preview's square plus room above it for the ×. */
const FRAME_HEIGHT = PREVIEW_SIZE + 6;
/** How long "copied" shows on a tile. */
const COPIED_MS = 1100;
const FILES_TYPE = 'x-special/gnome-copied-files';

export const FilesView = GObject.registerClass(
class FilesView extends St.Widget {
    _init(daemon, thumbnails) {
        super._init({
            style_class: 'isle-shelf-files',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._daemon = daemon;
        this._thumbnails = thumbnails;
        this._helperActive = false;
        this._helperAvailable = false;
        this._dropping = false;
        this._lastClick = {uri: null, at: 0};

        // Expanding, as BinLayout only honours START for children that do.
        this._tiles = new St.BoxLayout({
            style_class: 'isle-shelf-tiles',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._tiles);

        this._empty = new St.BoxLayout({
            ...VERTICAL,
            style_class: 'isle-empty',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._empty.add_child(new St.Icon({gicon: icon('isle-shelf'), icon_size: 24, style_class: 'isle-empty-icon', x_align: Clutter.ActorAlign.CENTER}));
        this._emptyTitle = label('', 'isle-empty-title', {x_align: Clutter.ActorAlign.CENTER});
        this._emptyHint = label('', 'isle-empty-hint', {x_align: Clutter.ActorAlign.CENTER});
        this._empty.add_child(this._emptyTitle);
        this._empty.add_child(this._emptyHint);
        this.add_child(this._empty);
        this.connect('destroy', () => (this._destroyed = true));
        this.update();
    }

    /** While the helper window covers this tab, draw nothing so the two never mix. */
    set helperActive(active) {
        if (active === this._helperActive)
            return;
        this._helperActive = active;
        this.update();
    }

    /** Whether the helper is installed, so files can be dropped here. */
    set helperAvailable(available) {
        if (available === this._helperAvailable)
            return;
        this._helperAvailable = available;
        this.update();
    }

    /** A file is on its way: show where it will land, as the helper does. */
    set dropping(dropping) {
        if (dropping === this._dropping)
            return;
        this._dropping = dropping;
        this.update();
    }

    update() {
        const items = this._daemon.state.shelf ?? [];
        // Not while isled is away (no list), or every preview would go.
        if (this._daemon.state.shelf)
            this._thumbnails.keepOnly(items.map(item => item.uri));
        this._tiles.destroy_all_children();
        const dragging = this._dropping && this._helperAvailable;
        const full = items.length >= SHELF_CAPACITY;
        if (dragging)
            this.add_style_pseudo_class('drop');
        else
            this.remove_style_pseudo_class('drop');

        if (this._helperActive) {
            this._tiles.hide();
            this._empty.hide();
            return;
        }
        if (dragging && !full && items.length > 0)
            this._tiles.add_child(this._slot());
        for (const item of items)
            this._tiles.add_child(this._tile(item));
        this._tiles.visible = items.length > 0;
        this._empty.visible = items.length === 0;

        if (!this._helperAvailable) {
            this._emptyTitle.text = 'No files on the shelf';
            this._emptyHint.text = 'Drag and drop needs the shelf helper; run install.sh again';
        } else if (dragging) {
            this._emptyTitle.text = 'Drop to add it';
            this._emptyHint.text = 'Then drag it into any app, or click to copy it';
        } else {
            this._emptyTitle.text = 'Drop files here';
            this._emptyHint.text = 'Then drag them into any app, or click to copy';
        }
    }

    // Tiles

    _tile(item) {
        const preview = new St.Bin({style_class: 'isle-shelf-preview', width: PREVIEW_SIZE, height: PREVIEW_SIZE});
        // A plain file icon until the file's own one is known (or for good,
        // if the file is gone).
        preview.child = new St.Icon({gicon: icon('isle-file'), icon_size: ICON_SIZE * 0.6, opacity: 160});

        const copied = new St.Bin({
            style_class: 'isle-shelf-copied',
            width: PREVIEW_SIZE,
            height: PREVIEW_SIZE,
            opacity: 0,
            child: new St.Icon({gicon: icon('isle-check-symbolic'), icon_size: 18}),
        });
        const remove = iconButton('isle-close-symbolic', 'isle-shelf-remove',
            () => this._daemon.call('shelf', 'Remove', item.uri), {size: 10, accessibleName: 'Remove from the shelf'});
        remove.set_size(REMOVE_SIZE, REMOVE_SIZE);

        const tile = this._tileBox(this._frame(preview, {copied, remove}), item.name);
        tile.accessible_name = item.name;
        tile.connect('clicked', () => this._onClicked(item, copied));

        let destroyed = false;
        tile.connect('destroy', () => (destroyed = true));
        this._thumbnails.get(item.uri).then(shown => {
            if (destroyed || !shown)
                return;
            if (shown.image) {
                preview.add_style_class_name('thumbnail');
                preview.style = `background-image: url("${GLib.filename_to_uri(shown.image, null).replace(/"/g, '%22')}");`;
                preview.child = null;
            } else if (shown.gicon) {
                preview.child = new St.Icon({gicon: shown.gicon, icon_size: ICON_SIZE});
            }
        });
        return tile;
    }

    /** The empty slot a dragged file will land in. */
    _slot() {
        const square = new St.Bin({
            style_class: 'isle-shelf-preview isle-shelf-slot',
            width: PREVIEW_SIZE,
            height: PREVIEW_SIZE,
            child: new St.Icon({gicon: icon('isle-plus-symbolic'), icon_size: 18}),
        });
        const tile = this._tileBox(this._frame(square), 'Drop here');
        tile.reactive = false;
        return tile;
    }

    /** The preview (with `copied` over it) and room for the × over its corner. */
    _frame(preview, {copied = null, remove = null} = {}) {
        const frame = new St.Widget({layout_manager: new Clutter.FixedLayout(), width: TILE_WIDTH, height: FRAME_HEIGHT});
        const left = (TILE_WIDTH - PREVIEW_SIZE) / 2;
        for (const square of [preview, copied].filter(Boolean)) {
            frame.add_child(square);
            square.set_position(left, FRAME_HEIGHT - PREVIEW_SIZE);
        }
        if (remove) {
            frame.add_child(remove);
            // Its centre a few pixels inside the preview's corner.
            remove.set_position(left + PREVIEW_SIZE - REMOVE_SIZE + 6, 0);
        }
        return frame;
    }

    _tileBox(frame, name) {
        const box = new St.BoxLayout({...VERTICAL, style_class: 'isle-shelf-tile-box'});
        box.add_child(frame);
        const text = label(name, 'isle-shelf-name', {width: NAME_WIDTH, x_align: Clutter.ActorAlign.CENTER});
        text.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        box.add_child(text);
        return new St.Button({
            style_class: 'isle-shelf-tile',
            child: box,
            can_focus: true,
            width: TILE_WIDTH,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    // Clicks

    /** A click copies the file; a second one soon after opens it. */
    _onClicked(item, copied) {
        const now = GLib.get_monotonic_time() / 1000;
        const double = this._lastClick.uri === item.uri &&
            now - this._lastClick.at < Clutter.Settings.get_default().double_click_time;
        this._lastClick = {uri: double ? null : item.uri, at: now};
        if (double) {
            Gio.AppInfo.launch_default_for_uri_async(item.uri, global.create_app_launch_context(0, -1), null, null);
            return;
        }
        this._copy(item);
        copied.remove_all_transitions();
        copied.opacity = 255;
        copied.ease({opacity: 0, delay: COPIED_MS, duration: 200});
    }

    /** Copies the file: a PNG as the image (chats paste it as one), anything else as a file. */
    async _copy(item) {
        const clipboard = St.Clipboard.get_default();
        const file = Gio.File.new_for_uri(item.uri);
        // St takes one type, so only PNGs go as pictures here; the helper converts the rest.
        if ((await this._thumbnails.get(item.uri))?.contentType === 'image/png') {
            try {
                const bytes = await new Promise((resolve, reject) => {
                    file.load_bytes_async(null, (source, result) => {
                        try {
                            resolve(source.load_bytes_finish(result)[0]);
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
                clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
                return;
            } catch (e) {
                console.warn(`Isle: could not read ${item.uri}: ${e.message}`);
            }
        }
        clipboard.set_content(St.ClipboardType.CLIPBOARD, FILES_TYPE,
            GLib.Bytes.new(new TextEncoder().encode(`copy\n${item.uri}`)));
    }
});
