// Now playing: cover, title, a scrubber and controls; or, with lyrics on, a
// wider island with the player on the left and synced lyrics on the right.
// See docs/product-spec.md, section 5.

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Format from '../format.js';
import * as Playback from '../playback.js';
import {Art, icon, iconButton, label, setButtonIcon} from '../widgets.js';
import {Page} from './page.js';

/** The island widens to this while lyrics are shown. */
const LYRICS_WIDTH = 720;
/** How often the elapsed time and scrubber move while playing. */
const PROGRESS_REFRESH_MS = 250;
/** Where the current lyric line sits in the lyrics pane, from the top. */
const LYRIC_ANCHOR = 0.42;
/** After scrolling the lyrics by hand, wait this long before following again. */
const MANUAL_SCROLL_HOLD_MS = 4000;
/** Line opacity by distance from the current line; lines fade out with distance. */
const LINE_OPACITY = [255, 120, 80, 55];

const LYRICS_MESSAGES = {
    none: '',
    loading: 'Looking for lyrics…',
    not_found: 'No lyrics found for this song',
    instrumental: '♪  Instrumental',
    error: "Couldn't load lyrics. Check your connection.",
};

/**
 * The cover's most colourful average colour, toned for a background wash,
 * or null. Reads a 12×12 thumbnail, so it costs next to nothing.
 */
function coverColor(path) {
    if (!path)
        return null;
    let pixbuf;
    try {
        pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 12, 12, false);
    } catch {
        return null;
    }
    const pixels = pixbuf.get_pixels();
    const channels = pixbuf.get_n_channels();
    const stride = pixbuf.get_rowstride();
    let [r, g, b, total] = [0, 0, 0, 0];
    for (let y = 0; y < pixbuf.get_height(); y++) {
        for (let x = 0; x < pixbuf.get_width(); x++) {
            const i = y * stride + x * channels;
            const [pr, pg, pb] = [pixels[i], pixels[i + 1], pixels[i + 2]];
            const max = Math.max(pr, pg, pb);
            const min = Math.min(pr, pg, pb);
            // Favour saturated, not-too-dark pixels.
            const weight = max < 24 ? 0.02 : 0.1 + (max - min) / 255;
            r += pr * weight;
            g += pg * weight;
            b += pb * weight;
            total += weight;
        }
    }
    if (!total)
        return null;
    const color = [r / total, g / total, b / total];
    const peak = Math.max(...color, 1);
    return color.map(channel => (channel / peak) * 0.8);
}

/** A seek bar that can be clicked or dragged. */
const Scrubber = GObject.registerClass({
    Signals: {'seek': {param_types: [GObject.TYPE_DOUBLE]}},
}, class Scrubber extends St.Widget {
    _init() {
        super._init({
            style_class: 'pulau-scrubber',
            reactive: true,
            track_hover: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.FixedLayout(),
        });
        this._track = new St.Widget({style_class: 'pulau-scrubber-track'});
        this._fill = new St.Widget({style_class: 'pulau-scrubber-fill'});
        this._knob = new St.Widget({style_class: 'pulau-scrubber-knob', opacity: 0});
        this.add_child(this._track);
        this.add_child(this._fill);
        this.add_child(this._knob);
        this._fraction = 0;
        this._grab = null;
        this.connect('notify::allocation', () => this._layout());
        this.connect('notify::hover', () => this._knob.ease({opacity: this.hover || this._grab ? 255 : 0, duration: 120}));
    }

    set fraction(value) {
        if (this._grab)
            return; // the user is dragging
        this._fraction = Math.min(1, Math.max(0, value || 0));
        this._layout();
    }

    _layout() {
        const [width, height] = this.get_size();
        const trackHeight = 4;
        const y = Math.round((height - trackHeight) / 2);
        this._track.set_position(0, y);
        this._track.set_size(width, trackHeight);
        this._fill.set_position(0, y);
        this._fill.set_size(Math.round(width * this._fraction), trackHeight);
        const knob = 12;
        this._knob.set_size(knob, knob);
        this._knob.set_position(Math.round(width * this._fraction - knob / 2), Math.round((height - knob) / 2));
    }

    _fractionAt(event) {
        const [x] = event.get_coords();
        const [ok, localX] = this.transform_stage_point(x, 0);
        return ok ? Math.min(1, Math.max(0, localX / this.width)) : this._fraction;
    }

    vfunc_button_press_event(event) {
        this._grab = global.stage.grab(this);
        this._fraction = this._fractionAt(event);
        this._layout();
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        if (!this._grab)
            return Clutter.EVENT_PROPAGATE;
        this._fraction = this._fractionAt(event);
        this._layout();
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        if (!this._grab)
            return Clutter.EVENT_PROPAGATE;
        this._grab.dismiss();
        this._grab = null;
        this._fraction = this._fractionAt(event);
        this._layout();
        this.emit('seek', this._fraction);
        return Clutter.EVENT_STOP;
    }
});

/** Synced lyrics that follow the song; click a line to jump to it. */
const LyricsPane = GObject.registerClass(
class LyricsPane extends St.Widget {
    _init(page) {
        super._init({
            style_class: 'pulau-lyrics',
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            reactive: true,
            x_expand: true,
            y_expand: true,
        });
        this._page = page;
        this._key = null;
        this._lines = [];
        this._labels = [];
        this._current = -2;
        this._manualUntil = 0;

        this._column = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.START});
        this._message = label('', 'pulau-lyrics-message', {x_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._column);
        this.add_child(this._message);
    }

    update() {
        const {lyrics} = this._page.daemon.state;
        const status = lyrics?.status ?? 'none';
        const showLines = status === 'synced' || status === 'plain';
        this._message.text = LYRICS_MESSAGES[status] ?? '';
        this._message.visible = !showLines;
        this._column.visible = showLines;

        // The same track goes from "loading" to "synced", so both matter.
        const key = `${lyrics?.track}\u001f${status}`;
        if (key !== this._key) {
            this._key = key;
            this._rebuild(showLines ? lyrics : null);
        }
        this.follow();
    }

    _rebuild(lyrics) {
        this._column.destroy_all_children();
        this._lines = lyrics?.lines ?? [];
        this._synced = lyrics?.status === 'synced';
        this._current = -2;
        this._column.translation_y = 0;
        this._labels = this._lines.map(line => {
            const text = new St.Label({
                text: line.text || '♪',
                style_class: this._synced ? 'pulau-lyric-line' : 'pulau-lyric-line plain',
                reactive: this._synced,
            });
            text.clutter_text.line_wrap = true;
            text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            if (this._synced) {
                text.connect('button-release-event', () => {
                    this._manualUntil = 0;
                    this._page.daemon.call('media', 'SetPosition', line.time_ms * 1000);
                    return Clutter.EVENT_STOP;
                });
            }
            this._column.add_child(text);
            return text;
        });
    }

    /** Highlights the line being sung and scrolls it into place. */
    follow() {
        if (!this._synced || !this._lines.length)
            return;
        const {nowPlaying} = this._page.daemon.state;
        const index = Playback.lineIndexAt(this._lines, Playback.positionMs(nowPlaying));
        if (index !== this._current) {
            this._current = index;
            this._labels.forEach((text, i) => {
                const distance = Math.min(Math.abs(i - index), LINE_OPACITY.length - 1);
                text.ease({opacity: LINE_OPACITY[distance], duration: 300, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            });
            if (Date.now() > this._manualUntil)
                this._scrollTo(index);
        }
        const wait = Playback.isPlaying(nowPlaying) ? Playback.msUntilLine(nowPlaying, this._lines, index) : null;
        if (wait === null || !this._page.active)
            this._page.cancel('lyric');
        else
            this._page.later('lyric', wait + 30, () => this.follow());
    }

    _scrollTo(index) {
        const target = this._labels[Math.max(index, 0)];
        if (!target)
            return;
        // Allocation may lag a frame behind a rebuild; wait for it.
        if (!target.has_allocation()) {
            this._page.later('lyric-layout', 16, () => this._scrollTo(index));
            return;
        }
        const anchor = this.height * LYRIC_ANCHOR;
        const offset = anchor - (target.y + target.height / 2);
        this._column.ease({
            translation_y: Math.min(0, offset),
            duration: 420,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    vfunc_scroll_event(event) {
        const direction = event.get_scroll_direction();
        let delta = 0;
        if (direction === Clutter.ScrollDirection.UP)
            delta = 40;
        else if (direction === Clutter.ScrollDirection.DOWN)
            delta = -40;
        else if (direction === Clutter.ScrollDirection.SMOOTH)
            delta = -event.get_scroll_delta()[1] * 30;
        if (!delta)
            return Clutter.EVENT_PROPAGATE;
        const min = Math.min(0, this.height - this._column.height - 12);
        this._column.remove_transition('translation-y');
        this._column.translation_y = Math.max(min, Math.min(0, this._column.translation_y + delta));
        this._manualUntil = Date.now() + MANUAL_SCROLL_HOLD_MS;
        return Clutter.EVENT_STOP;
    }
});

export const MediaPage = GObject.registerClass(
class MediaPage extends Page {
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'pulau-page pulau-media',
            layout_manager: new Clutter.BinLayout(),
            height,
        });
        this.name = 'music';
        this._showLyrics = false;
        this._tint = null;
        this._tintPath = null;
        // Both layouts have their own copy of these; they update together.
        this._arts = [];
        this._titles = [];
        this._artists = [];
        this._elapsed = [];
        this._remaining = [];
        this._scrubbers = [];
        this._playButtons = [];

        this._player = this._buildPlayer();
        this._lyricsLayout = this._buildLyricsLayout();
        this._empty = this._buildEmpty();
        for (const child of [this._player, this._lyricsLayout, this._empty])
            this.add_child(child);

        this.watch(['nowPlaying', 'lyrics'], () => this._update());
        this._update();
    }

    get relevant() {
        return Playback.hasTrack(this.daemon.state.nowPlaying);
    }

    get preferredWidth() {
        return this._lyricsShown() ? LYRICS_WIDTH : null;
    }

    get tint() {
        return this._lyricsShown() ? this._tint : null;
    }

    _lyricsShown() {
        return this._showLyrics && Playback.hasTrack(this.daemon.state.nowPlaying);
    }

    // Building blocks; each layout has its own copy.

    _art(size, radius) {
        const art = new Art({size, radius});
        art.reactive = true;
        art.connect('button-release-event', () => {
            this.daemon.call('media', 'Raise');
            return Clutter.EVENT_STOP;
        });
        this._arts.push(art);
        return art;
    }

    _texts(titleClass, artistClass) {
        const box = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'pulau-player-texts'});
        const title = label('', titleClass);
        const artist = label('', artistClass);
        for (const text of [title, artist]) {
            text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(text);
        }
        this._titles.push(title);
        this._artists.push(artist);
        return box;
    }

    _progress() {
        const row = new St.BoxLayout({style_class: 'pulau-player-progress'});
        const elapsed = label('0:00', 'pulau-time');
        const remaining = label('-0:00', 'pulau-time pulau-time-end');
        const scrubber = new Scrubber();
        scrubber.connect('seek', (_scrubber, fraction) => {
            const length = this.daemon.state.nowPlaying?.length_us ?? 0;
            if (length > 0)
                this.daemon.call('media', 'SetPosition', Math.round(fraction * length));
        });
        row.add_child(elapsed);
        row.add_child(scrubber);
        row.add_child(remaining);
        this._elapsed.push(elapsed);
        this._remaining.push(remaining);
        this._scrubbers.push(scrubber);
        return row;
    }

    _transport() {
        const row = new St.BoxLayout({style_class: 'pulau-transport', y_align: Clutter.ActorAlign.CENTER});
        const play = iconButton('media-playback-start-symbolic', 'pulau-button-flat pulau-play',
            () => this.daemon.call('media', 'PlayPause'), {size: 22, accessibleName: 'Play or pause'});
        row.add_child(iconButton('media-skip-backward-symbolic', 'pulau-button-flat',
            () => this.daemon.call('media', 'Previous'), {size: 18, accessibleName: 'Previous'}));
        row.add_child(play);
        row.add_child(iconButton('media-skip-forward-symbolic', 'pulau-button-flat',
            () => this.daemon.call('media', 'Next'), {size: 18, accessibleName: 'Next'}));
        this._playButtons.push(play);
        return row;
    }

    _lyricsToggle(on) {
        return iconButton('pulau-lyrics', `pulau-button-flat pulau-lyrics-toggle${on ? ' on' : ''}`,
            () => this._toggleLyrics(), {size: 18, accessibleName: on ? 'Hide lyrics' : 'Show lyrics'});
    }

    // Layouts.

    _buildPlayer() {
        const player = new St.BoxLayout({vertical: true, style_class: 'pulau-player', x_expand: true, y_expand: true});

        const top = new St.BoxLayout({style_class: 'pulau-player-top'});
        top.add_child(this._art(72, 14));
        top.add_child(this._texts('pulau-track-title', 'pulau-track-subtitle'));
        this._appIcon = new St.Icon({icon_size: 20, style_class: 'pulau-app-icon', y_align: Clutter.ActorAlign.CENTER});
        top.add_child(this._appIcon);

        const controls = new St.Widget({layout_manager: new Clutter.BinLayout(), style_class: 'pulau-player-controls', x_expand: true});
        const toggle = this._lyricsToggle(false);
        toggle.x_expand = true;
        toggle.x_align = Clutter.ActorAlign.START;
        const transport = this._transport();
        transport.x_align = Clutter.ActorAlign.CENTER;
        controls.add_child(toggle);
        controls.add_child(transport);

        player.add_child(top);
        player.add_child(this._progress());
        player.add_child(controls);
        return player;
    }

    _buildLyricsLayout() {
        const layout = new St.BoxLayout({style_class: 'pulau-lyrics-layout', x_expand: true, y_expand: true, visible: false});

        const side = new St.BoxLayout({vertical: true, style_class: 'pulau-lyrics-side', y_align: Clutter.ActorAlign.CENTER});
        const top = new St.BoxLayout({style_class: 'pulau-player-top'});
        top.add_child(this._art(60, 12));
        top.add_child(this._texts('pulau-side-title', 'pulau-side-artist'));
        side.add_child(top);
        side.add_child(this._progress());

        const controls = new St.BoxLayout({style_class: 'pulau-lyrics-controls', x_align: Clutter.ActorAlign.CENTER});
        controls.add_child(this._lyricsToggle(true));
        controls.add_child(this._transport());
        side.add_child(controls);

        this._lyricsPane = new LyricsPane(this);
        layout.add_child(side);
        layout.add_child(new St.Widget({style_class: 'pulau-divider', y_expand: true}));
        layout.add_child(this._lyricsPane);
        return layout;
    }

    _buildEmpty() {
        const box = new St.BoxLayout({
            vertical: true,
            style_class: 'pulau-empty',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(new St.Icon({gicon: icon('pulau-music'), icon_size: 28, style_class: 'pulau-empty-icon'}));
        box.add_child(label('Nothing playing', 'pulau-empty-title', {x_align: Clutter.ActorAlign.CENTER}));
        box.add_child(label('Play music in Spotify, a browser or any media player', 'pulau-empty-hint', {x_align: Clutter.ActorAlign.CENTER}));
        return box;
    }

    _toggleLyrics() {
        this._showLyrics = !this._showLyrics;
        this._update();
        this.emit('width-changed');
        this.emit('tint-changed');
    }

    _update() {
        const {nowPlaying} = this.daemon.state;
        const hasTrack = Playback.hasTrack(nowPlaying);
        const lyricsMode = this._lyricsShown();
        this._empty.visible = !hasTrack;
        this._player.visible = hasTrack && !lyricsMode;
        this._lyricsLayout.visible = lyricsMode;
        if (!hasTrack)
            return;

        const [playerTitle, sideTitle] = this._titles;
        const [playerArtist, sideArtist] = this._artists;
        playerTitle.text = sideTitle.text = nowPlaying.title;
        playerArtist.text = [nowPlaying.artist, nowPlaying.album].filter(Boolean).join(' — ') || nowPlaying.identity;
        sideArtist.text = nowPlaying.artist || nowPlaying.identity;
        for (const art of this._arts)
            art.setPath(nowPlaying.art_path);
        this._updateTint(nowPlaying.art_path);

        const playIcon = nowPlaying.status === 'Playing' ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        for (const button of this._playButtons)
            setButtonIcon(button, playIcon);

        const app = nowPlaying.desktop_entry
            ? Gio.DesktopAppInfo.new(`${nowPlaying.desktop_entry}.desktop`)
            : null;
        this._appIcon.gicon = app?.get_icon() ?? null;
        this._appIcon.visible = Boolean(app);

        for (const scrubber of this._scrubbers)
            scrubber.reactive = nowPlaying.can_seek && nowPlaying.length_us > 0;
        this._lyricsPane.update();
        this._tickProgress();
    }

    _updateTint(path) {
        if (path === this._tintPath)
            return;
        this._tintPath = path;
        this._tint = coverColor(path);
        if (this._lyricsShown())
            this.emit('tint-changed');
    }

    _tickProgress() {
        const {nowPlaying} = this.daemon.state;
        if (!Playback.hasTrack(nowPlaying))
            return;
        const position = Playback.positionMs(nowPlaying);
        const length = Playback.lengthMs(nowPlaying);
        const elapsed = Format.duration(position);
        const remaining = length > 0 ? `-${Format.duration(length - position)}` : '';
        this._elapsed.forEach(text => (text.text = elapsed));
        this._remaining.forEach(text => (text.text = remaining));
        for (const scrubber of this._scrubbers)
            scrubber.fraction = length > 0 ? position / length : 0;

        if (this.active && Playback.isPlaying(nowPlaying))
            this.later('progress', PROGRESS_REFRESH_MS, () => this._tickProgress());
    }

    onActivate() {
        this._tickProgress();
        this._lyricsPane.follow();
    }
});
