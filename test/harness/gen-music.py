#!/usr/bin/env python3
"""Synthetic instrumental audio for harness condition B.

Sum of slowly changing sine chords (three notes plus a bass an octave below the
root, each with three harmonics, slow tremolo, 1 s crossfades every 8 s) over a
low noise bed, normalized to about -20 dBFS RMS. Output is raw PCM s16le mono
16 kHz, the same format the proxy streams to Soniox.

Usage: gen-music.py SECONDS OUT.raw [SEED]
"""
import math
import sys

import numpy as np

SR = 16000
TARGET_RMS_DBFS = -20.0
NOISE_RMS_DBFS = -40.0
BLOCK_S = 8.0
FADE_S = 1.0

# C major, A minor, F major, G major; last entry is the bass note.
CHORDS = [
    [261.63, 329.63, 392.00, 130.81],
    [220.00, 261.63, 329.63, 110.00],
    [174.61, 220.00, 261.63, 87.31],
    [196.00, 246.94, 293.66, 98.00],
]


def dbfs(x):
    rms = math.sqrt(float(np.mean(np.square(x)))) if len(x) else 0.0
    return 20 * math.log10(rms) if rms > 0 else float("-inf")


def main():
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    seconds = float(sys.argv[1])
    out = sys.argv[2]
    seed = int(sys.argv[3]) if len(sys.argv) > 3 else 7
    rng = np.random.default_rng(seed)

    n = int(seconds * SR)
    sig = np.zeros(n, dtype=np.float64)
    block = int(BLOCK_S * SR)
    fade = int(FADE_S * SR)

    pos = 0
    idx = 0
    while pos < n:
        end = min(pos + block + fade, n)
        length = end - pos
        t = np.arange(length) / SR
        chord = CHORDS[idx % len(CHORDS)]
        seg = np.zeros(length)
        for k, f in enumerate(chord):
            amp = 1.0 if k < 3 else 0.7
            detune = 1.0 + rng.uniform(-0.002, 0.002)
            trem = 1.0 + 0.15 * np.sin(
                2 * np.pi * rng.uniform(0.1, 0.4) * t + rng.uniform(0, 2 * np.pi)
            )
            w = 2 * np.pi * f * detune * t
            seg += amp * trem * (np.sin(w) + 0.5 * np.sin(2 * w) + 0.25 * np.sin(3 * w))
        env = np.ones(length)
        fi = min(fade, length)
        env[:fi] = np.linspace(0.0, 1.0, fi)
        fo = min(fade, length)
        env[length - fo:] = np.minimum(env[length - fo:], np.linspace(1.0, 0.0, fo))
        sig[pos:end] += seg * env
        pos += block
        idx += 1

    rms = math.sqrt(float(np.mean(np.square(sig))))
    sig *= (10 ** (TARGET_RMS_DBFS / 20)) / rms

    noise = rng.standard_normal(n)
    noise = np.convolve(noise, np.ones(32) / 32, mode="same")
    noise *= (10 ** (NOISE_RMS_DBFS / 20)) / math.sqrt(float(np.mean(np.square(noise))))
    sig += noise

    sig = np.clip(sig, -0.99, 0.99)
    pcm = (sig * 32767).astype("<i2")
    pcm.tofile(out)
    print(
        f"{out}: {seconds:.0f}s, rms {dbfs(sig):.1f} dBFS, "
        f"peak {20 * math.log10(float(np.max(np.abs(sig)))):.1f} dBFS, {len(pcm) * 2} bytes"
    )


if __name__ == "__main__":
    main()
