# Changelog

All notable changes to Isle are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.7.3] - 2026-10-22

### Changed

- The top bar is glass or black; the theme's own colour is no longer offered
  (a bar set to it before reads as glass).

### Fixed

- Antigravity's logs (one per request) are deleted at the end of the day,
  with its conversations, instead of piling up in Isle's folder.

## [0.7.2] - 2026-10-22

### Fixed

- The files tray's helper (`isle-shelf`) stayed in memory, about 130 MB,
  when something other than opening the tray started it (a drag passing
  the island, at login): it now quits a minute after starting unless the
  tray is shown, as it does after the tray closes.

## [0.7.1] - 2026-10-22

### Changed

- The assistant's steps read as what it does ("Setting the volume to
  30%…", "Turning Wi-Fi off…"), with each step done ticked on a line of its
  own; a long answer is set smaller and lighter, as a paragraph.
- New screenshots in the README: the notifications page, the files tray,
  the assistant at work and its three ways in, and the alerts.

### Fixed

- Alerts with nothing on the right (a reminder, a new song, a summary of
  notifications) sat off-centre; the alert's sides are now even.
- "5-hour limit" and other text in alerts and the assistant no longer has
  the clock's wide digits and dashes.

## [0.7.0] - 2026-10-22

### Added

- **The voice assistant works as an agent, in the background.** A request
  with several steps ("open Firefox, then put it on the left", "find my CV
  and open it") is done one step after another, each step seeing what the
  last one did. Close the island while it works: it carries on, with a small
  mic in the closed island, and the answer comes as an alert. Click the
  island or press Super+I to watch it, and Stop to end it.
- `isled --doctor` checks speech recognition and each AI: where it is
  installed and whether you are signed in, as Isle itself sees them.
  `isle-setup-voice` runs it at the end. Also `isled --version` and `--help`.
- **Type a request instead of saying it**: start typing while the assistant
  listens, or click the keyboard in its panel. No speech recognition runs.
- A Set up button when speech recognition or the model chosen in Settings is
  missing: it opens a terminal that downloads it, with no command to type.
- **Multiple displays**: the island can follow the display you are using
  (Settings), hanging from its top edge there; GNOME's own volume pop-up
  shows on a display the island is not on.
- **Privacy while sharing the screen**: alerts leave out what notifications
  say, and the clipboard history stays hidden, while the screen is shared or
  recorded.
- Notifications keep their buttons ("Mark as read", "Join") on the alert and
  in the list; critical ones and reminders wait until you are back at the
  computer; right-clicking an alert puts it away.
- A switch to another music player when two run, and lyrics online can be
  turned off.
- Settings: open on a click or after a chosen rest; each system alert on its
  own; GNOME's own banners or calendar menu instead of the island's; the
  assistant's shortcut; an About page with the version, help, a bug report
  to copy and a reset of every setting.
- The island says when a newer Isle is out (GitHub, at most once a day; can
  be turned off), and warns, with a Restart button, when its service stops.
- `isled --report` gathers what a bug report needs: versions, what works and
  recent logs.
- Packages: `.deb`, `.rpm` and an AUR `PKGBUILD`, each attested with build
  provenance, besides the one-line install.

### Changed

- **Speech recognition without Python.** The voice assistant now hears you
  with `isle-whisper`, built on whisper.cpp: no Python environment, and about
  a tenth of the space (the program 29 MB and the `small` model 265 MB,
  instead of up to 3 GB). On an NVIDIA, AMD or Intel Arc graphics card it
  runs through Vulkan, in about a second and with a third of the memory; on
  the processor it is about half as fast as before. Integrated graphics are
  not used (Intel UHD crashed). Updating moves a voice set up before over
  by itself: the installer downloads the new model and deletes the old
  Python environment and model (`isle-setup-voice --remove-old` does the
  same by hand). `isled --doctor` shows the models and where speech runs.
- **A calmer voice panel.** Light rises from the panel's edge and flows
  along the bottom, instead of drifting blobs of colour; it follows your
  voice, and your keys as you type. One round button sits at the end: the
  keyboard, Stop while it works, and Send inside the field as you type. The
  face's eyes read along as you type.
- **The assistant checks its work.** An answer's own actions run before it
  answers, so a step that failed is never answered as done: it tries
  another way or says what did not work. Closing an app counts once its
  windows are gone (one asking to save stays open, and you hear so). Out of
  steps, it says where it got to. Slow steps (opening an app, starting a
  player) get the time they need, and an answer in a code block or in plain
  words is read alike from all three AIs.
- Buttons in the island are translucent grey, as on macOS, and alerts take
  the island's own colours: the Claude and ChatGPT plans their own, red when
  nearly used up; reminders and Caps Lock neutral.
- **Nothing of the assistant runs while you are not asking.** The AI quits
  as soon as a request is done (it used to stay ten minutes) and speech
  recognition once your words are text; both run at a lower priority, take
  everything they started with them when they quit, and transcribing uses at
  most half the processor's cores.
- **Lighter when idle.** `isled` sleeps until its next real deadline instead
  of waking every 30 seconds, checks the clock again on waking from
  suspend, and asks nothing about AI usage while that is turned off; the
  files tray's helper quits a minute after the tray closes; on battery the
  music bars rest after 15 seconds without input.
- Updating keeps your top bar settings: the installer sets Isle's look only
  on a first install. It refuses to run as root, stops before changing
  anything on an unsupported GNOME Shell, and says what went wrong when
  GitHub cannot be reached.
- Uninstalling also removes speech recognition and Isle's caches, and lifts
  a battery charge limit Isle set.
- The installer no longer turns other extensions off (Blur my Shell's top
  bar blur, Hide Top Bar, other islands); it says which to turn off and how.
- Sharing the selected text with the assistant is off by default, and the
  spoken language is detected unless you pick one.
- The clock follows GNOME's own (right after waking from suspend and on a
  time-zone change), and times of day follow the 12/24-hour setting
  everywhere.
- `isled` keeps restarting after repeated crashes instead of giving up, and
  can never gain privileges.
- Building from source needs Rust 1.88 (1.92 with the shelf helper).

### Fixed

- **Smoother opening, closing and switching tabs.** The island no longer
  restyles every page whenever the pointer enters or leaves it, or as one
  page takes over from another. While it rests closed, the pages are
  prepared ahead, including any that changed meanwhile, so the frames that
  animate them only draw.
- **New songs no longer stall the island**: covers are decoded once, off
  the main thread, at the size they are shown, however big the cover a
  browser sends.
- Switching between the player, lyrics and outputs no longer restyles the
  whole music page.
- Opening the calendar or notifications no longer rebuilds them unless
  something changed.
- The assistant finds AIs installed with nvm, volta, fnm or pnpm, and the
  Node.js beside them.
- AI usage shows up soon after login: offline at first, Claude is asked
  again within a minute instead of 20; the Usage tab no longer goes
  missing when Isle starts before GNOME Shell asks for it.
- A second `isled` started by hand (`isled --version` did) no longer takes
  over the running one.
- Plugging in at a battery charge limit no longer repeats the Charging and
  On Battery alerts.
- **Nothing is lost behind a fullscreen window**: alerts, notifications and
  reminders wait and show once it is gone, instead of being thrown away; a
  burst of notifications comes as one; a notification counts as seen only
  once it was on screen. Super+I and Super+V do nothing while the island is
  hidden, so nothing listens unseen.
- A login renewed by Codex or agy inside Isle goes back to your own CLI, so
  neither is signed out.
- Reading files in the shell (thumbnails, clipboard images, covers) no
  longer blocks it.
- A song's cover could stay blank after logging in, deleted with the last
  session's covers as it was saved.
- The AI Usage page of Settings had no icon on GNOME's own theme, and the
  typed request's field took the theme's accent ring.

### Security

- Only GNOME Shell may read the clipboard history from Isle's service or
  steer its assistant; other programs on the session bus are refused.

## [0.5.0] - 2026-10-22

### Added

- **A voice assistant.** Press Super+I (or the mic in the open island) and
  ask, in English or Indonesian: play a song, find a file, open or close an
  app, put windows side by side or in a 2×2 grid, add a reminder or an event,
  change the volume, brightness or dark style, write where your cursor is,
  or ask a question. It works as an agent, looking things up on your computer
  and on the web and showing each step, with the AI you already use: Claude
  Code, Codex or Antigravity, picked in Settings → Voice. Speech is
  recognised on your computer; set it up once with `isle-setup-voice`.
- **AI usage**: how much of your Claude and ChatGPT plans' limits is used,
  one plan at a time with its logo, with a warning as a limit nears its end.
  Only the plans you are signed in to show.
- Reminders the assistant sets show as alerts when due.

### Security

- Each AI is started with only web search and reading pages; Isle runs the
  actions it answers with, opens documents and media but never programs,
  never reads folders that hold keys or passwords, even through a link, and
  treats text from other apps and the web as data, never as instructions.

## [0.4.1] - 2026-10-22

### Fixed

- **GNOME Shell could crash** when the island closed in the moment a ticked
  reminder folded away, or when renaming one reminder and then another.
- The island **no longer shakes by a pixel** while it grows and shrinks:
  its contents stay put on screen, and its edges no longer step back.
- **Switching tabs** no longer makes the tabs jump: names open and close
  smoothly, and the Focus page now fits the same width as the others, so
  the island keeps its size from tab to tab.
- One alert replacing another fades over instead of swapping in a frame,
  and an alert shown again while fading out no longer blinks.
- After adding a reminder with Enter, the field keeps the keyboard, ready
  for the next one.
- `isled` stops when its session ends instead of lingering in the
  background.
- Less work while music plays: synced lyrics no longer retry scrolling
  sixty times a second while hidden, the music bars animate without
  re-laying out the island, the output list is not rebuilt as the volume
  moves, and a cover is decoded once.
- Cached covers and lyrics are trimmed to the latest 500 songs.

### Changed

- The Focus page's Break and Focus are round buttons, lit in the phase's
  colour, so the timer and today's reminders share the usual width.

## [0.4.0] - 2026-10-22

### Added

- A **settings gear** in the open island's header, beside the clock.

### Changed

- **Focus and Reminders share one page**: the timer on the left, today's
  reminders on the right, so what to work on sits beside the time to work
  on it. The header has one tab fewer; this page is a little wider than the
  others to fit both.
- **Reminders** look closer to macOS's: an orange title with the number
  still open, a thin ring per reminder that fills with an orange dot when
  ticked, the title struck through at once, then the row folds away; a
  last "New Reminder" row to add one. Four whole rows show before the list
  scrolls.
- **Alerts are slimmer**: as tall as their text (one line or two), with a
  smaller badge and tighter type, so a short alert wastes no room.
- The island opens when the pointer **rests** on it; passing over it on the
  way to the clock or a menu leaves it closed.

### Fixed

- The island no longer flickers open and closed when the pointer passes
  over the top bar, or when it shrinks under a still pointer after
  switching to a narrower page.
- Opening, closing and resizing settle cleanly, with no one-pixel wobble at
  the end, and stop drawing sooner.
- Closing the island right after ticking a reminder no longer leaves the
  list frozen; the reminder stays done.
- The volume alert no longer repeats "Volume" under its title.

## [0.3.0] - 2026-10-21

### Added

- **Calls** in the island, from any app or browser (WhatsApp, Telegram,
  Meet, Zoom, Discord…): the closed island shows a green phone and how long
  the call has lasted, and a **Call** page appears for as long as the call
  lasts. It shows the call live, so you see yourself and whoever you call
  while you work in other windows, with **Mute** and **Open** to go back to
  the call. The preview is drawn by GNOME Shell from the window already on
  screen, so it costs about nothing and records nothing; it hides while you
  share your screen. Both can be turned off in Settings → Calls.
- Right-clicking the closed island during a call brings the call to the
  front.

### Changed

- **Tasks are now Reminders**, laid out as macOS Reminders: an orange title
  and count, a round tick box, plain rows under hairlines and a New
  Reminder row last (Enter adds one and leaves the field ready for the
  next). A ticked reminder is struck through and folds away a moment later;
  tapping it again in that moment undoes it. Finished ones are no longer
  listed, and the progress ring is gone.
- The shelf holds six files, which still fit the open island's width.
- A file on its way to the shelf lights the drop area with a dashed, tinted
  outline, brighter under the pointer.
- On-screen displays that come with only an icon (touchpad, airplane mode,
  camera) get a title and an On/Off state in the alert.
- During a call the closed island stays slim: the camera and screen-sharing
  dots sit beside the activity, and the open island's header no longer
  repeats the call.

### Fixed

- Typing into the island (Super+V, a new reminder) works on GNOME Shell 50
  and later.
- The first paste from the clipboard history after logging in is no longer
  lost, and pasting works on every keyboard layout (Dvorak, Colemak, a
  Ctrl/Caps swap, Russian, Greek…) and in the Ptyxis terminal.
- A call's preview and Open stay with the window the call is in, and never
  pick another window of the same browser or an unrelated app.
- The microphone dot still shows when another app records during a call.
- The empty shelf shows the same icon in the island and in the shelf
  helper, whatever the icon theme.
- No more warnings in the log when Isle starts while the microphone is in
  use.

## [0.2.0] - 2026-10-21

### Added

- A **Calendar** page, like macOS's Calendar widget: the month on the left
  (today in red, a dot under days with events) and the chosen day's events
  on the right. It shows the desktop's calendars (Google and others through
  Online Accounts) and events written in one line on the island, such as
  "Dinner 8:00 pm" or "Standup 9:00-9:15". isled keeps them
  (`Calendar1` on D-Bus).
- Files on the shelf can be copied with a click: a picture as the image
  itself, so it pastes straight into WhatsApp, an AI chat or any web page,
  and other files as files. Double-click opens a file.
- When a file lands on the shelf, the island glows in its colour from its
  bottom corners.

### Changed

- The lyrics look like Apple Music's: the line being sung large and bright,
  the others smaller and dimmer, faded edges, breathing dots for pauses and
  a long intro, a clearer column for the player with the music bars by the
  title, and proper states for loading, no lyrics and the service being
  unreachable.
- Dropping a file on the island is much quicker: the shelf helper starts as
  soon as a drag begins and takes the drop as soon as the island opens over
  it (about 0.25 s, from over a second), showing where the file will land.
  A drag that goes off elsewhere closes the island again.
- The cover's colour for the lyrics wash is its main hue, not an average
  that could turn two colours into grey.
- The open island lays its pages out at full size from the start and
  reveals them as it grows, so nothing reflows during the animation.

### Fixed

- Files on the shelf keep their × to remove them: a picture's thumbnail
  made its tile grow until the × was pushed out of sight. Tiles now all
  have one size, the same in the helper's window and on the island.
- The island stays steady when a browser moves on to the next video: the
  song, its cover and the dancing music bars no longer drop out for a
  moment between songs.
- Big photos on the shelf no longer make the island stutter as it opens;
  previews are made off the shell's main thread.
- Lyrics opened on a song already playing scroll to the right line.
- No more warnings in the log when the island starts.

## [0.1.2] - 2026-10-20

### Added

- Support for GNOME Shell 47, 48, 49, 50 and 51 besides 46, so Isle installs
  on Ubuntu 24.04 up to 26.10 and the Fedora releases with those versions,
  looking and moving the same on each. Volume and brightness alerts follow
  GNOME 49's new way of showing them, per monitor.
- An [installation guide](docs/install.md): checking the desktop, installing,
  updating, uninstalling, installing offline and troubleshooting.

### Fixed

- Lists scroll with a mouse wheel again: notifications, sound outputs and
  tasks only followed a touchpad.
- The music bars in the closed island keep dancing when the song changes;
  players that drop the title for a moment between songs (Spotify) froze
  them until the island was opened and closed.
- The playing app's badge stays on the cover's corner: with Spotify the
  cover drifted left, leaving a gap before the title, and the badge sat
  apart from it. The same in the song alert.
- `install.sh` finishes without a user service manager (over SSH, say);
  isled then starts when the extension first calls it.

## [0.1.1] - 2026-10-20

### Added

- A one-line install that needs no compiler or cloning:
  `curl -fsSL https://raw.githubusercontent.com/zickrian/isle/main/get.sh | bash`.
  It downloads the latest release package, checks its checksum and installs
  it, leaving an `isle-uninstall` command.
- Release packages with the programs ready-built
  (`isle-<version>-x86_64-linux.tar.gz`), made by a Release workflow for
  every version tag; `install.sh` uses ready-built programs when present.
- Notifications from one app fold into a stack, as on macOS: the newest
  card, the next one's edge under it and "+2 more from Chrome", which
  unfolds them under the app's name with "Show less".

### Changed

- A paused song keeps its cover in the closed island, with the music bars
  resting and dimmed, until the player closes.
- `isle-shelf` draws on the CPU (GTK's cairo renderer): about 28 MB instead
  of 40. A renderer set with `GSK_RENDERER` is kept.
- D-Bus names move to the project's own namespace,
  `io.github.zickrian.isle.*` (`/io/github/zickrian/isle/…`).
  `./install.sh` removes the activation files of the old names.

## [0.1.0] - 2026-10-20

The first release.

### Added

- A code of conduct (Contributor Covenant 2.1) and a security policy.
- A README with a demo, screenshots, installation steps for Ubuntu and
  Fedora, usage, measured resource use, privacy notes and troubleshooting.
- One look across every page, as on macOS: Isle's own solid icons for
  play, pause, skip, close, check, add and the folding arrows instead of
  the theme's; controls are pills and cards share a 12 px corner; the
  Clipboard / Files switch is a segmented control whose chosen segment is
  raised.
- Music laid out like macOS's Now Playing: a large cover beside the title,
  the scrubber and the controls, with lyrics and output as small buttons
  at the top right. Tasks stack today's progress under the ring, drop the
  repeated empty message, and scroll to the finished tasks when unfolded.
- Alerts: the first one shown measures its width right (Volume read
  "Vol…"); focus alerts tint their icon; a critical notification is red; a
  new song carries the playing app's icon; battery and Bluetooth rings hold
  a lit badge; "Keyboard brightness" reads "Keyboard light".
- The closed island keeps the clock centred and whole next to the privacy
  dots. Shelf files that are gone show a plain file icon.
- Tidier pages: Notifications fill the width under a slim row with the
  count and round Do Not Disturb and Clear All buttons; Focus shows the
  time inside its ring with the phase, today's total and one row of
  controls beside it; the clipboard search is a round button that opens
  into a field.
- Notification cards like macOS's: the app's icon (a system one on a grey
  tile), the title with its time on the right, and a close button in the
  time's place under the pointer. Lists fade out at an edge that scrolls
  on instead of being cut.
- Alerts look like iOS's: icon badges lit in the alert's colour with a soft
  gradient, and Caps Lock as its own icon with an "On" / "Off" pill.
- Type like macOS: SF Pro where installed, else Inter, which the installer
  now puts in `~/.local/share/fonts/isle`; semibold titles, tighter
  tracking on large figures, medium-weight top bar text instead of the
  theme's bold, and the date without the year ("Tue 20 Oct"). The shelf's
  drag-and-drop window uses the same type.
- Tabs in the open island's header, like NotchNook: one per page, the open
  one named on a dark grey pill, and a red dot while notifications are unseen.
  They replace the side arrows and page dots. The island
  reopens on the page picked last (for 5 minutes), and stays on the Shelf
  after a file was dragged onto it.
- The playing app's icon on the cover's corner, found by name when the
  player gives no desktop entry (Chrome).
- A glass top bar, the new default: see-through with no colour of its own,
  and the island as a black notch hanging from the top of the screen, like
  a MacBook's notch. "Top bar" in the settings picks glass,
  black (the island blends in) or the theme's colour.
- The closed island sits inside the top bar (32 px), like a MacBook's notch:
  maximised windows start right below it and the island never covers an
  app. Alerts and the open island still hang below
  for as long as they are shown. "Island inside the top bar" in the settings
  turns it off.

- The island in the GNOME top bar: compact, alert and open presentations
  with spring-driven morphs and a black top bar it blends into.
- Music with cover art, scrubber, controls and synced lyrics (LRCLIB).
- GNOME notifications in the island, a Notifications page and Do Not Disturb.
- Pomodoro focus timer with phase chips.
- Tasks as a plain list with a daily reset of finished tasks: a progress
  ring, an always-ready add field, rename by clicking a title, and finished
  tasks folded under "Completed".
- File shelf with drag and drop through the `isle-shelf` helper.
- Alerts for charging, battery, losing the connection, Bluetooth, volume,
  brightness and Caps Lock.
- Privacy dots for the camera, microphone and screen sharing; a screen
  recording timer with a stop button.
- Volume and output device switching on the music page.
- Daily focus totals and Do Not Disturb during focus sessions.
- Rubber-band stretch when the volume is pressed past its limit.
- Clipboard history on the Shelf page (Clipboard · Files): the 20 latest
  copies plus up to 10 pinned, as cards with search and type filters; click
  to copy, Super+V and Enter to paste, hand-offs to Tasks and Files;
  password managers and chosen apps are ignored.
- The Files tab holds up to 5 files with no scrolling; dragging a file
  towards the island opens it and says whether the file can land, and the
  island stays open while a file is dragged out.
- Right-click brings the music player to the front.
- GNOME's calendar drop-down no longer appears alongside the island.
- Shelf files can be removed with × even without the `isle-shelf` helper.
- The focus timer, and Do Not Disturb during focus, survive the lock screen
  and an `isled` restart.
- `isled` D-Bus service, install and uninstall scripts, product spec and
  D-Bus API docs.

### Changed

- The extension's id is `isle@zickrian.github.io`. `./install.sh` replaces
  an install under the development id `isle@isle.github.io`, keeping its
  settings.

### Fixed

- Lyrics no longer say "Check your connection" when LRCLIB is only busy:
  busy answers are retried at once, and the island tells a busy service
  from being offline. Lookups for YouTube titles are more robust, and media
  without an artist (an Instagram reel) is no longer matched to a random
  song.
- Files can be dragged onto the shelf again: its drop window appeared in the
  middle of the screen instead of over the island.
- An app's logo sent in place of a cover (Chrome does when a page has none)
  is shown on its own, without a dark tile behind it.
- Swiping between pages no longer skips a page or stalls: each swipe was
  counted twice (as a smooth scroll and as clicks), and the leftover of one
  swipe carried into the next. Sideways swipes now turn pages even over
  lists and lyrics.
- Alerts on a glass bar no longer start with an empty black band, and fit
  their content instead of always being 380 px wide.
- With Blur my Shell's popup blur on, the Tasks and clipboard search fields
  were black on black: it restyles every text field in the shell.
- Lyrics over a grey cover are readable: neutral covers now tint the island
  dark, vivid ones bright.
- Text is at least 12 px throughout.

[Unreleased]: https://github.com/zickrian/isle/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/zickrian/isle/compare/v0.5.0...v0.7.0
[0.5.0]: https://github.com/zickrian/isle/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/zickrian/isle/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/zickrian/isle/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/zickrian/isle/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/zickrian/isle/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/zickrian/isle/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/zickrian/isle/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/zickrian/isle/releases/tag/v0.1.0
