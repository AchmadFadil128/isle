# Isle product spec

The single source of truth for how the island looks and behaves. Code that
disagrees with this document is a bug in one or the other; fix both together.

## 1. Who it is for and what they need

| As a user I want to… | So Isle must… |
|---|---|
| see the time and what is running at a glance | show the clock in the closed island, with live activities beside it (timer ring, music) |
| control music without switching windows | open on hover with cover, scrubber, controls; sing along with synced lyrics |
| focus in blocks | run a Pomodoro timer that stays visible while closed and chimes at the end |
| not forget small tasks | write them down in one line, tick them off; tasks survive reboots and power cuts |
| move files between apps | park files on the island and drag them out later |
| know when something changes | show short, consistent alerts: charging, battery, losing the connection, earbuds, volume, brightness, Caps Lock |
| still get my notifications now that the clock is gone | show GNOME's notifications in the island, keep them in a list, and offer Do Not Disturb right there |
| know when I am being watched or recorded | show privacy dots for the camera, microphone and screen sharing, and a timer while the screen records |
| control sound without opening Quick Settings | change the volume and the output device from the music page |
| keep my laptop fast and cool | never poll; animate only while something moves |

Out of scope for v1: water reminders (removed), notification banners in the
island, and desktops other than GNOME.

## 2. Presentations

The island is always in exactly one presentation. `P` is the top bar height:
26 px with the compact top bar (the default), GNOME's 32 px otherwise. All
sizes are logical pixels.

| Presentation | Size (w × h) | Corner | Shoulder | Content |
|---|---|---|---|---|
| Compact | 144 × P; 232 with an activity | 10 | 7 | Clock; activity slots left/right |
| Compact, hanging | 164 × (P + 30); 256 with an activity | 16 | 10 | As above |
| Peek (alert) | 380 × (P + 56); 380 × 62 off a black bar | 22 | 13 | Badge · title/subtitle · value, level bar or button |
| Expanded | 600 × (P + 164); 720 for lyrics | 32 | 22 | Header row (tabs) · page |

The top bar is slimmed to a thin bezel (status icons and the tray stay in
it) and see-through like glass, with no colour of its own. The
island is a black notch hanging from the top edge of the screen with concave
shoulders, like Boring Notch on a MacBook. Closed, it sits inside the bar
(32 px, against 26 px when it hangs below instead): maximised
windows start below the bar, so the resting island never covers an app and
no screen space is lost to it. Alerts and the open island reach below the
bar; they cover windows only for as long as they are shown. Their content
sits below the bar's height, and the open island's header row level with
the bar. In the settings the closed island can hang below the bar instead
("Compact, hanging").

The bar can also be black, so that bar and island read as one shape: the
shoulders then curve out of the bar's lower edge instead of the screen's
top, or keep the theme's colour. The installer sets glass (and the slim
bar) on every install, turns off Blur my Shell's top bar blur (it darkens
the bar), and turns off
extensions that take the island's place. Isle adds its colour to the bar's
own style and puts it back if another extension replaces that style,
leaving the other extension's rules in place.

### State details

Every state change shows in the icon, not only in colour, so it reads at a
glance (and for colour-blind users):

| Control | Off | On |
|---|---|---|
| Do Not Disturb | bell outline, grey chip | filled moon, indigo chip; moon in the closed island |
| Focus Time | target outline, grey chip | filled target, indigo chip |
| Short Break | cup outline, grey chip | filled cup, green chip ("Long Break" during a long break) |
| Focus stopwatch | outline | filled while running; reset dims until the timer starts |
| Lyrics | speech bubble outline | filled bubble, lit button |
| Completed tasks | arrow pointing right, folded | arrow pointing down, listed |
| Play / pause | play | pause |
| Task | empty circle | white circle with a black check; title struck through |

Controls that cannot act right now (Clear All with nothing to clear) stay in
place, dimmed, so the layout never jumps.

### Motion

- Size uses one spring for growing and shrinking: stiffness 155, damping 18
  (≈3.5% overshoot, peak at 0.37 s, settled by 0.57 s), close to
  `cubic-bezier(.34, 1.32, .5, 1)` over 0.62 s.
- Corner radius and shoulders use the same speed without overshoot, and are
  clamped every frame so corners never exceed the visible body: the outline
  stays clean at every size in between.
- Content cross-fades: outgoing 160 ms, incoming 320 ms after a 200 ms delay
  (the shape makes room first). No scaling.
- Pages slide 48 px with a fade, 260 ms ease-out.
- Rings in alerts sweep from empty to their value over 1 s, starting 350 ms in.
- With "reduce animations" on, everything jumps to its end state.

## 3. Interaction flow

| Input | Closed / alert | Open |
|---|---|---|
| Pointer rests 120 ms | Open on the default page | – |
| Pointer leaves | – | Close after 300 ms (not while typing or dragging a file) |
| Click | Open now (an alert opens on its page) | Normal button clicks |
| Middle-click | Play / pause | Play / pause |
| Right-click | Bring the music player to the front | Bring the music player to the front |
| Super+V (GNOME's calendar shortcut) | Open the clipboard history, search ready, held open | Close |
| Click a tab | – | Go to that page |
| Two-finger swipe sideways | – | Previous / next page, one page a swipe |
| Scroll up / down | – | Lists and lyrics scroll; elsewhere previous / next page, one a wheel click |
| ← → Enter (search field) | – | Choose a clipboard card; Enter pastes it into the window in front |
| Esc | – | Clear the search, stop typing or renaming; then close when opened with Super+V |

**Default page on open**, first match wins: the page of the alert being
shown → the page picked by hand (a tab, a swipe, or the Shelf after a file
was dragged onto the island), remembered for 5 minutes → Notifications if
some arrived unseen (during Do Not Disturb) → Music if something plays →
Focus if the timer runs → Music.

Pages, in order: **Music · Notifications · Focus · Shelf · Tasks**, one tab
each in the header. Lists scroll with the wheel or touchpad and never show
a scrollbar.

## 4. Closed island

- Left slot, first that applies: breathing red dot (screen recording) →
  focus timer ring → cover art (music playing) → white dot (unseen
  notifications) → moon (Do Not Disturb on).
- While the screen records, the centre shows how long it has been recording
  instead of the clock.
- Right slot: music bars while playing. They dance only while the closed
  island is on screen, and rest after a minute without input.
- Far right: privacy dots, as on iPhone: green camera, orange microphone,
  blue screen sharing (the island widens by 22 px while any is shown).
- Centre: the clock (follows GNOME's 12/24-hour setting).

## 5. Pages

Every page shares the header row inside the top bar, like NotchNook's. On
the left, a tab per page: icons, the open page's in a lit pill with its
name, and a red dot on Notifications while some are unseen. On the right a
red "● 0:42" pill while the screen records (click to stop), the privacy
dots, the music bars and `[timer ring] Tue 20 Oct 2026 12:26`.

**Music**. Cover (click: bring the player forward) with the playing app's
icon on its corner (Spotify, Chrome, …; found by name when the player gives
no desktop entry), title, artist — album (or the app's name), scrubber with
elapsed / remaining time, lyrics toggle, previous · play/pause · next. An
app's logo sent in place of a cover is shown whole, without the badge. Built for Spotify and YouTube in
the browser; any MPRIS player works. With nothing playing: "Nothing
playing" and "Play something in Spotify or on YouTube".

**Volume and output** (Music page, the output button at the bottom right).
The volume with a mute button and percentage, then the outputs (speakers,
headphones, earbuds, HDMI) with a check on the current one; click one to
switch. The output button lights up and fills in while this is shown; it
returns to the player when the island closes.

**Lyrics** (Music page, toggled). The island widens to 720. Left: cover,
title, artist, scrubber, controls with the lyrics toggle lit. A hairline
divider. Right: synced lines, the current one white, others dimmed, faded at
the top and bottom; click a line to jump there; scrolling by hand pauses
following for 4 s. The island takes a soft wash of the cover's colour.
States: looking for lyrics, no lyrics found, instrumental, offline.

**Notifications** (title "Notifications"). Left: how many there are,
**Do Not Disturb** and **Clear All** (see state details above). Right: newest first,
each with its app icon, title, one line of text and how long ago; click to
open it (the island closes), × to dismiss. Opening the page marks them seen.
Empty: "No notifications · You're all caught up".

**Focus** (title "Pomodoro"). A thin white ring that fills clockwise as the
phase runs (green during breaks), with a clock icon inside; the remaining
time large with a reset button; the phase underneath ("Focus time", "Short
break", "Long break"). Buttons: **Short Break** · white play/pause ·
**Focus Time**; the chips start that phase at once and the current one is
highlighted. No glows or accent fills. Once a focus session has finished
today, a line underneath reads "Today · 3 sessions · 1h 15m".

While a focus phase runs (paused included), Do Not Disturb is on, like a
Focus mode; it goes off when the phase ends. Isle only undoes what it did:
if Do Not Disturb was already on, or the user turns it off mid-session, it
is left alone. It stays on across the lock screen, and is turned off on the
next start if the shell stopped mid-session. ("Do Not Disturb" in Focus
Timer settings.)

**Shelf** (title "Shelf"): things to keep close, in two tabs on a
segmented control (switching crossfades).

- **Clipboard**: what was copied, pinned items first, then newest first, as
  cards (136 × 96): text
  (three lines; code in a monospace font), links (site and address), images
  (thumbnail with its size) and files (icon, name, "+2 more"). Each card shows
  the app it came from and how long ago. Click a card to copy it ("Copied"
  flashes on it). On hover: pin (pinned items stay at the front and are
  never cleared), a hand-off (text to Tasks; images and files to the Files
  tab) and ×. The bar holds type filters (text, links,
  images, files; the chosen one lit, the others dimmed), a search field and
  Clear all (asks once more; pinned items are kept). Opened with Super+V, the search
  field has the keyboard: ← → choose a card (white outline), Enter pastes it
  into the window in front (Ctrl+Shift+V in terminals).
- **Files**: at most 5 files, all in view with no scrolling; a sixth is
  refused until one is removed. The bar says what the tab is for ("Drop
  files here, then drag them into any app"), how full it is ("3 of 5"), or
  "Full · remove a file to add another". With `isle-shelf` installed, a drop
  zone and file tiles drawn by the helper over this tab: drag a file out to
  any app (a chat, an email, a folder), double-click to open, × on hover to
  remove. Dragging copies; a drag that ends nowhere leaves the file on the
  shelf, and the island stays open until the drag ends. Dragging a file near
  the island opens this tab by itself, and the bar says "Drop to keep it on
  the shelf" (or "Full · remove a file first", and the drop is refused); the
  drop zone lights up softly while a file is over it. Without the helper: tiles that open on
  click, × on hover to remove, and an install hint when empty.

Clipboard history is event driven (GNOME tells the shell when the
clipboard changes; nothing polls) and kept by `isled`: the 20 most recent
items plus up to 10 pinned ones ("Pins full · unpin one" past that), images
with a 320 × 200 thumbnail. The cards are only
drawn while the page is open, so copying costs nothing on screen. Copies are never kept
when a password manager marks them secret, from ignored apps (password
managers by default; Settings → Clipboard), or while history is off.

**Tasks** (title "Tasks"): a plain list, with no times or reminders. Left: a
white progress ring with done / total inside, "2 to go" and "3 of 5 done
today". Right: an "Add a task" field (Enter adds and stays ready, Esc
stops), then open tasks in the order they were added. On a task: the circle
ticks it off; clicking the title renames it in place (Enter or clicking away
saves, Esc cancels); × appears on hover. Finished tasks fold under
"Completed · N" and show as plain struck-through rows when unfolded.
Finished tasks are cleared at midnight.

## 6. Alerts

One at a time. *Instant* alerts replace whatever is showing; the rest queue
(same kind replaces in place) and wait while the island is open. Volume,
brightness and Caps Lock are dropped instead of waiting, since they are
stale by the time the island closes.

| Alert | Badge | Title / subtitle | Right | Time |
|---|---|---|---|---|
| Charging | green ring + bolt | Charging / Charger connected | 76% | 2.6 s |
| Unplugged | ring + battery | On Battery / Charger disconnected | 76% | 2.6 s |
| Low battery (20, 10, 5%) | red ring | Low Battery / Plug in your charger soon | 10% | 8 s |
| Fully charged | green ring | Fully Charged | 100% | 2.6 s |
| Earbuds connected | ring + device icon | AirBuds Pro / Connected | 70% | 2.6 s |
| Connection lost | Wi-Fi offline icon | Offline / The network connection was lost | – | 2.6 s |
| Volume, brightness (instant) | icon | Volume / device | level bar + %, gliding to each new level; pressing on at 0% or 100% stretches the island like a rubber band | 1.5 s |
| Caps Lock (instant) | ⇪ | Caps Lock on / off | – | 1.5 s |
| New song (off by default) | cover | title / artist | – | 2.6 s |
| Timer phase ends (+ chime) | timer | Focus session done… | Start break | 8 s |
| Screen recording started | red record icon | Recording screen | Stop | 2.6 s |
| Notification (GNOME's sound) | app icon, large | title / first line | – | 5 s; urgent 8 s and instant |

When a window is fullscreen the island hides and GNOME's own volume pop-up
is used.

### Notifications and Do Not Disturb

The island replaces GNOME's banners and its calendar drop-down while the
extension runs, so nothing shows twice (hovering opens Notifications; Super+V
opens the clipboard history instead of the drop-down). Rules
match GNOME's: low-urgency and already-seen notifications never pop up, and
apps whose banners are turned off in Settings stay quiet. Do Not Disturb is
GNOME's own setting, so it stays in sync with Quick Settings; while it is on,
only critical notifications pop up. Clicking a notification alert opens it;
hovering opens the Notifications page.

## 7. Data and reliability

- Tasks, shelf, clipboard history (images in `clips/`) and timer settings
  live in `~/.local/share/isle/*.json`,
  written atomically and flushed to disk (file and folder), so they survive
  reboots and power cuts. A corrupt file is set aside, never lost silently.
- Lyrics and cover art are cached in `~/.cache/isle`.
- `isled` restarts on failure (systemd); the extension reconnects on its own.

## 8. Performance budget

- Idle, nothing playing: one wake-up per minute (the clock). No polling.
- Animations run on the display's frame clock only while a spring moves.
- The open island ticks only the visible page (scrubber 4×/s, timer 1×/s).
- `isled` sleeps until a D-Bus signal arrives. The camera is watched with
  inotify, so the kernel reports opens and closes; nothing is polled.
- Moving parts that loop (music bars, the recording dot) run only while on
  screen; the music bars also rest after a minute without input.
