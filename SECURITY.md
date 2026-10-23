# Security policy

## Supported versions

Security fixes go into the latest release. Please update to it before
reporting.

| Version | Supported |
|---|---|
| 0.9.x | Yes |
| 0.8.x and older | No |

## Reporting a vulnerability

Please do not report security problems in public issues.

Report them privately instead, through **Security → Report a vulnerability**
on this repository, or by contacting the maintainer,
[@zickrian](https://github.com/zickrian), through the contact details on that
GitHub profile.

Include what you found, how to reproduce it, and what an attacker could do
with it. You will get a reply within 7 days. Once a fix is released, you are
credited in the changelog unless you would rather not be.

## Verifying a release

Each release's tarball, `.deb` and `.rpm` are built by GitHub Actions from
the tagged source and carry a build provenance attestation. With the
[GitHub CLI](https://cli.github.com):

```sh
gh attestation verify isle-0.9.0-x86_64-linux.tar.gz --repo zickrian/isle
```

`get.sh` also checks each download against the release's `.sha256`.

## What leaves your computer

Isle runs as your user, with no server of its own and no telemetry. It
connects to the network only for these:

| What | Where to | What is sent |
|---|---|---|
| Synced lyrics | [LRCLIB](https://lrclib.net) (`lrclib.net/api`) | The playing song's title, artist, album and length, once per song (then cached) |
| Cover art | The address the music player gives for the song's cover | A plain download of that picture, once per song (then cached) |
| Claude plan usage | `api.anthropic.com/api/oauth/usage` | Claude Code's own sign-in token, read from Claude Code's credentials; Isle never signs in or refreshes it. Off when AI usage is turned off |
| Voice assistant | The AI command-line app you picked (Claude Code, Codex or Antigravity), which sends it to its own service under your plan | The text of your request (speech is turned into text on this computer), the context it needs (time, open apps and windows, reminders and events) and, only if you allow it, the selected text or your notifications |
| Web search by the assistant | Whatever the AI's own web search and page reading reach | Search words and page addresses the AI chooses for your request |
| Song check | `open.spotify.com/oembed` | A Spotify link the AI suggested, to check it exists before playing it |
| New versions | `api.github.com` (Isle's latest release) | A plain request, at most once a day; off when New versions is turned off in Settings |
| Speech model | `huggingface.co` (the official whisper.cpp and Silero files) | A plain download, only when you run `isle-setup-voice` (or press Set up); each file's SHA-256 is checked |

ChatGPT plan usage is read from Codex's own logs on this computer, with no
network at all.

## What stays on your computer

- The clipboard history, shelf, reminders, calendar events you add in Isle,
  timer settings and the assistant's chats, in `~/.local/share/isle`
  (readable by you only). The assistant's chats are deleted at midnight.
- Caches of covers and lyrics, in `~/.cache/isle`.
- Your voice: speech is recognised by whisper.cpp (isle-whisper) on this computer, and
  the recording is never stored or sent.
- The call preview: GNOME Shell draws it from the call's window as it is on
  screen; nothing is recorded, and it hides while you share your screen.
- Meeting links: read from the event in your desktop calendars (Evolution
  Data Server) on this computer, and opened in your browser only when you
  click Join.
- AI agent alerts, only once you turn them on: Isle adds its hook to Claude
  Code's `~/.claude/settings.json` or Codex's `~/.codex/config.toml`,
  keeping a copy of the file as it was (`settings.json.isle-backup`) the
  first time. The hook runs `isled --agent-hook`, which passes the event
  (the project's folder name and the AI's short message) to the island over
  the session bus and exits; nothing is sent anywhere. Turning the switch
  off, or uninstalling Isle, removes Isle's entry and leaves the rest of
  the file as it is.

## Clipboard history

The history keeps text, links, images and files you copy, on this computer
only, and can be turned off in Settings. Copies marked as secrets by password
managers (`x-kde-passwordManagerHint`), and every copy from the apps on the
ignore list (KeePassXC, Bitwarden, 1Password, Secrets, Seahorse, Proton Pass
by default; editable in Settings), are never kept. Clearing the history
deletes its files.

## The voice assistant's safety model

- The AI only answers. It cannot run commands or change files itself: Isle
  runs its actions, and only those it knows (music, apps and windows, files,
  reminders and events, a few system settings, writing text where your
  cursor is).
- Each AI is started with only web search and reading pages: Claude Code with
  just its web tools, Codex with its shell, file, browser and computer-use
  tools off, and agy in its own home folder behind a hook that refuses
  anything else.
- Files: Isle searches by name for it, within your home folder and removable
  drives, and reads only small plain-text files you ask about. It skips
  hidden folders, never searches those that hold keys or passwords (`.ssh`,
  `.gnupg`, keyrings), judges a link by where it really points (a link to
  `~/.ssh` is `~/.ssh`) and does not follow links while searching. It opens
  documents and media, never programs, scripts or anything executable.
- Terminal commands (a battery charge limit, installing an app) are typed
  into a terminal and run only when you press Enter.
- Text from other apps (your selection, notifications, window titles) is
  passed to the AI as data, never as instructions.

## Scope

Areas where a report is especially welcome:

- `isled`'s D-Bus API on the session bus (`docs/dbus-api.md`): input that
  crashes it, or reads or changes data it should not.
- The voice assistant: a way for a request, a web page, a file, a
  notification or other text to make Isle run something you did not ask for,
  read hidden or private files, or run a terminal command without Enter.
- The clipboard history in `~/.local/share/isle`: copies kept from apps on
  the ignore list or marked as secrets, or files readable by other users.
- Network requests: anything sent beyond what the table above lists.
- `isle-shelf`: files it opens or exposes that the user did not drop on it.
- The installers and packages (`get.sh`, `install.sh`, the `.deb`, `.rpm`
  and AUR package): files written outside the places they document.
