# isled D-Bus API

`isled` owns `io.github.isle.Daemon` on the session bus and serves every
interface at `/io/github/isle/Daemon`. State is exposed as read-only string
properties holding JSON, with `PropertiesChanged` emitted on every change.
Timestamps are milliseconds since the Unix epoch; durations are
milliseconds unless the name says `_us` (microseconds).

## io.github.isle.Media1

The active MPRIS player: the one playing, or else the one that played last.

| Member | Signature | |
|---|---|---|
| `PlayPause()`, `Next()`, `Previous()` | | Control the active player. |
| `SetPosition(x position_us)` | | Seek to an absolute position. |
| `Raise()` | | Bring the player's window to the front. |
| `NowPlaying` | `s` | `{available, identity, desktop_entry, status, title, artist, album, art_path, length_us, position_us, sampled_at_ms, rate, can_go_next, can_go_previous, can_play_pause, can_seek}` |
| `Lyrics` | `s` | `{track, status, lines: [{time_ms, text}]}`; `status` is `none`, `loading`, `synced`, `plain` (lines have `time_ms` -1), `instrumental`, `not_found` or `error`. |

The position is only sampled when something changes. While playing, the
current position is `position_us + (now - sampled_at_ms) * 1000 * rate`.

The control methods only fail when no player is running. They return
without waiting for the player, so a slow player cannot hold the daemon up;
if the player then rejects the command, isled only logs it.

## io.github.isle.Pomodoro1

| Member | Signature | |
|---|---|---|
| `Start()` | | Start a focus session, or resume a paused phase. |
| `StartPhase(s phase)` | | Start `focus`, `short_break` or `long_break` right away (`idle` stops). |
| `Pause()`, `Stop()`, `Skip()` | | `Skip` ends the phase early without counting it. |
| `SetConfig(s json)` | | Replace the configuration (below). |
| `State` | `s` | `{phase, running, ends_at_ms, remaining_ms, duration_ms, completed_sessions, sessions_before_long_break, today_sessions, today_focus_ms}`; `phase` is `idle`, `focus`, `short_break` or `long_break`. |
| `Config` | `s` | `{focus_minutes, short_break_minutes, long_break_minutes, sessions_before_long_break, auto_start_breaks, auto_start_focus}` |
| `PhaseFinished(s finished, s next)` | signal | A phase ran out (not emitted for `Skip` or `Stop`). |

## io.github.isle.Todo1

| Member | Signature | |
|---|---|---|
| `Add(s text) → t id` | | Quick-add: a trailing `@18:30`, `@7`, `@3pm` or `in 20m` / `in 2h` sets the due time. |
| `SetDone(t id, b done)`, `Rename(t id, s title)`, `Remove(t id)`, `ClearDone()` | | Finished tasks are cleared at midnight. |
| `Items` | `s` | `[{id, title, due_at_ms, done, alerted, done_at_ms}]`; `done_at_ms` is when the task was ticked off, or null. |
| `Due(t id, s title)` | signal | A task's due time arrived. |

## io.github.isle.Shelf1

| Member | Signature | |
|---|---|---|
| `Add(as uris)` | | Add local `file://` URIs (moved to the front if already there). Other URIs are skipped and reported with an `InvalidArgs` error once the rest are added. |
| `Remove(s uri)`, `Clear()` | | |
| `Refresh()` | | Drop items whose files no longer exist. |
| `Items` | `s` | `[{uri, name, added_at_ms}]`, newest first. |

## io.github.isle.System1

| Member | Signature | |
|---|---|---|
| `State` | `s` | `{battery: {percent, plugged, charging, time_to_empty_s, time_to_full_s} or null, network: {connected, connection, name}, bluetooth: [{path, name, icon, battery}], camera_in_use}` |
| `Event(s json)` | signal | One of `{kind: "power", plugged, percent}`, `{kind: "battery_low", percent}`, `{kind: "battery_full"}`, `{kind: "network", connected, connection, name}`, `{kind: "bluetooth", connected, device}`. |

## io.github.isle.ShelfWindow1

Served by `isle-shelf` (not `isled`) as `io.github.isle.ShelfWindow` at
`/io/github/isle/ShelfWindow`.

| Member | | |
|---|---|---|
| `Show(i x, i y, i width, i height)` | | Show the shelf window over this area, in logical pixels. |
| `Hide()` | | |
