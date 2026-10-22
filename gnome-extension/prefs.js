// SPDX-License-Identifier: GPL-3.0-or-later

// Preferences: island look and behaviour (GSettings), clipboard history, and
// focus timer durations (stored by isled, edited over D-Bus).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {DesktopAppInfo} from './src/appInfo.js';

const DAEMON = 'io.github.zickrian.isle.Daemon';
const DAEMON_PATH = '/io/github/zickrian/isle/Daemon';
const POMODORO_INTERFACE = 'io.github.zickrian.isle.Pomodoro1';
const CLIPBOARD_INTERFACE = 'io.github.zickrian.isle.Clipboard1';
/** Edits to the timer are sent once typing pauses for this long. */
const SAVE_DELAY_MS = 400;

export default class IslePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 680);
        window.add(this._islandPage(settings));
        window.add(this._clipboardPage(settings, window));
        window.add(this._timerPage(settings, window));
        window.add(this._voicePage(settings));
        window.add(this._usagePage(settings));
    }

    // AI plan usage: only the providers signed in on this computer are listed.
    _usagePage(settings) {
        const page = new Adw.PreferencesPage({title: 'AI Usage', icon_name: 'speedometer-symbolic'});
        const found = usageProviders();
        const group = new Adw.PreferencesGroup({
            title: 'AI Usage',
            description: found.length
                ? 'How much of your plans\' limits is used, on a Usage page in the open island, with a warning ' +
                  'as one nears its end. Found from the apps you are signed in to; nothing else to set up.'
                : 'Sign in to Claude Code (claude) or Codex (codex) and your plan shows up here.',
        });
        const enabled = switchRow(settings, 'usage-enabled', 'Show AI usage', 'The Usage page and its warnings');
        group.add(enabled);
        const rows = found.map(({key, title, subtitle}) => switchRow(settings, key, title, subtitle));
        const warn = spinRow(settings, 'usage-warn', 'Warn at', 'Share of a limit, in %', 50, 99);
        const critical = spinRow(settings, 'usage-critical', 'Warn again at', 'Share of a limit, in %', 50, 100);
        for (const row of found.length ? [...rows, warn, critical] : []) {
            settings.bind('usage-enabled', row, 'sensitive', Gio.SettingsBindFlags.GET);
            group.add(row);
        }
        enabled.sensitive = found.length > 0;
        page.add(group);
        return page;
    }

    _voicePage(settings) {
        const page = new Adw.PreferencesPage({title: 'Voice', icon_name: 'audio-input-microphone-symbolic'});
        const installed = AI_PROVIDERS.filter(provider => findProgram(provider.command));
        const group = new Adw.PreferencesGroup({
            title: 'Voice Assistant',
            description: 'Press Super+I (or the mic in the open island) and speak. Speech is recognised on this ' +
                'computer (set up once with isle-setup-voice in a terminal); the request goes to the AI you pick, with your ' +
                'own sign-in and plan.',
        });
        group.add(switchRow(settings, 'voice-assistant', 'Voice assistant', 'Super+I and the mic in the open island'));

        // Only the AIs installed here are offered; with none, the assistant says how to get one.
        const provider = choiceRow(settings, 'voice-provider', 'AI', installed.length
            ? 'Answers with your own sign-in; Isle runs its actions'
            : 'Install Claude Code, Codex or Antigravity (agy), and sign in', [
            ['auto', installed.length ? `Automatic (${installed[0].name})` : 'None installed'],
            ...installed.map(({id, name}) => [id, name]),
        ]);
        const model = new Adw.ComboRow({title: 'Model'});
        let modelChoices = [];
        let modelKey = null;
        // Swapping the list moves the selection; that must not write a model of its own.
        let syncing = false;
        const syncModel = () => {
            syncing = true;
            try {
                fillModel();
            } finally {
                syncing = false;
            }
        };
        const fillModel = () => {
            const wanted = settings.get_string('voice-provider');
            const current = installed.find(p => p.id === wanted) ?? installed[0];
            model.visible = Boolean(current);
            if (!current)
                return;
            modelKey = current.modelKey;
            modelChoices = current.models();
            // A model set by hand, not in the list, stays shown and kept.
            const value = settings.get_string(modelKey);
            if (!modelChoices.some(([id]) => id === value))
                modelChoices.push([value, value || 'Default']);
            model.subtitle = current.about;
            model.model = Gtk.StringList.new(modelChoices.map(([, label]) => label));
            model.selected = Math.max(0, modelChoices.findIndex(([id]) => id === value));
        };
        model.connect('notify::selected', () => {
            if (syncing)
                return;
            const value = modelChoices[model.selected]?.[0];
            if (modelKey && value !== undefined && value !== settings.get_string(modelKey))
                settings.set_string(modelKey, value);
        });
        const changed = settings.connect('changed::voice-provider', syncModel);
        model.connect('destroy', () => settings.disconnect(changed));
        syncModel();

        const options = [provider, model];
        options.push(choiceRow(settings, 'voice-speech-model', 'Speech recognition', 'Bigger is more accurate, and slower', [
            ['base', 'Base'],
            ['small', 'Small'],
            ['medium', 'Medium'],
        ]));
        options.push(choiceRow(settings, 'voice-language', 'Language', 'The language you speak', [
            ['id,en', 'Indonesian or English'],
            ['id', 'Indonesian'],
            ['en', 'English'],
            ['', 'Detect'],
        ]));
        options.push(switchRow(settings, 'voice-use-selection', 'Use selected text',
            'Send the text you have selected, so the AI can work on it; never from terminals or password managers'));
        options.push(switchRow(settings, 'voice-read-notifications', 'Read notifications',
            'Let the AI read your recent notifications when you ask about them'));
        for (const row of options) {
            settings.bind('voice-assistant', row, 'sensitive', Gio.SettingsBindFlags.GET);
            group.add(row);
        }
        page.add(group);

        const notes = new Adw.PreferencesGroup({
            title: 'About the AIs',
            description: 'Claude Code and Codex answer within your Claude or ChatGPT plan\'s limits. Antigravity\'s ' +
                'terms bar third-party tools from its service; Isle only runs the official agy app, but use it at ' +
                'your own risk. Each runs kept to answering: commands and file changes go through Isle, which ' +
                'asks you first.',
        });
        page.add(notes);
        return page;
    }

    _clipboardPage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'Clipboard', icon_name: 'edit-paste-symbolic'});

        const history = new Adw.PreferencesGroup({
            title: 'Clipboard History',
            description: 'Super+V opens it. Everything stays on this computer.',
        });
        history.add(switchRow(settings, 'clipboard-history', 'Keep clipboard history',
            'Text, links, images and files you copy. Passwords from password managers are never kept.'));
        const clear = new Adw.ActionRow({title: 'Clear history', subtitle: 'Pinned items are kept'});
        const clearButton = new Gtk.Button({label: 'Clear…', valign: Gtk.Align.CENTER});
        clearButton.connect('clicked', () => confirmClear(window));
        clear.add_suffix(clearButton);
        history.add(clear);
        page.add(history);

        const ignored = new Adw.PreferencesGroup({
            title: 'Never Keep Copies From',
            description: 'Known password managers are on the list from the start.',
        });
        page.add(ignored);
        fillIgnoredApps(ignored, settings);
        return page;
    }

    _islandPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Island', icon_name: 'preferences-desktop-appearance-symbolic'});

        const look = new Adw.PreferencesGroup({title: 'Appearance'});
        look.add(choiceRow(settings, 'top-bar-style', 'Top bar', 'Glass shows the island as a notch, like on a Mac', [
            ['glass', 'Glass'],
            ['black', 'Black'],
            ['theme', 'Theme'],
        ]));
        look.add(switchRow(settings, 'compact-top-bar', 'Compact top bar', 'A slimmer top bar that frames the island like a bezel'));
        look.add(switchRow(settings, 'island-in-top-bar', 'Island inside the top bar',
            'Like a MacBook’s notch: the closed island never covers windows'));
        const depth = spinRow(settings, 'notch-depth', 'Island height', 'How far the closed island hangs below the top bar, in pixels', 24, 40);
        settings.bind('island-in-top-bar', depth, 'sensitive', Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.INVERT_BOOLEAN);
        look.add(depth);
        page.add(look);

        const alerts = new Adw.PreferencesGroup({title: 'Alerts'});
        alerts.add(switchRow(settings, 'replace-osd', 'Volume and brightness', 'Show them in the island instead of the centre of the screen'));
        alerts.add(switchRow(settings, 'system-alerts', 'Charging, network and Bluetooth', 'Also Caps Lock'));
        alerts.add(switchRow(settings, 'privacy-indicators', 'Privacy indicators', 'Dots when the camera, microphone or screen sharing is in use'));
        alerts.add(switchRow(settings, 'track-peek', 'New song', 'Briefly show the song when the track changes'));
        alerts.add(switchRow(settings, 'chimes', 'Sounds', 'Chime when a focus session or break ends'));
        page.add(alerts);

        const calls = new Adw.PreferencesGroup({
            title: 'Calls',
            description: 'WhatsApp, Telegram, Meet and other calls, in any app or browser.',
        });
        calls.add(switchRow(settings, 'call-activity', 'Calls in the island', 'The call’s length, mute and a way back to it'));
        const preview = switchRow(settings, 'call-preview', 'Live preview',
            'See yourself and whoever you call, live in the open island');
        settings.bind('call-activity', preview, 'sensitive', Gio.SettingsBindFlags.GET);
        calls.add(preview);
        page.add(calls);
        return page;
    }

    _timerPage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'Focus Timer', icon_name: 'alarm-symbolic'});
        const focus = new Adw.PreferencesGroup({title: 'While Focusing'});
        focus.add(switchRow(settings, 'focus-dnd', 'Do Not Disturb', 'Silence notifications during focus sessions, and restore them afterwards'));
        page.add(focus);

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
            console.warn(`Isle: could not read the timer settings: ${e.message}`);
        }
        if (!config) {
            group.add(new Adw.ActionRow({
                title: 'Isle’s background service is not running',
                subtitle: 'Run the installer again, or start it with “systemctl --user start isled”.',
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
        // Don't lose the last change when the window closes before it is saved.
        window.connect('close-request', () => {
            if (!saveId)
                return false;
            GLib.source_remove(saveId);
            saveId = 0;
            try {
                proxy.call_sync('SetConfig', new GLib.Variant('(s)', [JSON.stringify(config)]),
                    Gio.DBusCallFlags.NONE, -1, null);
            } catch (e) {
                console.warn(`Isle: could not save the timer settings: ${e.message}`);
            }
            return false;
        });
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

/** The AI CLIs the voice assistant can ask, in the order "Automatic" tries them (as isled does). */
const AI_PROVIDERS = [
    {
        id: 'agy', name: 'Antigravity', command: 'agy', modelKey: 'voice-agy-model',
        about: 'What agy answers with',
        models: () => [
            ['gemini-3.8-flash-low', 'Gemini Flash (fastest)'],
            ['gemini-3.8-flash-medium', 'Gemini Flash (medium)'],
            ['gemini-3.8-flash-high', 'Gemini Flash (high)'],
            ['claude-sonnet-4-6', 'Claude Sonnet'],
        ],
    },
    {
        id: 'claude', name: 'Claude Code', command: 'claude', modelKey: 'voice-claude-model',
        about: 'What Claude answers with',
        models: () => [
            ['haiku', 'Haiku (fastest, less reliable)'],
            ['sonnet', 'Sonnet'],
            ['opus', 'Opus (smartest, slower)'],
            ['', 'Claude Code\'s default'],
        ],
    },
    {
        id: 'codex', name: 'Codex', command: 'codex', modelKey: 'voice-codex-model',
        about: 'What Codex answers with, with little reasoning, to be quick',
        models: () => [['', 'Codex\'s default'], ...codexModels()],
    },
];

/** `command` on the PATH or where installers put it, else null. */
function findProgram(command) {
    const home = GLib.get_home_dir();
    return GLib.find_program_in_path(command) ?? ['.local/bin', '.npm-global/bin', '.bun/bin']
        .map(dir => GLib.build_filenamev([home, dir, command]))
        .find(path => GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) ?? null;
}

/** The models Codex lists, from the cache it keeps (Isle's own home for it, else the user's). */
function codexModels() {
    const home = GLib.get_home_dir();
    for (const dir of [[home, '.local', 'share', 'isle', 'codex'], [home, '.codex']]) {
        try {
            const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([...dir, 'models_cache.json']));
            const models = JSON.parse(new TextDecoder().decode(bytes)).models ?? [];
            return models.filter(m => m.visibility === 'list').map(m => [m.slug, m.display_name ?? m.slug]);
        } catch {
            // Not there, or not readable: the next place.
        }
    }
    return [];
}

/** The AI providers signed in here, as rows to switch: Claude Code's sign-in, and Codex's logs. */
function usageProviders() {
    const home = GLib.get_home_dir();
    const providers = [];
    try {
        const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([home, '.claude', '.credentials.json']));
        const plan = JSON.parse(new TextDecoder().decode(bytes)).claudeAiOauth?.subscriptionType ?? '';
        providers.push({key: 'usage-claude', title: 'Claude',
            subtitle: `${plan ? `${plan[0].toUpperCase()}${plan.slice(1)} plan, ` : ''}signed in with Claude Code`});
    } catch {
        // Not signed in to Claude Code.
    }
    if (GLib.file_test(GLib.build_filenamev([home, '.codex', 'sessions']), GLib.FileTest.IS_DIR))
        providers.push({key: 'usage-codex', title: 'ChatGPT', subtitle: 'As Codex last saw it'});
    return providers;
}

/** A drop-down for a string key with `choices`: [[value, label], …]. */
function choiceRow(settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });
    const sync = () => {
        const index = choices.findIndex(([value]) => value === settings.get_string(key));
        row.selected = Math.max(0, index);
    };
    sync();
    const changed = settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        const value = choices[row.selected]?.[0];
        if (value !== undefined && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    row.connect('destroy', () => settings.disconnect(changed));
    return row;
}

function spinRow(settings, key, title, subtitle, min, max) {
    const row = Adw.SpinRow.new_with_range(min, max, 1);
    row.title = title;
    row.subtitle = subtitle;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** Asks, then clears everything but pinned items from the clipboard history. */
function confirmClear(window) {
    const dialog = new Adw.MessageDialog({
        transient_for: window,
        heading: 'Clear clipboard history?',
        body: 'Everything you copied is removed. Pinned items stay.',
    });
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('clear', 'Clear');
    dialog.set_response_appearance('clear', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.connect('response', (_dialog, response) => {
        if (response !== 'clear')
            return;
        Gio.DBus.session.call(DAEMON, DAEMON_PATH, CLIPBOARD_INTERFACE, 'Clear', null, null,
            Gio.DBusCallFlags.NONE, -1, null, null);
    });
    dialog.present();
}

/** Lists the ignored apps, each with a remove button, and a search to add one. */
function fillIgnoredApps(group, settings) {
    const key = 'clipboard-ignored-apps';
    const apps = Gio.AppInfo.get_all()
        .filter(app => app.should_show() && app.get_id())
        .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));
    let rows = [];

    const add = new Adw.ComboRow({
        title: 'Add an app',
        model: Gtk.StringList.new(['Choose…', ...apps.map(app => app.get_display_name())]),
        // Search needs to know what text to match.
        expression: new Gtk.PropertyExpression(Gtk.StringObject, null, 'string'),
        enable_search: true,
    });
    add.connect('notify::selected', () => {
        const app = apps[add.selected - 1];
        if (!app)
            return;
        const ids = settings.get_strv(key);
        if (!ids.includes(app.get_id()))
            settings.set_strv(key, [...ids, app.get_id()]);
        add.selected = 0;
    });

    const refresh = () => {
        rows.forEach(row => group.remove(row));
        // Only apps on this computer; the built-in list names others too.
        rows = settings.get_strv(key).map(id => [id, DesktopAppInfo.new(id)]).filter(([, app]) => app).map(([id, app]) => {
            const row = new Adw.ActionRow({title: app.get_display_name()});
            if (app.get_icon())
                row.add_prefix(new Gtk.Image({gicon: app.get_icon(), pixel_size: 24}));
            const remove = new Gtk.Button({icon_name: 'list-remove-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
            remove.set_tooltip_text('Keep copies from this app again');
            remove.connect('clicked', () => settings.set_strv(key, settings.get_strv(key).filter(other => other !== id)));
            row.add_suffix(remove);
            return row;
        });
        // Keep "Add an app" last.
        group.remove(add);
        rows.forEach(row => group.add(row));
        group.add(add);
    };
    group.add(add);
    const changed = settings.connect(`changed::${key}`, refresh);
    group.connect('destroy', () => settings.disconnect(changed));
    refresh();
}
