# Pulau

A dynamic island for Linux. Pulau ("island" in Indonesian) turns the centre of
the GNOME top bar into a black island that grows and shrinks with spring
physics to show what is going on:

- **Music** from any MPRIS player (Spotify, Firefox, Chrome, mpv…) with cover
  art, a scrubber and controls, plus **synced lyrics** from
  [LRCLIB](https://lrclib.net); click a line to jump to it.
- **Focus timer** (Pomodoro) with a progress ring that stays visible in the
  closed island.
- **Tasks** with quick-add: `Call mum @18:30`, `Stretch in 20m`, `Report @3pm`.
- **File shelf**: drop files on the island, drag them out later.
- **Notifications** from GNOME shown in the island, a list to catch up on,
  and **Do Not Disturb** right there.
- **Alerts**: charging, low battery, Wi-Fi, Bluetooth earbuds with their
  battery level, volume and brightness, Caps Lock, keyboard layout, a new song.
- **Sleepy eyes** when you step away.

Hover the island to open it; scroll or click the dots to change page.
Middle-click plays or pauses; right-click opens GNOME's calendar.

## Design

```
┌──────────────── pulaud (Rust) ──────────────────┐
│ MPRIS · lyrics · timer · tasks · shelf          │
│ UPower · NetworkManager · BlueZ                 │
│           exposed on D-Bus (zbus)               │
└───────────────────────┬─────────────────────────┘
          ┌─────────────┴──────────────┐
  GNOME Shell extension (JS)     pulau-shelf (Rust, GTK 4)
  draws the island and its       drag-and-drop window laid
  animations, nothing else       over the shelf page
```

The extension only draws; everything else is in Rust and talks to it over
D-Bus. GNOME Shell extensions must be JavaScript, and on Wayland only the
shell can draw into the top bar, so this split keeps as much as possible in
Rust while the island still blends into the bar.

| Crate / folder | What it is |
|---|---|
| `crates/pulau-core` | Platform-independent logic: springs, LRC parsing, track-title clean-up, Pomodoro, tasks, shelf. Unit tested. |
| `crates/pulau-daemon` | `pulaud`, the D-Bus service. See [`docs/dbus-api.md`](docs/dbus-api.md). |
| `crates/pulau-shelf` | `pulau-shelf`, the shelf's drag-and-drop window. |
| `crates/pulau-island` | Experimental GTK 4 island for desktops with wlr-layer-shell (KDE Plasma, Hyprland, Sway…) or X11. |
| `gnome-extension/pulau@pulau.github.io` | The GNOME Shell extension. |

### Staying light

The island is meant to run all day, so nothing polls:

- Animations are driven by the display's frame clock only while a spring is
  moving, and stop as soon as it settles.
- The clock wakes once a minute; the timer ring every few seconds; lyrics
  exactly when the next line starts. Pages only tick while they are open.
- `pulaud` sleeps until D-Bus tells it something changed. Lyrics and cover
  art are fetched once and cached in `~/.cache/pulau`.

## Requirements

- GNOME Shell 46 (Ubuntu 24.04 and similar)
- Rust 1.85 or newer
- For the shelf's drag and drop: GTK 4 development files
  (`sudo apt install libgtk-4-dev`). Without them the shelf is read-only.

## Install

```sh
./install.sh
```

This builds everything and installs it for your user only (no root): binaries
in `~/.local/bin`, the extension, a systemd user service for `pulaud`, and
D-Bus activation files. On Wayland, log out and back in once so GNOME Shell
loads the extension. Settings are in the Extensions app → Pulau.

`./uninstall.sh` removes it again. Your shelf, tasks and timer settings stay in
`~/.local/share/pulau` until you delete that folder.

## Development

```sh
cargo test                     # core logic
cargo clippy --all-targets     # lint the daemon and core
cargo build -p pulau-shelf     # needs GTK 4 development files
journalctl --user -u pulaud -f # daemon logs
journalctl -f /usr/bin/gnome-shell | grep -i pulau   # extension logs
```

To try the extension without logging out, run a nested shell:
`dbus-run-session -- gnome-shell --nested --wayland`.

## Notes

- The top bar is painted black so the island blends into it (turn this off in
  the settings). If you use Blur my Shell, you can switch off its panel blur,
  since it is hidden under the black bar anyway.
- Lyrics come from LRCLIB, a free community database; songs it does not know
  show "No lyrics found".
