// SPDX-License-Identifier: GPL-3.0-or-later

// The voice assistant's view: a little character with lively eyes that listens, thinks and answers,
// beside what was heard and the answer. isled listens and asks the AI; the actions it answers with run here.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {isTerminal} from './clipboard.js';
import {VERTICAL} from './compat.js';
import {plainBody} from './notifications.js';
import {pillButton} from './widgets.js';

/** Three calm colours, violet to blue to cyan, that light the island while it is open (see island.js). */
export const SIRI_COLORS = [[0.56, 0.4, 1], [0.27, 0.56, 1], [0.22, 0.84, 0.96]];

const FACE_SIZE = 36;
/** The pill while listening, and the panel an answer opens into. */
const LISTENING_WIDTH = 280;
const ANSWER_WIDTH = 460;
/** Row padding plus the face and the gap after it (see stylesheet.css). */
const TEXT_INSET = 16 + 22 + FACE_SIZE + 14;
/** The row's padding above and below the texts; below leaves room for the glow. */
const ROW_PADDING = 14 + 22;
/** Always room for the whole face. */
const MIN_HEIGHT = FACE_SIZE + ROW_PADDING;
const MAX_HEIGHT = 230;
/** Answers past this many characters are cut, the panel being small. */
const MAX_REPLY = 360;
/** Selected text past this many characters is cut before it goes to the AI. */
const MAX_SELECTION = 4000;
const SELECTION_TIMEOUT_MS = 500;
/** How many notifications the AI may read, newest first, and how much of each body. */
const MAX_NOTIFICATIONS = 10;
const MAX_NOTIFICATION_BODY = 300;

/** The head's radius, the eyes' size and how far apart they sit, in pixels. */
const HEAD_RADIUS = 15;
const EYE_WIDTH = 5.8;
const EYE_HEIGHT = 11.5;
const EYE_SPACING = 5.1;
/** A player just opened gets this long (ms) to appear before a media command is dropped. */
const PLAYER_WAIT_MS = 12000;
/** Spotify's name on the session bus, for its MPRIS player. */
const SPOTIFY_BUS = 'org.mpris.MediaPlayer2.spotify';

/** How far the eyes and the head turn towards what they look at. */
const EYE_TRAVEL = {x: 3.3, y: 2.6};
const HEAD_TRAVEL = {x: 1.3, y: 1};
/** How fast (per second) the glow follows the voice up and down, how fast a silent mic fades,
 * and how fast it moves to each phase's level. */
const MIC_ATTACK = 14;
const MIC_RELEASE = 4;
const MIC_FADE = 2;
const LEVEL_RATE = 8;
/** After answering it smiles this long (s). */
const SMILE_S = 1.6;
/** Blinks come every few seconds, at random, and take this long (s). */
const BLINK_S = 0.15;
/** Without the pointer moving for this long (s), the eyes wander on their own. */
const POINTER_REST_S = 2.5;

const easeOutBack = x => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2;
const clamp = (value, limit = 1) => Math.max(-limit, Math.min(limit, value));

// The character: a white head whose eyes follow the pointer, glance about and blink. They
// stretch as you speak, look up while thinking, smile on answering and droop on an error.
const Face = GObject.registerClass(
class Face extends St.DrawingArea {
    _init() {
        super._init({width: FACE_SIZE, height: FACE_SIZE});
        this.time = 0;
        this.level = 0;
        this._form = 'listening';
        this._pointer = [0, 0];
        this.restart();
        this.connect('repaint', area => this._paint(area));
    }

    /** Starts the clock over, as the view's animation does when it opens again. */
    restart() {
        this.time = 0;
        this._formAt = 0;
        this._last = 0;
        this._gaze = {x: 0, y: 0};
        this._glance = {x: 0, y: 0};
        this._nextGlance = 0;
        this._pointerAt = -POINTER_REST_S;
        this._blinkAt = -1;
        this._nextBlink = 1.2;
    }

    /** listening, thinking, searching, reply or error; each new form pops in. */
    setForm(form, time) {
        if (form !== this._form) {
            this._form = form;
            this._formAt = time;
        }
    }

    /** Moves the eyes on to `time` (s): where they look, and when they blink. */
    step(time) {
        const dt = Math.min(0.1, Math.max(0, time - this._last));
        this._last = this.time = time;

        const [px, py] = global.get_pointer();
        if (px !== this._pointer[0] || py !== this._pointer[1]) {
            this._pointer = [px, py];
            this._pointerAt = time;
        }
        const target = this._target(time, px, py);
        // Quick to turn, then settled: an eye's saccade.
        const follow = 1 - Math.exp(-dt * 16);
        this._gaze.x += (target.x - this._gaze.x) * follow;
        this._gaze.y += (target.y - this._gaze.y) * follow;

        if (time >= this._nextBlink) {
            this._blinkAt = time;
            // Now and then a double blink.
            this._nextBlink = time + (Math.random() < 0.15 ? 0.3 : 2.4 + Math.random() * 3);
        }
    }

    /** Where the eyes look, each of x and y in -1..1. */
    _target(time, px, py) {
        if (this._form === 'thinking')
            return {x: 0.75 * Math.sin(time * 1.3), y: -0.75};
        // Reading along, line after line: a sweep left to right, then back.
        if (this._form === 'searching')
            return {x: 0.9 * Math.sin(time * 2.2), y: 0.15 + 0.1 * Math.sin(time * 0.7)};
        if (this._form === 'error')
            return {x: 0.25 * Math.sin(time * 0.8), y: 0.5};
        if (time - this._pointerAt < POINTER_REST_S) {
            const [fx, fy] = this.get_transformed_position();
            return {x: clamp((px - fx - FACE_SIZE / 2) / 260), y: clamp((py - fy - FACE_SIZE / 2) / 180)};
        }
        if (time >= this._nextGlance) {
            this._glance = {x: (Math.random() * 2 - 1) * 0.8, y: (Math.random() * 2 - 1) * 0.5};
            this._nextGlance = time + 1 + Math.random() * 2.2;
        }
        return this._glance;
    }

    _paint(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const since = this.time - this._formAt;
        const pop = easeOutBack(Math.min(1, since / 0.3));
        const {x: gx, y: gy} = this._gaze;
        cr.translate(width / 2, height / 2);
        // Kept inside the drawing area at its largest (overshoot, voice, a turn).
        const scale = (0.88 + 0.12 * pop) * (1 + 0.04 * this.level);
        cr.scale(scale, scale);

        const hx = gx * HEAD_TRAVEL.x;
        const hy = gy * HEAD_TRAVEL.y;
        cr.setSourceRGBA(0.97, 0.97, 0.98, 1);
        cr.arc(hx, hy, HEAD_RADIUS, 0, 2 * Math.PI);
        cr.fill();

        cr.setSourceRGBA(0.08, 0.08, 0.09, 1);
        const ey = hy - 0.5 + gy * EYE_TRAVEL.y;
        for (const side of [-1, 1]) {
            const ex = hx + side * EYE_SPACING + gx * EYE_TRAVEL.x;
            if (this._form === 'reply' && since < SMILE_S)
                this._smile(cr, ex, ey);
            else
                this._eye(cr, ex, ey);
        }
        cr.$dispose();
    }

    // A rounded eye, taller as you speak, shut for a moment when it blinks, low when it droops.
    _eye(cr, x, y) {
        const blinking = this.time - this._blinkAt;
        const open = blinking >= 0 && blinking < BLINK_S
            ? 1 - 0.9 * Math.sin(Math.PI * blinking / BLINK_S) : 1;
        const listening = this._form === 'listening' ? 1 + 0.32 * this.level : 1;
        const droop = this._form === 'error' ? 0.6 : 1;
        const h = Math.max(EYE_WIDTH * 0.4, EYE_HEIGHT * open * listening * droop);
        const w = EYE_WIDTH;
        const r = Math.min(w, h) / 2;
        const top = y - h / 2 + (EYE_HEIGHT - h) * (droop < 1 ? 0.5 : 0);
        cr.newSubPath();
        cr.arc(x, top + r, r, Math.PI, 0);
        cr.arc(x, top + h - r, r, 0, Math.PI);
        cr.closePath();
        cr.fill();
    }

    // Happy, closed eyes: two little arches.
    _smile(cr, x, y) {
        cr.setLineWidth(2.5);
        cr.setLineCap(1); // round
        cr.newSubPath();
        cr.arc(x, y + 2.2, 3.2, Math.PI * 1.1, Math.PI * 1.9);
        cr.stroke();
    }
});

export const VoiceView = GObject.registerClass({
    Signals: {
        // Taps on the face: speak again, or finish speaking.
        'orb-clicked': {},
        // The Sign in button, shown when the AI is signed out.
        'sign-in': {},
        // Each frame: the animation's time (s) and level, to move the island's edge glow with.
        'frame': {param_types: [GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE]},
    },
}, class VoiceView extends St.Widget {
    _init() {
        super._init({style_class: 'isle-voice', layout_manager: new Clutter.BinLayout()});
        this._phase = 'listening';
        /** Shown instead of "Listening…" while it listens for the first request. */
        this.greeting = null;
        /** While it listens for a follow-up, what it just asked, so you know what you answer. */
        this.followUp = null;
        this._mic = 0;
        this._micTarget = 0;
        this._level = 0;

        const row = new St.BoxLayout({style_class: 'isle-voice-row', x_expand: true, y_expand: true});
        this._face = new Face();
        this._faceButton = new St.Button({
            style_class: 'isle-voice-orb',
            child: this._face,
            accessible_name: 'Speak',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._faceButton.connect('clicked', () => this.emit('orb-clicked'));
        row.add_child(this._faceButton);

        this._texts = new St.BoxLayout({...VERTICAL, y_align: Clutter.ActorAlign.CENTER});
        this._heard = new St.Label({style_class: 'isle-voice-heard'});
        this._heard.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._text = new St.Label({style_class: 'isle-voice-text'});
        this._hint = new St.Label({style_class: 'isle-voice-hint'});
        for (const label of [this._text, this._hint]) {
            label.clutter_text.line_wrap = true;
            label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        }
        // Not wider than its label, at the start of the line.
        this._signIn = pillButton('Sign in', 'isle-pill-small isle-voice-sign-in', () => this.emit('sign-in'));
        this._signIn.x_align = Clutter.ActorAlign.START;
        this._texts.add_child(this._heard);
        this._texts.add_child(this._text);
        this._texts.add_child(this._hint);
        this._texts.add_child(this._signIn);
        row.add_child(this._texts);
        this.add_child(row);

        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());
        this._start = 0;
        this._lastTick = 0;
        this._flow = 0;
        this.connect('destroy', () => this._timeline.stop());
        this.setState({phase: 'listening'});
    }

    /** Shows `state` from isled: {phase, heard, reply, error, hint, sign_in}. */
    setState(state) {
        this._phase = state.phase;
        this._exchange = {heard: state.heard ?? '', reply: clip(state.reply ?? '')};
        const heard = state.heard ? `“${state.heard}”` : '';
        const [top, main, dim] = {
            // The first time it opens it greets you, as Siri does.
            listening: [this.followUp ?? '', this.greeting ?? 'Listening…', !this.greeting],
            transcribing: [this.followUp ?? '', 'One moment…', true],
            // An agent's step as it happens ("Searching ~/Downloads for “ttd”…"), else thinking.
            thinking: [heard, state.activity || 'Thinking…', true],
            reply: [heard, clip(state.reply ?? ''), false],
            error: [heard, state.error || 'Something went wrong', false],
        }[state.phase] ?? ['', '', true];
        this._heard.text = top;
        this._heard.visible = Boolean(top);
        this._text.text = main;
        if (dim)
            this._text.add_style_class_name('isle-voice-text-dim');
        else
            this._text.remove_style_class_name('isle-voice-text-dim');
        const hint = state.phase === 'error' ? state.hint ?? '' : '';
        this._hint.text = hint;
        this._hint.visible = Boolean(hint);
        this._signIn.visible = state.phase === 'error' && Boolean(state.sign_in);
        const searching = state.phase === 'thinking' && Boolean(state.activity);
        const form = searching ? 'searching' : {transcribing: 'thinking'}[state.phase] ?? state.phase;
        this._face.setForm(form, this._face.time);
    }

    /** The microphone's level (0..1). */
    setLevel(level) {
        this._micTarget = level;
    }

    get phase() {
        return this._phase;
    }

    /** The exchange on show once answered: {heard, reply}, else null. */
    get exchange() {
        return this._phase === 'reply' ? this._exchange : null;
    }

    get preferredWidth() {
        // With something to show above, it stays wide, so a conversation never jumps.
        const short = ['listening', 'transcribing'].includes(this._phase) && !this.followUp;
        return short ? LISTENING_WIDTH : ANSWER_WIDTH;
    }

    /** Sizes the texts, wrapped, and returns the height wanted below the top bar. */
    fit() {
        const width = this.preferredWidth - TEXT_INSET;
        // Measured per label: the box's own answer is the size set below.
        const natural = [this._heard, this._text, this._hint, this._signIn].filter(part => part.visible)
            .reduce((sum, part) => sum + part.get_preferred_height(width)[1], 0);
        // Set outright: the row kept an earlier, shorter height for them.
        this._texts.set_size(width, Math.min(natural, MAX_HEIGHT - ROW_PADDING));
        // Beside a line or two it sits in the middle; beside more, level with the first line.
        this._faceButton.y_align = natural > FACE_SIZE + 8 ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER;
        return Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, natural + ROW_PADDING)));
    }

    /** Animates while shown; rests otherwise. */
    setActive(active) {
        if (active && !this._timeline.is_playing()) {
            this._start = Date.now();
            this._lastTick = 0;
            this._face.restart();
            this._timeline.start();
        } else if (!active) {
            this._timeline.stop();
        }
    }

    _tick() {
        const t = (Date.now() - this._start) / 1000;
        const dt = Math.min(0.1, Math.max(0, t - this._lastTick));
        this._lastTick = t;
        // The voice, smoothed by time (not by frame): quick to rise with a syllable, slow to fall,
        // so the 20 updates a second from isled never show as flicker.
        this._micTarget = (this._micTarget ?? 0) * Math.exp(-dt * MIC_FADE);
        const rate = this._micTarget > this._mic ? MIC_ATTACK : MIC_RELEASE;
        this._mic += (this._micTarget - this._mic) * (1 - Math.exp(-dt * rate));
        // The edge glow swells with your voice, breathes while thinking and settles once answered.
        const target = {
            listening: this._mic,
            transcribing: 0.28 + 0.05 * Math.sin(t * 2),
            thinking: 0.32 + 0.08 * Math.sin(t * 1.8),
            reply: 0.12 + 0.03 * Math.sin(t * 1.2),
        }[this._phase] ?? 0.05;
        this._level += (target - this._level) * (1 - Math.exp(-dt * LEVEL_RATE));
        this._face.level = this._level;
        this._face.step(t);
        this._face.queue_repaint();
        // A little faster while it thinks; summed up, so a change of speed never makes the glow jump.
        const speed = this._phase === 'thinking' || this._phase === 'transcribing' ? 1.6 : 1;
        this._flow += dt * speed;
        this.emit('frame', this._flow, this._level);
    }
});

function clip(text) {
    const trimmed = text.trim();
    return trimmed.length > MAX_REPLY ? `${trimmed.slice(0, MAX_REPLY - 1).trimEnd()}…` : trimmed;
}

// Terminals to sign in with, most likely first; the CLI's own sign-in runs there (a browser, then a
// code pasted back into it), so Isle never handles the code.
const TERMINALS = [['gnome-terminal', '--'], ['kgx', '--'], ['ptyxis', '--'], ['x-terminal-emulator', '-e']];

/** Opens a terminal to sign in to `provider` ("agy", "claude", "codex"); false without a terminal or it. */
export function openSignIn(provider) {
    const [name, ...args] = SIGN_IN[provider] ?? SIGN_IN.agy;
    const program = GLib.find_program_in_path(name) ??
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', name]);
    return GLib.file_test(program, GLib.FileTest.IS_EXECUTABLE) && inTerminal([program, ...args]);
}

/** How each AI CLI signs in, run in a terminal (`agy` and `claude` ask on start). */
const SIGN_IN = {agy: ['agy'], claude: ['claude'], codex: ['codex', 'login']};

/** The AI picked in Settings and the model picked for each, as isled reads them. */
export function aiSettings(settings) {
    return {
        provider: settings.get_string('voice-provider'),
        agy_model: settings.get_string('voice-agy-model'),
        claude_model: settings.get_string('voice-claude-model'),
        codex_model: settings.get_string('voice-codex-model'),
    };
}

/** Runs `argv` in a new terminal window; false when no terminal could be opened. */
function inTerminal(argv) {
    for (const [program, separator] of TERMINALS) {
        const terminal = GLib.find_program_in_path(program);
        if (!terminal)
            continue;
        try {
            GLib.spawn_async(null, [terminal, separator, ...argv], null, GLib.SpawnFlags.DEFAULT, null);
            return true;
        } catch (e) {
            console.warn(`Isle: could not open ${program}: ${e.message}`);
        }
    }
    return false;
}

// Shows `$1` typed at a bash prompt, run only once Enter is pressed (it can be edited first); a shell stays
// open afterwards. Passed as an argument, the command is never part of the script itself.
const TYPED_COMMAND = 'printf "\\033[2mIsle: press Enter to run it, edit it first, or Ctrl+C to cancel.\\033[0m\\n"; ' +
    'read -r -e -i "$1" -p "$ " line && eval "$line"; exec bash';

/** Opens a terminal with `command` typed in, waiting for the user to press Enter. */
function typeInTerminal(command) {
    // On one line: a newline would be an Enter of its own.
    const line = command.split('\n').map(part => part.trim()).filter(Boolean).join(' && ');
    if (line)
        inTerminal(['bash', '-c', TYPED_COMMAND, 'isle', line]);
}

/** The greeting it opens with; it understands any language spoken back. */
export const GREETING = 'How can I help?';

// What isled passes on to the AI: the apps, the models, the selected text (not from apps kept out of the
// clipboard history) and, when allowed, the latest of `notifications` (a NotificationCenter).
export async function voiceContext(settings, notifications, {apps = [], selectedIn = null} = {}) {
    // Asked for first, before anything else can move the selection.
    const selection = sharesSelection(settings, selectedIn) ? primarySelection() : Promise.resolve('');
    const system = Shell.AppSystem.get_default();
    return JSON.stringify({
        apps,
        actions: actionTypes(),
        running: system.get_running().map(app => app.get_name()),
        windows: openWindows(),
        ...aiSettings(settings),
        whisper_model: settings.get_string('voice-speech-model'),
        language: settings.get_string('voice-language'),
        selection: await selection,
        // null: not allowed to read them; []: allowed, but there are none.
        notifications: settings.get_boolean('voice-read-notifications') ? recentNotifications(notifications) : null,
    });
}

// The installed apps' names, sorted, for the AI. Gathering them takes a few milliseconds, enough to stall
// the island as it opens, so they are kept until apps are installed or removed, and gathered when idle.
export class InstalledApps {
    constructor() {
        this._names = null;
        this._system = Shell.AppSystem.get_default();
        this._changed = this._system.connect('installed-changed', () => this._gatherLater());
        this._gatherLater();
    }

    get names() {
        this._names ??= [...new Set(this._system.get_installed()
            .filter(info => info.should_show()).map(info => info.get_name()))].sort();
        return this._names;
    }

    _gatherLater() {
        this._names = null;
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._idle = 0;
            void this.names;
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._system.disconnect(this._changed);
        if (this._idle)
            GLib.source_remove(this._idle);
    }
}

// Whether the selected text may go to the AI: allowed in Settings, made in the window in front (`selectedIn`),
// and that is neither a terminal (tokens, commands) nor an app kept out of the clipboard history.
function sharesSelection(settings, selectedIn) {
    const window = global.display.focus_window;
    if (!settings.get_boolean('voice-use-selection') || !window || window !== selectedIn)
        return false;
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    return !isTerminal(window) && !(app && settings.get_strv('clipboard-ignored-apps').includes(app.get_id()));
}

/** The newest notifications as {app, title, body, time}, the time as local HH:MM. */
function recentNotifications(center) {
    return center.notifications.slice(0, MAX_NOTIFICATIONS).map(notification => {
        const body = plainBody(notification).replace(/\s+/g, ' ').trim();
        return {
            app: notification.source?.title ?? '',
            title: notification.title ?? '',
            body: body.length > MAX_NOTIFICATION_BODY ? `${body.slice(0, MAX_NOTIFICATION_BODY - 1)}…` : body,
            time: notification.datetime?.to_local().format('%H:%M') ?? '',
        };
    });
}

/** The text selected anywhere (the primary selection), trimmed and cut to MAX_SELECTION; '' if none. */
function primarySelection() {
    return new Promise(resolve => {
        let done = false;
        const finish = text => {
            if (done)
                return;
            done = true;
            const trimmed = (text ?? '').trim();
            resolve(trimmed.length > MAX_SELECTION ? `${trimmed.slice(0, MAX_SELECTION - 1)}…` : trimmed);
        };
        // An app that is slow to hand its selection over is not waited for.
        const giveUp = after(SELECTION_TIMEOUT_MS, () => finish(''));
        St.Clipboard.get_default().get_text(St.ClipboardType.PRIMARY, (_clipboard, text) => {
            giveUp();
            finish(text);
        });
    });
}

// What each action the AI may answer with does; see `Session::prompt` in isled. `isle` holds the daemon, audio,
// notifications, the window in front when asked (`target`), its `writer` and `closeThen(callback)`.
const ACTIONS = {
    open_url: ({url}) => {
        if (/^(https?|mailto):/i.test(url ?? ''))
            openUri(url);
    },
    open_app: ({app}, isle) => {
        const found = findApp(app ?? '');
        // Not running yet: a media command after it waits for its player.
        if (found && found.get_state() !== Shell.AppState.RUNNING)
            isle.launched = found;
        found?.activate();
    },
    media: ({command}, {daemon, launched}) => {
        const method = {play_pause: 'PlayPause', next: 'Next', previous: 'Previous'}[command];
        if (method)
            whenPlayerOf(daemon, launched, () => daemon.call('media', method));
    },
    focus: ({command}, {daemon}) => daemon.call('pomodoro', command === 'stop' ? 'Stop' : 'Start'),
    add_task: ({text}, {daemon}) => text && daemon.call('todo', 'Add', text),
    add_event: ({date, text}, {daemon}) => date && text && daemon.call('calendar', 'Add', date, text),
    done_task: ({id}, {daemon}) => Number.isInteger(id) && daemon.call('todo', 'SetDone', id, true),
    remove_task: ({id}, {daemon}) => Number.isInteger(id) && daemon.call('todo', 'Remove', id),
    cancel_reminder: ({id}, {daemon}) => Number.isInteger(id) && daemon.call('reminders', 'Dismiss', id),
    remove_event: ({id}, {daemon}) => Number.isInteger(id) && daemon.call('calendar', 'Remove', id),
    remind: ({minutes, text}, {daemon}) => {
        if (text && minutes > 0)
            daemon.call('reminders', 'Add', Math.round(minutes * 60000), text);
    },
    volume: ({level, command}, {audio}) => {
        if (typeof level === 'number')
            audio.volume = level / 100;
        else if (command === 'up' || command === 'down')
            audio.volume += command === 'up' ? 0.1 : -0.1;
        else if ((command === 'mute') !== audio.muted && ['mute', 'unmute'].includes(command))
            audio.toggleMuted();
    },
    wifi: ({on}) => spawn(['nmcli', 'radio', 'wifi', on === false ? 'off' : 'on']),
    bluetooth: ({on}) => setBluetooth(on !== false),
    dnd: ({on}, {notifications}) => (notifications.dnd = on !== false),
    notifications: (_action, {showNotifications}) => showNotifications(),
    play_music: ({query, uri}) => playMusic(query ?? '', uri),
    window: ({command, title, app}, {target}) => {
        const window = title ? windowTitled(title)
            : app ? findApp(app, Shell.AppSystem.get_default().get_running())?.get_windows()[0] : target;
        if (window)
            WINDOW_COMMANDS[command]?.(window);
    },
    arrange: ({layout, apps}) => arrangeWindows(layout, Array.isArray(apps) ? apps : []),
    open_file: ({path}) => withFile(path, file => openUri(file.get_uri()), {opening: true}),
    reveal_file: ({path}) => withFile(path, file => revealFile(file)),
    chrome_profile: ({profile}) => openChromeProfile(profile ?? ''),
    close_app: ({app}) => findApp(app ?? '', Shell.AppSystem.get_default().get_running())?.request_quit(),
    open_folder: ({path}) => openFolder(path ?? ''),
    brightness: ({level, command}) => setBrightness(level, command),
    dark_mode: ({on}) => setDarkMode(on !== false),
    night_light: ({on}) => new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'})
        .set_boolean('night-light-enabled', on !== false),
    settings: ({panel}) => /^[a-z-]+$/.test(panel ?? '') && spawn(['gnome-control-center', panel]),
    terminal: ({command}) => typeof command === 'string' && typeInTerminal(command),
    screenshot: (_action, {closeThen}) => closeThen(() => Main.screenshotUI.open()),
    lock: (_action, {closeThen}) => closeThen(() => Main.screenShield?.lock(true)),
    // Closed first, so the keys go back to the window the user asked from.
    write: ({text}, {closeThen, target, writer}) => {
        if (typeof text === 'string' && text)
            closeThen(() => writer.write(text, target));
    },
};

// What the actions are still waiting on (a player to appear, a moment to pass), each with how to stop it;
// all stopped when the extension is turned off (`stopPending`).
const pending = new Set();

/** Calls `callback` after `ms`, unless stopped first; returns the stop. */
function after(ms, callback) {
    const entry = {};
    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        pending.delete(entry);
        callback();
        return GLib.SOURCE_REMOVE;
    });
    entry.stop = () => {
        if (pending.delete(entry))
            GLib.source_remove(id);
    };
    pending.add(entry);
    return entry.stop;
}

/** Stops everything the actions still wait on. */
export function stopPending() {
    for (const entry of [...pending])
        entry.stop();
}

// Runs `run` once `app` (just launched; null for none) is the player isled controls; never if it doesn't show up.
function whenPlayerOf(daemon, app, run) {
    const id = app?.get_id().replace(/\.desktop$/, '').toLowerCase();
    const ready = () => {
        const playing = daemon.state.nowPlaying;
        return playing?.available && (playing.desktop_entry.toLowerCase() === id ||
            playing.identity.toLowerCase() === app.get_name().toLowerCase());
    };
    if (!app || ready()) {
        run();
        return;
    }
    const entry = {};
    const changed = daemon.connect('changed', (_daemon, key) => {
        if (key === 'nowPlaying' && ready()) {
            entry.stop();
            run();
        }
    });
    const giveUp = after(PLAYER_WAIT_MS, () => entry.stop());
    entry.stop = () => {
        if (!pending.delete(entry))
            return;
        daemon.disconnect(changed);
        giveUp();
    };
    pending.add(entry);
}


// Parts of the screen's work area, as [x, y, width, height] shares of it: where one window goes...
const TILES = {
    left: [0, 0, 0.5, 1],
    right: [0.5, 0, 0.5, 1],
    top: [0, 0, 1, 0.5],
    bottom: [0, 0.5, 1, 0.5],
    top_left: [0, 0, 0.5, 0.5],
    top_right: [0.5, 0, 0.5, 0.5],
    bottom_left: [0, 0.5, 0.5, 0.5],
    bottom_right: [0.5, 0.5, 0.5, 0.5],
    center: [0.125, 0.1, 0.75, 0.8],
};
// ...and where several go, left to right and top to bottom.
const LAYOUTS = {
    halves: [TILES.left, TILES.right],
    rows: [TILES.top, TILES.bottom],
    quarters: [TILES.top_left, TILES.top_right, TILES.bottom_left, TILES.bottom_right],
    thirds: [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]],
};

// What `window` does to a window; GNOME 49 dropped the flags to maximize with.
const WINDOW_COMMANDS = {
    focus: window => Main.activateWindow(window),
    close: window => window.delete(global.get_current_time()),
    minimize: window => window.minimize(),
    maximize: window => (Meta.MaximizeFlags ? window.maximize(Meta.MaximizeFlags.BOTH) : window.maximize()),
    unmaximize: window => (Meta.MaximizeFlags ? window.unmaximize(Meta.MaximizeFlags.BOTH) : window.unmaximize()),
    fullscreen: window => window.make_fullscreen(),
    unfullscreen: window => window.unmake_fullscreen(),
    ...Object.fromEntries(Object.entries(TILES).map(([name, slot]) => [name, window => tile(window, slot)])),
};

/** The places for `count` windows in `layout`, or in a grid that fits them when it names none. */
function slotsFor(layout, count) {
    if (LAYOUTS[layout])
        return LAYOUTS[layout];
    if (count <= 1)
        return [[0, 0, 1, 1]];
    if (count <= 4)
        return [LAYOUTS.halves, LAYOUTS.thirds, LAYOUTS.quarters][count - 2];
    const columns = 3;
    const rows = Math.ceil(count / columns);
    return Array.from({length: count}, (_, i) =>
        [(i % columns) / columns, Math.floor(i / columns) / rows, 1 / columns, 1 / rows]);
}

/** Puts `window` in `slot` of its monitor's work area. */
function tile(window, [x, y, width, height]) {
    const area = window.get_work_area_current_monitor();
    if (window.is_fullscreen())
        window.unmake_fullscreen();
    // A maximized window keeps its size; a no-op on any other.
    WINDOW_COMMANDS.unmaximize(window);
    window.move_resize_frame(true, Math.round(area.x + area.width * x), Math.round(area.y + area.height * y),
        Math.round(area.width * width), Math.round(area.height * height));
}

// Tiles windows on this workspace: those of `apps` in that order (one each, or every window of a single
// app), else the ones in front; as many as `layout` holds, and the first of them is focused.
function arrangeWindows(layout, apps) {
    const workspace = global.workspace_manager.get_active_workspace();
    // Windows of their own, which a dialog with no parent window is too.
    const shown = window => !window.skip_taskbar && !window.minimized && (window.get_window_type() === Meta.WindowType.NORMAL ||
        (window.get_window_type() === Meta.WindowType.DIALOG && !window.get_transient_for()));
    // Front to back.
    const stack = global.display.sort_windows_by_stacking(workspace.list_windows().filter(shown)).reverse();
    let windows = stack;
    if (apps.length > 0) {
        const running = Shell.AppSystem.get_default().get_running();
        const each = apps.length > 1 ? 1 : Infinity;
        windows = apps.flatMap(name => {
            const app = findApp(name, running);
            return app ? stack.filter(window => app.get_windows().includes(window)).slice(0, each) : [];
        });
        windows = [...new Set(windows)];
    }
    const slots = slotsFor(layout, windows.length);
    windows.slice(0, slots.length).forEach((window, i) => tile(window, slots[i]));
    if (windows.length > 0)
        Main.activateWindow(windows[0]);
}

// Plays `uri` (a Spotify link isled checked) in Spotify, started first if need be; without one, Spotify
// opens on a search for `query`, and without Spotify, YouTube Music does.
function playMusic(query, uri) {
    const spotify = findApp('spotify');
    if (!spotify) {
        if (query)
            openUri(`https://music.youtube.com/search?q=${encodeURIComponent(query)}`);
        return;
    }
    if (!uri) {
        if (query)
            openUri(`spotify:search:${encodeURIComponent(query)}`);
        return;
    }
    const play = () => Gio.DBus.session.call(SPOTIFY_BUS, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player',
        'OpenUri', new GLib.Variant('(s)', [uri]), null, Gio.DBusCallFlags.NONE, -1, null, (bus, result) => {
            try {
                bus.call_finish(result);
            } catch (e) {
                // Spotify then at least shows it.
                console.warn(`Isle: Spotify would not play ${uri}: ${e.message}`);
                openUri(uri);
            }
        });
    // Just started, it takes a moment past joining the bus before it plays what it's given.
    const ready = spotify.get_state() === Shell.AppState.RUNNING ? play : () => after(1500, play);
    whenOnBus(SPOTIFY_BUS, PLAYER_WAIT_MS, ready);
    spotify.activate();
}

/** At most this many open windows go to the AI, each title cut to this many characters. */
const MAX_WINDOWS = 20;
const MAX_WINDOW_TITLE = 80;

/** The windows on screen, as {app, title}, the ones in the task bar only. */
function openWindows() {
    const tracker = Shell.WindowTracker.get_default();
    return global.get_window_actors().map(actor => actor.meta_window)
        .filter(window => !window.skip_taskbar && window.title)
        .slice(0, MAX_WINDOWS)
        .map(window => ({
            app: tracker.get_window_app(window)?.get_name() ?? '',
            title: window.title.slice(0, MAX_WINDOW_TITLE),
        }));
}

/** The open window whose title contains `title`, ignoring case. */
function windowTitled(title) {
    const wanted = title.toLowerCase().trim();
    return global.get_window_actors().map(actor => actor.meta_window)
        .find(window => !window.skip_taskbar && window.title?.toLowerCase().includes(wanted)) ?? null;
}

/** Folders the assistant may open or show files in, as isled's own file tools do. */
const FILE_ROOTS = ['/media/', '/mnt/', '/run/media/'];
/** Kinds of file that run something when opened; the assistant never opens those. */
const RUNS = /x-desktop|java-archive|executable|x-sharedlib|x-msdownload|x-ms-dos|x-msi|x-deb|x-rpm|x-appimage|x-shellscript|x-perl|x-python|x-ruby|x-php/;

/**
 * Runs `callback` with `path` (from ~, or absolute) as a Gio.File if it is there and allowed: in the home
 * folder (not a hidden part of it) or on a removable drive, and not a link; `opening` also refuses
 * anything that would run.
 */
function withFile(path, callback, {opening = false} = {}) {
    if (typeof path !== 'string' || !path.trim())
        return;
    const home = GLib.get_home_dir();
    const expanded = path.trim().replace(/^~(?=\/|$)/, home);
    const file = Gio.File.new_for_path(GLib.canonicalize_filename(expanded, home));
    const where = file.get_path();
    const inHome = where.startsWith(`${home}/`);
    if (!inHome && !FILE_ROOTS.some(root => where.startsWith(root)))
        return;
    if (inHome && where.slice(home.length + 1).split('/').some(part => part.startsWith('.')))
        return;
    let info;
    try {
        info = file.query_info('standard::is-symlink,standard::content-type,access::can-execute',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    } catch {
        return; // not there
    }
    if (info.get_is_symlink())
        return;
    if (opening) {
        const type = info.get_content_type() ?? '';
        const mime = Gio.content_type_get_mime_type(type) ?? '';
        // Documents and media open in a viewer whatever their permissions (files on a USB stick often
        // look executable); anything else that could run is left alone.
        const viewed = type === 'inode/directory' || /^(image|video|audio|text)\//.test(mime) ||
            /pdf|opendocument|officedocument|msword|ms-excel|ms-powerpoint|epub/.test(mime);
        const runnable = Gio.content_type_can_be_executable(type) || info.get_attribute_boolean('access::can-execute');
        if (RUNS.test(mime) || (!viewed && runnable))
            return;
    }
    callback(file);
}

/** Shows `file` selected in the file manager, as "Show in Files" does. */
function revealFile(file) {
    Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1', 'ShowItems', new GLib.Variant('(ass)', [[file.get_uri()], '']),
        null, Gio.DBusCallFlags.NONE, -1, null, (bus, result) => {
            try {
                bus.call_finish(result);
            } catch {
                // No file manager there: its folder, at least.
                openUri(file.get_parent()?.get_uri() ?? file.get_uri());
            }
        });
}

/** Opens Chrome (or Chromium) in the profile kept in folder `profile`, e.g. "Profile 2". */
function openChromeProfile(profile) {
    if (!/^[\w .-]+$/.test(profile))
        return;
    const browser = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
        .map(name => GLib.find_program_in_path(name)).find(Boolean);
    if (browser)
        GLib.spawn_async(null, [browser, `--profile-directory=${profile}`], null, GLib.SpawnFlags.DEFAULT, null);
}

function openUri(uri) {
    Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
}

/** Runs `callback` once `name` is on the session bus, now or within `ms`; never if it doesn't come. */
function whenOnBus(name, ms, callback) {
    const entry = {};
    const watch = Gio.bus_watch_name(Gio.BusType.SESSION, name, Gio.BusNameWatcherFlags.NONE, () => {
        entry.stop();
        callback();
    }, null);
    const giveUp = after(ms, () => entry.stop());
    entry.stop = () => {
        if (!pending.delete(entry))
            return;
        Gio.bus_unwatch_name(watch);
        giveUp();
    };
    pending.add(entry);
}

function spawn(argv) {
    const program = GLib.find_program_in_path(argv[0]);
    if (program)
        GLib.spawn_async(null, [program, ...argv.slice(1)], null, GLib.SpawnFlags.DEFAULT, null);
}

/** Opens `path` (from ~, or absolute) in Files; a folder that isn't there opens its nearest parent. */
function openFolder(path) {
    const home = GLib.get_home_dir();
    const expanded = path.trim().replace(/^~(?=\/|$)/, home);
    let folder = Gio.File.new_for_path(GLib.path_is_absolute(expanded) ? expanded : GLib.build_filenamev([home, expanded]));
    while (folder.get_parent() && folder.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY)
        folder = folder.get_parent();
    openUri(folder.get_uri());
}

/** The dark style, and on Ubuntu its Yaru theme to match, as its Settings do. */
function setDarkMode(dark) {
    const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    settings.set_string('color-scheme', dark ? 'prefer-dark' : 'default');
    const theme = settings.get_string('gtk-theme');
    if (theme.startsWith('Yaru')) {
        const light = theme.replace(/-dark$/, '');
        settings.set_string('gtk-theme', dark ? `${light}-dark` : light);
    }
}

/** The screen's brightness: `level` 0..100, or `command` up or down by a tenth. */
function setBrightness(level, command) {
    const step = {up: 10, down: -10}[command];
    // GNOME 48 and later.
    const scale = Main.brightnessManager?.globalScale;
    if (scale) {
        const value = typeof level === 'number' ? level / 100 : scale.value + (step ?? 0) / 100;
        scale.value = Math.max(0.01, Math.min(1, value));
        return;
    }
    const call = (method, args, callback) => Gio.DBus.session.call('org.gnome.SettingsDaemon.Power',
        '/org/gnome/SettingsDaemon/Power', 'org.freedesktop.DBus.Properties', method, args, null,
        Gio.DBusCallFlags.NONE, -1, null, callback);
    const set = percent => call('Set', new GLib.Variant('(ssv)', ['org.gnome.SettingsDaemon.Power.Screen', 'Brightness',
        new GLib.Variant('i', Math.round(Math.max(1, Math.min(100, percent))))]), null);
    if (typeof level === 'number') {
        set(level);
    } else if (step) {
        call('Get', new GLib.Variant('(ss)', ['org.gnome.SettingsDaemon.Power.Screen', 'Brightness']), (bus, result) => {
            try {
                set(bus.call_finish(result).deep_unpack()[0].deep_unpack() + step);
            } catch (e) {
                console.warn(`Isle: could not change the brightness: ${e.message}`);
            }
        });
    }
}

/** Turns Bluetooth on or off as Quick Settings does, through GNOME's rfkill service. */
function setBluetooth(on) {
    Gio.DBus.session.call('org.gnome.SettingsDaemon.Rfkill', '/org/gnome/SettingsDaemon/Rfkill',
        'org.freedesktop.DBus.Properties', 'Set',
        new GLib.Variant('(ssv)', ['org.gnome.SettingsDaemon.Rfkill', 'BluetoothAirplaneMode',
            new GLib.Variant('b', !on)]),
        null, Gio.DBusCallFlags.NONE, -1, null, null);
}

/** What this extension can do: isled offers the AI nothing else. */
export function actionTypes() {
    return Object.keys(ACTIONS);
}

/** Runs the AI's actions; `isle` is what they act on (see `ACTIONS`). */
export function runActions(actions, isle) {
    for (const action of actions ?? []) {
        try {
            ACTIONS[action.type]?.(action, isle);
        } catch (e) {
            console.warn(`Isle: voice action ${action.type} failed: ${e.message}`);
        }
    }
}

/** The app called `name` among `running` (Shell.Apps), else installed: by exact name, then by part of its name or id. */
function findApp(name, running = null) {
    const wanted = name.toLowerCase().trim();
    if (!wanted)
        return null;
    const system = Shell.AppSystem.get_default();
    const apps = running ?? system.get_installed().filter(info => info.should_show());
    const match = apps.find(app => app.get_name().toLowerCase() === wanted) ??
        apps.find(app => app.get_name().toLowerCase().includes(wanted)) ??
        apps.find(app => app.get_id().toLowerCase().includes(wanted.replace(/\s+/g, '')));
    return match && !running ? system.lookup_app(match.get_id()) : match ?? null;
}
