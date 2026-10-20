#!/usr/bin/env bash
# Removes everything install.sh put in place. Your shelf, clipboard history,
# tasks and timer settings in ~/.local/share/isle are kept; delete that
# folder to remove them.
set -uo pipefail

UUID="isle@zickrian.github.io"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"

gnome-extensions disable "$UUID" 2>/dev/null
# Also drop it from the enabled list, in case GNOME Shell never loaded it.
current=$(gsettings get org.gnome.shell enabled-extensions)
updated=$(printf '%s' "$current" | sed -e "s/, '$UUID'//" -e "s/'$UUID', //" -e "s/\['$UUID'\]/@as []/")
[ "$updated" != "$current" ] && gsettings set org.gnome.shell enabled-extensions "$updated"
systemctl --user disable --now isled.service 2>/dev/null
pkill -x isle-shelf 2>/dev/null

rm -rf "$DATA/gnome-shell/extensions/$UUID" "$DATA/doc/isle" "$DATA/fonts/isle"
fc-cache "$DATA/fonts" >/dev/null 2>&1
rm -f "$HOME/.local/bin/isled" "$HOME/.local/bin/isle-shelf" \
      "$DATA/dbus-1/services/io.github.isle.Daemon.service" \
      "$DATA/dbus-1/services/io.github.isle.ShelfWindow.service" \
      "$CONFIG/systemd/user/isled.service"
systemctl --user daemon-reload
echo "Isle has been removed."
