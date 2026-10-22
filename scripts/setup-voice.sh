#!/usr/bin/env bash
# Sets up speech recognition for Isle's voice assistant: faster-whisper in a venv (with CUDA when there
# is an NVIDIA GPU) and the model. The assistant answers with Claude Code, Codex or agy.
# Installed as `isle-setup-voice`; also runs from the source folder as scripts/setup-voice.sh.
set -euo pipefail

DATA="${XDG_DATA_HOME:-$HOME/.local/share}/isle"
# From the source folder, its speech helper; installed, the one install.sh put in place.
HELPER="$(dirname "$(readlink -f "$0")")/../data/isle-whisper.py"
VENV="$DATA/voice-venv"
SCHEMAS="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/isle@zickrian.github.io/schemas"
# The model given, else the one chosen in Settings (tiny, base, small or medium), else small.
MODEL="${1:-$(gsettings --schemadir "$SCHEMAS" get org.gnome.shell.extensions.isle voice-speech-model 2>/dev/null | tr -d "'" || true)}"
MODEL="${MODEL:-small}"

step() { printf '\033[1m==> %s\033[0m\n' "$*"; }

command -v python3 >/dev/null || { echo "Please install Python 3 first." >&2; exit 1; }
if ! python3 -c "import ensurepip" 2>/dev/null; then
    echo "Python cannot make a venv here; install it first:" >&2
    echo "  Ubuntu/Debian: sudo apt install python3-venv    Fedora: sudo dnf install python3" >&2
    exit 1
fi

step "Making the venv in $VENV"
python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
step "Installing faster-whisper (about 300 MB; a few minutes)"
"$VENV/bin/pip" install --progress-bar on faster-whisper
if command -v nvidia-smi >/dev/null; then
    step "Adding CUDA libraries for the NVIDIA GPU (about 1.5 GB)"
    "$VENV/bin/pip" install --progress-bar on nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
fi
if [ -f "$HELPER" ]; then
    install -Dm755 "$HELPER" "$DATA/isle-whisper.py"
elif [ ! -f "$DATA/isle-whisper.py" ]; then
    echo "The speech helper is missing; install Isle again, then run isle-setup-voice." >&2
    exit 1
fi

step "Downloading the '$MODEL' speech model"
"$VENV/bin/python" -I -c "from faster_whisper import WhisperModel; WhisperModel('$MODEL', device='cpu', compute_type='int8')"

# What isled itself finds: the AI it answers with must be installed and signed in where it looks.
step "Checking"
ISLED="$(command -v isled || echo "$HOME/.local/bin/isled")"
if [ -x "$ISLED" ]; then
    "$ISLED" --doctor
else
    echo "isled is not installed yet; install Isle, then run isled --doctor."
fi
echo "Done. Pick the AI in Settings → Voice if you have more than one, then press Super+I and speak."
