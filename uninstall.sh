#!/usr/bin/env bash
# Removes everything install.sh put in place. Your shelf, tasks and timer
# settings in ~/.local/share/pulau are kept; delete that folder to remove them.
set -uo pipefail

UUID="pulau@pulau.github.io"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"

gnome-extensions disable "$UUID" 2>/dev/null
systemctl --user disable --now pulaud.service 2>/dev/null
pkill -x pulau-shelf 2>/dev/null

rm -rf "$DATA/gnome-shell/extensions/$UUID" "$DATA/doc/pulau"
rm -f "$HOME/.local/bin/pulaud" "$HOME/.local/bin/pulau-shelf" \
      "$DATA/dbus-1/services/io.github.pulau.Daemon.service" \
      "$DATA/dbus-1/services/io.github.pulau.ShelfWindow.service" \
      "$CONFIG/systemd/user/pulaud.service"
systemctl --user daemon-reload
echo "Pulau has been removed."
