# Installing Isle

Three steps and an optional fourth: about a minute, no root and nothing to compile.

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
computers (Raspberry Pi and other ARM machines), for which there are no ready-built
programs.

## 2. Install

Paste this into a terminal and press Enter:

```sh
curl -fsSL https://raw.githubusercontent.com/zickrian/isle/main/get.sh | bash
```

It downloads the latest release, checks its checksum and installs it for
your user. It ends with `==> Isle 0.x.y is installed`. Run it as yourself,
**without sudo**: everything goes in your own home folder, and it refuses to
run as root. On a GNOME Shell version Isle was not made for it stops before
changing anything.

## 3. Log out and back in

GNOME Shell on Wayland only loads a new extension at login, so log out and
back in once. (On GNOME 46 to 48 with an X11 session you can instead press
Alt+F2, type `r` and press Enter.)

The island now sits in the middle of the top bar, in place of the clock.
Rest the pointer on it to open it.

## 4. The voice assistant (optional)

Everything else works without it. To ask the island things out loud with
Super+I:

1. Install and sign in to one of Claude Code, Codex or Antigravity (the
   [README](../README.md#voice-assistant) says how; each uses your own plan).
2. Set up speech recognition once, in a terminal. It downloads the speech
   model picked in Settings → Assistant (`small`, 265 MB, by default; or name
   one: `isle-setup-voice base`) and needs nothing else installed. A graphics
   card is used through Vulkan when there is one, else the processor:

   ```sh
   isle-setup-voice
   ```

   Set up with an older Isle, speech recognition used a Python environment
   of up to 3 GB; updating Isle with the installer downloads the new model
   and deletes it by itself (`isle-setup-voice --remove-old` does the same by
   hand). In the assistant, a **Set up** button opens a terminal that runs
   `isle-setup-voice` for you.

3. Pick the AI in Isle's Settings → Assistant, or leave it on Automatic,
   and press Super+I. An AI installed later is found by itself.

`isle-setup-voice` ends by checking what Isle itself finds; run the same check
any time:

```sh
isled --doctor
```

It lists speech recognition (its models, and the GPU or processor it runs
on) and each AI, where it is installed and whether
you are signed in. Isle finds AIs installed with npm (also a prefix of your
own), nvm, volta, fnm, pnpm, bun, Homebrew, mise, asdf, Nix or their own
installers, and takes what your login shell sets for them
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, an API key, a proxy).

## Updating

Run the same command again; it installs the newest release over the old one
and keeps your tasks, calendar events, clipboard history and settings (the
top bar look you picked included). Log out and back in afterwards.

```sh
curl -fsSL https://raw.githubusercontent.com/zickrian/isle/main/get.sh | bash
```

To install a particular version instead, put `ISLE_VERSION` before `bash`:
`… | ISLE_VERSION=0.1.2 bash`.

## Uninstalling

```sh
isle-uninstall
```

This removes the extension, its programs, its service and its font, the
voice assistant's speech recognition and its models, Isle's caches, and a
battery charge limit Isle set (asking for your password), and takes Isle's
hooks out of Claude Code's and Codex's settings. Your tasks,
calendar events, clipboard history and timer settings stay in
`~/.local/share/isle`; delete it too to remove everything.

## Without internet on the computer

Download `isle-<version>-x86_64-linux.tar.gz` from
[Releases](https://github.com/zickrian/isle/releases) on another computer,
copy it over, then:

```sh
tar -xzf isle-*-x86_64-linux.tar.gz
cd isle-*-x86_64-linux
./install.sh
```

## Other ways to install

### Ubuntu and Debian (.deb), Fedora (.rpm)

Each [release](https://github.com/zickrian/isle/releases) also has
system-wide packages, installed for every user of the computer with the
system's package manager (so they update and uninstall with it):

```sh
sudo apt install ./isle_1.0.0_amd64.deb         # Ubuntu 24.04 and newer, Debian 13
sudo dnf install ./isle-1.0.0-1.x86_64.rpm      # Fedora 40 and newer
```

They put the programs in `/usr/bin`, the extension in
`/usr/share/gnome-shell/extensions`, and the rest where the system expects
it. GNOME turns extensions on per user, so each user then runs this once and
logs out and back in:

```sh
gnome-extensions enable isle@zickrian.github.io
```

`isled` starts on its own when the extension first calls it. The voice
assistant is set up per user as above, with `isle-setup-voice`.

### Arch Linux

[`packaging/aur`](../packaging/aur) has a `PKGBUILD` for `isle-bin`, made
from the release tarball. In that folder:

```sh
makepkg -si
```

### Both a package and the one-line install

A copy installed with `get.sh`, in your home folder, takes precedence for
you over a system-wide package: GNOME Shell, D-Bus and systemd all look in
your home folder first. Run `isle-uninstall` to remove your own copy; the
package's then takes over, with your settings and data kept. Remove the
package itself with `sudo apt remove isle`, `sudo dnf remove isle` or
`sudo pacman -R isle-bin`.

### Checking a download

Release files are built by GitHub Actions from the tagged source, with a
build provenance attestation. With the [GitHub CLI](https://cli.github.com):

```sh
gh attestation verify isle-1.0.0-x86_64-linux.tar.gz --repo zickrian/isle
```

`get.sh` checks each download against its `.sha256` already.

## What the installer changes

Everything goes in your home folder:

| Where | What |
|---|---|
| `~/.local/share/gnome-shell/extensions/isle@zickrian.github.io` | The GNOME Shell extension |
| `~/.local/bin` | `isled` (the background service), `isle-shelf` (drag and drop), `isle-whisper` (speech recognition), `isle-uninstall`, `isle-setup-voice`, `isle-charge-limit` |
| `~/.config/systemd/user`, `~/.local/share/dbus-1/services` | Starting `isled` with your session |
| `~/.local/share/fonts/isle` | Inter, the island's typeface |
| `~/.local/share/isle` | Your data, and the speech models `isle-setup-voice` downloads (`models`) |
| `~/.local/share/doc/isle` | This README |

Once running, Isle adds its hooks to Claude Code's `~/.claude/settings.json`
and Codex's `~/.codex/hooks.json` when it finds them, so they ask you on
the island (Codex asks once, at its next start, to trust them); turning
them off in Settings → AI Usage → AI Agents, or uninstalling, takes them
out. Commands you run from the assistant keep their logs in
`~/.cache/isle/runs` until they end.

On a first install only, it sets Isle's look (a slim glass top bar with the
island in it); updates leave it as you have it. It never changes other
extensions: when one would fight with the island (Blur my Shell's top bar
blur, or an extension that takes the same place in the top bar, such as Hide
Top Bar), it ends with a recommendation and the command to turn that off. If
GNOME's extensions were switched off altogether (the Extensions app's main
switch), it switches them on.

## If something goes wrong

**The island does not appear.** Log out and back in once more, then check:

```sh
gnome-extensions info isle@zickrian.github.io   # State: ACTIVE (or ENABLED)
```

If it says `ERROR` or `OUT OF DATE`, your GNOME Shell version is outside 46
to 51.

**Music does not show.** Check the background service:
`systemctl --user status isled`.

**The voice assistant does not answer.** Run `isled --doctor`: it says what
is missing (speech recognition, an AI, or its sign-in) and what to run.

**Anything else.** GNOME Shell's log shows extension errors:
`journalctl -b -o cat /usr/bin/gnome-shell | grep -i isle`. Please
[open an issue](https://github.com/zickrian/isle/issues) with what it says
and the output of `gnome-shell --version`.
