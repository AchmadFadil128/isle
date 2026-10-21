# isled D-Bus API

`isled` owns `io.github.zickrian.isle.Daemon` on the session bus and serves every
interface at `/io/github/zickrian/isle/Daemon`. State is exposed as read-only string
properties holding JSON, with `PropertiesChanged` emitted on every change.
Timestamps are milliseconds since the Unix epoch; durations are
milliseconds unless the name says `_us` (microseconds).

## io.github.zickrian.isle.Media1

The active MPRIS player: the one playing, or else the one that played last.

| Member | Signature | |
|---|---|---|
| `PlayPause()`, `Next()`, `Previous()` | | Control the active player. |
| `SetPosition(x position_us)` | | Seek to an absolute position. |
| `Raise()` | | Bring the player's window to the front. |
| `NowPlaying` | `s` | `{available, identity, desktop_entry, status, title, artist, album, art_path, length_us, position_us, sampled_at_ms, rate, can_go_next, can_go_previous, can_play_pause, can_seek}` |
| `Lyrics` | `s` | `{track, status, lines: [{time_ms, text}]}`; `status` is `none`, `loading`, `synced`, `plain` (lines have `time_ms` -1), `instrumental`, `not_found`, `error` (LRCLIB could not be reached) or `unavailable` (LRCLIB answered but is busy or failing); isled retries the last two on its own. |

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
| `Events` | `s` | `[{id, title, date, start, end}]` by day and time; `start` and `end` are `HH:MM` or null (all day; no end given). Events over 400 days old are forgotten. |

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
| `GetText(t id) → s` | | The full content to copy back: the text, the URIs one per line, or the path of an image's PNG. |
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

## io.github.zickrian.isle.System1

| Member | Signature | |
|---|---|---|
| `State` | `s` | `{battery: {percent, plugged, charging, time_to_empty_s, time_to_full_s} or null, network: {connected, connection, name}, bluetooth: [{path, name, icon, battery}], camera_in_use}` |
| `Event(s json)` | signal | One of `{kind: "power", plugged, percent}`, `{kind: "battery_low", percent}`, `{kind: "battery_full"}`, `{kind: "network", connected, connection, name}`, `{kind: "bluetooth", connected, device}`. |

## io.github.zickrian.isle.ShelfWindow1

Served by `isle-shelf` (not `isled`) as `io.github.zickrian.isle.ShelfWindow` at
`/io/github/zickrian/isle/ShelfWindow`.

| Member | | |
|---|---|---|
| `Show(i x, i y, i width, i height)` | | Show the shelf window over this area, in logical pixels. |
| `Hide()` | | |
| `SetDropping(b dropping)` | | A file is being dragged towards the island: show where it will land. |
