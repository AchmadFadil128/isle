# Contributing to Isle

Thanks for helping! This guide covers how to build, test and send changes.

## Ground rules

- **The spec leads.** [`docs/product-spec.md`](docs/product-spec.md) defines
  how the island looks and behaves. If a change alters behaviour, update the
  spec in the same pull request.
- **Small details matter.** Every state change shows in the icon, not only in
  colour; disabled controls dim in place; nothing jumps. See "State details"
  in the spec.
- **Stay light.** No polling, no timers that run while nothing is visible, and
  animations that stop when they settle.
- **Logic goes in Rust.** The extension draws; rules that can be unit tested
  belong in `crates/isle-core`.

## Building

```sh
cargo build                     # isle-core and isled
cargo build -p isle-shelf       # needs libgtk-4-dev
./install.sh                    # build and install for your user
```

## Checks

Run these before sending a pull request (CI runs the same). They build
`isle-shelf` too, so they need the GTK 4 development files (`libgtk-4-dev`):

```sh
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
for f in gnome-extension/*.js gnome-extension/src/*.js gnome-extension/src/pages/*.js; do
    node --experimental-default-type=module --check "$f"
done
```

## Trying the extension without logging out

GNOME Shell can run nested inside your session:

```sh
dbus-run-session -- gnome-shell --nested --wayland
```

GNOME Shell caches extension code, so restart the nested shell after each
change. Logs:

```sh
journalctl --user -u isled -f                        # the daemon
journalctl -f /usr/bin/gnome-shell | grep -i isle    # the extension
```

## Code style

- Rust: `rustfmt` defaults, `clippy` clean, doc comments on public items.
- JavaScript: GNOME Shell's style (4 spaces, single quotes, ES modules);
  match the surrounding code.
- Comments explain *why*, not *what*.
- Every source file starts with `SPDX-License-Identifier: GPL-3.0-or-later`.

## Commits and pull requests

- One topic per pull request; describe what changed and how you tested it.
- Include screenshots for visual changes.
- By contributing you agree that your work is licensed under the
  GPL-3.0-or-later, like the rest of Isle.
