// SPDX-License-Identifier: GPL-3.0-or-later

// Gio.DesktopAppInfo from wherever this GLib keeps it: GLib 2.86 (GNOME 49)
// moved it to GioUnix and warns on the old name, which is all GNOME 46 has.
// Shared by the extension and its preferences, so nothing from the shell here.

import Gio from 'gi://Gio';

let GioUnix = null;
try {
    ({default: GioUnix} = await import('gi://GioUnix?version=2.0'));
} catch {
    // Older GLib: the old name below is the only one.
}

export const DesktopAppInfo = GioUnix?.DesktopAppInfo ?? Gio.DesktopAppInfo;
