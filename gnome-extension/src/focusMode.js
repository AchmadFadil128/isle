// SPDX-License-Identifier: GPL-3.0-or-later

// Do Not Disturb during focus sessions, like a Focus mode on iPhone.
//
// When a focus phase starts and Do Not Disturb is off, it is turned on; when
// the phase ends it is turned off again. Isle only ever undoes what it did:
// if Do Not Disturb was already on, or the user turns it off mid-session, it
// is left alone.

/** Keeps Do Not Disturb in step with the focus timer. */
export class FocusMode {
    constructor(daemon, notifications, settings) {
        this._daemon = daemon;
        this._notifications = notifications;
        this._settings = settings;
        /** Whether Isle turned Do Not Disturb on and owes turning it off. */
        this._owned = false;
        this._changing = false;

        this._daemonId = daemon.connect('changed', (_daemon, key) => {
            if (key === 'pomodoro')
                this._sync();
        });
        this._dndId = notifications.connect('dnd-changed', () => {
            // The user turned it off themselves: it is theirs again.
            if (!this._changing && this._owned && !notifications.dnd)
                this._owned = false;
        });
        this._settingsId = settings.connect('changed::focus-dnd', () => this._sync());
        this._sync();
    }

    _sync() {
        const phase = this._daemon.state.pomodoro?.phase;
        // A paused focus session is still a focus session.
        const focusing = phase === 'focus' && this._settings.get_boolean('focus-dnd');
        if (focusing && !this._owned && !this._notifications.dnd) {
            this._owned = true;
            this._setDnd(true);
        } else if (!focusing && this._owned) {
            this._owned = false;
            this._setDnd(false);
        }
    }

    _setDnd(on) {
        this._changing = true;
        this._notifications.dnd = on;
        this._changing = false;
    }

    destroy() {
        this._daemon.disconnect(this._daemonId);
        this._notifications.disconnect(this._dndId);
        this._settings.disconnect(this._settingsId);
        // Leave the desktop as the user had it.
        if (this._owned)
            this._setDnd(false);
    }
}
