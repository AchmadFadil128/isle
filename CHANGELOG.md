# Changelog

All notable changes to Isle are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
