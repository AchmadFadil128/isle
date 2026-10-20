// SPDX-License-Identifier: GPL-3.0-or-later

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
import {Art, Slider, icon, iconButton, label, setButtonIcon} from '../widgets.js';
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

/** The playing app per player, looked up once: `desktop_entry|identity`. */
const playerApps = new Map();

/**
 * The app that is playing: from the player's desktop entry, or else found
 * by its name (Chrome gives only "Chrome"). Null when there is none.
 */
function playerApp({desktop_entry: entry, identity}) {
    const key = `${entry}|${identity}`;
    if (!playerApps.has(key)) {
        const ids = [];
        if (entry)
            ids.push(`${entry}.desktop`);
        if (identity)
            ids.push(...Gio.DesktopAppInfo.search(identity).flat());
        let app = null;
        for (const id of ids) {
            app = Gio.DesktopAppInfo.new(id);
            if (app)
                break;
        }
        playerApps.set(key, app);
    }
    return playerApps.get(key);
}

const LYRICS_MESSAGES = {
    none: '',
    loading: 'Looking for lyrics…',
    not_found: 'No lyrics found for this song',
    instrumental: '♪  Instrumental',
    error: "Couldn't load lyrics. Check your connection.",
    unavailable: 'The lyrics service is busy. Trying again soon.',
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

/** Synced lyrics that follow the song; click a line to jump to it. */
const LyricsPane = GObject.registerClass(
class LyricsPane extends St.Widget {
    _init(page) {
        super._init({
            style_class: 'isle-lyrics',
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
        this._message = label('', 'isle-lyrics-message', {x_align: Clutter.ActorAlign.CENTER});
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
                style_class: this._synced ? 'isle-lyric-line' : 'isle-lyric-line plain',
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
    _init(daemon, audio, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-media',
            layout_manager: new Clutter.BinLayout(),
            height,
        });
        this.name = 'music';
        this._audio = audio;
        /** 'player', 'lyrics' or 'audio' (volume and outputs). */
        this._mode = 'player';
        this._tint = null;
        this._tintPath = null;
        // Each layout has its own copy of these; they update together.
        this._arts = [];
        this._badges = [];
        this._titles = [];
        this._artists = [];
        this._elapsed = [];
        this._remaining = [];
        this._scrubbers = [];
        this._playButtons = [];

        this._player = this._buildPlayer();
        this._lyricsLayout = this._buildLyricsLayout();
        this._audioLayout = this._buildAudioLayout();
        this._empty = this._buildEmpty();
        for (const child of [this._player, this._lyricsLayout, this._audioLayout, this._empty])
            this.add_child(child);

        this.watch(['nowPlaying', 'lyrics'], () => this._update());
        this._audioChanged = audio.connect('changed', () => this._updateAudio());
        this._update();
        this._updateAudio();
        this.connect('destroy', () => this._onDestroy());
    }

    get relevant() {
        return Playback.hasTrack(this.daemon.state.nowPlaying);
    }

    get preferredWidth() {
        return this._shown('lyrics') ? LYRICS_WIDTH : null;
    }

    get tint() {
        return this._shown('lyrics') ? this._tint : null;
    }

    /** Whether `mode` is on screen (the special modes need a track). */
    _shown(mode) {
        return this._mode === mode && Playback.hasTrack(this.daemon.state.nowPlaying);
    }

    // Building blocks; each layout has its own copy.

    /** Cover art with the playing app's icon on its corner. */
    _art(size, radius) {
        const art = new Art({size, radius});
        art.reactive = true;
        art.connect('button-release-event', () => {
            this.daemon.call('media', 'Raise');
            return Clutter.EVENT_STOP;
        });
        this._arts.push(art);

        const badgeIcon = new St.Icon({icon_size: Math.round(size * 0.3)});
        const badge = new St.Bin({
            style_class: 'isle-app-badge',
            child: badgeIcon,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
            // Sits over the corner, half outside it, like on a Mac.
            translation_x: 5,
            translation_y: 5,
            visible: false,
        });
        this._badges.push({badge, icon: badgeIcon});

        const box = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        box.add_child(art);
        box.add_child(badge);
        return box;
    }

    _texts(titleClass, artistClass) {
        const box = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'isle-player-texts'});
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
        const row = new St.BoxLayout({style_class: 'isle-player-progress'});
        const elapsed = label('0:00', 'isle-time');
        const remaining = label('-0:00', 'isle-time isle-time-end');
        const scrubber = new Slider();
        scrubber.connect('released', (_slider, fraction) => {
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
        const row = new St.BoxLayout({style_class: 'isle-transport', y_align: Clutter.ActorAlign.CENTER});
        const play = iconButton('media-playback-start-symbolic', 'isle-button-flat isle-play',
            () => this.daemon.call('media', 'PlayPause'), {size: 22, accessibleName: 'Play or pause'});
        row.add_child(iconButton('media-skip-backward-symbolic', 'isle-button-flat',
            () => this.daemon.call('media', 'Previous'), {size: 18, accessibleName: 'Previous'}));
        row.add_child(play);
        row.add_child(iconButton('media-skip-forward-symbolic', 'isle-button-flat',
            () => this.daemon.call('media', 'Next'), {size: 18, accessibleName: 'Next'}));
        this._playButtons.push(play);
        return row;
    }

    /**
     * A button switching to `mode` and back. While its mode is shown it is
     * lit and its icon fills in.
     */
    _modeButton(mode, iconName, accessibleName, on) {
        return iconButton(on ? `${iconName}-fill` : iconName, `isle-button-flat isle-mode-toggle${on ? ' on' : ''}`,
            () => this._toggleMode(mode), {size: 18, accessibleName});
    }

    // Layouts.

    _buildPlayer() {
        const player = new St.BoxLayout({vertical: true, style_class: 'isle-player', x_expand: true, y_expand: true});

        const top = new St.BoxLayout({style_class: 'isle-player-top'});
        top.add_child(this._art(72, 14));
        top.add_child(this._texts('isle-track-title', 'isle-track-subtitle'));

        const controls = new St.Widget({layout_manager: new Clutter.BinLayout(), style_class: 'isle-player-controls', x_expand: true});
        const lyrics = this._modeButton('lyrics', 'isle-lyrics', 'Show lyrics', false);
        lyrics.x_expand = true;
        lyrics.x_align = Clutter.ActorAlign.START;
        const transport = this._transport();
        transport.x_align = Clutter.ActorAlign.CENTER;
        const output = this._modeButton('audio', 'isle-output', 'Volume and output', false);
        output.x_expand = true;
        output.x_align = Clutter.ActorAlign.END;
        controls.add_child(lyrics);
        controls.add_child(transport);
        controls.add_child(output);

        player.add_child(top);
        player.add_child(this._progress());
        player.add_child(controls);
        return player;
    }

    _buildLyricsLayout() {
        const layout = new St.BoxLayout({style_class: 'isle-lyrics-layout', x_expand: true, y_expand: true, visible: false});

        const side = new St.BoxLayout({vertical: true, style_class: 'isle-lyrics-side', y_align: Clutter.ActorAlign.CENTER});
        const top = new St.BoxLayout({style_class: 'isle-player-top'});
        top.add_child(this._art(60, 12));
        top.add_child(this._texts('isle-side-title', 'isle-side-artist'));
        side.add_child(top);
        side.add_child(this._progress());

        const controls = new St.BoxLayout({style_class: 'isle-lyrics-controls', x_align: Clutter.ActorAlign.CENTER});
        controls.add_child(this._modeButton('lyrics', 'isle-lyrics', 'Hide lyrics', true));
        controls.add_child(this._transport());
        side.add_child(controls);

        this._lyricsPane = new LyricsPane(this);
        layout.add_child(side);
        layout.add_child(new St.Widget({style_class: 'isle-divider', y_expand: true}));
        layout.add_child(this._lyricsPane);
        return layout;
    }

    /** Volume, then the outputs to choose from, like macOS's Sound menu. */
    _buildAudioLayout() {
        const layout = new St.BoxLayout({vertical: true, style_class: 'isle-audio-layout', x_expand: true, y_expand: true, visible: false});

        const volume = new St.BoxLayout({style_class: 'isle-volume-row'});
        this._muteButton = iconButton('audio-volume-high-symbolic', 'isle-button-flat',
            () => this._audio.toggleMuted(), {size: 18, accessibleName: 'Mute'});
        this._volumeSlider = new Slider({scrollStep: 0.05});
        this._volumeSlider.connect('value-changed', (_slider, value) => (this._audio.volume = value));
        this._volumeText = label('', 'isle-volume-text');
        volume.add_child(this._muteButton);
        volume.add_child(this._volumeSlider);
        volume.add_child(this._volumeText);
        volume.add_child(this._modeButton('audio', 'isle-output', 'Back to the player', true));
        layout.add_child(volume);

        this._outputList = new St.BoxLayout({vertical: true, style_class: 'isle-output-list'});
        const scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            // Scrolls with the wheel or touchpad; no scrollbar over the rows.
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        scroll.set_child(this._outputList);
        layout.add_child(scroll);
        return layout;
    }

    _buildEmpty() {
        const box = new St.BoxLayout({
            vertical: true,
            style_class: 'isle-empty',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(new St.Icon({gicon: icon('isle-music'), icon_size: 28, style_class: 'isle-empty-icon'}));
        box.add_child(label('Nothing playing', 'isle-empty-title', {x_align: Clutter.ActorAlign.CENTER}));
        box.add_child(label('Play something in Spotify or on YouTube', 'isle-empty-hint', {x_align: Clutter.ActorAlign.CENTER}));
        return box;
    }

    _toggleMode(mode) {
        this._mode = this._mode === mode ? 'player' : mode;
        this._update();
        this.emit('width-changed');
        this.emit('tint-changed');
    }

    _update() {
        const {nowPlaying} = this.daemon.state;
        const hasTrack = Playback.hasTrack(nowPlaying);
        this._empty.visible = !hasTrack;
        this._player.visible = hasTrack && this._mode === 'player';
        this._lyricsLayout.visible = this._shown('lyrics');
        this._audioLayout.visible = this._shown('audio');
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

        // Which app plays it, unless the cover already is that app's logo.
        const appIcon = playerApp(nowPlaying)?.get_icon() ?? null;
        for (const {badge, icon: badgeIcon} of this._badges) {
            badgeIcon.gicon = appIcon;
            badge.visible = Boolean(appIcon) && !this._arts[0].showsIcon;
        }

        for (const scrubber of this._scrubbers)
            scrubber.reactive = nowPlaying.can_seek && nowPlaying.length_us > 0;
        this._lyricsPane.update();
        this._tickProgress();
    }

    _updateAudio() {
        const audio = this._audio;
        setButtonIcon(this._muteButton, audio.iconName);
        this._volumeSlider.value = audio.muted ? 0 : audio.volume;
        this._volumeText.text = audio.muted ? 'Muted' : `${Math.round(audio.volume * 100)}%`;

        this._outputList.destroy_all_children();
        for (const output of audio.outputs) {
            const row = new St.BoxLayout({style_class: 'isle-output-row', x_expand: true, x_align: Clutter.ActorAlign.FILL});
            row.add_child(new St.Icon({gicon: output.gicon, fallback_icon_name: 'audio-speakers-symbolic', icon_size: 18, y_align: Clutter.ActorAlign.CENTER}));
            const texts = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            texts.add_child(label(output.name, 'isle-output-name'));
            if (output.detail)
                texts.add_child(label(output.detail, 'isle-output-detail'));
            row.add_child(texts);
            // The current output is marked with a check, like macOS.
            const check = new St.Icon({icon_name: 'object-select-symbolic', icon_size: 14, opacity: output.active ? 255 : 0, y_align: Clutter.ActorAlign.CENTER});
            row.add_child(check);

            const button = new St.Button({
                style_class: `isle-output-button${output.active ? ' active' : ''}`,
                child: row,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                can_focus: true,
            });
            button.connect('clicked', () => audio.activate(output.id));
            this._outputList.add_child(button);
        }
    }

    _updateTint(path) {
        if (path === this._tintPath)
            return;
        this._tintPath = path;
        this._tint = coverColor(path);
        if (this._shown('lyrics'))
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
            scrubber.value = length > 0 ? position / length : 0;

        if (this.active && Playback.isPlaying(nowPlaying))
            this.later('progress', PROGRESS_REFRESH_MS, () => this._tickProgress());
    }

    onActivate() {
        this._tickProgress();
        this._lyricsPane.follow();
    }

    onDeactivate() {
        // Reopening the island starts on the player, not a sub-view.
        if (this._mode === 'audio')
            this._toggleMode('audio');
    }

    _onDestroy() {
        this._audio.disconnect(this._audioChanged);
    }
});
