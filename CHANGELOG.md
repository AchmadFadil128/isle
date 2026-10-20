# Changelog

All notable changes to Isle are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Tabs in the open island's header, like NotchNook: one per page, the open
  one named in a lit pill, and a red dot while notifications are unseen.
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
- Alerts on a glass bar no longer start with an empty black band.
- Text is at least 12 px throughout.
