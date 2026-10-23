# isled D-Bus API

`isled` owns `io.github.zickrian.isle.Daemon` on the session bus and serves every
interface at `/io/github/zickrian/isle/Daemon`. State is exposed as read-only string
properties holding JSON, with `PropertiesChanged` emitted on every change.
Timestamps are milliseconds since the Unix epoch; durations are
milliseconds unless the name says `_us` (microseconds).

Methods that read what the user copied (`Clipboard1.GetText`), steer the
assistant (every `Assistant1` method) or change an AI's settings
(`Agents1.SetHooked`) answer GNOME Shell only, where the extension runs; any
other caller gets `org.freedesktop.DBus.Error.AccessDenied`.

`isled --version`, `isled --doctor` (what works: the service, speech
recognition, each AI's install and sign-in, and whether its alerts are on) and
`isled --report` (that, the versions and recent logs, for a bug report) print
and exit. `isled --unhook-all` takes Isle's alert hooks out of Claude Code's
and Codex's settings (`uninstall.sh` runs it), one line per AI. A second
`isled` started by hand exits at once ("already running") and leaves the
running one alone.

## io.github.zickrian.isle.Media1

The active MPRIS player: the one picked with `Choose` while it runs, else the one playing, else the one
that played last. Another player starting to play ends the pick.

| Member | Signature | |
|---|---|---|
| `PlayPause()`, `Next()`, `Previous()` | | Control the active player. |
| `SetPosition(x position_us)` | | Seek to an absolute position. |
| `Raise()` | | Bring the player's window to the front. |
| `Choose(s name)` | | Show and control the player `name` (from `Players`). |
| `SetLyrics(b enabled)` | | Look lyrics up online (LRCLIB), or not; off, `Lyrics` says `off`. The extension sends its setting whenever isled appears. |
| `NowPlaying` | `s` | `{available, identity, desktop_entry, status, title, artist, album, art_path, length_us, position_us, sampled_at_ms, rate, can_go_next, can_go_previous, can_play_pause, can_seek}` |
| `Lyrics` | `s` | `{track, status, lines: [{time_ms, text}]}`; `status` is `none`, `loading`, `synced`, `plain` (lines have `time_ms` -1), `instrumental`, `not_found`, `error` (LRCLIB could not be reached), `unavailable` (LRCLIB answered but is busy or failing) or `off` (turned off with `SetLyrics`); isled retries `error` and `unavailable` on its own. |
| `Players` | `s` | `[{name, identity, desktop_entry, playing, active}]`, sorted by name; empty unless two or more players run. |

The position is only sampled when something changes. While playing, the
current position is `position_us + (now - sampled_at_ms) * 1000 * rate`.

The control methods only fail when no player is running. They return
without waiting for the player, so a slow player cannot hold the daemon up;
if the player then rejects the command, isled only logs it.

## io.github.zickrian.isle.Pomodoro1

| Member | Signature | |
|---|---|---|
| `Start()` | | Start a focus session, or resume a paused phase. |
| `StartPhase(s phase)` | | Start `focus`, `short_break` or `long_break` right away (`idle` stops). |
| `Pause()`, `Stop()`, `Skip()` | | `Skip` ends the phase early without counting it. |
| `SetConfig(s json)` | | Replace the configuration (below). |
| `State` | `s` | `{phase, running, ends_at_ms, remaining_ms, duration_ms, completed_sessions, sessions_before_long_break, today_sessions, today_focus_ms}`; `phase` is `idle`, `focus`, `short_break` or `long_break`. |
| `Config` | `s` | `{focus_minutes, short_break_minutes, long_break_minutes, sessions_before_long_break, auto_start_breaks, auto_start_focus}` |
| `PhaseFinished(s finished, s next)` | signal | A phase ran out (not emitted for `Skip` or `Stop`). |

## io.github.zickrian.isle.Todo1

| Member | Signature | |
|---|---|---|
| `Add(s text) → t id` | | Adds a task; a blank title is refused. |
| `SetDone(t id, b done)`, `Rename(t id, s title)`, `Remove(t id)`, `ClearDone()` | | Finished tasks are cleared at midnight. |
| `Items` | `s` | `[{id, title, done, done_at_ms}]`; `done_at_ms` is when the task was ticked off, or null. |

## io.github.zickrian.isle.Calendar1

Isle's own calendar events, kept in `~/.local/share/isle/calendar.json`.
Times are local wall-clock times. (Events of the desktop's calendars come
from GNOME Shell, not from here.)

| Member | Signature | |
|---|---|---|
| `Add(s date, s text) → t id` | | Adds an event on `date` (`YYYY-MM-DD`) from a line of text, taking its time from it: `Dinner 8:00 pm`, `Standup 9:00-9:15`, `Gym at 7pm`; without a time it lasts all day. A date that does not exist, or no title left, is refused with `InvalidArgs`. |
| `Remove(t id)` | | |
| `MeetingLink(s source_uid, s event_uid) → s` | | The meeting link of a desktop calendar's event (the first two lines of the id GNOME Shell's calendar server gives it), or `""`. |
| `Events` | `s` | `[{id, title, date, start, end}]` by day and time; `start` and `end` are `HH:MM` or null (all day; no end given). Events over 400 days old are forgotten. |

`MeetingLink` reads the event from Evolution Data Server
(`org.gnome.evolution.dataserver.Calendar8`, else `Calendar7`:
`CalendarFactory.OpenCalendar`, then `Calendar.Open`, `GetObject(uid, "")` and
`Close`) and looks in its `X-GOOGLE-CONFERENCE`, `URL`, `LOCATION` and
`DESCRIPTION`, in that order, for the first `https://` link to Google Meet
(`meet.google.com`), Zoom (`zoom.us` or `*.zoom.us`, `/j/`, `/my/` or `/w/`),
Microsoft Teams (`teams.microsoft.com/l/meetup-join/` or `/meet/`,
`teams.live.com`) or Webex (`*.webex.com`). Answers are kept for six hours (at
most 256 events). Without EDS (not installed, masked or not answering within
five seconds) it is `""`; empty or over-long ids are refused with
`InvalidArgs`.

## io.github.zickrian.isle.Shelf1

| Member | Signature | |
|---|---|---|
| `Add(as uris)` | | Add local `file://` URIs (moved to the front if already there). The shelf holds 6 files: files that do not fit are refused with `LimitsExceeded`. Other URIs are skipped and reported with `InvalidArgs` once the rest are added. |
| `Remove(s uri)`, `Clear()` | | |
| `Refresh()` | | Drop items whose files no longer exist. |
| `Items` | `s` | `[{uri, name, added_at_ms}]`, newest first. |

## io.github.zickrian.isle.Clipboard1

Clipboard history. The extension watches the clipboard and reports each
copy; isled keeps the list in `~/.local/share/isle/clipboard.json` and
images in `~/.local/share/isle/clips` (`<hash>.png` as copied, plus a
`<hash>.thumb.png` that fits in 320×200). `app_id` is the desktop app id
of the app copied from, or `""`.

| Member | Signature | |
|---|---|---|
| `AddText(s text, s app_id) → t id` | | Copied text, at most 512 KiB and not blank. A lone `http://` or `https://` address is a `link`. |
| `AddImage(ay png, s app_id) → t id` | | A copied PNG image, at most 16 MiB. |
| `AddFiles(as uris, s app_id) → t id` | | Copied files; only `file://` URIs. |
| `GetText(t id) → s` | | The full content to copy back: the text, the URIs one per line, or the path of an image's PNG. GNOME Shell only. |
| `Touch(t id)` | | Move to the top, as copied again (e.g. from the history). |
| `SetPinned(t id, b pinned)` | | At most 10 items are pinned; pinning an eleventh fails with `LimitsExceeded`. |
| `Remove(t id)` | | |
| `Clear()` | | Remove every item that is not pinned. |
| `Items` | `s` | `[{id, kind, preview, uris, image, thumb, width, height, app_id, at_ms, pinned}]`, newest first. `kind` is `text`, `link`, `image` or `files`; `preview` is the first 400 characters of a text, or the file names one per line; `uris` is empty except for files; `image` and `thumb` (paths), `width` and `height` are null except for images; `at_ms` is when it was last copied. |

Adding something already in the history (the same text, image or list of
files) moves that item to the top and returns its id; it stays pinned if
it was. Beyond 20 unpinned items the oldest are
dropped; pinned items are only removed by hand. Unknown ids and invalid
content are rejected with `InvalidArgs`.

## io.github.zickrian.isle.Reminders1

Reminders the voice assistant sets ("remind me in ten minutes to…"), kept in
`~/.local/share/isle/reminders.json`. The extension shows each as an alert
when it is due, then dismisses it.

| Member | Signature | |
|---|---|---|
| `Add(t delay_ms, s text) → t id` | | A reminder due `delay_ms` from now. |
| `Dismiss(t id)` | | Forgets one, once shown (or cancelled). |
| `Items` | `s` | `[{id, text, due_ms}]`, soonest first. |

## io.github.zickrian.isle.Assistant1

The voice assistant. isled records the microphone, turns speech into text
(whisper.cpp, through `isle-whisper`), asks the AI picked in Settings
(Claude Code, Codex or agy, with the user's own sign-in), runs the look-up
tools the AI asks for (finding files and apps, reading small text files), and
publishes the answer; the extension runs its actions. It works step by step:
desktop actions the AI takes mid-way go to the extension in the `acting`
phase, and what they did (`Results`) goes back to the AI for its next step.
A request carries on after `End`; the AI and the speech model run only while
needed and quit afterwards.

| Member | Signature | |
|---|---|---|
| `Listen(s context)` | | Records a request until the user pauses, then answers it. `context` is JSON from the extension: `{apps, running, windows, actions, provider, agy_model, claude_model, codex_model, whisper_model, language, selection, notifications}`; `actions` lists the action types it can run, and the AI is offered only those. |
| `Ask(s text, s context)` | | Answers a typed request, with the same context. |
| `Stop()` | | Stops recording and answers what was said so far. |
| `End()` | | The island closed: listening stops, and the AI and the speech model quit. A request being answered carries on in the background and finishes as a `reply` or `error`. |
| `Results(t step, s results)` | | What the actions handed out as `step` did: JSON `[{type, ok, detail}]`, one per action, in order. Unanswered within 20 s, they count as not done. |
| `Cancel()` | | Stops the request being answered; the AI quits. |
| `State` | `s` | `{phase, heard, reply, actions, error, hint, sign_in, provider, set_up, model, listen, heard_nothing, activity, turn, step}`. With `sign_in`, signing in to `provider` fixes the error; with `set_up`, running `isle-setup-voice model` does. `phase` is `idle`, `listening`, `transcribing`, `thinking`, `acting`, `reply` or `error`. In `acting`, `actions` are to run now, once per `step`, and reported with `Results`; in `reply`, they are what the answer asks, run once per `turn`. `activity` says what the AI is doing while it thinks ("Searching ~/Downloads for “ttd”…"). |
| `Level` (signal) | `d` | The microphone's level (0..1) while listening, 20 times a second. |

## io.github.zickrian.isle.Usage1

How much of the user's AI plans is used. Claude's numbers come from
`api.anthropic.com/api/oauth/usage` with Claude Code's sign-in (asked every
ten minutes, at most every two when refreshed; offline, again within a
minute; backing off after the server fails; never refreshing the sign-in);
ChatGPT's are read from Codex's own logs. Turned off, nothing runs.

| Member | Signature | |
|---|---|---|
| `SetConfig(s config)` | | `{enabled, claude, codex, warn, critical}`, from Settings; off until set. |
| `Refresh()` | | Reads again now (Claude at most every two minutes). |
| `Usage` | `s` | `{providers: [{id, name, plan, windows: [{label, percent, resets_at_ms}], updated_ms, note}]}`; a provider not signed in is left out. |
| `Alert` (signal) | `ssdx` | `(provider, window, percent, resets_at_ms)`: a limit passed the warning or the critical share, once per window. |

## io.github.zickrian.isle.Agents1

Alerts from AI coding agents: Claude Code when it needs a permission or the
user's input, or finishes; Codex when it finishes a turn. Each is turned on
in Settings, which puts a hook in that AI's own config, running isled as a
client (`isled --agent-hook claude|codex`). The hook reports to `Report`
and the island shows the `Event`.

| Member | Signature | |
|---|---|---|
| `SetHooked(s provider, b on)` | | Puts Isle's hook in `claude`'s or `codex`'s config, or takes it out (below). GNOME Shell only. Fails with `Failed` and a message to show (`Codex already sends its notifications to another program`, a config that does not parse); an unknown `provider` is `InvalidArgs`. |
| `Report(s json)` | | From the hook: `{provider, kind, project, cwd, message, session}`. Unknown providers or kinds are `InvalidArgs`. Texts are put on one line and cut (`message` to 160 characters, `project` to 60, `session` to 100); a `cwd` that is not absolute is dropped, and `project` defaults to its last folder. An event follows another of the same `provider` and `kind` by at least 300 ms, or is dropped. |
| `Agents` | `s` | `{claude: {found, hooked}, codex: {found, hooked}}`: `found`, the CLI is installed; `hooked`, Isle's hook is in its config. Read afresh on each `Get`, and published again after `SetHooked` and whenever either config file changes. |
| `Event(s json)` | signal | `{provider, kind, project, cwd, message, session}`; `provider` is `claude` or `codex`, `kind` is `permission`, `waiting` or `done`, `project` the name of the folder it works in, `session` its session (Codex: thread) id or `""`. |

The hooks, put in idempotently; taking them out removes only Isle's, and a
file is copied to `<name>.isle-backup` once, before Isle first changes it.
Each is rewritten whole and moved into place, keeping its permissions; a
file that does not parse is never written.

- **Claude Code**: `$CLAUDE_CONFIG_DIR/settings.json`, else
  `~/.claude/settings.json`, gets
  `{"hooks": [{"type": "command", "command": "<isled> --agent-hook claude"}]}`
  under `hooks.Notification` and `hooks.Stop`, beside the user's own hooks
  (every other key keeps its place). Lists and `hooks` that only Isle's hook
  was in go again with it.
- **Codex**: `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`, gets
  `notify = ["<isled>", "--agent-hook", "codex"]` (made if missing), with
  its comments and layout kept. A `notify` that runs another program is
  left alone, and `SetHooked` fails.

`<isled>` is the running isled's own path (`~/.local/bin/isled` or
`/usr/bin/isled`). The client reads Claude Code's hook JSON from standard
input (at most 1 MB): `Notification` is `permission` (its
`notification_type` is `permission_prompt`, or the message asks for a
permission) or `waiting`, with Claude's message; `Stop` is `done`, with the
first line of `last_assistant_message` when Claude Code sends one. Codex's
`agent-turn-complete` JSON, its last argument, is `done`, with the first
line of `last-assistant-message`. It calls `Report` with a one-second limit
and without starting isled, prints nothing and always exits 0.

## io.github.zickrian.isle.Updates1

Whether a newer Isle is out: GitHub's latest release, looked up at most once a day while enabled.

| Member | Signature | |
|---|---|---|
| `SetEnabled(b enabled)` | | Look, or not (Settings → New versions); off until set. |
| `Latest` | `s` | The latest release's version (`0.8.0`) when it is newer than this isled; empty otherwise. |

## io.github.zickrian.isle.System1

| Member | Signature | |
|---|---|---|
| `State` | `s` | `{battery: {percent (a whole number), plugged, charging} or null, network: {connected, connection, name}, bluetooth: [{path, name, icon, battery}], camera_in_use}` |
| `Event(s json)` | signal | One of `{kind: "power", plugged, percent}`, `{kind: "battery_low", percent}`, `{kind: "battery_full"}`, `{kind: "network", connected, connection, name}`, `{kind: "bluetooth", connected, device}`. |

## io.github.zickrian.isle.ShelfWindow1

Served by `isle-shelf` (not `isled`) as `io.github.zickrian.isle.ShelfWindow` at
`/io/github/zickrian/isle/ShelfWindow`.

| Member | | |
|---|---|---|
| `Show(i x, i y, i width, i height)` | | Show the shelf window over this area, in logical pixels. |
| `Hide()` | | |
| `SetDropping(b dropping)` | | A file is being dragged towards the island: show where it will land. |
