#!/usr/bin/env bash
# Installs the latest Isle release for the current user, with no building:
#   curl -fsSL https://raw.githubusercontent.com/zickrian/isle/main/get.sh | bash
#
# ISLE_VERSION=0.1.1 picks a release; ISLE_PACKAGE=path/to/isle-….tar.gz
# installs a package already downloaded.
set -euo pipefail

REPO="zickrian/isle"
ARCH="$(uname -m)"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf 'Isle: %s\n' "$*" >&2; exit 1; }

for tool in curl tar sha256sum; do
    command -v "$tool" >/dev/null || fail "please install $tool first."
done
command -v gnome-shell >/dev/null || fail "GNOME Shell was not found; Isle is a GNOME Shell extension."
SHELL_VERSION="$(gnome-shell --version | grep -oE '[0-9]+' | head -n1)"
[ "$SHELL_VERSION" = 46 ] ||
    echo "Note: Isle is made for GNOME Shell 46, and this is GNOME Shell $SHELL_VERSION; it may not load."

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ -n "${ISLE_PACKAGE:-}" ]; then
    cp "$ISLE_PACKAGE" "$WORK/isle.tar.gz"
else
    if [ -n "${ISLE_VERSION:-}" ]; then
        api="https://api.github.com/repos/$REPO/releases/tags/v$ISLE_VERSION"
    else
        api="https://api.github.com/repos/$REPO/releases/latest"
    fi
    say "Finding the release"
    url="$(curl -fsSL "$api" |
        grep -oE "\"browser_download_url\": *\"[^\"]*-$ARCH-linux\\.tar\\.gz\"" |
        cut -d'"' -f4 | head -n1)" || true
    [ -n "$url" ] || fail "no release for $ARCH was found at github.com/$REPO/releases."

    say "Downloading $(basename "$url")"
    curl -fsSL "$url" -o "$WORK/isle.tar.gz"
    curl -fsSL "$url.sha256" -o "$WORK/isle.tar.gz.sha256"
    expected="$(cut -d' ' -f1 "$WORK/isle.tar.gz.sha256")"
    actual="$(sha256sum "$WORK/isle.tar.gz" | cut -d' ' -f1)"
    [ "$expected" = "$actual" ] || fail "the download is damaged (checksum mismatch); please try again."
fi

tar -C "$WORK" -xzf "$WORK/isle.tar.gz"
PACKAGE="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name 'isle-*' | head -n1)"
[ -n "$PACKAGE" ] || fail "the package has an unexpected layout."
"$PACKAGE/install.sh"

# The package's uninstaller stays around as a command.
install -Dm755 "$PACKAGE/uninstall.sh" "$HOME/.local/bin/isle-uninstall"
echo "To remove Isle later, run: isle-uninstall"
