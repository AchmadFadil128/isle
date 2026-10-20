# Isle

A dynamic island for the GNOME desktop. Isle turns the centre of the top bar
into a black island that grows and shrinks with spring physics to show what is
going on, and opens on hover:

- **Music** from Spotify or YouTube in your browser (any MPRIS player works) with cover
  art, a scrubber and controls, plus **synced lyrics** from
  [LRCLIB](https://lrclib.net). Click a line to jump to it.
- **Notifications** from GNOME, shown in the island instead of banners, with a
  list to catch up on and **Do Not Disturb** right there.
- **Focus timer** (Pomodoro) with a ring that stays visible while closed,
  daily totals, and Do Not Disturb while you focus.
- **Tasks**: a plain list to write things down and tick them off, with a
  daily reset of finished ones.
- **Shelf** with two tabs:
  - **Clipboard history**: text, links, images and files you copy, as cards.
    Search, filter, click to copy, or press Super+V and Enter to paste. Pin
    what you paste often. Password managers are ignored, and nothing leaves
    your computer.
  - **Files**: drop up to 5 files on the island, then drag them into any app (a
    chat, an email, another folder).
- **Privacy dots** when the camera, microphone or screen sharing is in use,
  and a timer with a stop button while the screen records.
- **Volume and output** switching right from the music page.
- **Alerts**: charging, low battery, losing the connection, Bluetooth earbuds
  with their battery, volume and brightness, Caps Lock.

Hover to open; scroll, swipe or use the arrows to change page. Middle-click
plays or pauses, right-click brings the music player forward, and Super+V
opens the clipboard history.

## Requirements

- GNOME Shell 46 (e.g. Ubuntu 24.04)
- Rust 1.85 or newer (`rustup` or your distribution's packages)
- GTK 4 development files for the shelf's drag and drop:
  `sudo apt install libgtk-4-dev` (optional; without them the shelf is
  read-only)

## Install

```sh
git clone <repository-url> isle
cd isle
./install.sh
```

Everything is installed for your user only; no root is needed. On Wayland,
log out and back in once so GNOME Shell loads the extension. Settings are in
the Extensions app → Isle.

The installer gives every desktop the same look: a slim black top bar the
island blends into. It also turns off what would get in the way: Blur my
Shell's top bar blur (the rest of its blur stays) and other extensions that
take the same place in the top bar.

`./uninstall.sh` removes it again. Your tasks, shelf, clipboard history and
timer settings stay in `~/.local/share/isle` until you delete that folder.

## How it works

```
┌────────────────── isled (Rust) ──────────────────┐
│ MPRIS · lyrics · timer · tasks · shelf           │
│ UPower · NetworkManager · BlueZ                  │
│            exposed on D-Bus (zbus)               │
└────────────────────────┬─────────────────────────┘
           ┌─────────────┴──────────────┐
  GNOME Shell extension (JS)      isle-shelf (Rust, GTK 4)
  draws the island and its        drag-and-drop window laid
  animations                      over the shelf page
```

GNOME Shell extensions must be written in JavaScript, and on Wayland only the
shell can draw into the top bar. So the extension only draws, and everything
else lives in Rust behind a D-Bus API.

Isle is built to run all day without being noticed:

- Nothing polls. Animations run on the display's frame clock only while a
  spring moves, and stop when it settles.
- The clock wakes once a minute, lyrics exactly when the next line starts,
  and pages only tick while they are open.
- `isled` sleeps until something changes (about 7 MB of memory). Lyrics and
  cover art are fetched once and cached in `~/.cache/isle`.

## Repository layout

| Path | Contents |
|---|---|
| `crates/isle-core` | Platform-independent logic: LRC parsing, track-title clean-up, Pomodoro, tasks, shelf, clipboard history. Unit tested. |
| `crates/isle-daemon` | `isled`, the D-Bus service. |
| `crates/isle-shelf` | `isle-shelf`, the shelf's drag-and-drop window. |
| `gnome-extension` | The GNOME Shell extension. |
| `data` | systemd and D-Bus activation files. |
| `docs/product-spec.md` | How the island looks and behaves: sizes, motion, flows, pages, alerts. |
| `docs/dbus-api.md` | The D-Bus interfaces of `isled` and `isle-shelf`. |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and ideas are welcome as
issues.

## Notes

- The top bar is painted black so the island blends into it, and stays black
  when other extensions restyle it; this can be turned off in the settings.
- Lyrics come from LRCLIB, a free community database; songs it does not know
  show "No lyrics found".

## License

Isle is free software under the [GNU General Public License v3.0 or later](LICENSE).
