// Preferences: how the island looks and behaves (GSettings), and the focus
// timer's durations (stored by pulaud, edited over D-Bus).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DAEMON = 'io.github.pulau.Daemon';
const DAEMON_PATH = '/io/github/pulau/Daemon';
const POMODORO_INTERFACE = 'io.github.pulau.Pomodoro1';
/** Edits to the timer are sent once typing pauses for this long. */
const SAVE_DELAY_MS = 400;

export default class PulauPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 680);
        window.add(this._islandPage(settings));
        window.add(this._timerPage());
    }

    _islandPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Island', icon_name: 'preferences-desktop-appearance-symbolic'});

        const look = new Adw.PreferencesGroup({title: 'Appearance'});
        look.add(switchRow(settings, 'black-top-bar', 'Black top bar', 'Blend the top bar into the island'));
        look.add(spinRow(settings, 'notch-depth', 'Notch depth', 'How far the island hangs below the top bar, in pixels', 0, 16));
        page.add(look);

        const idle = new Adw.PreferencesGroup({title: 'When Idle'});
        idle.add(switchRow(settings, 'sleepy-eyes', 'Sleepy eyes', 'Eyes appear and doze off when you step away'));
        idle.add(spinRow(settings, 'idle-seconds', 'Idle after', 'Seconds without input', 15, 3600));
        page.add(idle);

        const alerts = new Adw.PreferencesGroup({title: 'Alerts'});
        alerts.add(switchRow(settings, 'replace-osd', 'Volume and brightness', 'Show them in the island instead of the centre of the screen'));
        alerts.add(switchRow(settings, 'system-alerts', 'Charging, network and Bluetooth', 'Also Caps Lock and keyboard layout changes'));
        alerts.add(switchRow(settings, 'track-peek', 'New song', 'Briefly show the song when the track changes'));
        alerts.add(switchRow(settings, 'compact-lyrics', 'Live lyrics', 'Show the current lyric line in the closed island'));
        alerts.add(switchRow(settings, 'chimes', 'Sounds', 'Chime when a timer ends or a task is due'));
        page.add(alerts);
        return page;
    }

    _timerPage() {
        const page = new Adw.PreferencesPage({title: 'Focus Timer', icon_name: 'alarm-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: 'Pomodoro',
            description: 'Focus sessions with short breaks, and a long break after a few sessions.',
        });
        page.add(group);

        let proxy = null;
        let config = null;
        try {
            proxy = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE,
                null, DAEMON, DAEMON_PATH, POMODORO_INTERFACE, null);
            config = JSON.parse(proxy.get_cached_property('Config')?.unpack() ?? 'null');
        } catch (e) {
            console.warn(`Pulau: could not read the timer settings: ${e.message}`);
        }
        if (!config) {
            group.add(new Adw.ActionRow({
                title: 'Pulau’s background service is not running',
                subtitle: 'Run the installer again, or start it with “systemctl --user start pulaud”.',
            }));
            return page;
        }

        let saveId = 0;
        const save = () => {
            if (saveId)
                GLib.source_remove(saveId);
            saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
                saveId = 0;
                proxy.call('SetConfig', new GLib.Variant('(s)', [JSON.stringify(config)]),
                    Gio.DBusCallFlags.NONE, -1, null, null);
                return GLib.SOURCE_REMOVE;
            });
        };
        const number = (key, title, min, max) => {
            const row = Adw.SpinRow.new_with_range(min, max, 1);
            row.title = title;
            row.value = config[key];
            row.connect('notify::value', () => {
                config[key] = row.value;
                save();
            });
            return row;
        };
        const toggle = (key, title, subtitle) => {
            const row = new Adw.SwitchRow({title, subtitle, active: config[key]});
            row.connect('notify::active', () => {
                config[key] = row.active;
                save();
            });
            return row;
        };

        group.add(number('focus_minutes', 'Focus (minutes)', 1, 180));
        group.add(number('short_break_minutes', 'Short break (minutes)', 1, 60));
        group.add(number('long_break_minutes', 'Long break (minutes)', 1, 120));
        group.add(number('sessions_before_long_break', 'Sessions before a long break', 1, 12));
        group.add(toggle('auto_start_breaks', 'Start breaks automatically', null));
        group.add(toggle('auto_start_focus', 'Start focus automatically', 'After a break ends'));
        return page;
    }
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, min, max) {
    const row = Adw.SpinRow.new_with_range(min, max, 1);
    row.title = title;
    row.subtitle = subtitle;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}
