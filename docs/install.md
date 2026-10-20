# Installing Isle

Three steps, about a minute, no root and nothing to compile.

## 1. Check your desktop

Isle runs on **GNOME Shell 46 to 51** on a 64-bit Intel or AMD PC. Check
in a terminal:

```sh
gnome-shell --version   # GNOME Shell 46.x up to 51.x
uname -m                # x86_64
```

Each of these was installed with the command below and checked:

| GNOME Shell | Ubuntu | Fedora Workstation | Debian |
|---|---|---|---|
| 46 | 24.04 LTS | 40 | |
| 47 | 24.10 | 41 | |
| 48 | 25.04 | 42 | 13 |
| 49 | 25.10 | 43 | |
| 50 | 26.04 LTS | 44 | |
| 51 | 26.10 | 45 | |

Other systems with one of these GNOME Shell versions work the same way.
Other desktops (KDE Plasma, Cinnamon, XFCE, COSMIC, …) cannot load GNOME
Shell extensions, so Isle does not run there; nor does it run on ARM
computers (Raspberry Pi, Apple Silicon), for which there are no ready-built
programs.

## 2. Install

Paste this into a terminal and press Enter:

```sh
curl -fsSL https://raw.githubusercontent.com/zickrian/isle/main/get.sh | bash
```

It downloads the latest release, checks its checksum and installs it for
your user. It ends with `==> Done`.

## 3. Log out and back in

GNOME Shell on Wayland only loads a new extension at login, so log out and
back in once. (On GNOME 46 to 48 with an X11 session you can instead press
Alt+F2, type `r` and press Enter.)

The island now sits in the middle of the top bar, in place of the clock.
Hover it to open it.

## Updating

Run the same command again; it installs the newest release over the old one
and keeps your tasks, clipboard history and settings.

```sh
curl -fsSL https://raw.githubusercontent.com/zickrian/isle/main/get.sh | bash
```

To install a particular version instead, put `ISLE_VERSION` before `bash`:
`… | ISLE_VERSION=0.1.2 bash`.

## Uninstalling

```sh
isle-uninstall
```

This removes the extension, its programs, its service and its font. Your
tasks, clipboard history and timer settings stay in `~/.local/share/isle`;
delete that folder too to remove everything.

## Without internet on the computer

Download `isle-<version>-x86_64-linux.tar.gz` from
[Releases](https://github.com/zickrian/isle/releases) on another computer,
copy it over, then:

```sh
tar -xzf isle-*-x86_64-linux.tar.gz
cd isle-*-x86_64-linux
./install.sh
```

## What the installer changes

Everything goes in your home folder:

| Where | What |
|---|---|
| `~/.local/share/gnome-shell/extensions/isle@zickrian.github.io` | The GNOME Shell extension |
| `~/.local/bin` | `isled` (the background service), `isle-shelf` (drag and drop), `isle-uninstall` |
| `~/.config/systemd/user`, `~/.local/share/dbus-1/services` | Starting `isled` with your session |
| `~/.local/share/fonts/isle` | Inter, the island's typeface |

It also turns off what would fight with the island: Blur my Shell's top bar
blur (the rest of its blur stays) and extensions that take the same place in
the top bar.

## If something goes wrong

**The island does not appear.** Log out and back in once more, then check:

```sh
gnome-extensions info isle@zickrian.github.io   # State: ACTIVE (or ENABLED)
```

If it says `ERROR` or `OUT OF DATE`, your GNOME Shell version is outside 46
to 51.

**Music does not show.** Check the background service:
`systemctl --user status isled`.

**Anything else.** GNOME Shell's log shows extension errors:
`journalctl -b -o cat /usr/bin/gnome-shell | grep -i isle`. Please
[open an issue](https://github.com/zickrian/isle/issues) with what it says
and the output of `gnome-shell --version`.
