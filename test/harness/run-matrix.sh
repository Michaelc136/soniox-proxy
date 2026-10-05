#!/bin/bash
# Runs the six reproduction conditions (A/B/C gap x language_hints_strict off/on)
# against Soniox directly, at most MAX_PARALLEL (default 3) streams at a time,
# then builds summary.md and matrix.json with summarize.js.
#
# Usage:
#   SONIOX_API_KEY=<key> ./run-matrix.sh            full runs (2 + 12 + 3 minutes of audio each)
#   SONIOX_API_KEY=<key> SMOKE=1 ./run-matrix.sh    1 minute runs to validate the pipeline
#
# Optional: HARNESS_DIR (output root), MAX_PARALLEL, HARNESS_LIVE_SESSIONS (recorded in the
# summary), RUNS="A B" (subset; append --strict inside quotes per entry, e.g. RUNS="A|A --strict").
# The key is read from the environment only; this script never prints or stores it.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HARNESS_DIR="${HARNESS_DIR:-/private/tmp/claude-501/-Users-michaelcolley/09c687da-aa28-4f09-b63f-5172f23505f0/scratchpad/harness}"
LOGS="$HARNESS_DIR/logs"
MAX="${MAX_PARALLEL:-3}"
: "${SONIOX_API_KEY:?SONIOX_API_KEY must be set in the environment}"

mkdir -p "$LOGS"

SUFFIX=""
EXTRA=()
if [ "${SMOKE:-0}" = "1" ]; then
    SUFFIX="-smoke"
    EXTRA=(--smoke)
fi

if [ -n "${RUNS:-}" ]; then
    IFS='|' read -r -a RUN_LIST <<< "$RUNS"
else
    RUN_LIST=("A" "B" "C" "A --strict" "B --strict" "C --strict")
fi

for f in en-pre.raw en-post.raw gap-A-silence.raw gap-B-music.raw gap-C-spanish.raw; do
    [ -s "$HARNESS_DIR/audio/$f" ] || { echo "missing $HARNESS_DIR/audio/$f (run gen-audio.sh)" >&2; exit 1; }
done

pids=()
labels=()
count=0
for entry in "${RUN_LIST[@]}"; do
    # shellcheck disable=SC2086
    set -- $entry
    cond="$1"; shift
    strict="nostrict"
    [ "${1:-}" = "--strict" ] && strict="strict"
    label="$cond-$strict$SUFFIX"
    echo "$(date -u +%FT%TZ) start $label"
    # ${EXTRA[@]+"${EXTRA[@]}"} expands to nothing when the array is empty (bash 3.2 + set -u safe).
    node "$HERE/reproduce-stall.js" --condition "$cond" "$@" ${EXTRA[@]+"${EXTRA[@]}"} --out-dir "$HARNESS_DIR" \
        > "$LOGS/$label.log" 2>&1 &
    pids+=($!)
    labels+=("$label")
    count=$((count + 1))
    sleep 2
    if [ $((count % MAX)) -eq 0 ]; then
        for i in "${!pids[@]}"; do
            wait "${pids[$i]}"; rc=$?; echo "$(date -u +%FT%TZ) done ${labels[$i]} exit=$rc"
        done
        pids=(); labels=()
    fi
done
for i in "${!pids[@]}"; do
    wait "${pids[$i]}"; rc=$?; echo "$(date -u +%FT%TZ) done ${labels[$i]} exit=$rc"
done

if [ "${SMOKE:-0}" = "1" ]; then
    node "$HERE/summarize.js" "$HARNESS_DIR" --smoke
else
    node "$HERE/summarize.js" "$HARNESS_DIR"
fi
