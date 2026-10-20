#!/usr/bin/env bash
# Builds Isle and installs it for the current user (no root needed):
#   ~/.local/bin                              isled, isle-shelf
#   ~/.local/share/gnome-shell/extensions     the GNOME Shell extension
#   ~/.local/share/dbus-1/services            D-Bus activation files
#   ~/.config/systemd/user                    isled.service
set -euo pipefail

cd "$(dirname "$0")"
UUID="isle@isle.github.io"
BINDIR="$HOME/.local/bin"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

step() { printf '\033[1m==> %s\033[0m\n' "$*"; }

# Installs a service file from data/, pointing it at the installed binaries.
install_service() {
    sed "s|@BINDIR@|$BINDIR|" "data/$1" > "$WORK/$1"
    install -Dm644 "$WORK/$1" "$2/$1"
}

step "Building isled"
cargo build --release -p isle-daemon

SHELF=0
if pkg-config --exists gtk4; then
    step "Building isle-shelf"
    cargo build --release -p isle-shelf
    SHELF=1
else
    echo "GTK 4 development files not found: skipping isle-shelf (drag and drop on the shelf)."
    echo "Install them with 'sudo apt install libgtk-4-dev' and run this script again."
fi

step "Installing binaries to $BINDIR"
install -Dm755 target/release/isled "$BINDIR/isled"
if [ "$SHELF" = 1 ]; then
    install -Dm755 target/release/isle-shelf "$BINDIR/isle-shelf"
fi

step "Installing services"
install_service io.github.isle.Daemon.service "$DATA/dbus-1/services"
if [ "$SHELF" = 1 ]; then
    install_service io.github.isle.ShelfWindow.service "$DATA/dbus-1/services"
fi
install_service isled.service "$CONFIG/systemd/user"
install -Dm644 README.md "$DATA/doc/isle/README.md"

step "Installing the GNOME Shell extension"
DEST="$DATA/gnome-shell/extensions/$UUID"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r gnome-extension/. "$DEST/"
glib-compile-schemas "$DEST/schemas"

step "Starting isled"
# Let the session bus see the new activation files.
busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus ReloadConfig >/dev/null 2>&1 || true
systemctl --user daemon-reload
systemctl --user enable isled.service >/dev/null 2>&1
systemctl --user restart isled.service

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

step "Setting up the top bar"
# Isle's look is the same everywhere: a slim black top bar the island
# blends into.
gsettings --schemadir "$DEST/schemas" set org.gnome.shell.extensions.isle black-top-bar true
gsettings --schemadir "$DEST/schemas" set org.gnome.shell.extensions.isle compact-top-bar true

# Settings of another extension, from its user or system install.
other_settings() {
    local uuid="$1"; shift
    local dir
    for dir in "$DATA/gnome-shell/extensions/$uuid/schemas" "/usr/share/gnome-shell/extensions/$uuid/schemas"; do
        if [ -d "$dir" ]; then
            gsettings --schemadir "$dir" "$@" 2>/dev/null
            return
        fi
    done
    return 1
}
# Blur my Shell's top bar blur would only be drawn, unseen, under the
# black bar.
if [ "$(other_settings blur-my-shell@aunetx get org.gnome.shell.extensions.blur-my-shell.panel blur)" = "true" ]; then
    other_settings blur-my-shell@aunetx set org.gnome.shell.extensions.blur-my-shell.panel blur false
    echo "Turned off Blur my Shell's top bar blur; the rest of its blur is unchanged."
fi
# Extensions that take the same place in the top bar.
for uuid in dynamic-island@bjagetic hidetopbar@mathieu.bidon.ca; do
    if gnome-extensions info "$uuid" 2>/dev/null | grep -q "Enabled: Yes"; then
        gnome-extensions disable "$uuid"
        echo "Turned off $uuid, which would cover the island."
    fi
done

step "Done"
if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
    echo "Log out and back in once so GNOME Shell loads the extension."
else
    echo "Press Alt+F2, type 'r' and Enter to restart GNOME Shell."
fi
