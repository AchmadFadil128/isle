// SPDX-License-Identifier: GPL-3.0-or-later

// Mic, camera (from isled), screen sharing and recording; all event driven.
// Mic streams that only meter input (sound settings) are ignored, as GNOME does.

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

import {isWayland} from './compat.js';

/** Apps that open the microphone only to show its level. */
export const LEVEL_METERS = ['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol'];

/** Signals: `changed` (any state), `recording-started` (GNOME's screen recorder). */
export class PrivacyMonitor extends Signals.EventEmitter {
    constructor(daemon) {
        super();
        this._daemon = daemon;
        /** Screen-sharing handles and their `stopped` handler ids. */
        this._shares = new Map();
        this.microphone = false;
        this.camera = false;
        this.screenShare = false;
        this.recording = false;
        /** GLib monotonic time (µs) when the current recording started. */
        this.recordingSince = 0;

        this._mixer = getMixerControl();
        this._mixerIds = ['stream-added', 'stream-removed'].map(signal =>
            this._mixer.connect(signal, () => this._syncMicrophone()));

        this._daemonId = daemon.connect('changed', (_daemon, key) => {
            if (key === 'system')
                this._syncCamera();
        });

        this._screenshotUI = Main.screenshotUI;
        this._recordingId = this._screenshotUI.connect('notify::screencast-in-progress',
            () => this._syncRecording());

        // Screen sharing is only reliably known on Wayland, where Mutter
        // does the sharing itself; GNOME makes the same choice.
        this._remote = isWayland() ? global.backend.get_remote_access_controller() : null;
        this._remoteId = this._remote?.connect('new-handle', (_controller, handle) => this._onHandle(handle));

        this._syncMicrophone();
        this._syncCamera();
        this._syncRecording();
    }

    /** Whether anything at all is in use, for showing indicators. */
    get any() {
        return this.microphone || this.camera || this.screenShare;
    }

    stopRecording() {
        this._screenshotUI.stopScreencast();
    }

    _syncMicrophone() {
        const inUse = this._mixer.get_source_outputs()
            .some(stream => !LEVEL_METERS.includes(stream.get_application_id()));
        this._set('microphone', inUse);
    }

    _syncCamera() {
        this._set('camera', Boolean(this._daemon.state.system?.camera_in_use));
    }

    _syncRecording() {
        const recording = this._screenshotUI.screencast_in_progress;
        if (recording === this.recording)
            return;
        this.recording = recording;
        this.recordingSince = recording ? GLib.get_monotonic_time() : 0;
        this.emit('changed');
        if (recording)
            this.emit('recording-started');
    }

    _onHandle(handle) {
        // Recordings are covered by the screen recorder state above.
        if (handle.is_recording)
            return;
        this._shares.set(handle, handle.connect('stopped', () => {
            handle.disconnect(this._shares.get(handle));
            this._shares.delete(handle);
            this._set('screenShare', this._shares.size > 0);
        }));
        this._set('screenShare', true);
    }

    _set(key, value) {
        if (this[key] === value)
            return;
        this[key] = value;
        this.emit('changed');
    }

    destroy() {
        // Tell no one about changes made while tearing down.
        this.disconnectAll();
        this._mixerIds.forEach(id => this._mixer.disconnect(id));
        this._daemon.disconnect(this._daemonId);
        this._screenshotUI.disconnect(this._recordingId);
        if (this._remoteId)
            this._remote.disconnect(this._remoteId);
        this._shares.forEach((id, handle) => handle.disconnect(id));
    }
}
