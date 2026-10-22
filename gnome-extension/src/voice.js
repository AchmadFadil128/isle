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

import {describeActions, failed, outcomeOf, slotsFor, TILES} from './actionRules.js';
import {isTerminal} from './clipboard.js';
import {VERTICAL} from './compat.js';
import {plainBody} from './notifications.js';
import {icon, iconButton, pillButton, wrapLines} from './widgets.js';

/** Three calm colours, violet to blue to cyan, that light the island while it is open (see island.js). */
export const SIRI_COLORS = [[0.56, 0.4, 1], [0.27, 0.56, 1], [0.22, 0.84, 0.96]];

const FACE_SIZE = 36;
/** The pill while listening, and the panel an answer opens into. */
const LISTENING_WIDTH = 280;
const ANSWER_WIDTH = 460;
/** The round button at the row's end: type instead, stop or send (see stylesheet.css). */
const ACTION_SIZE = 32;
/** Row padding, the face, the action and the gaps between them (see stylesheet.css). */
const TEXT_INSET = 16 + 16 + FACE_SIZE + 2 * 12 + ACTION_SIZE;
/** The row's padding above and below the texts; below leaves room for the glow. */
const ROW_PADDING = 14 + 20;
/** Always room for the whole face. */
const MIN_HEIGHT = FACE_SIZE + ROW_PADDING;
const MAX_HEIGHT = 230;
/** Answers past this many characters are cut, the panel being small. */
const MAX_REPLY = 360;
/** Answers longer than this read as a paragraph: set smaller and lighter, as Siri's. */
const LONG_REPLY = 90;
/** Selected text past this many characters is cut before it goes to the AI. */
const MAX_SELECTION = 4000;
const SELECTION_TIMEOUT_MS = 500;
/** How many notifications the AI may read, newest first, and how much of each body. */
const MAX_NOTIFICATIONS = 10;
const MAX_NOTIFICATION_BODY = 300;

/** The head's radius; the eyes sit on a ball this big inside it and measure in this unit, in pixels. */
const HEAD_RADIUS = 15;
const EYE_BALL = 17.3;
const EYE_UNIT = 20.3;
/** An app just opened gets this long (ms) to show its window before the next step goes on without it. */
const WINDOW_WAIT_MS = 5000;
/** An app asked to quit gets this long (ms) to close its windows; one asking to save stays open. */
const CLOSE_WAIT_MS = 3000;
/** A player just opened gets this long (ms) to appear before a media command is dropped. */
const PLAYER_WAIT_MS = 12000;
/** Spotify's name on the session bus, for its MPRIS player. */
const SPOTIFY_BUS = 'org.mpris.MediaPlayer2.spotify';

/** How far the head turns towards what it looks at (degrees), and how far it may turn in all. */
const LOOK_TURN = {yaw: 14, pitch: 12};
const MAX_TURN = {yaw: 26, pitch: 22};
const HEAD_TRAVEL = {x: 1.3, y: 1};
/** How fast (per second) the glow follows the voice up and down, how fast a silent mic fades,
 * and how fast it moves to each phase's level. */
const MIC_ATTACK = 14;
const MIC_RELEASE = 4;
const MIC_FADE = 2;
const LEVEL_RATE = 8;
/** The glow's level when animations are off in GNOME: there, but still. */
const STILL_LEVEL = 0.2;
/** After answering it smiles this long (s). */
const SMILE_S = 1.6;
/** Surprised this long (s) when it first hears you; sleepy after this long (s) with nothing going on. */
const SURPRISE_S = 0.6;
const SLEEPY_S = 8;
/** How fast (per second) the face takes on a new expression: a morph of about a third of a second. */
const MORPH_RATE = 10;
const pair = (w, h, tilt = 0, open = 1) => [{w, h, tilt, open}, {w, h, tilt: -tilt, open}];
// Expressions from bloub (MIT, © 2026 Jérémy Perret, github.com/jeremy-prt/bloub): the head's turn and
// how far apart the eyes sit (degrees), each eye's width and height (EYE_UNIT), tilt and how open.
const EXPRESSIONS = {
    attentive: {yaw: 4, pitch: 5, roll: -4, split: 16, eyes: pair(0.21, 0.44)},
    surprised: {yaw: 3, pitch: -3, roll: 0, split: 19, eyes: pair(0.45, 0.47)},
    curious: {yaw: 16, pitch: -9, roll: -15, split: 16.5, eyes: [{w: 0.24, h: 0.46, tilt: -8, open: 1}, {w: 0.2, h: 0.38, tilt: -8, open: 1}]},
    happy: {yaw: 5, pitch: 9, roll: 0, split: 17, eyes: pair(0.27, 0.17, 14)},
    confused: {yaw: -14, pitch: 3, roll: 8, split: 16.5, eyes: [{w: 0.2, h: 0.44, tilt: -18, open: 1}, {w: 0.28, h: 0.17, tilt: 14, open: 1}]},
    sad: {yaw: 3, pitch: -13, roll: 0, split: 16, eyes: pair(0.22, 0.4, -28)},
    sleepy: {yaw: 6, pitch: -9, roll: -3, split: 16, eyes: pair(0.2, 0.42, 0, 0.42)},
};
const copyExpression = ({eyes, ...turn}) => ({...turn, eyes: eyes.map(eye => ({...eye}))});
/** Errors that come from not hearing you (isled's wording): it looks confused at them, sad at others. */
const NOT_HEARD = /^(Didn't catch that|The microphone is muted|No microphone)/;
/** Blinks come every few seconds, at random, and take this long (s). */
const BLINK_S = 0.15;
/** Without the pointer moving for this long (s), the eyes wander on their own. */
const POINTER_REST_S = 2.5;
/** How much each key typed lights the edge, as a syllable does. */
const KEY_LEVEL = 0.32;

const easeOutBack = x => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2;
const clamp = (value, limit = 1) => Math.max(-limit, Math.min(limit, value));
const RAD = Math.PI / 180;

/** `u` turned towards `v` by `angle` (radians), with `v` turned along: one rotation of two axes. */
function rotate(u, v, angle) {
    const [c, s] = [Math.cos(angle), Math.sin(angle)];
    return [u.map((x, i) => x * c + v[i] * s), v.map((x, i) => x * c - u[i] * s)];
}

/** Where each eye sits on the turned head, and its axes there: the eyes lie on a ball, as bloub's. */
function placeEyes({yaw, pitch, roll, split}) {
    let [forward, across, up] = [[0, 0, 1], [1, 0, 0], [0, 1, 0]];
    [forward, across] = rotate(forward, across, yaw * RAD);
    [up, forward] = rotate(up, forward, pitch * RAD);
    [across, up] = rotate(across, up, roll * RAD);
    return [-1, 1].map(side => {
        const [at, eyeAcross] = rotate(forward, across, split * side * RAD);
        return {x: at[0] * EYE_BALL, y: at[1] * EYE_BALL, across: eyeAcross, up};
    });
}

// The character: a white head that turns to the pointer, sways, glances about and blinks; its eyes
// stretch as you speak and it morphs between expressions (see EXPRESSIONS) as it listens and answers.
const Face = GObject.registerClass(
class Face extends St.DrawingArea {
    _init() {
        super._init({width: FACE_SIZE, height: FACE_SIZE});
        this.time = 0;
        this.level = 0;
        this._form = 'listening';
        this._pointer = [0, 0];
        /** While typing: where on the stage to look (the caret), or null. */
        this.lookAt = null;
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
        this._surpriseAt = -SURPRISE_S;
        this._heard = false;
        this._voiceAt = 0;
        this._shape = copyExpression(EXPRESSIONS.attentive);
    }

    /** listening, typing, thinking, searching, reply, confused or error; each new form pops in. */
    setForm(form, time) {
        if (form !== this._form) {
            this._form = form;
            this._formAt = time;
            this._heard = false;
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
        if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
            this._gaze.x += (target.x - this._gaze.x) * follow;
            this._gaze.y += (target.y - this._gaze.y) * follow;
        }

        // The first word heard surprises it, for a moment.
        if (this._form === 'listening' && this.level > 0.3) {
            if (!this._heard)
                this._surpriseAt = time;
            this._heard = true;
            this._voiceAt = time;
        }
        const goal = EXPRESSIONS[this._expression(time)];
        const morph = 1 - Math.exp(-dt * MORPH_RATE);
        const shape = this._shape;
        for (const key of ['yaw', 'pitch', 'roll', 'split'])
            shape[key] += (goal[key] - shape[key]) * morph;
        shape.eyes.forEach((eye, index) => {
            for (const key in eye)
                eye[key] += (goal.eyes[index][key] - eye[key]) * morph;
        });

        if (time >= this._nextBlink) {
            this._blinkAt = time;
            // Now and then a double blink; slow and far apart when sleepy.
            const sleepy = shape.eyes[0].open < 0.7;
            this._nextBlink = time + (sleepy ? 3.5 + Math.random() * 3 : Math.random() < 0.15 ? 0.3 : 2.4 + Math.random() * 3);
        }
    }

    /** The expression for the form at `time` (see EXPRESSIONS). */
    _expression(time) {
        const since = time - this._formAt;
        // Nothing going on for a while: no pointer, no voice, no new form.
        const idle = time - Math.max(this._formAt, this._pointerAt, this._voiceAt) > SLEEPY_S;
        switch (this._form) {
        case 'listening':
            return time - this._surpriseAt < SURPRISE_S ? 'surprised' : idle ? 'sleepy' : 'attentive';
        case 'thinking':
            return 'curious';
        case 'reply':
            return since < SMILE_S ? 'happy' : idle ? 'sleepy' : 'attentive';
        case 'confused':
            return 'confused';
        case 'error':
            return 'sad';
        default:
            return 'attentive';
        }
    }

    /** Where the eyes look, each of x and y in -1..1. */
    _target(time, px, py) {
        const [fx, fy] = this.get_transformed_position();
        const towards = (x, y) => ({x: clamp((x - fx - FACE_SIZE / 2) / 260), y: clamp((y - fy - FACE_SIZE / 2) / 180)});
        // Reading along as you type.
        const caret = this._form === 'typing' ? this.lookAt?.() : null;
        if (caret)
            return towards(...caret);
        // Thinking, sad and confused look where their expression turns the head, swaying a little.
        if (this._form === 'thinking')
            return {x: 0.3 * Math.sin(time * 1.3), y: -0.15};
        // Reading along, line after line: a sweep left to right, then back.
        if (this._form === 'searching')
            return {x: 0.9 * Math.sin(time * 2.2), y: 0.15 + 0.1 * Math.sin(time * 0.7)};
        if (this._form === 'error')
            return {x: 0.15 * Math.sin(time * 0.8), y: 0.1};
        if (this._form === 'confused')
            return {x: 0.12 * Math.sin(time * 1.6), y: 0};
        if (time - this._pointerAt < POINTER_REST_S)
            return towards(px, py);
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

        // The expression's turn, plus where it looks and a slow sway, as if it breathed.
        const t = this.time * 2 * Math.PI;
        const shape = this._shape;
        const turn = {
            yaw: clamp(shape.yaw + gx * LOOK_TURN.yaw + 2.2 * Math.sin(t / 11.3 + 0.4) + 0.7 * Math.sin(t / 3.7 + 2.1), MAX_TURN.yaw),
            pitch: clamp(shape.pitch - gy * LOOK_TURN.pitch + 1.7 * Math.sin(t / 9.1 + 1.3) + 0.5 * Math.sin(t / 4.3 + 0.7), MAX_TURN.pitch),
            roll: shape.roll + 0.9 * Math.sin(t / 13.7 + 3.2),
            split: shape.split,
        };
        cr.setSourceRGBA(0.08, 0.08, 0.09, 1);
        placeEyes(turn).forEach((place, index) => this._eye(cr, hx + place.x, hy + place.y, place, shape.eyes[index]));
        cr.$dispose();
    }

    // A rounded eye of `eye`'s shape lying on the head as `place` says (turned, foreshortened); taller as
    // you speak; its lid falls from the top as it blinks or gets sleepy.
    _eye(cr, x, y, place, eye) {
        const blinking = this.time - this._blinkAt;
        const length = eye.open < 0.7 ? 2.5 * BLINK_S : BLINK_S;
        const blink = blinking >= 0 && blinking < length ? 1 - 0.88 * Math.sin(Math.PI * blinking / length) : 1;
        const listening = this._form === 'listening' ? 1 + 0.32 * this.level : 1;
        const w = EYE_UNIT * eye.w;
        const h = EYE_UNIT * eye.h * listening;
        const r = Math.min(w, h) / 2;
        const [ax, ay] = place.across;
        const [ux, uy] = place.up;
        const angle = Math.atan2(ay, ax);
        cr.save();
        cr.translate(x, y);
        cr.rotate(angle);
        // Foreshortened as the head turns: narrower across, shorter up and down.
        cr.scale(Math.max(0.2, Math.hypot(ax, ay)), Math.max(0.2, Math.abs(-Math.sin(angle) * ux + Math.cos(angle) * uy)));
        cr.rotate(eye.tilt * RAD);
        const shown = Math.max(0.12, eye.open * blink);
        if (shown < 0.99) {
            cr.rectangle(-w, h / 2 - h * shown, 2 * w, h * shown + 1);
            cr.clip();
        }
        // A capsule either way: tall, or wide (a happy squint).
        const [left, top, right, bottom] = [-w / 2 + r, -h / 2 + r, w / 2 - r, h / 2 - r];
        cr.newSubPath();
        cr.arc(right, top, r, -Math.PI / 2, 0);
        cr.arc(right, bottom, r, 0, Math.PI / 2);
        cr.arc(left, bottom, r, Math.PI / 2, Math.PI);
        cr.arc(left, top, r, Math.PI, 1.5 * Math.PI);
        cr.closePath();
        cr.fill();
        cr.restore();
    }
});

export const VoiceView = GObject.registerClass({
    Signals: {
        // Taps on the face: speak again, or finish speaking.
        'orb-clicked': {},
        // The Sign in button, shown when the AI is signed out.
        'sign-in': {},
        // The Set up button, shown when speech recognition (or its model) is missing.
        'set-up': {},
        // The stop button, while a request is being worked on.
        'stop': {},
        // The keyboard button: type the request instead of saying it.
        'type-requested': {},
        // A typed request, sent with Enter.
        'typed': {param_types: [GObject.TYPE_STRING]},
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
        /** The shortcut as set, for hints that name it ("Press Super+I…"). */
        this.shortcut = 'Super+I';
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
        for (const label of [this._text, this._hint])
            wrapLines(label);
        // Not wider than its label, at the start of the line.
        this._signIn = pillButton('Sign in', 'isle-pill-small isle-voice-sign-in', () => this.emit('sign-in'));
        this._signIn.x_align = Clutter.ActorAlign.START;
        this._setUp = pillButton('Set up', 'isle-pill-small isle-voice-sign-in', () => this.emit('set-up'));
        this._setUp.x_align = Clutter.ActorAlign.START;
        /** The steps of the request being worked on, done ones first. */
        this._steps = [];
        // Those done, below the one now: a tick and a line each.
        this._stepsBox = new St.BoxLayout({...VERTICAL, style_class: 'isle-voice-steps', visible: false});
        // A typed request, instead of a spoken one (see `startTyping`).
        this._entry = new St.Entry({style_class: 'isle-voice-entry', hint_text: 'Ask anything…', can_focus: true,
            x_expand: true, visible: false});
        const caret = this._entry.clutter_text;
        caret.connect('activate', () => this._send());
        // Sent from inside the field, as in Messages.
        this._sendButton = new St.Bin({style_class: 'isle-voice-send', reactive: true,
            child: new St.Icon({gicon: icon('isle-send-symbolic'), icon_size: 14})});
        this._entry.set_secondary_icon(this._sendButton);
        this._entry.connect('secondary-icon-clicked', () => this._send());
        caret.connect('text-changed', () => {
            this._micTarget = KEY_LEVEL;
            this._syncSend();
        });
        this._face.lookAt = () => {
            const position = caret.cursor_position < 0 ? caret.text.length : caret.cursor_position;
            // [ok, x, y, line height], or without ok in older GNOME.
            const [x, y, line] = caret.position_to_coords(position).slice(-3);
            const [cx, cy] = caret.get_transformed_position();
            return [cx + x, cy + y + line / 2].every(Number.isFinite) ? [cx + x, cy + y + line / 2] : null;
        };
        this._texts.add_child(this._heard);
        this._texts.add_child(this._entry);
        this._texts.add_child(this._text);
        this._texts.add_child(this._stepsBox);
        this._texts.add_child(this._hint);
        this._texts.add_child(this._signIn);
        this._texts.add_child(this._setUp);
        row.add_child(this._texts);
        // One round button at the end, its size kept whichever shows, so the texts never shift.
        this._action = new St.Widget({layout_manager: new Clutter.BinLayout(), width: ACTION_SIZE, height: ACTION_SIZE,
            y_align: Clutter.ActorAlign.CENTER});
        this._typeButton = iconButton('isle-keyboard-symbolic', 'isle-voice-action', () => this.emit('type-requested'),
            {accessibleName: 'Type instead'});
        this._stop = iconButton('isle-stop-symbolic', 'isle-voice-action isle-voice-stop', () => this.emit('stop'),
            {size: 12, accessibleName: 'Stop'});
        for (const button of [this._typeButton, this._stop]) {
            button.set_pivot_point(0.5, 0.5);
            this._action.add_child(button);
        }
        this._shownAction = null;
        row.add_child(this._action);
        this.add_child(row);

        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());
        this._start = 0;
        this._lastTick = 0;
        this._flow = 0;
        this.connect('destroy', () => this._timeline.stop());
        this.setState({phase: 'listening'});
    }

    /** Shows `state` from isled: {phase, heard, reply, error, hint, sign_in, activity, actions}. */
    setState(state) {
        this.stopTyping();
        this._phase = state.phase;
        this._exchange = {heard: state.heard ?? '', reply: clip(state.reply ?? '')};
        const heard = state.heard ? `“${state.heard}”` : '';
        const step = state.phase === 'acting' ? describeActions(state.actions) : state.activity || '';
        this._noteStep(state.phase, step);
        const [top, main, dim] = {
            // The first time it opens it greets you, as Siri does.
            listening: [this.followUp ?? '', this.greeting ?? 'Listening…', !this.greeting],
            transcribing: [this.followUp ?? '', 'One moment…', true],
            // An agent's step as it happens ("Searching ~/Downloads for “ttd”…"), else thinking.
            thinking: [heard, step || 'Thinking…', true],
            acting: [heard, step, true],
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
        if (!dim && main.length > LONG_REPLY)
            this._text.add_style_class_name('isle-voice-text-long');
        else
            this._text.remove_style_class_name('isle-voice-text-long');
        const working = WORKING.includes(state.phase);
        const hint = state.phase === 'error' ? this._withShortcut(state.hint ?? '') : '';
        this._hint.text = hint;
        this._hint.visible = Boolean(hint);
        // While it works, the steps already done, dimmed below the current one.
        this._showSteps(working ? this._steps.slice(0, -1).slice(-MAX_DONE_STEPS) : []);
        this._signIn.visible = state.phase === 'error' && Boolean(state.sign_in);
        this._setUp.visible = state.phase === 'error' && Boolean(state.set_up);
        // Stop while it works; else typing instead (to follow up, too).
        this._showAction(working ? this._stop : this._typeButton);
        const searching = (state.phase === 'thinking' && Boolean(state.activity)) || state.phase === 'acting';
        const notHeard = state.phase === 'error' && NOT_HEARD.test(state.error ?? '');
        const form = searching ? 'searching' : notHeard ? 'confused' : {transcribing: 'thinking'}[state.phase] ?? state.phase;
        this._face.setForm(form, this._face.time);
    }

    _send() {
        const text = this._entry.text.trim();
        if (text)
            this.emit('typed', text);
    }

    // Dim until there is something to send.
    _syncSend() {
        if (this._entry.text.trim())
            this._sendButton.remove_style_class_name('isle-voice-send-empty');
        else
            this._sendButton.add_style_class_name('isle-voice-send-empty');
    }

    _showSteps(done) {
        this._stepsBox.destroy_all_children();
        for (const step of done) {
            const row = new St.BoxLayout({style_class: 'isle-voice-step'});
            row.add_child(new St.Icon({gicon: icon('isle-check-symbolic'), icon_size: 11, style_class: 'isle-voice-step-tick',
                y_align: Clutter.ActorAlign.CENTER}));
            const line = new St.Label({text: step, style_class: 'isle-voice-step-text', y_align: Clutter.ActorAlign.CENTER});
            line.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(line);
            this._stepsBox.add_child(row);
        }
        this._stepsBox.visible = done.length > 0;
    }

    /** `text` naming the shortcut as set instead of the default one isled's hints name. */
    _withShortcut(text) {
        if (this.shortcut)
            return text.replaceAll('Super+I', this.shortcut);
        // No shortcut set: "Press Super+I and speak again." is "Speak again."
        return text.replace(/Press Super\+I and (\w)/, (_match, first) => first.toUpperCase());
    }

    /** Whether a request is being typed. */
    get typing() {
        return this._entry.visible;
    }

    /** Shows the field to type a request in, starting with `initial` (a key typed while it listened). */
    startTyping(initial = '') {
        this._phase = 'typing';
        this._entry.text = initial;
        this._entry.show();
        this._text.hide();
        this._hint.hide();
        this._stepsBox.hide();
        this._signIn.hide();
        this._setUp.hide();
        this._showAction(null);
        this._syncSend();
        this._entry.grab_key_focus();
        this._entry.clutter_text.set_cursor_position(-1);
        this._face.setForm('typing', this._face.time);
    }

    stopTyping() {
        this._entry.hide();
        this._text.show();
    }

    /** Shows `button` (or none) at the row's end; a new one comes in with a small pop. */
    _showAction(button) {
        this._action.visible = Boolean(button);
        if (button === this._shownAction)
            return;
        this._shownAction = button;
        for (const other of [this._typeButton, this._stop])
            other.visible = other === button;
        if (!button || !St.Settings.get().enable_animations)
            return;
        button.remove_all_transitions();
        button.set({opacity: 0, scale_x: 0.6, scale_y: 0.6});
        button.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_BACK});
    }

    /** Keeps the steps of the request being worked on; a new request starts the list over. */
    _noteStep(phase, step) {
        if (!WORKING.includes(phase)) {
            if (phase === 'listening')
                this._steps = [];
            return;
        }
        const done = step?.replace(/…$/, '');
        if (done && this._steps.at(-1) !== done)
            this._steps.push(done);
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
        const short = ['listening', 'transcribing'].includes(this._phase) && !this.followUp && !this.typing;
        return short ? LISTENING_WIDTH : ANSWER_WIDTH;
    }

    /** Sizes the texts, wrapped, and returns the height wanted below the top bar. */
    fit() {
        // Typing, the field takes the button's place too (its send is inside it).
        const width = this.preferredWidth - TEXT_INSET + (this._action.visible ? 0 : ACTION_SIZE + 12);
        // Measured per label: the box's own answer is the size set below.
        const natural = [this._heard, this._entry, this._text, this._stepsBox, this._hint, this._signIn, this._setUp].filter(part => part.visible)
            .reduce((sum, part) => sum + part.get_preferred_height(width)[1], 0);
        // Set outright: the row kept an earlier, shorter height for them.
        this._texts.set_size(width, Math.min(natural, MAX_HEIGHT - ROW_PADDING));
        // Beside a line or two it sits in the middle; beside more, level with the first line.
        this._faceButton.y_align = this._action.y_align =
            natural > FACE_SIZE + 8 ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER;
        return Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, natural + ROW_PADDING)));
    }

    /** Animates while shown; rests otherwise. With animations off in GNOME, the face and glow hold still. */
    setActive(active) {
        if (active && !this._timeline.is_playing()) {
            this._start = Date.now();
            this._lastTick = 0;
            this._face.restart();
            if (St.Settings.get().enable_animations) {
                this._timeline.start();
            } else {
                this._face.queue_repaint();
                this.emit('frame', 0, STILL_LEVEL);
            }
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
            // Each key lights it a little, as a syllable does.
            typing: 0.08 + 0.6 * this._mic,
            transcribing: 0.28 + 0.05 * Math.sin(t * 2),
            thinking: 0.32 + 0.08 * Math.sin(t * 1.8),
            acting: 0.32 + 0.08 * Math.sin(t * 1.8),
            reply: 0.12 + 0.03 * Math.sin(t * 1.2),
        }[this._phase] ?? 0.05;
        this._level += (target - this._level) * (1 - Math.exp(-dt * LEVEL_RATE));
        this._face.level = this._level;
        this._face.step(t);
        this._face.queue_repaint();
        // A little faster while it thinks; summed up, so a change of speed never makes the glow jump.
        const speed = WORKING.includes(this._phase) ? 1.6 : 1;
        this._flow += dt * speed;
        this.emit('frame', this._flow, this._level);
    }
});

/** The phases in which a request is being worked on. */
const WORKING = ['transcribing', 'thinking', 'acting'];
/** How many done steps show below the current one. */
const MAX_DONE_STEPS = 3;

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

/** Opens a terminal that downloads the speech `model` (isle-setup-voice) and stays open to show how it went. */
export function openSetUp(model) {
    const program = GLib.find_program_in_path('isle-setup-voice') ??
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'isle-setup-voice']);
    return GLib.file_test(program, GLib.FileTest.IS_EXECUTABLE) && inTerminal(['bash', '-c', SET_UP, 'isle', program,
        ...model ? [model] : []]);
}

// Runs isle-setup-voice, then says what next; a shell stays open afterwards.
const SET_UP = '"$@" && printf "\\nIsle: done. Press Super+I and speak.\\n" || ' +
    'printf "\\nIsle: that did not finish; run isle-setup-voice again.\\n"; exec bash';

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
// Each returns what it did, for the AI to go on from (see `runActions`).
const ACTIONS = {
    open_url: ({url}) => {
        if (!/^(https?|mailto):/i.test(url ?? ''))
            return failed('not a web address');
        openUri(url);
        return 'opened in the browser';
    },
    open_app: async ({app}, isle) => {
        const found = findApp(app ?? '');
        if (!found)
            return failed(`no app called ${app}`);
        // Not running yet: a media command after it waits for its player.
        if (found.get_state() !== Shell.AppState.RUNNING)
            isle.launched = found;
        found.activate();
        // What comes next (placing its window) needs the window there.
        return await windowOf(found, WINDOW_WAIT_MS) ? `${found.get_name()} is open` : `${found.get_name()} is starting`;
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
    dnd: ({on}, {notifications}) => {
        notifications.dnd = on !== false;
    },
    notifications: (_action, {showNotifications}) => showNotifications(),
    play_music: ({query, uri}) => playMusic(query ?? '', uri),
    window: ({command, title, app}, {target}) => {
        const window = title ? windowTitled(title)
            : app ? findApp(app, Shell.AppSystem.get_default().get_running())?.get_windows()[0] : target;
        // The window in front when asked may have closed since.
        if (!window?.get_compositor_private())
            return failed('no such window is open');
        if (!WINDOW_COMMANDS[command])
            return failed(`no window command ${command}`);
        WINDOW_COMMANDS[command](window);
        return `${command}: ${window.title ?? 'the window'}`;
    },
    arrange: ({layout, apps}) => {
        const count = arrangeWindows(layout, Array.isArray(apps) ? apps : []);
        return count ? `${count} windows arranged` : failed('no matching windows are open');
    },
    open_file: async ({path}) => await withFile(path, file => openUri(file.get_uri()), {opening: true})
        ? 'opened' : failed('not found, or not allowed'),
    reveal_file: async ({path}) => await withFile(path, file => revealFile(file))
        ? 'shown in Files' : failed('not found, or not allowed'),
    chrome_profile: ({profile}) => openChromeProfile(profile ?? ''),
    close_app: async ({app}) => {
        const running = findApp(app ?? '', Shell.AppSystem.get_default().get_running());
        if (!running)
            return failed(`${app} is not open`);
        const name = running.get_name();
        running.request_quit();
        return await closed(running, CLOSE_WAIT_MS) ? `${name} closed` : failed(`${name} is still open; it may be asking to save`);
    },
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
/** Counts `stopPending` calls: actions started before one never go on after it. */
let generation = 0;

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

/** Stops everything the actions still wait on, and the actions still to run. */
export function stopPending() {
    generation++;
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
// app), else the ones in front; as many as `layout` holds, and the first of them is focused. Returns how many.
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
    const placed = windows.slice(0, slots.length);
    placed.forEach((window, i) => tile(window, slots[i]));
    if (placed.length > 0)
        Main.activateWindow(placed[0]);
    return placed.length;
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
 * anything that would run. Returns whether it ran.
 */
async function withFile(path, callback, {opening = false} = {}) {
    if (typeof path !== 'string' || !path.trim())
        return false;
    const home = GLib.get_home_dir();
    const expanded = path.trim().replace(/^~(?=\/|$)/, home);
    const file = Gio.File.new_for_path(GLib.canonicalize_filename(expanded, home));
    const where = file.get_path();
    const inHome = where.startsWith(`${home}/`);
    if (!inHome && !FILE_ROOTS.some(root => where.startsWith(root)))
        return false;
    if (inHome && where.slice(home.length + 1).split('/').some(part => part.startsWith('.')))
        return false;
    let info;
    try {
        info = await queryInfo(file, 'standard::is-symlink,standard::content-type,access::can-execute',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS);
    } catch {
        return false; // not there
    }
    if (info.get_is_symlink())
        return false;
    if (opening) {
        const type = info.get_content_type() ?? '';
        const mime = Gio.content_type_get_mime_type(type) ?? '';
        // Documents and media open in a viewer whatever their permissions (files on a USB stick often
        // look executable); anything else that could run is left alone.
        const viewed = type === 'inode/directory' || /^(image|video|audio|text)\//.test(mime) ||
            /pdf|opendocument|officedocument|msword|ms-excel|ms-powerpoint|epub/.test(mime);
        const runnable = Gio.content_type_can_be_executable(type) || info.get_attribute_boolean('access::can-execute');
        if (RUNS.test(mime) || (!viewed && runnable))
            return false;
    }
    callback(file);
    return true;
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
async function openFolder(path) {
    const home = GLib.get_home_dir();
    const expanded = path.trim().replace(/^~(?=\/|$)/, home);
    let folder = Gio.File.new_for_path(GLib.path_is_absolute(expanded) ? expanded : GLib.build_filenamev([home, expanded]));
    while (folder.get_parent() && !await isFolder(folder))
        folder = folder.get_parent();
    openUri(folder.get_uri());
    return `opened ${folder.get_path()}`;
}

/** `file`'s info for `attributes`, read off the main loop's way. */
function queryInfo(file, attributes, flags = Gio.FileQueryInfoFlags.NONE) {
    return new Promise((resolve, reject) => {
        file.query_info_async(attributes, flags, GLib.PRIORITY_DEFAULT, null, (_file, result) => {
            try {
                resolve(file.query_info_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function isFolder(file) {
    try {
        return (await queryInfo(file, 'standard::type')).get_file_type() === Gio.FileType.DIRECTORY;
    } catch {
        return false;
    }
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

/** Runs the AI's actions in order; `isle` is what they act on (see `ACTIONS`). Resolves to what each did,
 * as `{type, ok, detail}`, for the AI to take its next step from. */
export async function runActions(actions, isle) {
    const results = [];
    const started = generation;
    for (const action of actions ?? []) {
        // Isle turned off meanwhile: nothing more runs.
        if (generation !== started)
            break;
        let outcome;
        try {
            outcome = ACTIONS[action.type] ? await ACTIONS[action.type](action, isle) : failed('unknown action');
        } catch (e) {
            console.warn(`Isle: voice action ${action.type} failed: ${e.message}`);
            outcome = failed(e.message);
        }
        results.push({type: action.type, ...outcomeOf(outcome)});
    }
    return results;
}

/** Resolves once `app` has a window (true), or after `ms` (false). */
function windowOf(app, ms) {
    return windowsUntil(app, windows => windows.length > 0, ms);
}

/** Resolves once `app` has no window left (true), or after `ms` (false). */
function closed(app, ms) {
    return windowsUntil(app, windows => windows.length === 0, ms);
}

/** Resolves once `app`'s windows pass `test` (true), or after `ms` (false). */
function windowsUntil(app, test, ms) {
    if (test(app.get_windows()))
        return Promise.resolve(true);
    return new Promise(resolve => {
        const entry = {};
        const changed = app.connect('windows-changed', () => {
            if (test(app.get_windows()))
                entry.stop(true);
        });
        const giveUp = after(ms, () => entry.stop(false));
        entry.stop = (found = false) => {
            if (!pending.delete(entry))
                return;
            app.disconnect(changed);
            giveUp();
            resolve(found);
        };
        pending.add(entry);
    });
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
