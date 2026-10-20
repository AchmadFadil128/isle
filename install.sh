#!/usr/bin/env bash
# Builds Pulau and installs it for the current user (no root needed):
#   ~/.local/bin                              pulaud, pulau-shelf
#   ~/.local/share/gnome-shell/extensions     the GNOME Shell extension
#   ~/.local/share/dbus-1/services            D-Bus activation files
#   ~/.config/systemd/user                    pulaud.service
set -euo pipefail

cd "$(dirname "$0")"
UUID="pulau@pulau.github.io"
BINDIR="$HOME/.local/bin"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"

step() { printf '\033[1m==> %s\033[0m\n' "$*"; }

step "Building pulaud"
cargo build --release -p pulau-daemon

SHELF=0
if pkg-config --exists gtk4; then
    step "Building pulau-shelf"
    cargo build --release -p pulau-shelf
    SHELF=1
else
    echo "GTK 4 development files not found: skipping pulau-shelf (drag and drop on the shelf)."
    echo "Install them with 'sudo apt install libgtk-4-dev' and run this script again."
fi

step "Installing binaries to $BINDIR"
install -Dm755 target/release/pulaud "$BINDIR/pulaud"
if [ "$SHELF" = 1 ]; then
    install -Dm755 target/release/pulau-shelf "$BINDIR/pulau-shelf"
fi

step "Installing services"
sed "s|@BINDIR@|$BINDIR|" data/io.github.pulau.Daemon.service > /tmp/pulau-$$.service
install -Dm644 /tmp/pulau-$$.service "$DATA/dbus-1/services/io.github.pulau.Daemon.service"
if [ "$SHELF" = 1 ]; then
    sed "s|@BINDIR@|$BINDIR|" data/io.github.pulau.ShelfWindow.service > /tmp/pulau-$$.service
    install -Dm644 /tmp/pulau-$$.service "$DATA/dbus-1/services/io.github.pulau.ShelfWindow.service"
fi
sed "s|@BINDIR@|$BINDIR|" data/pulaud.service > /tmp/pulau-$$.service
install -Dm644 /tmp/pulau-$$.service "$CONFIG/systemd/user/pulaud.service"
rm -f /tmp/pulau-$$.service
install -Dm644 README.md "$DATA/doc/pulau/README.md"

step "Installing the GNOME Shell extension"
DEST="$DATA/gnome-shell/extensions/$UUID"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "gnome-extension/$UUID/." "$DEST/"
glib-compile-schemas "$DEST/schemas"

step "Starting pulaud"
# Let the session bus see the new activation files.
busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus ReloadConfig >/dev/null 2>&1 || true
systemctl --user daemon-reload
systemctl --user enable pulaud.service >/dev/null 2>&1
systemctl --user restart pulaud.service

# A running GNOME Shell on Wayland does not know a new extension until the
# next login, so add it to the enabled list directly when enabling fails.
if ! gnome-extensions enable "$UUID" 2>/dev/null; then
    current=$(gsettings get org.gnome.shell enabled-extensions)
    case "$current" in
        *"'$UUID'"*) ;;
        "@as []") gsettings set org.gnome.shell enabled-extensions "['$UUID']" ;;
        *) gsettings set org.gnome.shell enabled-extensions "${current%]}, '$UUID']" ;;
    esac
fi

step "Done"
if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
    echo "Log out and back in once so GNOME Shell loads the extension."
else
    echo "Press Alt+F2, type 'r' and Enter to restart GNOME Shell."
fi
