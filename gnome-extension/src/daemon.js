// SPDX-License-Identifier: GPL-3.0-or-later

// Client for isled, the Rust service that does the actual work. Each interface's state comes as
// JSON string properties, parsed here into plain objects on `Daemon.state`.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const BUS_NAME = 'io.github.zickrian.isle.Daemon';
const OBJECT_PATH = '/io/github/zickrian/isle/Daemon';

const node = (name, body) =>
    `<node><interface name="io.github.zickrian.isle.${name}">${body}</interface></node>`;

// Each interface, its JSON properties and the `state` keys they map to.
const INTERFACES = {
    media: {
        xml: node('Media1', `
            <method name="PlayPause"/>
            <method name="Next"/>
            <method name="Previous"/>
            <method name="SetPosition"><arg name="position_us" type="x" direction="in"/></method>
            <method name="Raise"/>
            <property name="NowPlaying" type="s" access="read"/>
            <property name="Lyrics" type="s" access="read"/>`),
        properties: {NowPlaying: 'nowPlaying', Lyrics: 'lyrics'},
    },
    pomodoro: {
        xml: node('Pomodoro1', `
            <method name="Start"/>
            <method name="Pause"/>
            <method name="Stop"/>
            <method name="Skip"/>
            <method name="StartPhase"><arg name="phase" type="s" direction="in"/></method>
            <method name="SetConfig"><arg name="config" type="s" direction="in"/></method>
            <signal name="PhaseFinished"><arg name="finished" type="s"/><arg name="next" type="s"/></signal>
            <property name="State" type="s" access="read"/>
            <property name="Config" type="s" access="read"/>`),
        properties: {State: 'pomodoro', Config: 'pomodoroConfig'},
    },
    todo: {
        xml: node('Todo1', `
            <method name="Add"><arg name="text" type="s" direction="in"/><arg type="t" direction="out"/></method>
            <method name="SetDone"><arg name="id" type="t" direction="in"/><arg name="done" type="b" direction="in"/></method>
            <method name="Rename"><arg name="id" type="t" direction="in"/><arg name="title" type="s" direction="in"/></method>
            <method name="Remove"><arg name="id" type="t" direction="in"/></method>
            <method name="ClearDone"/>
            <property name="Items" type="s" access="read"/>`),
        properties: {Items: 'tasks'},
    },
    shelf: {
        xml: node('Shelf1', `
            <method name="Add"><arg name="uris" type="as" direction="in"/></method>
            <method name="Remove"><arg name="uri" type="s" direction="in"/></method>
            <method name="Clear"/>
            <method name="Refresh"/>
            <property name="Items" type="s" access="read"/>`),
        properties: {Items: 'shelf'},
    },
    clipboard: {
        xml: node('Clipboard1', `
            <method name="AddText"><arg name="text" type="s" direction="in"/><arg name="app_id" type="s" direction="in"/><arg type="t" direction="out"/></method>
            <method name="AddImage"><arg name="png" type="ay" direction="in"/><arg name="app_id" type="s" direction="in"/><arg type="t" direction="out"/></method>
            <method name="AddFiles"><arg name="uris" type="as" direction="in"/><arg name="app_id" type="s" direction="in"/><arg type="t" direction="out"/></method>
            <method name="GetText"><arg name="id" type="t" direction="in"/><arg type="s" direction="out"/></method>
            <method name="Touch"><arg name="id" type="t" direction="in"/></method>
            <method name="SetPinned"><arg name="id" type="t" direction="in"/><arg name="pinned" type="b" direction="in"/></method>
            <method name="Remove"><arg name="id" type="t" direction="in"/></method>
            <method name="Clear"/>
            <property name="Items" type="s" access="read"/>`),
        properties: {Items: 'clipboard'},
    },
    calendar: {
        xml: node('Calendar1', `
            <method name="Add"><arg name="date" type="s" direction="in"/><arg name="text" type="s" direction="in"/><arg type="t" direction="out"/></method>
            <method name="Remove"><arg name="id" type="t" direction="in"/></method>
            <property name="Events" type="s" access="read"/>`),
        properties: {Events: 'events'},
    },
    system: {
        xml: node('System1', `
            <signal name="Event"><arg name="event" type="s"/></signal>
            <property name="State" type="s" access="read"/>`),
        properties: {State: 'system'},
    },
};

// Signals: `changed` (key): `state[key]` is new; `pomodoro-finished` (finished, next): phase names;
// `system-event` (event): see `SystemEvent` in the daemon.
export class Daemon extends Signals.EventEmitter {
    constructor() {
        super();
        /** Parsed state; a key is `null` until the daemon has reported it. */
        this.state = {};
        /** The JSON each key last had, to tell a real change from the same value sent again. */
        this._raw = {};
        this._proxies = {};
        this._cancellable = new Gio.Cancellable();

        for (const [name, {xml, properties}] of Object.entries(INTERFACES)) {
            for (const key of Object.values(properties))
                this.state[key] = null;
            this._connect(name, xml, properties);
        }
        this._start();
    }

    /** Starts isled through D-Bus activation if it is not running yet. */
    _start() {
        Gio.DBus.session.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'StartServiceByName', new GLib.Variant('(su)', [BUS_NAME, 0]), null,
            Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (connection, result) => {
                try {
                    connection.call_finish(result);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`Isle: could not start isled: ${e.message}`);
                }
            });
    }

    _connect(name, xml, properties) {
        const Proxy = Gio.DBusProxy.makeProxyWrapper(xml);
        // The proxy is created even while isled is not running, and picks up
        // its state whenever it appears (or restarts).
        new Proxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH, (proxy, error) => {
            if (error) {
                if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`Isle: could not create the ${name} proxy: ${error.message}`);
                return;
            }
            this._proxies[name] = proxy;

            const refresh = () => {
                for (const [property, key] of Object.entries(properties))
                    this._update(key, proxy[property]);
            };
            // Only what changed: NowPlaying changing many times a song should not re-read the lyrics.
            proxy.connect('g-properties-changed', (_proxy, changed, invalidated) => {
                for (const property of [...Object.keys(changed.deep_unpack()), ...invalidated]) {
                    if (property in properties)
                        this._update(properties[property], proxy[property]);
                }
            });
            // The daemon restarted (or stopped): re-read everything.
            proxy.connect('notify::g-name-owner', refresh);
            proxy.connect('g-signal', (_proxy, _sender, signal, parameters) =>
                this._onSignal(signal, parameters.deep_unpack()));
            refresh();
        }, this._cancellable, Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION);
    }

    _update(key, json) {
        // isled may send a value again unchanged; nobody needs to hear it twice.
        if (key in this._raw && this._raw[key] === json)
            return;
        this._raw[key] = json;
        let value = null;
        try {
            value = json ? JSON.parse(json) : null;
        } catch (e) {
            console.warn(`Isle: invalid ${key} from isled: ${e.message}`);
        }
        this.state[key] = value;
        this.emit('changed', key);
    }

    _onSignal(signal, args) {
        switch (signal) {
        case 'PhaseFinished':
            this.emit('pomodoro-finished', ...args);
            break;
        case 'Event':
            try {
                this.emit('system-event', JSON.parse(args[0]));
            } catch (e) {
                console.warn(`Isle: invalid system event: ${e.message}`);
            }
            break;
        }
    }

    /** Calls `method` on interface `name`. Failures are logged, not thrown, as callers can rarely do better. */
    call(name, method, ...args) {
        const proxy = this._proxies[name];
        if (!proxy)
            return Promise.resolve(null);
        return new Promise(resolve => {
            try {
                proxy[`${method}Remote`](...args, (result, error) => {
                    if (error)
                        console.warn(`Isle: ${method} failed: ${error.message}`);
                    resolve(error ? null : result);
                });
            } catch (e) {
                // Arguments that do not fit the method's signature.
                console.warn(`Isle: ${method} failed: ${e.message}`);
                resolve(null);
            }
        });
    }

    destroy() {
        // Tell no one about changes made while tearing down.
        this.disconnectAll();
        this._cancellable.cancel();
        for (const proxy of Object.values(this._proxies))
            proxy.run_dispose();
        this._proxies = {};
    }
}
