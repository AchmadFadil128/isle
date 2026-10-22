#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later

# Speech to text for Isle's voice assistant, run by isled from the venv made by scripts/setup-voice.sh.
# Reads JSON lines {"audio": path to raw 16 kHz mono s16le}; answers {"text"} or {"error"}.

import argparse
import ctypes
import glob
import json
import os
import sys

import numpy as np


def preload_cuda():
    # The pip-installed CUDA libraries are not on the loader's path; load them by hand.
    import nvidia

    for pattern in ("cublas/lib/libcublasLt.so.*", "cublas/lib/libcublas.so.*", "cudnn/lib/libcudnn*.so.*"):
        for path in sorted(glob.glob(os.path.join(nvidia.__path__[0], pattern))):
            try:
                ctypes.CDLL(path, mode=ctypes.RTLD_GLOBAL)
            except OSError:
                pass


try:
    preload_cuda()
except ImportError:
    pass

from faster_whisper import WhisperModel  # noqa: E402


def reply(**message):
    print(json.dumps(message), flush=True)


DEVICES = (("cuda", "int8_float16"), ("cpu", "int8"))
# isled passes half the cores, so transcribing never takes the whole computer; 0 lets CTranslate2 pick.
THREADS = int(os.environ.get("ISLE_WHISPER_THREADS", "0") or 0)


def load(name, devices=DEVICES):
    # The GPU when CUDA works, else the CPU.
    for device, compute in devices:
        try:
            # Only from disk: a download here would leave the island waiting with no word why.
            return WhisperModel(name, device=device, compute_type=compute, local_files_only=True,
                                cpu_threads=THREADS), device
        except Exception as err:  # noqa: BLE001 (CUDA fails in many ways)
            last = err
    raise last


# Phrases Whisper makes up from noise (it learnt them from video subtitles).
HALLUCINATIONS = ("terima kasih", "thank you", "thanks for watching", "terima kasih kerana menonton",
                  "terima kasih telah menonton", "sampai jumpa", "subtitle", "selamat menonton")


def heard(segment):
    # Noise has a high no-speech score (~0.9) and real speech a low one (~0.02); a usual
    # made-up phrase must sound clearly like speech to count.
    words = segment.text.strip().lower().strip(".!?,")
    limit = 0.2 if any(words.startswith(phrase) for phrase in HALLUCINATIONS) else 0.5
    return segment.no_speech_prob < limit


# Whisper hears Indonesian as Malay at times; both mean Indonesian here.
ALIASES = {"ms": "id"}


def transcribe(model, audio, language):
    # "id,en": whichever of these it sounds most like; one code: only that; empty: any.
    allowed = [code for code in language.split(",") if code]
    options = dict(beam_size=5, vad_filter=True, condition_on_previous_text=False)
    segments, info = model.transcribe(audio, language=allowed[0] if len(allowed) == 1 else None, **options)
    if len(allowed) > 1 and ALIASES.get(info.language, info.language) not in allowed:
        scores = {}
        for code, prob in info.all_language_probs or []:
            code = ALIASES.get(code, code)
            scores[code] = scores.get(code, 0) + prob
        best = max(allowed, key=lambda code: scores.get(code, 0))
        # Segments come lazily, so the first guess is dropped before any decoding.
        segments, _ = model.transcribe(audio, language=best, **options)
    return " ".join(s.text.strip() for s in segments if heard(s)).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default="")
    args = parser.parse_args()

    try:
        model, device = load(args.model)
    except Exception as err:  # noqa: BLE001
        missing = "local_files_only" in str(err) or "snapshot" in str(err).lower()
        reply(error=f"model {args.model} not downloaded" if missing else f"could not load the speech model: {err}")
        return
    reply(ready=True, device=device)

    for line in sys.stdin:
        try:
            path = json.loads(line)["audio"]
            audio = np.fromfile(path, dtype=np.int16).astype(np.float32) / 32768.0
            try:
                text = transcribe(model, audio, args.language)
            except RuntimeError:
                # CUDA loaded but cannot run (a missing library): the CPU from now on.
                if device != "cuda":
                    raise
                model, device = load(args.model, DEVICES[1:])
                text = transcribe(model, audio, args.language)
            reply(text=text)
        except Exception as err:  # noqa: BLE001
            reply(error=str(err))


if __name__ == "__main__":
    main()
