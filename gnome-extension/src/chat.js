// SPDX-License-Identifier: GPL-3.0-or-later

// The conversation above the assistant's pill (what you said in bubbles, its answers, the commands it ran),
// and the card that asks before a command that changes the system runs.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {BotIcon} from './botIcon.js';
import {VERTICAL} from './compat.js';
import * as Format from './format.js';
import {icon, iconButton, playMotion, wrapLines} from './widgets.js';

/** The little face beside its answers, in pixels. */
const FACE_SIZE = 18;
/** Messages this far apart (ms) get the time between them. */
const TIME_GAP_MS = 5 * 60000;
/** A bubble of yours is at most this wide; longer ones wrap. */
const BUBBLE_MAX = 300;
/** What a risk badge says, and its icon (see `risksOf` in isled). */
const RISKS = {
    root: ['isle-lock-symbolic', 'Password'],
    internet: ['isle-link', 'Script from the web'],
    removes: ['isle-trash', 'Removes things'],
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

/**
 * An answer's light Markdown as Pango markup: **bold**, `code` and "- " lists; everything else as written.
 * The text is escaped first, so nothing in it can be read as markup.
 */
export function answerMarkup(text) {
    return text.split('\n').map(line => {
        let out = GLib.markup_escape_text(line, -1);
        out = out.replace(/^\s*[-*•]\s+/, '  •  ');
        out = out.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
        out = out.replace(/`([^`]+)`/g, '<span font_family="monospace" background="#ffffff" bgalpha="12%">$1</span>');
        return out;
    }).join('\n');
}

/** How a command's words are coloured: a little like a shell's own highlighting. */
const SHELL = {
    prompt: ['#ffffff', 45],
    root: ['#ffb340', 100],
    program: ['#ffffff', 100],
    flag: ['#ffffff', 52],
    quoted: ['#64d2ff', 100],
    joiner: ['#ff6482', 100],
    word: ['#ffffff', 86],
};
/** A span of `text` in one of SHELL's colours (Pango wants its alpha apart). */
const span = ([color, alpha], text, bold = false) =>
    `<span foreground="${color}" fgalpha="${alpha}%"${bold ? ' weight="bold"' : ''}>${text}</span>`;
const JOINERS = new Set(['|', '||', '&&', ';', '>', '>>', '<', '2>&1']);

/** `command` as Pango markup: the program bright, sudo amber, flags dim, links and quotes blue, pipes pink. */
export function shellMarkup(command) {
    let first = true;
    const words = command.split(/(\s+)/).map(word => {
        if (/^\s+$/.test(word) || !word)
            return word;
        const text = GLib.markup_escape_text(word, -1);
        let color = SHELL.word;
        if (JOINERS.has(word)) {
            color = SHELL.joiner;
            first = true;
        } else if (word === 'sudo' || word === 'pkexec') {
            color = SHELL.root;
        } else if (first) {
            color = SHELL.program;
            first = false;
        } else if (word.startsWith('-')) {
            color = SHELL.flag;
        } else if (/^["']|:\/\//.test(word)) {
            color = SHELL.quoted;
        }
        return span(color, text, color === SHELL.program);
    });
    return `${span(SHELL.prompt, '$')} ${words.join('')}`;
}

/** A label with a key's name in a small box after it: Run ⏎. */
function keyButton(text, key, styleClass, onClick) {
    const box = new St.BoxLayout({style_class: 'isle-card-button-box'});
    box.add_child(label(text, 'isle-card-button-label', {y_align: Clutter.ActorAlign.CENTER}));
    const cap = label(key ?? '', 'isle-card-key', {y_align: Clutter.ActorAlign.CENTER, visible: Boolean(key)});
    box.add_child(cap);
    const button = new St.Button({child: box, style_class: `isle-pill isle-pill-small isle-card-button ${styleClass}${key ? '' : ' isle-card-button-plain'}`,
        can_focus: true, y_align: Clutter.ActorAlign.CENTER});
    button.connect('clicked', () => onClick());
    button.cap = cap;
    return button;
}

// The card for one command, made like a small terminal. Waiting: what it is for, the command coloured as a
// shell would, what to know first (chips), and Deny or Run (Esc or Enter). Running: its last lines as they
// print, how long, light sweeping along, and Stop. Ended: one line, done, failed (its error), denied or stopped.
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
        // The terminal's own sign, in a small tile, so the card reads as a command at a glance.
        this._glyph = new St.Bin({style_class: 'isle-card-glyph', y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({gicon: icon('isle-terminal-symbolic'), icon_size: 12})});
        top.add_child(this._glyph);
        this._title = label('', 'isle-card-title', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._chips = new St.BoxLayout({style_class: 'isle-card-chips', y_align: Clutter.ActorAlign.CENTER});
        this._status = new St.BoxLayout({style_class: 'isle-card-status', y_align: Clutter.ActorAlign.CENTER});
        this._statusIcon = new St.Icon({icon_size: 11, y_align: Clutter.ActorAlign.CENTER});
        this._statusText = label('', 'isle-card-status-text', {y_align: Clutter.ActorAlign.CENTER});
        this._status.add_child(this._statusIcon);
        this._status.add_child(this._statusText);
        top.add_child(this._title);
        top.add_child(this._chips);
        top.add_child(this._status);
        this.add_child(top);

        // The terminal: the command, then what it prints.
        this._terminal = new St.BoxLayout({...VERTICAL, style_class: 'isle-card-terminal'});
        // Its colours are markup, which the hyphen fix of `wrapLines` would undo at the start.
        this._command = label('', 'isle-card-command');
        this._command.clutter_text.set({use_markup: true, line_wrap_mode: Pango.WrapMode.WORD_CHAR});
        this._terminal.add_child(this._command);
        this._output = label('', 'isle-card-output');
        this._output.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._terminal.add_child(this._output);
        this._sweep = new Sweep();
        this._terminal.add_child(this._sweep);
        this.add_child(this._terminal);

        this._detail = label('', 'isle-card-detail');
        wrapLines(this._detail);
        this.add_child(this._detail);

        this._end = new St.BoxLayout({style_class: 'isle-card-end'});
        this._end.add_child(new St.Widget({x_expand: true}));
        this._stopButton = keyButton('Stop', null, 'isle-card-ghost', () => this.emit('stop'));
        this._deny = keyButton('Deny', 'esc', 'isle-card-ghost', () => this.decide(false));
        this._run = keyButton('Run', '⏎', 'isle-card-run', () => this.decide(true));
        for (const button of [this._stopButton, this._deny, this._run])
            this._end.add_child(button);
        this.add_child(this._end);
        this._state = null;
        this._lines = [];
        this.connect('destroy', () => (this._destroyed = true));
    }

    /**
     * Shows `card`: {command, why, detail, risks, status (waiting, running, done, failed, denied, stopped), output,
     * seconds, exit}.
     */
    setCard(card) {
        const previous = this._state;
        this._state = card.status;
        const waiting = card.status === 'waiting';
        const running = card.status === 'running';
        const ended = !waiting && !running;
        this._title.text = card.why;
        this._command.clutter_text.set_markup(shellMarkup(card.command));
        // Waiting, the whole command shows; once on its way, a line of it is enough.
        this._command.clutter_text.line_wrap = waiting;
        this._command.clutter_text.ellipsize = waiting ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END;

        this._chips.destroy_all_children();
        if (waiting) {
            for (const risk of card.risks ?? []) {
                const [iconName, text] = RISKS[risk] ?? [];
                if (!text)
                    continue;
                const chip = new St.BoxLayout({style_class: `isle-card-chip isle-card-chip-${risk}`});
                chip.add_child(new St.Icon({gicon: icon(iconName), icon_size: 10, y_align: Clutter.ActorAlign.CENTER}));
                chip.add_child(label(text, 'isle-card-chip-text', {y_align: Clutter.ActorAlign.CENTER}));
                this._chips.add_child(chip);
            }
        }
        this._chips.visible = this._chips.get_n_children() > 0;

        // Its last two lines as they print; on failure, the line that says why, in red.
        const lines = (card.output ?? '').split('\n').map(line => line.trimEnd()).filter(Boolean);
        this._output.text = running ? lines.slice(-2).join('\n') : card.status === 'failed' ? lines.at(-1) ?? '' : '';
        this._output.clutter_text.single_line_mode = false;
        this._output.visible = Boolean(this._output.text);
        this._output.style_class = card.status === 'failed' ? 'isle-card-output isle-card-output-failed' : 'isle-card-output';
        this._sweep.visible = running;

        this._detail.text = waiting ? card.detail ?? '' : '';
        this._detail.visible = Boolean(this._detail.text);

        const [iconName, text, styleClass] = running ? ['isle-timer-symbolic', elapsed(card.seconds ?? 0), 'isle-card-running']
            : STATUS[card.status] ?? [null, '', ''];
        this._status.visible = !waiting;
        if (iconName) {
            this._statusIcon.gicon = icon(iconName);
            const time = ended && card.seconds >= 1 ? ` · ${elapsed(card.seconds)}` : '';
            const exit = card.status === 'failed' && card.exit ? ` · exit ${card.exit}` : '';
            this._statusText.text = `${text}${exit}${time}`;
            this._status.style_class = `isle-card-status ${styleClass}`;
        }
        this._end.visible = waiting || running;
        this._deny.visible = this._run.visible = waiting;
        this._stopButton.visible = running;
        // Ended, it steps back: the answer above is what matters now.
        this.style_class = ended ? 'isle-card isle-card-ended' : 'isle-card';
        this.opacity = card.status === 'denied' || card.status === 'stopped' ? 165 : 255;
        if (ended && previous && previous !== card.status && St.Settings.get().enable_animations) {
            this._statusIcon.set_pivot_point(0.5, 0.5);
            this._statusIcon.set({scale_x: 0.4, scale_y: 0.4, opacity: 0});
            this._statusIcon.ease({scale_x: 1, scale_y: 1, opacity: 255, duration: 320, mode: Clutter.AnimationMode.EASE_OUT_BACK});
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

    /** Run (true) or Deny (false): a small press, or a shake; then it goes on. Also from Enter and Esc. */
    decide(run) {
        if (this._state !== 'waiting')
            return;
        const button = run ? this._run : this._deny;
        if (St.Settings.get().enable_animations) {
            button.set_pivot_point(0.5, 0.5);
            button.ease({scale_x: 0.92, scale_y: 0.92, duration: 80, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => !this._destroyed && button.ease({scale_x: 1, scale_y: 1, duration: 240,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK})});
            if (!run)
                playMotion(this, 'shake');
        }
        this.emit('decided', run);
    }
});

// The conversation so far: your words right, in bubbles (a mic for spoken ones), its answers left, the
// commands it ran as short lines; + starts a new one. It scrolls, newest at the bottom.
export const ChatView = GObject.registerClass({
    Signals: {'new-chat': {}, 'close': {}},
}, class ChatView extends St.BoxLayout {
    _init() {
        super._init({...VERTICAL, style_class: 'isle-chat', x_expand: true});
        const header = new St.BoxLayout({style_class: 'isle-chat-header'});
        this._title = label('Chat', 'isle-chat-title', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        header.add_child(this._title);
        header.add_child(iconButton('isle-plus-symbolic', 'isle-button-flat isle-chat-new', () => this.emit('new-chat'),
            {size: 13, accessibleName: 'New chat'}));
        header.add_child(iconButton('isle-chevron-down-symbolic', 'isle-button-flat isle-chat-new', () => this.emit('close'),
            {size: 13, accessibleName: 'Hide the conversation'}));
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

    /** {shape, palette} for the little face beside its answers (see bot.js). */
    set look(look) {
        this._look = look;
        this.setItems(this._items);
    }

    /**
     * The messages: [{role: user | assistant | command, text, spoken, command, status, at (ms)}]. A gap of a while
     * gets the time above it; its answers after yours get its face.
     */
    setItems(items) {
        // Those after the ones shown before are new: they rise into place.
        const known = this._items.length && items.length >= this._items.length && items[0] === this._items[0]
            ? this._items.length : items.length;
        this._items = items;
        this._list.destroy_all_children();
        let last = null;
        items.forEach((item, index) => {
            if (item.at && (!last?.at || item.at - last.at > TIME_GAP_MS))
                this._list.add_child(label(Format.timeOfDay(GLib.DateTime.new_from_unix_local(Math.floor(item.at / 1000))),
                    'isle-chat-time', {x_align: Clutter.ActorAlign.CENTER}));
            const row = this._row(item, last?.role !== 'assistant');
            this._list.add_child(row);
            if (index >= known && St.Settings.get().enable_animations) {
                row.set({opacity: 0, translation_y: 10});
                row.ease({opacity: 255, translation_y: 0, duration: 260, delay: 60 * (index - known),
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            }
            last = item;
        });
        this._title.text = 'Conversation';
    }

    get count() {
        return this._items.length;
    }

    _row(item, withFace) {
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
            row.add_child(new St.Widget({width: FACE_SIZE}));
            const command = label('', 'isle-chat-command-text', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            command.clutter_text.set_markup(shellMarkup(item.command));
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
        const row = new St.BoxLayout({style_class: 'isle-chat-reply-row'});
        // The face once per run of answers; a space as wide after it, so their text lines up.
        const face = withFace && this._look ? new BotIcon(FACE_SIZE, this._look) : new St.Widget({width: FACE_SIZE});
        face.y_align = Clutter.ActorAlign.START;
        row.add_child(face);
        const text = label('', 'isle-chat-reply', {x_expand: true});
        text.clutter_text.set({line_wrap: true, line_wrap_mode: Pango.WrapMode.WORD_CHAR, ellipsize: Pango.EllipsizeMode.NONE});
        text.clutter_text.set_markup(answerMarkup(item.text));
        row.add_child(text);
        return row;
    }

    /** The height it would like at `width`, header and all, for the island to fit (never more than `max`). */
    naturalHeight(width, max) {
        const parts = [this.get_first_child(), this._list].map(part => part.get_preferred_height(width)[1]);
        const node = this.get_theme_node();
        return Math.min(max, Math.ceil(parts[0] + parts[1] + node.get_length('spacing') + node.get_vertical_padding()));
    }
});
