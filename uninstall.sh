#!/usr/bin/env bash
# Removes everything install.sh and isle-setup-voice put in place. Your shelf, clipboard history,
# tasks and timer settings in ~/.local/share/isle are kept; delete that folder to remove them.
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
# The voice assistant's speech recognition (up to 2 GB with CUDA), Isle's caches and its AIs' own homes.
rm -rf "$DATA/isle/voice-venv" "$DATA/isle/isle-whisper.py" "$DATA/isle/assistant" "$DATA/isle/codex" \
       "$DATA/isle/agy" "${XDG_CACHE_HOME:-$HOME/.cache}/isle" "${XDG_RUNTIME_DIR:-/nonexistent}/isle-covers"
# The battery charge limit, set with isle-charge-limit, would outlive Isle: lifted (asks for the password).
if [ -e /etc/systemd/system/isle-charge-limit.service ]; then
    echo "Lifting the battery charge limit Isle set (sudo asks for your password)."
    sudo systemctl disable --now isle-charge-limit.service 2>/dev/null
    sudo rm -f /etc/systemd/system/isle-charge-limit.service
    for file in /sys/class/power_supply/BAT*/charge_control_end_threshold; do
        [ -e "$file" ] && echo 100 | sudo tee "$file" >/dev/null
    done
fi
rm -f "$HOME/.local/bin/isled" "$HOME/.local/bin/isle-shelf" "$HOME/.local/bin/isle-charge-limit" \
      "$HOME/.local/bin/isle-setup-voice" "$HOME/.local/bin/isle-uninstall" \
      "$DATA/dbus-1/services/io.github.zickrian.isle.Daemon.service" \
      "$DATA/dbus-1/services/io.github.zickrian.isle.ShelfWindow.service" \
      "$DATA/dbus-1/services/io.github.isle.Daemon.service" \
      "$DATA/dbus-1/services/io.github.isle.ShelfWindow.service" \
      "$CONFIG/systemd/user/isled.service"
systemctl --user daemon-reload 2>/dev/null
echo "Isle has been removed. The speech model it downloaded stays in ~/.cache/huggingface (faster-whisper-*); delete it to free its space."
