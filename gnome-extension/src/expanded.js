// SPDX-License-Identifier: GPL-3.0-or-later

// The open island: a header row inside the top bar (page title, clock,
// music bars), one page at a time with arrows to its neighbours, and page
// dots at the bottom. See docs/product-spec.md, section 5.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {timerColor} from './compact.js';
import * as Format from './format.js';
import * as Playback from './playback.js';
import {Bars, PrivacyDots, RecordingDot, Ring, iconButton, label} from './widgets.js';

export const EXPANDED_WIDTH = 600;
export const PAGE_HEIGHT = 150;
export const DOTS_HEIGHT = 20;

const SLIDE_DISTANCE = 48;
const SLIDE_DURATION = 260;
/** Minimum time between page flips from the scroll wheel. */
const SCROLL_COOLDOWN_MS = 350;
/** Accumulated smooth-scroll distance that flips a page. */
const SMOOTH_SCROLL_STEP = 1.2;

export const ExpandedView = GObject.registerClass({
    Signals: {
        'page-changed': {},
        // The page slide finished; the new page is in its final place.
        'page-settled': {},
        // The current page wants the island wider or narrower.
        'width-changed': {},
        // The current page's tint colour changed; see `tint`.
        'tint-changed': {},
    },
}, class ExpandedView extends St.BoxLayout {
    _init(daemon, privacy, settings, pages) {
        super._init({vertical: true, style_class: 'isle-expanded', width: EXPANDED_WIDTH});
        this._daemon = daemon;
        this._privacy = privacy;
        this._settings = settings;
        this._pages = pages;
        this._index = 0;
        this._active = false;
        this._width = EXPANDED_WIDTH;
        this._lastFlip = 0;
        this._smoothScroll = 0;
        this._clockTimeout = 0;

        this._header = this._buildHeader();
        this.add_child(this._header);
        this.add_child(this._buildPager());

        this._dots = new St.BoxLayout({style_class: 'isle-dots', x_align: Clutter.ActorAlign.CENTER, height: DOTS_HEIGHT});
        pages.forEach((page, index) => {
            const dot = new St.Button({style_class: 'isle-dot', accessible_name: page.name, y_align: Clutter.ActorAlign.CENTER});
            dot.connect('clicked', () => this.showPage(index));
            this._dots.add_child(dot);
        });
        this.add_child(this._dots);

        for (const page of pages) {
            page.connect('width-changed', () => {
                if (page === this.page)
                    this._syncWidth();
            });
            page.connect('tint-changed', () => {
                if (page === this.page)
                    this.emit('tint-changed');
            });
        }

        this._daemonChanged = daemon.connect('changed', (_daemon, key) => {
            if (key === 'nowPlaying' || key === 'pomodoro')
                this._updateHeader();
        });
        this._privacyChanged = privacy.connect('changed', () => this._updateHeader());
        this._syncPage();
        this._syncWidth();
        this.connect('destroy', () => this._onDestroy());
    }

    _buildHeader() {
        const header = new St.Widget({layout_manager: new Clutter.BinLayout(), style_class: 'isle-header'});

        this._title = new St.Label({
            style_class: 'isle-header-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._title);

        const clock = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, style_class: 'isle-header-clock'});
        this._headerRing = new Ring({size: 15, lineWidth: 2.5});
        this._date = label('', 'isle-header-date');
        this._time = label('', 'isle-header-time');
        clock.add_child(this._headerRing);
        clock.add_child(this._date);
        clock.add_child(this._time);
        header.add_child(clock);

        // Right: a running recording (click to stop), privacy dots, music.
        const status = new St.BoxLayout({style_class: 'isle-header-status', x_expand: true, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER});
        const recordingBox = new St.BoxLayout({style_class: 'isle-recording-pill-box'});
        recordingBox.add_child(new RecordingDot());
        this._recordingTime = label('', 'isle-recording-time');
        recordingBox.add_child(this._recordingTime);
        this._recordingButton = new St.Button({
            style_class: 'isle-recording-pill',
            child: recordingBox,
            accessible_name: 'Stop recording',
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._recordingButton.connect('clicked', () => this._privacy.stopRecording());
        this._privacyDots = new PrivacyDots();
        this._headerBars = new Bars({height: 14});
        status.add_child(this._recordingButton);
        status.add_child(this._privacyDots);
        status.add_child(this._headerBars);
        header.add_child(status);
        return header;
    }

    _buildPager() {
        const area = new St.Widget({layout_manager: new Clutter.BinLayout(), height: PAGE_HEIGHT});

        this._pager = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            x_expand: true,
            y_expand: true,
        });
        for (const page of this._pages) {
            page.x_expand = page.y_expand = true;
            page.hide();
            this._pager.add_child(page);
        }
        this._pages[0].show();
        area.add_child(this._pager);

        // Arrows to the neighbouring pages.
        this._previous = iconButton('go-previous-symbolic', 'isle-nav', () => this.showPage(this._index - 1),
            {size: 12, accessibleName: 'Previous page'});
        this._next = iconButton('go-next-symbolic', 'isle-nav', () => this.showPage(this._index + 1),
            {size: 12, accessibleName: 'Next page'});
        this._previous.x_expand = this._next.x_expand = true;
        this._previous.x_align = Clutter.ActorAlign.START;
        this._next.x_align = Clutter.ActorAlign.END;
        area.add_child(this._previous);
        area.add_child(this._next);
        return area;
    }

    /** The header sits in the top bar, so it is exactly as tall. */
    set topInset(height) {
        this._header.height = height;
    }

    get page() {
        return this._pages[this._index];
    }

    /** The width the island should have for the current page. */
    get preferredWidth() {
        return this.page.preferredWidth ?? EXPANDED_WIDTH;
    }

    /** RGB colour to wash the island with, or null. */
    get tint() {
        return this.page.tint ?? null;
    }

    pageNamed(name) {
        return this._pages.find(page => page.name === name) ?? null;
    }

    /** Shows the page at `index` (or with `name`), sliding in from its side. */
    showPage(target, {animate = true} = {}) {
        const index = typeof target === 'string'
            ? this._pages.findIndex(page => page.name === target)
            : target;
        if (index < 0 || index >= this._pages.length || index === this._index)
            return;

        const previous = this.page;
        const direction = index > this._index ? 1 : -1;
        this._index = index;
        const next = this.page;

        previous.setActive(false);
        previous.remove_all_transitions();
        next.remove_all_transitions();
        next.show();

        if (animate && St.Settings.get().enable_animations) {
            previous.ease({
                translation_x: -direction * SLIDE_DISTANCE,
                opacity: 0,
                duration: SLIDE_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onStopped: () => {
                    if (previous !== this.page)
                        previous.hide();
                    previous.translation_x = 0;
                    previous.opacity = 255;
                },
            });
            next.translation_x = direction * SLIDE_DISTANCE;
            next.opacity = 0;
            next.ease({
                translation_x: 0,
                opacity: 255,
                duration: SLIDE_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => this.emit('page-settled'),
            });
        } else {
            previous.hide();
            next.translation_x = 0;
            next.opacity = 255;
        }

        next.setActive(this._active);
        this._syncPage();
        this._syncWidth();
        this.emit('tint-changed');
        this.emit('page-changed');
    }

    /** Starts or stops everything that ticks while the island is open. */
    setActive(active) {
        if (active === this._active)
            return;
        this._active = active;
        this.page.setActive(active);
        this._updateHeader();
        if (active) {
            this._tickClock();
        } else {
            this._stopClock();
            this._stopRecordingTick();
        }
    }

    _syncPage() {
        this._dots.get_children().forEach((dot, index) => {
            if (index === this._index)
                dot.add_style_pseudo_class('checked');
            else
                dot.remove_style_pseudo_class('checked');
        });
        this._previous.visible = this._index > 0;
        this._next.visible = this._index < this._pages.length - 1;
        this._title.clutter_text.set_markup(this.page.headerTitle ?? '');
    }

    _syncWidth() {
        // Compare with the width we set, not `this.width`: reading that makes
        // St style the actor, which fails before it is on the stage.
        const width = this.preferredWidth;
        if (width === this._width)
            return;
        this._width = width;
        this.width = width;
        this.emit('width-changed');
    }

    _updateHeader() {
        const {nowPlaying, pomodoro} = this._daemon.state;
        const timerActive = pomodoro && pomodoro.phase !== 'idle';
        this._headerRing.visible = Boolean(timerActive);
        if (timerActive) {
            const remaining = pomodoro.running ? Math.max(0, pomodoro.ends_at_ms - Format.nowMs()) : pomodoro.remaining_ms;
            this._headerRing.color = timerColor(pomodoro.phase);
            this._headerRing.progress = 1 - remaining / pomodoro.duration_ms;
        }
        const playing = Playback.isPlaying(nowPlaying);
        this._headerBars.visible = playing;
        this._headerBars.playing = this._active && playing;

        const showPrivacy = this._settings.get_boolean('privacy-indicators');
        this._privacyDots.update(showPrivacy ? this._privacy : {});
        this._recordingButton.visible = this._privacy.recording;
        if (this._privacy.recording && this._active)
            this._tickRecording();
        else
            this._stopRecordingTick();
    }

    _tickRecording() {
        const elapsedMs = (GLib.get_monotonic_time() - this._privacy.recordingSince) / 1000;
        this._recordingTime.text = Format.duration(elapsedMs);
        this._stopRecordingTick();
        this._recordingTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000 - (elapsedMs % 1000) + 10, () => {
            this._recordingTimeout = 0;
            this._tickRecording();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopRecordingTick() {
        if (this._recordingTimeout) {
            GLib.source_remove(this._recordingTimeout);
            this._recordingTimeout = 0;
        }
    }

    _tickClock() {
        const now = GLib.DateTime.new_now_local();
        this._date.text = Format.longDate(now);
        this._time.text = Format.clockTime(now);
        this._updateHeader();
        const msIntoMinute = now.get_second() * 1000 + Math.floor(now.get_microsecond() / 1000);
        this._stopClock();
        this._clockTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60000 - msIntoMinute + 20, () => {
            this._clockTimeout = 0;
            this._tickClock();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopClock() {
        if (this._clockTimeout) {
            GLib.source_remove(this._clockTimeout);
            this._clockTimeout = 0;
        }
    }

    vfunc_scroll_event(event) {
        // Scrollable parts of pages (lyrics, the task list) see the event
        // first and stop it; anything else flips the page.
        const direction = event.get_scroll_direction();
        let step = 0;
        if (direction === Clutter.ScrollDirection.DOWN || direction === Clutter.ScrollDirection.RIGHT) {
            step = 1;
        } else if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.LEFT) {
            step = -1;
        } else if (direction === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            // Horizontal swipes on a touchpad are the natural gesture here.
            this._smoothScroll += Math.abs(dx) > Math.abs(dy) ? dx : dy;
            if (Math.abs(this._smoothScroll) >= SMOOTH_SCROLL_STEP) {
                step = Math.sign(this._smoothScroll);
                this._smoothScroll = 0;
            }
        }
        if (!step)
            return Clutter.EVENT_STOP;

        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastFlip < SCROLL_COOLDOWN_MS)
            return Clutter.EVENT_STOP;
        this._lastFlip = now;
        const index = Math.min(this._pages.length - 1, Math.max(0, this._index + step));
        this.showPage(index);
        return Clutter.EVENT_STOP;
    }

    _onDestroy() {
        this._stopClock();
        this._stopRecordingTick();
        this._daemon.disconnect(this._daemonChanged);
        this._privacy.disconnect(this._privacyChanged);
    }
});
