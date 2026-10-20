// SPDX-License-Identifier: GPL-3.0-or-later

// The Files tab of the Shelf page. GNOME Shell itself cannot take part in
// drag and drop with apps, so when the `isle-shelf` helper is installed it
// draws this tab in a small window placed exactly over it. Without it, the
// tab shows the files without drag and drop: click to open, × to remove.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {icon, iconButton, label} from '../widgets.js';

const TILE_ICON_SIZE = 40;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];

export const FilesView = GObject.registerClass(
class FilesView extends St.Widget {
    _init(daemon) {
        super._init({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._daemon = daemon;
        this._helperActive = false;

        this._tiles = new St.BoxLayout({style_class: 'isle-shelf-tiles'});
        this._scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.NEVER,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._scroll.set_child(this._tiles);
        this.add_child(this._scroll);

        this._empty = new St.BoxLayout({
            vertical: true,
            style_class: 'isle-empty',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._empty.add_child(new St.Icon({gicon: icon('isle-shelf'), icon_size: 24, style_class: 'isle-empty-icon'}));
        this._empty.add_child(label('No files on the shelf', 'isle-empty-title', {x_align: Clutter.ActorAlign.CENTER}));
        this._empty.add_child(label('Install isle-shelf to drag files in and out', 'isle-empty-hint', {x_align: Clutter.ActorAlign.CENTER}));
        this.add_child(this._empty);
        this.update();
    }

    /**
     * While the helper window covers this tab, it draws nothing itself so
     * the two never show through each other.
     */
    set helperActive(active) {
        if (active === this._helperActive)
            return;
        this._helperActive = active;
        this.update();
    }

    update() {
        const items = this._daemon.state.shelf ?? [];
        this._tiles.destroy_all_children();
        if (this._helperActive) {
            this._scroll.hide();
            this._empty.hide();
            return;
        }
        for (const item of items)
            this._tiles.add_child(this._tile(item));
        this._scroll.visible = items.length > 0;
        this._empty.visible = items.length === 0;
    }

    _tile(item) {
        const file = Gio.File.new_for_uri(item.uri);
        const box = new St.BoxLayout({vertical: true});
        const preview = new St.Bin({style_class: 'isle-shelf-preview', width: TILE_ICON_SIZE, height: TILE_ICON_SIZE, x_align: Clutter.ActorAlign.CENTER});
        const name = label(item.name, 'isle-shelf-name', {x_align: Clutter.ActorAlign.CENTER});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        box.add_child(preview);
        box.add_child(name);
        const open = new St.Button({style_class: 'isle-shelf-open', child: box, can_focus: true, accessible_name: item.name, x_expand: true, y_expand: true});
        open.connect('clicked', () => {
            Gio.AppInfo.launch_default_for_uri_async(item.uri, global.create_app_launch_context(0, -1), null, null);
        });

        // × in the tile's corner while hovered, as in the helper's shelf.
        const remove = iconButton('isle-close-symbolic', 'isle-shelf-remove',
            () => this._daemon.call('shelf', 'Remove', item.uri), {size: 10, accessibleName: 'Remove from the shelf'});
        // BinLayout only honours the alignment of children that expand.
        remove.set({x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.START, opacity: 0});

        // Explicitly not expanding, so its expanding children do not widen it.
        const tile = new St.Widget({
            style_class: 'isle-shelf-tile',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            x_expand: false,
            y_expand: false,
        });
        tile.add_child(open);
        tile.add_child(remove);
        tile.connect('notify::hover', () => remove.ease({opacity: tile.hover ? 255 : 0, duration: 120}));

        let destroyed = false;
        tile.connect('destroy', () => (destroyed = true));
        file.query_info_async('standard::content-type,standard::icon', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, null, (source, result) => {
                let info;
                try {
                    info = source.query_info_finish(result);
                } catch {
                    return; // the file is gone; the daemon prunes it on refresh
                }
                if (destroyed)
                    return;
                if (IMAGE_TYPES.includes(info.get_content_type())) {
                    preview.style = `background-image: url("${item.uri.replace(/"/g, '%22')}"); background-size: cover; border-radius: 8px;`;
                } else {
                    preview.child = new St.Icon({gicon: info.get_icon(), icon_size: TILE_ICON_SIZE});
                }
            });
        return tile;
    }
});
