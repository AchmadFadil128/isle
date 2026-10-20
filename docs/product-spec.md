# Pulau product spec

The single source of truth for how the island looks and behaves. Code that
disagrees with this document is a bug in one or the other; fix both together.

## 1. Who it is for and what they need

| As a user I want to… | So Pulau must… |
|---|---|
| see the time and what is running at a glance | show the clock in the closed island, with live activities beside it (timer ring, music) |
| control music without switching windows | open on hover with cover, scrubber, controls; sing along with synced lyrics |
| focus in blocks | run a Pomodoro timer that stays visible while closed and chimes at the end |
| not forget small tasks | add tasks in one line (`Call mum @18:30`), get reminded, tick them off; tasks survive reboots and power cuts |
| move files between apps | park files on the island and drag them out later |
| know when something changes | show short, consistent alerts: charging, battery, Wi-Fi, earbuds, volume, brightness, keyboard, new song |
| keep my laptop fast and cool | never poll; animate only while something moves |

Out of scope for v1: water reminders (removed), notification banners in the
island, other desktops than GNOME 46 (the GTK frontend is experimental).

## 2. Presentations

The island is always in exactly one presentation. `P` is the top bar height
(32 px by default). All sizes are logical pixels.

| Presentation | Size (w × h) | Corner | Shoulder | Content |
|---|---|---|---|---|
| Compact | 150 × (P + 10); 232 with an activity; 400 with live lyrics | 14 | 10 | Clock, or lyric line, or eyes; activity slots left/right |
| Peek (alert) | 380 × 80 | 24 | 16 | Badge · title/subtitle · value, level bar or button |
| Expanded | 600 × (P + 170); 720 for lyrics | 32 | 22 | Header row · page · dots |

The top bar is painted black; the island hangs from it with concave
shoulders, so bar and island read as one shape.

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
| Right-click | GNOME calendar and notifications | GNOME calendar |
| Scroll / two-finger swipe | – | Previous / next page |
| Esc | – | Stop typing a task |

**Default page on open**, first match wins: the page of the alert being
shown → Music if something plays → Focus if the timer runs → Tasks if one is
due within an hour → the page last viewed (remembered for 5 minutes) → Music.

Pages, in order: **Music · Focus · Shelf · Tasks**. Arrows at the sides go to
the neighbouring page (hidden at the ends); dots show where you are.

## 4. Closed island

- Left slot, first that applies: focus timer ring → cover art (music
  playing) → white dot (unread GNOME notifications).
- Right slot: music bars while playing (static, to save power).
- Centre: the clock (follows GNOME's 12/24-hour setting); or the current
  lyric line if *Live lyrics* is on and synced lyrics exist; or the eyes.
- Idle: after *Idle after* seconds (90) without input and nothing playing,
  the eyes open, blink twice and doze off. Any input wakes them, then the
  clock returns after 1.2 s.

## 5. Pages

Every page shares the header row inside the top bar: page title on the left,
`[timer ring] Tue 20 Oct 2026 12:26` in the centre, music bars on the right.

**Music** (no title). Cover (click: bring the player forward), title, artist
— album, scrubber with elapsed / remaining time, lyrics toggle, previous ·
play/pause · next, the player's app icon. With nothing playing: "Nothing
playing" and a hint.

**Lyrics** (Music page, toggled). The island widens to 720. Left: cover,
title, artist, scrubber, controls with the lyrics toggle lit. A hairline
divider. Right: synced lines, the current one white, others dimmed, faded at
the top and bottom; click a line to jump there; scrolling by hand pauses
following for 4 s. The island takes a soft wash of the cover's colour.
States: looking for lyrics, no lyrics found, instrumental, offline.

**Focus** (title "Pomodoro"). A thin white ring that fills clockwise as the
phase runs (green during breaks), with a clock icon inside; the remaining
time large with a reset button; the phase underneath ("Focus time", "Short
break", "Long break"). Buttons: **Short Break** · white play/pause ·
**Focus Time**; the chips start that phase at once and the current one is
highlighted. No glows or accent fills.

**Shelf** (title "Shelf"). With `pulau-shelf` installed: a drop zone, file
tiles with previews; drag out to any app, double-click to open, × to remove,
trash to clear. Dragging a file near the island opens this page by itself.
Without the helper: read-only tiles and an install hint.

**Tasks** (title "Todo**List**"). Left: done / total today (e.g. 4/5) and
"Task Done Today", **Add Task** and **Edit Task**. Right: the list, open
tasks first by due time, then finished ones as green struck-through pills.
Add Task turns the left side into a text field (Enter adds and stays open,
Esc closes). Edit Task shows × on each task. Finished tasks are cleared at
midnight.

## 6. Alerts

One at a time. *Instant* alerts replace whatever is showing; the rest queue
(same kind replaces in place) and wait while the island is open.

| Alert | Badge | Title / subtitle | Right | Time |
|---|---|---|---|---|
| Charging | green ring + bolt | Charging / Charger connected | 76% | 2.6 s |
| Unplugged | ring + battery | On Battery / Charger disconnected | 76% | 2.6 s |
| Low battery (20, 10, 5%) | red ring | Low Battery / Plug in your charger soon | 10% | 8 s |
| Fully charged | green ring | Fully Charged | 100% | 2.6 s |
| Earbuds connected | ring + device icon | AirBuds Pro / Connected | 70% | 2.6 s |
| Wi-Fi | icon | Wi-Fi connected / network name; Offline | – | 2.6 s |
| Volume, brightness (instant) | icon | Volume / device | level bar + % | 1.5 s |
| Caps Lock, layout (instant) | ⇪ / keyboard | Caps Lock on; layout name | code | 1.5 s |
| New song | cover | title / artist | – | 2.6 s |
| Timer phase ends (+ chime) | timer | Focus session done… | Start break | 8 s |
| Task due (+ chime) | tasks | task title / Due now | Done | 8 s |

When a window is fullscreen the island hides and GNOME's own volume pop-up
is used.

## 7. Data and reliability

- Tasks, shelf and timer settings live in `~/.local/share/pulau/*.json`,
  written atomically and flushed to disk (file and folder), so they survive
  reboots and power cuts. A corrupt file is set aside, never lost silently.
- Lyrics and cover art are cached in `~/.cache/pulau`.
- `pulaud` restarts on failure (systemd); the extension reconnects on its own.

## 8. Performance budget

- Idle, nothing playing: one wake-up per minute (the clock). No polling.
- Animations run on the display's frame clock only while a spring moves.
- The open island ticks only the visible page (scrubber 4×/s, timer 1×/s).
- `pulaud` sleeps until a D-Bus signal arrives.
