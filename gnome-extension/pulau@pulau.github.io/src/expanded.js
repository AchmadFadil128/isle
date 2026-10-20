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
import {Bars, Ring, iconButton, label} from './widgets.js';

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
        // The current page wants the island wider or narrower.
        'width-changed': {},
        // The current page's tint colour changed; see `tint`.
        'tint-changed': {},
    },
}, class ExpandedView extends St.BoxLayout {
    _init(daemon, pages) {
        super._init({vertical: true, style_class: 'pulau-expanded', width: EXPANDED_WIDTH});
        this._daemon = daemon;
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

        this._dots = new St.BoxLayout({style_class: 'pulau-dots', x_align: Clutter.ActorAlign.CENTER, height: DOTS_HEIGHT});
        pages.forEach((page, index) => {
            const dot = new St.Button({style_class: 'pulau-dot', accessible_name: page.name, y_align: Clutter.ActorAlign.CENTER});
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
        this._syncPage();
        this._syncWidth();
    }

    _buildHeader() {
        const header = new St.Widget({layout_manager: new Clutter.BinLayout(), style_class: 'pulau-header'});

        this._title = new St.Label({
            style_class: 'pulau-header-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._title);

        const clock = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, style_class: 'pulau-header-clock'});
        this._headerRing = new Ring({size: 15, lineWidth: 2.5});
        this._date = label('', 'pulau-header-date');
        this._time = label('', 'pulau-header-time');
        clock.add_child(this._headerRing);
        clock.add_child(this._date);
        clock.add_child(this._time);
        header.add_child(clock);

        this._headerBars = new Bars({height: 14});
        this._headerBars.x_expand = true;
        this._headerBars.x_align = Clutter.ActorAlign.END;
        header.add_child(this._headerBars);
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
        this._previous = iconButton('go-previous-symbolic', 'pulau-nav', () => this.showPage(this._index - 1),
            {size: 12, accessibleName: 'Previous page'});
        this._next = iconButton('go-next-symbolic', 'pulau-nav', () => this.showPage(this._index + 1),
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
            next.ease({translation_x: 0, opacity: 255, duration: SLIDE_DURATION, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
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
        if (active)
            this._tickClock();
        else
            this._stopClock();
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

    vfunc_destroy() {
        this._stopClock();
        this._daemon.disconnect(this._daemonChanged);
        super.vfunc_destroy();
    }
});
