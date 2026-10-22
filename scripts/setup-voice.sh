#!/usr/bin/env bash
# Sets up speech recognition for Isle's voice assistant: faster-whisper in a venv (with CUDA when there
# is an NVIDIA GPU) and the model. The assistant answers with Claude Code, Codex or agy.
# Installed as `isle-setup-voice`; also runs from the source folder as scripts/setup-voice.sh.
set -euo pipefail

DATA="${XDG_DATA_HOME:-$HOME/.local/share}/isle"
# From the source folder, its speech helper; installed, the one install.sh put in place.
HELPER="$(dirname "$(readlink -f "$0")")/../data/isle-whisper.py"
VENV="$DATA/voice-venv"
# The model chosen in Settings (tiny, base, small or medium); small by default.
MODEL="${1:-small}"

step() { printf '\033[1m==> %s\033[0m\n' "$*"; }

# The assistant answers with one of these, each with your own sign-in; see the README.
found=""
for ai in claude codex agy; do
    command -v "$ai" >/dev/null || [ -x "$HOME/.local/bin/$ai" ] && found="$found $ai"
done
[ -n "$found" ] && echo "AI found:$found (pick one in Settings → Voice)." ||
    echo "No AI found: install Claude Code, Codex or Antigravity (agy) and sign in; the assistant needs one."

command -v python3 >/dev/null || { echo "Please install Python 3 first." >&2; exit 1; }
if ! python3 -c "import ensurepip" 2>/dev/null; then
    echo "Python cannot make a venv here; install it first:" >&2
    echo "  Ubuntu/Debian: sudo apt install python3-venv    Fedora: sudo dnf install python3" >&2
    exit 1
fi

step "Making the venv in $VENV"
python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q faster-whisper
if command -v nvidia-smi >/dev/null; then
    step "Adding CUDA libraries for the GPU"
    "$VENV/bin/pip" install -q nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
fi
if [ -f "$HELPER" ]; then
    install -Dm755 "$HELPER" "$DATA/isle-whisper.py"
elif [ ! -f "$DATA/isle-whisper.py" ]; then
    echo "The speech helper is missing; install Isle again, then run isle-setup-voice." >&2
    exit 1
fi

step "Downloading the '$MODEL' speech model"
"$VENV/bin/python" -I -c "from faster_whisper import WhisperModel; WhisperModel('$MODEL', device='cpu', compute_type='int8')"
echo "Done. Press Super+I and speak."
