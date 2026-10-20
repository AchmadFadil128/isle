#!/usr/bin/env bash
# Builds Isle (or takes the programs a release package ships ready-built, in
# bin/) and installs it for the current user (no root needed):
#   ~/.local/bin                              isled, isle-shelf
#   ~/.local/share/gnome-shell/extensions     the GNOME Shell extension
#   ~/.local/share/dbus-1/services            D-Bus activation files
#   ~/.config/systemd/user                    isled.service
#   ~/.local/share/fonts/isle                 Inter, the island's typeface
set -euo pipefail

cd "$(dirname "$0")"
UUID="isle@zickrian.github.io"
# The extension's id before 0.1.0; an install under it is replaced.
OLD_UUID="isle@isle.github.io"
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

SHELF=0
if [ -x bin/isled ]; then
    # A release package: the programs come built.
    BUILT=bin
    [ -x bin/isle-shelf ] && SHELF=1
else
    BUILT=target/release
    step "Building isled"
    cargo build --release -p isle-daemon
    if pkg-config --exists gtk4; then
        step "Building isle-shelf"
        cargo build --release -p isle-shelf
        SHELF=1
    else
        echo "GTK 4 development files not found: skipping isle-shelf (drag and drop on the shelf)."
        echo "Install them with 'sudo apt install libgtk-4-dev' and run this script again."
    fi
fi

step "Installing binaries to $BINDIR"
install -Dm755 "$BUILT/isled" "$BINDIR/isled"
if [ "$SHELF" = 1 ]; then
    install -Dm755 "$BUILT/isle-shelf" "$BINDIR/isle-shelf"
    # A running helper is the old version; it starts again, updated, when needed.
    pkill -x isle-shelf 2>/dev/null || true
fi

step "Installing services"
# The D-Bus names before 0.1.0.
rm -f "$DATA/dbus-1/services/io.github.isle.Daemon.service" \
      "$DATA/dbus-1/services/io.github.isle.ShelfWindow.service"
install_service io.github.zickrian.isle.Daemon.service "$DATA/dbus-1/services"
# Also for a helper from an earlier install, when it was not rebuilt now.
if [ "$SHELF" = 1 ] || [ -x "$BINDIR/isle-shelf" ]; then
    install_service io.github.zickrian.isle.ShelfWindow.service "$DATA/dbus-1/services"
fi
install_service isled.service "$CONFIG/systemd/user"
install -Dm644 README.md "$DATA/doc/isle/README.md"

step "Installing the Inter font"
# The island is set in SF Pro where installed, else Inter, its open cousin.
install -Dm644 data/fonts/InterVariable.ttf "$DATA/fonts/isle/InterVariable.ttf"
install -Dm644 data/fonts/Inter-LICENSE.txt "$DATA/fonts/isle/Inter-LICENSE.txt"
fc-cache "$DATA/fonts/isle" >/dev/null 2>&1 || true

step "Installing the GNOME Shell extension"
# Replace an install under the old id, so two islands never run at once.
# Settings carry over: the settings schema did not change.
if [ -d "$DATA/gnome-shell/extensions/$OLD_UUID" ]; then
    gnome-extensions disable "$OLD_UUID" 2>/dev/null || true
    rm -rf "$DATA/gnome-shell/extensions/$OLD_UUID"
    current=$(gsettings get org.gnome.shell enabled-extensions)
    updated=$(printf '%s' "$current" | sed -e "s/, '$OLD_UUID'//" -e "s/'$OLD_UUID', //" -e "s/\['$OLD_UUID'\]/@as []/")
    [ "$updated" != "$current" ] && gsettings set org.gnome.shell enabled-extensions "$updated"
    echo "Replaced the install under the old id $OLD_UUID."
fi
DEST="$DATA/gnome-shell/extensions/$UUID"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r gnome-extension/. "$DEST/"
glib-compile-schemas "$DEST/schemas"

step "Starting isled"
# Let the session bus see the new activation files.
busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus ReloadConfig >/dev/null 2>&1 || true
# Without a user service manager (over SSH, say) isled still starts on its
# own when the extension first calls it.
if systemctl --user daemon-reload 2>/dev/null; then
    systemctl --user enable isled.service >/dev/null 2>&1
    systemctl --user restart isled.service
fi

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
# Isle's look is the same everywhere: a slim glass top bar with the island
# hanging from the top of the screen like a MacBook's notch.
gsettings --schemadir "$DEST/schemas" set org.gnome.shell.extensions.isle top-bar-style glass
gsettings --schemadir "$DEST/schemas" set org.gnome.shell.extensions.isle compact-top-bar true
gsettings --schemadir "$DEST/schemas" set org.gnome.shell.extensions.isle island-in-top-bar true

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
# Blur my Shell's top bar blur also darkens it, and the glass bar has no
# colour of its own.
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
