// SPDX-License-Identifier: GPL-3.0-or-later

// The conversation above the assistant's pill (what you said in bubbles, its answers, the commands it ran),
// and the card that asks before a command that changes the system runs.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL} from './compat.js';
import {icon, iconButton, pillButton, playMotion, wrapLines} from './widgets.js';

/** A bubble of yours is at most this wide; longer ones wrap. */
const BUBBLE_MAX = 300;
/** What a risk badge says, and its icon (see `risksOf` in isled). */
const RISKS = {
    root: ['isle-lock-symbolic', 'Asks for your password'],
    internet: ['isle-link', 'Runs a script from the internet'],
    removes: ['isle-trash', 'Removes files or apps'],
};
const STATUS = {
    done: ['isle-check-symbolic', 'Done', 'isle-card-done'],
    failed: ['isle-close-symbolic', 'Failed', 'isle-card-failed'],
    denied: ['isle-close-symbolic', 'Denied', 'isle-card-denied'],
    stopped: ['isle-stop-symbolic', 'Stopped', 'isle-card-denied'],
};

const label = (text, styleClass, params = {}) => new St.Label({text, style_class: styleClass, ...params});

/** m:ss for an elapsed time in seconds. */
export const elapsed = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

// A box no wider than `max`, as tall as its text wrapped at that width (St would measure one line).
const Bubble = GObject.registerClass(
class Bubble extends St.BoxLayout {
    _init(params, max) {
        super._init(params);
        this._max = max;
    }

    vfunc_get_preferred_width(forHeight) {
        const [min, natural] = super.vfunc_get_preferred_width(forHeight);
        return [Math.min(min, this._max), Math.min(natural, this._max)];
    }

    vfunc_get_preferred_height(forWidth) {
        const width = forWidth < 0 ? this._max : Math.min(forWidth, this._max);
        const [, natural] = super.vfunc_get_preferred_height(width);
        return [natural, natural];
    }
});

// A thin line with light sweeping along it: a command runs, for however long it takes. Moved by the
// assistant's own frame clock (`tick`), so it costs nothing of its own.
const Sweep = GObject.registerClass(
class Sweep extends St.DrawingArea {
    _init() {
        super._init({style_class: 'isle-card-sweep', height: 3, x_expand: true});
        this._time = 0;
        this.connect('repaint', area => this._paint(area));
    }

    tick(time) {
        this._time = time;
        if (this.mapped)
            this.queue_repaint();
    }

    _paint(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const r = height / 2;
        cr.newSubPath();
        cr.arc(r, r, r, Math.PI / 2, 1.5 * Math.PI);
        cr.arc(width - r, r, r, -Math.PI / 2, Math.PI / 2);
        cr.closePath();
        cr.setSourceRGBA(1, 1, 1, 0.1);
        cr.fillPreserve();
        const at = (this._time * 0.55) % 1.4 - 0.2;
        const light = new Cairo.LinearGradient(0, 0, width, 0);
        for (const [offset, alpha] of [[at - 0.22, 0], [at, 0.85], [at + 0.22, 0]])
            light.addColorStopRGBA(Math.max(0, Math.min(1, offset)), 1, 1, 1, alpha);
        cr.setSource(light);
        cr.fill();
        cr.$dispose();
    }
});

// The card for one command: what it is for, the command itself, what it might do, and Deny or Run; then
// it runs (the last line it printed, how long), and ends done, failed, denied or stopped.
export const CommandCard = GObject.registerClass({
    Signals: {
        // Run (true) or Deny (false), pressed.
        'decided': {param_types: [GObject.TYPE_BOOLEAN]},
        'stop': {},
    },
}, class CommandCard extends St.BoxLayout {
    _init() {
        super._init({...VERTICAL, style_class: 'isle-card', x_expand: true});
        this.set_pivot_point(0.5, 0.5);
        const top = new St.BoxLayout({style_class: 'isle-card-top'});
        this._glyph = new St.Icon({gicon: icon('isle-terminal-symbolic'), icon_size: 13, style_class: 'isle-card-glyph',
            y_align: Clutter.ActorAlign.CENTER});
        this._title = label('', 'isle-card-title', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._time = label('', 'isle-card-time', {y_align: Clutter.ActorAlign.CENTER});
        top.add_child(this._glyph);
        top.add_child(this._title);
        top.add_child(this._time);
        this.add_child(top);

        this._command = label('', 'isle-card-command');
        wrapLines(this._command, Pango.EllipsizeMode.END);
        this._command.clutter_text.set({line_wrap_mode: Pango.WrapMode.WORD_CHAR});
        this.add_child(this._command);
        this._output = label('', 'isle-card-output');
        this._output.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.add_child(this._output);
        this._risks = new St.BoxLayout({...VERTICAL, style_class: 'isle-card-risks'});
        this.add_child(this._risks);

        // The end: the buttons, or how it runs, or how it ended.
        this._end = new St.BoxLayout({style_class: 'isle-card-end'});
        this._sweep = new Sweep();
        this._sweep.y_align = Clutter.ActorAlign.CENTER;
        this._stopButton = pillButton('Stop', 'isle-pill-small isle-card-button', () => this.emit('stop'));
        this._status = new St.BoxLayout({style_class: 'isle-card-status', x_expand: true});
        this._statusIcon = new St.Icon({icon_size: 12, y_align: Clutter.ActorAlign.CENTER});
        this._statusText = label('', 'isle-card-status-text', {y_align: Clutter.ActorAlign.CENTER});
        this._status.add_child(this._statusIcon);
        this._status.add_child(this._statusText);
        this._deny = pillButton('Deny', 'isle-pill-small isle-card-button', () => this._decide(false));
        this._run = pillButton('Run', 'isle-pill-small isle-card-button isle-card-run', () => this._decide(true));
        const spacer = new St.Widget({x_expand: true});
        for (const part of [this._status, this._sweep, spacer, this._stopButton, this._deny, this._run])
            this._end.add_child(part);
        this._spacer = spacer;
        this.add_child(this._end);
        this._state = null;
        this.connect('destroy', () => (this._destroyed = true));
    }

    /** Shows `card`: {command, why, risks, status (waiting, running, done, failed, denied, stopped), output, seconds}. */
    setCard(card) {
        const previous = this._state;
        this._state = card.status;
        const waiting = card.status === 'waiting';
        const running = card.status === 'running';
        this._title.text = running ? `${card.why}…` : card.why;
        this._command.text = card.command;
        this._command.clutter_text.ellipsize = waiting ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END;
        this._command.clutter_text.line_wrap = waiting;
        this._time.text = card.seconds >= 1 && !waiting ? elapsed(card.seconds) : '';
        this._time.visible = Boolean(this._time.text);
        const output = (card.output ?? '').trim().split('\n').at(-1) ?? '';
        this._output.text = output;
        this._output.visible = (running || card.status === 'failed') && Boolean(output);
        this._risks.destroy_all_children();
        if (waiting) {
            for (const risk of card.risks ?? []) {
                const [iconName, text] = RISKS[risk] ?? [];
                if (!text)
                    continue;
                const row = new St.BoxLayout({style_class: 'isle-card-risk'});
                row.add_child(new St.Icon({gicon: icon(iconName), icon_size: 11, y_align: Clutter.ActorAlign.CENTER}));
                row.add_child(label(text, 'isle-card-risk-text', {y_align: Clutter.ActorAlign.CENTER}));
                this._risks.add_child(row);
            }
        }
        this._risks.visible = this._risks.get_n_children() > 0;
        this._deny.visible = this._run.visible = waiting;
        this._spacer.visible = waiting;
        this._sweep.visible = this._stopButton.visible = running;
        const ended = STATUS[card.status];
        this._status.visible = Boolean(ended);
        if (ended) {
            const [iconName, text, styleClass] = ended;
            this._statusIcon.gicon = icon(iconName);
            this._statusText.text = card.status === 'failed' && card.exit ? `${text} · exit ${card.exit}` : text;
            this._status.style_class = `isle-card-status ${styleClass}`;
            this.opacity = card.status === 'denied' || card.status === 'stopped' ? 170 : 255;
            // Done: the tick pops in.
            if (previous && previous !== card.status && St.Settings.get().enable_animations) {
                this._statusIcon.set_pivot_point(0.5, 0.5);
                this._statusIcon.set({scale_x: 0.4, scale_y: 0.4, opacity: 0});
                this._statusIcon.ease({scale_x: 1, scale_y: 1, opacity: 255, duration: 320, mode: Clutter.AnimationMode.EASE_OUT_BACK});
            }
        } else {
            this.opacity = 255;
        }
    }

    get status() {
        return this._state;
    }

    /** Moves the running sweep on, with the assistant's clock. */
    tick(time) {
        if (this._sweep.visible)
            this._sweep.tick(time);
    }

    // Run: a small press, then it runs. Deny: a shake, then it is set aside.
    _decide(run) {
        if (this._state !== 'waiting')
            return;
        if (St.Settings.get().enable_animations) {
            if (run) {
                this.remove_all_transitions();
                this.ease({scale_x: 0.97, scale_y: 0.97, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => !this._destroyed && this.ease({scale_x: 1, scale_y: 1, duration: 260,
                        mode: Clutter.AnimationMode.EASE_OUT_BACK})});
            } else {
                playMotion(this, 'shake');
            }
        }
        this.emit('decided', run);
    }
});

// The conversation so far: your words right, in bubbles (a mic for spoken ones), its answers left, the
// commands it ran as short lines; + starts a new one. It scrolls, newest at the bottom.
export const ChatView = GObject.registerClass({
    Signals: {'new-chat': {}},
}, class ChatView extends St.BoxLayout {
    _init() {
        super._init({...VERTICAL, style_class: 'isle-chat', x_expand: true});
        const header = new St.BoxLayout({style_class: 'isle-chat-header'});
        this._title = label('Chat', 'isle-chat-title', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        header.add_child(this._title);
        header.add_child(iconButton('isle-plus-symbolic', 'isle-button-flat isle-chat-new', () => this.emit('new-chat'),
            {size: 13, accessibleName: 'New chat'}));
        this.add_child(header);
        this._list = new St.BoxLayout({...VERTICAL, style_class: 'isle-chat-list', x_expand: true});
        this._scroll = new St.ScrollView({
            style_class: 'isle-chat-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(this._list);
        this.add_child(this._scroll);
        this._items = [];
        // New messages come in at the bottom, and it keeps there.
        this._scroll.vadjustment.connect('notify::upper', adjustment => {
            adjustment.value = adjustment.upper - adjustment.page_size;
        });
    }

    /** The messages: [{role: user | assistant | command, text, spoken, command, why, status}]. */
    setItems(items) {
        this._items = items;
        this._list.destroy_all_children();
        for (const item of items)
            this._list.add_child(this._row(item));
        this._title.text = items.length ? 'Chat' : 'New chat';
    }

    get count() {
        return this._items.length;
    }

    _row(item) {
        if (item.role === 'user') {
            const bubble = new Bubble({style_class: 'isle-chat-user', x_align: Clutter.ActorAlign.END}, BUBBLE_MAX);
            if (item.spoken) {
                bubble.add_child(new St.Icon({gicon: icon('isle-mic-symbolic'), icon_size: 11, style_class: 'isle-chat-spoken',
                    y_align: Clutter.ActorAlign.START}));
            }
            const text = label(item.text, 'isle-chat-user-text', {x_expand: true});
            wrapLines(text);
            bubble.add_child(text);
            return bubble;
        }
        if (item.role === 'command') {
            const row = new St.BoxLayout({style_class: 'isle-chat-command'});
            const [iconName, text, styleClass] = STATUS[item.status] ?? ['isle-terminal-symbolic', '', ''];
            row.add_child(new St.Icon({gicon: icon('isle-terminal-symbolic'), icon_size: 11, style_class: 'isle-chat-command-glyph',
                y_align: Clutter.ActorAlign.CENTER}));
            const command = label(item.command, 'isle-chat-command-text', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            command.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(command);
            if (text) {
                const status = new St.BoxLayout({style_class: `isle-card-status isle-chat-command-status ${styleClass}`});
                status.add_child(new St.Icon({gicon: icon(iconName), icon_size: 10, y_align: Clutter.ActorAlign.CENTER}));
                status.add_child(label(text, 'isle-card-status-text', {y_align: Clutter.ActorAlign.CENTER}));
                row.add_child(status);
            }
            return row;
        }
        const text = label(item.text, 'isle-chat-reply');
        wrapLines(text);
        return text;
    }

    /** The height it would like at `width`, header and all, for the island to fit (never more than `max`). */
    naturalHeight(width, max) {
        const parts = [this.get_first_child(), this._list].map(part => part.get_preferred_height(width)[1]);
        const node = this.get_theme_node();
        return Math.min(max, Math.ceil(parts[0] + parts[1] + node.get_length('spacing') + node.get_vertical_padding()));
    }
});
