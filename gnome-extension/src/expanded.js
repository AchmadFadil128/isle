// SPDX-License-Identifier: GPL-3.0-or-later

// The open island: a header row inside the top bar (tabs to the pages on the
// left; live activity and the clock on the right) above one page at a time. See docs/product-spec.md, section 5.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {timerColor} from './compact.js';
import {VERTICAL} from './compat.js';
import * as Format from './format.js';
import * as Playback from './playback.js';
import {Bars, PrivacyDots, RecordingDot, Ring, icon, label} from './widgets.js';

export const EXPANDED_WIDTH = 600;
export const PAGE_HEIGHT = 150;
/** Room below the page, so its content clears the rounded corners. */
export const BOTTOM_PADDING = 14;

/** Each page's tab: its icon, and the label shown while it is open. */
const TABS = {
    call: {icon: 'isle-phone-symbolic', label: 'Call'},
    music: {icon: 'isle-music', label: 'Music'},
    notifications: {icon: 'isle-bell', label: 'Notifications'},
    focus: {icon: 'isle-timer', label: 'Focus'},
    shelf: {icon: 'isle-shelf', label: 'Shelf'},
    tasks: {icon: 'isle-tasks', label: 'Tasks'},
    calendar: {icon: 'isle-calendar', label: 'Calendar'},
};
/** How bright a tab's icon is: open, under the pointer, otherwise. */
const TAB_OPACITY = {open: 255, hover: 230, idle: 140};

const SLIDE_DISTANCE = 48;
const SLIDE_DURATION = 260;
/** Touchpad travel (in wheel clicks) that flips a page; one flip a swipe. */
const SWIPE_STEP = 1.5;
/** Wheel travel that flips a page; a long spin flips several. */
const WHEEL_STEP = 1;
/** Minimum time between page flips from a spinning wheel. */
const WHEEL_REPEAT_MS = 200;
/** A pause this long between scroll events starts a new gesture. */
const GESTURE_GAP_MS = 180;

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
    _init(daemon, privacy, call, settings, pages) {
        super._init({...VERTICAL, style_class: 'isle-expanded', width: EXPANDED_WIDTH});
        this._daemon = daemon;
        this._privacy = privacy;
        this._call = call;
        this._settings = settings;
        this._pages = pages;
        // Some pages (Call) have no tab until there is something on them.
        this._index = Math.max(0, pages.findIndex(page => page.available));
        this._active = false;
        this._width = EXPANDED_WIDTH;
        this._lastFlip = 0;
        /** The scroll gesture in progress: travel so far, and whether it flipped. */
        this._gesture = {dx: 0, dy: 0, flipped: false, at: 0};
        /** Set once smooth scrolling is seen; its click-style copies are then ignored. */
        this._smoothScrolling = false;
        this._clockTimeout = 0;
        this._callTimeout = 0;

        // Sideways scrolls always flip pages, so catch them before lists and lyrics do;
        // vertical scrolls those leave flip pages in `vfunc_scroll_event`.
        this.connect('captured-event', (_actor, event) => this._captureScroll(event));

        this._header = this._buildHeader();
        this.add_child(this._header);
        this.add_child(this._buildPager());
        this.add_child(new St.Widget({height: BOTTOM_PADDING}));

        for (const page of pages) {
            page.connect('width-changed', () => {
                if (page === this.page)
                    this._syncWidth();
            });
            page.connect('tint-changed', () => {
                if (page === this.page)
                    this.emit('tint-changed');
            });
            page.connect('news-changed', () => this._syncTabs());
            page.connect('availability-changed', () => this._onAvailabilityChanged(page));
        }

        this._daemonChanged = daemon.connect('changed', (_daemon, key) => {
            if (key === 'nowPlaying' || key === 'pomodoro')
                this._updateHeader();
        });
        this._privacyChanged = privacy.connect('changed', () => this._updateHeader());
        this._callChanged = call.connect('changed', () => this._updateHeader());
        this._syncPage();
        this._syncWidth();
        this.connect('destroy', () => this._onDestroy());
    }

    _buildHeader() {
        const header = new St.Widget({layout_manager: new Clutter.BinLayout(), style_class: 'isle-header'});
        header.add_child(this._buildTabs());

        // Right: a running recording (click to stop), the call (click to see it),
        // privacy dots, music, the focus ring and the clock.
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
        const callBox = new St.BoxLayout({style_class: 'isle-call-pill-box'});
        callBox.add_child(new St.Icon({gicon: icon('isle-phone-symbolic'), icon_size: 11, style_class: 'isle-call-icon', y_align: Clutter.ActorAlign.CENTER}));
        this._callTime = label('', 'isle-call-pill-time');
        callBox.add_child(this._callTime);
        this._callButton = new St.Button({
            style_class: 'isle-call-pill',
            child: callBox,
            accessible_name: 'Show the call',
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._callButton.connect('clicked', () => this.showPage('call'));
        this._privacyDots = new PrivacyDots();
        this._headerBars = new Bars({height: 14});
        status.add_child(this._recordingButton);
        status.add_child(this._callButton);
        status.add_child(this._privacyDots);
        status.add_child(this._headerBars);

        const clock = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER, style_class: 'isle-header-clock'});
        this._headerRing = new Ring({size: 15, lineWidth: 2.5});
        this._date = label('', 'isle-header-date');
        this._time = label('', 'isle-header-time');
        clock.add_child(this._headerRing);
        clock.add_child(this._date);
        clock.add_child(this._time);
        status.add_child(clock);
        header.add_child(status);
        return header;
    }

    /** A tab per page; the open one is lit and says its name. */
    _buildTabs() {
        const tabs = new St.BoxLayout({style_class: 'isle-tabs', x_expand: true, x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER});
        this._tabs = this._pages.map((page, index) => {
            const {icon: iconName, label: text} = TABS[page.name];
            const glyph = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
            const tabIcon = new St.Icon({gicon: icon(iconName), icon_size: 15});
            glyph.add_child(tabIcon);
            // Something new waits on this page (unseen notifications).
            const badge = new St.Widget({
                style_class: 'isle-tab-badge',
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.START,
                visible: false,
            });
            glyph.add_child(badge);
            const name = label(text, 'isle-tab-label', {y_align: Clutter.ActorAlign.CENTER});
            const box = new St.BoxLayout({style_class: 'isle-tab-box'});
            box.add_child(glyph);
            box.add_child(name);
            const tab = new St.Button({
                style_class: `isle-tab isle-tab-${page.name}`,
                child: box,
                can_focus: true,
                track_hover: true,
                accessible_name: text,
                y_align: Clutter.ActorAlign.CENTER,
            });
            tab.connect('clicked', () => this.showPage(index));
            tab.connect('notify::hover', () => this._syncTabs());
            tabs.add_child(tab);
            return {tab, icon: tabIcon, name, badge};
        });
        return tabs;
    }

    /** Lights the open page's tab and shows which pages have news. */
    _syncTabs() {
        this._tabs.forEach(({tab, icon: tabIcon, name, badge}, index) => {
            const open = index === this._index;
            if (open)
                tab.add_style_pseudo_class('checked');
            else
                tab.remove_style_pseudo_class('checked');
            name.visible = open;
            tab.visible = this._pages[index].available;
            tabIcon.opacity = TAB_OPACITY[open ? 'open' : tab.hover ? 'hover' : 'idle'];
            badge.visible = !open && Boolean(this._pages[index].hasNews);
        });
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
        this.page.show();
        area.add_child(this._pager);
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

    /** How `tint` colours the island; see `Island.setTint`. */
    get tintStyle() {
        return this.page.tintStyle;
    }

    pageNamed(name) {
        return this._pages.find(page => page.name === name) ?? null;
    }

    /** Shows the page at `index` (or with `name`), sliding in from its side. */
    showPage(target, {animate = true} = {}) {
        const index = typeof target === 'string'
            ? this._pages.findIndex(page => page.name === target)
            : target;
        if (index < 0 || index >= this._pages.length || index === this._index || !this._pages[index].available)
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
            this._stopCallTick();
        }
    }

    _syncPage() {
        this._syncTabs();
        this._updateHeader();
    }

    /** A page lost its tab: leave it for the next page that has one. */
    _onAvailabilityChanged(page) {
        this._syncTabs();
        if (page !== this.page || page.available)
            return;
        const index = this._nearestAvailable(this._index, 1) ?? this._nearestAvailable(this._index, -1);
        if (index === null)
            return;
        this._automatic = true;
        this.showPage(index, {animate: this._active});
        this._automatic = false;
    }

    /** Whether the page just shown was picked by the user, not left for another on its own. */
    get pickedByHand() {
        return !this._automatic;
    }

    /** The first page from `index` on in `direction` (±1) that has a tab, or null. */
    _nearestAvailable(index, direction) {
        for (let i = index + direction; i >= 0 && i < this._pages.length; i += direction) {
            if (this._pages[i].available)
                return i;
        }
        return null;
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

        const privacy = this._settings.get_boolean('privacy-indicators') ? this._privacy : {};
        // On a call the microphone is a given (the call's own button says so), unless another app records too.
        const microphone = privacy.microphone && (!this._call.active || this._call.othersRecording);
        this._privacyDots.update({camera: privacy.camera, microphone, screenShare: privacy.screenShare});
        this._recordingButton.visible = this._privacy.recording;
        if (this._privacy.recording && this._active)
            this._tickRecording();
        else
            this._stopRecordingTick();
        // The Call page shows the call itself.
        this._callButton.visible = this._call.active && this.page.name !== 'call';
        if (this._callButton.visible && this._active)
            this._tickCall();
        else
            this._stopCallTick();
    }

    _tickCall() {
        const elapsedMs = (GLib.get_monotonic_time() - this._call.since) / 1000;
        this._callTime.text = Format.duration(elapsedMs);
        this._stopCallTick();
        this._callTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000 - (elapsedMs % 1000) + 10, () => {
            this._callTimeout = 0;
            this._tickCall();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopCallTick() {
        if (this._callTimeout) {
            GLib.source_remove(this._callTimeout);
            this._callTimeout = 0;
        }
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

    _captureScroll(event) {
        if (event.type() !== Clutter.EventType.SCROLL)
            return Clutter.EVENT_PROPAGATE;
        // Smooth scrolls also come as click-style copies (UP, LEFT, ...),
        // not always marked as emulated; counting both flipped two pages.
        const smooth = event.get_scroll_direction() === Clutter.ScrollDirection.SMOOTH;
        this._smoothScrolling ||= smooth;
        if (this._isCopy(event))
            return this._overList(event) ? Clutter.EVENT_PROPAGATE : Clutter.EVENT_STOP;
        this._trackGesture(event);
        return this._isSideways(event) ? this._flipFromScroll(event) : Clutter.EVENT_PROPAGATE;
    }

    vfunc_scroll_event(event) {
        // A click-style copy let through for a list flips nothing.
        if (this._isCopy(event))
            return Clutter.EVENT_STOP;
        // An up/down scroll no page part wanted.
        return this._flipFromScroll(event);
    }

    /** Whether `event` is the click-style copy of a smooth scroll. */
    _isCopy(event) {
        return event.get_scroll_direction() !== Clutter.ScrollDirection.SMOOTH &&
            (this._smoothScrolling || Boolean(event.get_flags() & Clutter.EventFlags.POINTER_EMULATED));
    }

    // Whether a wheel click is over a vertical list. St.ScrollView steps only on
    // the click and ignores its smooth copy, so the click must reach it.
    _overList(event) {
        const direction = event.get_scroll_direction();
        if (direction !== Clutter.ScrollDirection.UP && direction !== Clutter.ScrollDirection.DOWN)
            return false;
        if (event.get_scroll_source() === Clutter.ScrollSource.FINGER)
            return false;
        let actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, ...event.get_coords());
        for (; actor && actor !== this; actor = actor.get_parent()) {
            if (actor instanceof St.ScrollView)
                return actor.vscrollbar_policy !== St.PolicyType.NEVER;
        }
        return false;
    }

    /** Adds `event` to the gesture in progress, or starts a new one. */
    _trackGesture(event) {
        const now = GLib.get_monotonic_time() / 1000;
        const gesture = this._gesture;
        if (now - gesture.at > GESTURE_GAP_MS)
            Object.assign(gesture, {dx: 0, dy: 0, flipped: false});
        gesture.at = now;
        let stopped = event.get_scroll_finish_flags() !== Clutter.ScrollFinishFlags.NONE;
        if (event.get_scroll_direction() === Clutter.ScrollDirection.SMOOTH) {
            const [dx, dy] = event.get_scroll_delta();
            gesture.dx += dx;
            gesture.dy += dy;
            // A touchpad ends each swipe with an event that does not move.
            stopped ||= dx === 0 && dy === 0;
        }
        // Fingers lifted: the next touch is a new swipe however soon it comes.
        if (stopped)
            gesture.at = 0;
    }

    /** Whether `event` belongs to a sideways scroll. */
    _isSideways(event) {
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.LEFT:
        case Clutter.ScrollDirection.RIGHT:
            return true;
        case Clutter.ScrollDirection.SMOOTH:
            // The whole gesture decides, so a wobble does not switch axis.
            return Math.abs(this._gesture.dx) > Math.abs(this._gesture.dy);
        default:
            return false;
        }
    }

    /** Flips the page if the scroll so far calls for it. */
    _flipFromScroll(event) {
        const gesture = this._gesture;
        const now = GLib.get_monotonic_time() / 1000;
        let step = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            step = 1;
            break;
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            step = -1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const travel = this._isSideways(event) ? gesture.dx : gesture.dy;
            const wheel = event.get_scroll_source() === Clutter.ScrollSource.WHEEL;
            if (gesture.flipped || Math.abs(travel) < (wheel ? WHEEL_STEP : SWIPE_STEP))
                return Clutter.EVENT_STOP;
            step = Math.sign(travel);
            if (wheel) {
                // Count afresh, so a long spin flips again.
                gesture.dx = gesture.dy = 0;
            } else {
                // One page a swipe, however far it goes.
                gesture.flipped = true;
            }
            break;
        }
        }
        if (!step)
            return Clutter.EVENT_STOP;
        // Clicks and spins are spaced out; a swipe flips once anyway.
        if (!gesture.flipped && now - this._lastFlip < WHEEL_REPEAT_MS)
            return Clutter.EVENT_STOP;
        this._lastFlip = now;
        // Pages without a tab are skipped.
        const index = this._nearestAvailable(this._index, step);
        if (index !== null)
            this.showPage(index);
        return Clutter.EVENT_STOP;
    }

    _onDestroy() {
        this._stopClock();
        this._stopRecordingTick();
        this._stopCallTick();
        this._daemon.disconnect(this._daemonChanged);
        this._privacy.disconnect(this._privacyChanged);
        this._call.disconnect(this._callChanged);
    }
});
