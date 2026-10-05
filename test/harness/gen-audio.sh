#!/bin/bash
# Generates the reproduction-harness audio as raw PCM s16le, 16 kHz, mono
# (the format the proxy streams to Soniox) into $HARNESS_DIR/audio:
#
#   en-pre.raw          English speech, PRE_S seconds (default 120)
#   en-post.raw         English speech, POST_S seconds (default 180)
#   gap-A-silence.raw   digital silence, GAP_S seconds (default 720)
#   gap-B-music.raw     synthetic instrumental (gen-music.py), GAP_S seconds
#   gap-C-spanish.raw   Spanish speech looped, GAP_S seconds
#
# Speech comes from macOS `say` exported with --data-format=LEI16@16000 and
# converted to raw PCM with ffmpeg. Voices: EN_VOICE (default Samantha, en_US)
# and ES_VOICE (default Paulina, es_MX); run `say -v '?'` to see what is installed.
#
# Requires: say, ffmpeg, python3 with numpy.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HARNESS_DIR="${HARNESS_DIR:-/private/tmp/claude-501/-Users-michaelcolley/09c687da-aa28-4f09-b63f-5172f23505f0/scratchpad/harness}"
OUT="$HARNESS_DIR/audio"
EN_VOICE="${EN_VOICE:-Samantha}"
ES_VOICE="${ES_VOICE:-Paulina}"
PRE_S="${PRE_S:-120}"
GAP_S="${GAP_S:-720}"
POST_S="${POST_S:-180}"
BYTES_PER_SECOND=32000

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing tool: $1" >&2; exit 1; }; }
need say
need ffmpeg
need python3
python3 -c 'import numpy' 2>/dev/null || { echo "python3 needs numpy" >&2; exit 1; }

voice_ok() { say -v '?' 2>/dev/null | grep -q "^$1 "; }
voice_ok "$EN_VOICE" || { echo "English voice '$EN_VOICE' is not installed (say -v '?')" >&2; exit 1; }
voice_ok "$ES_VOICE" || { echo "Spanish voice '$ES_VOICE' is not installed (say -v '?')" >&2; exit 1; }

mkdir -p "$OUT"

# speech VOICE PASSAGE OUT.raw
speech() {
    local tmp="$OUT/.tmp-$$.wav"
    say -v "$1" -f "$2" -o "$tmp" --file-format=WAVE --data-format=LEI16@16000
    ffmpeg -v error -y -i "$tmp" -f s16le -ac 1 -ar 16000 "$3"
    rm -f "$tmp"
}

echo "English pre-gap passage ($EN_VOICE, ${PRE_S}s)"
speech "$EN_VOICE" "$HERE/passages/en-pre.txt" "$OUT/.en-pre-src.raw"
python3 "$HERE/fit-raw.py" "$OUT/.en-pre-src.raw" "$OUT/en-pre.raw" "$PRE_S"

echo "English post-gap passage ($EN_VOICE, ${POST_S}s)"
speech "$EN_VOICE" "$HERE/passages/en-post.txt" "$OUT/.en-post-src.raw"
python3 "$HERE/fit-raw.py" "$OUT/.en-post-src.raw" "$OUT/en-post.raw" "$POST_S"

echo "Gap A: digital silence (${GAP_S}s)"
head -c $((GAP_S * BYTES_PER_SECOND)) /dev/zero > "$OUT/gap-A-silence.raw"

echo "Gap B: synthetic instrumental (${GAP_S}s)"
python3 "$HERE/gen-music.py" "$GAP_S" "$OUT/gap-B-music.raw"

echo "Gap C: Spanish speech ($ES_VOICE, ${GAP_S}s, looped)"
speech "$ES_VOICE" "$HERE/passages/es-gap.txt" "$OUT/.es-gap-src.raw"
python3 "$HERE/fit-raw.py" "$OUT/.es-gap-src.raw" "$OUT/gap-C-spanish.raw" "$GAP_S" 1200

rm -f "$OUT"/.*-src.raw
echo
python3 "$HERE/audio-stats.py" "$OUT"/en-pre.raw "$OUT"/en-post.raw "$OUT"/gap-A-silence.raw "$OUT"/gap-B-music.raw "$OUT"/gap-C-spanish.raw
