#!/usr/bin/env python3
"""Print duration, RMS and peak (dBFS) for raw PCM s16le mono 16 kHz files.

Usage: audio-stats.py FILE.raw [FILE.raw ...]
"""
import math
import os
import sys

import numpy as np

SR = 16000


def main():
    for path in sys.argv[1:]:
        data = np.fromfile(path, dtype="<i2").astype(np.float64) / 32768.0
        if len(data) == 0:
            print(f"{os.path.basename(path)}: empty")
            continue
        rms = math.sqrt(float(np.mean(np.square(data))))
        peak = float(np.max(np.abs(data)))
        rms_db = 20 * math.log10(rms) if rms > 0 else float("-inf")
        peak_db = 20 * math.log10(peak) if peak > 0 else float("-inf")
        print(
            f"{os.path.basename(path)}: {len(data) / SR:.1f}s, "
            f"rms {rms_db:.1f} dBFS, peak {peak_db:.1f} dBFS"
        )


if __name__ == "__main__":
    main()
