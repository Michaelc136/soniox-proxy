#!/usr/bin/env python3
"""Loop or trim raw PCM s16le mono 16 kHz audio to an exact duration.

Repeats the source with a short silence between repeats until the target
length is reached, trims to the exact sample count, and applies a 50 ms
fade-out so a mid-word cut does not click.

Usage: fit-raw.py IN.raw OUT.raw SECONDS [GAP_MS=600]
"""
import sys

import numpy as np

SR = 16000


def main():
    if len(sys.argv) < 4:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    src, out, seconds = sys.argv[1], sys.argv[2], float(sys.argv[3])
    gap_ms = float(sys.argv[4]) if len(sys.argv) > 4 else 600.0

    data = np.fromfile(src, dtype="<i2")
    if len(data) == 0:
        print(f"{src}: empty source", file=sys.stderr)
        sys.exit(1)
    target = int(seconds * SR)
    gap = np.zeros(int(gap_ms / 1000 * SR), dtype="<i2")

    pieces = []
    total = 0
    repeats = 0
    while total < target:
        pieces.append(data)
        total += len(data)
        pieces.append(gap)
        total += len(gap)
        repeats += 1
    full = np.concatenate(pieces)[:target].copy()

    fade = min(int(0.05 * SR), target)
    if fade > 0:
        ramp = np.linspace(1.0, 0.0, fade)
        full[-fade:] = (full[-fade:].astype(np.float64) * ramp).astype("<i2")

    full.tofile(out)
    print(
        f"{out}: {seconds:.0f}s from a {len(data) / SR:.1f}s source "
        f"({repeats} pass{'es' if repeats != 1 else ''}), {len(full) * 2} bytes"
    )


if __name__ == "__main__":
    main()
