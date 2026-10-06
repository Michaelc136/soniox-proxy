#!/bin/bash
# Runs the reproduction matrix, at most MAX_PARALLEL (default 3) streams at a time,
# then builds summary.md and matrix.json with summarize.js.
#
# Direct mode, six runs (A/B/C gap x language_hints_strict off/on) straight to Soniox:
#   SONIOX_API_KEY=<key> ./run-matrix.sh            full runs (2 + 12 + 3 minutes of audio each)
#   SONIOX_API_KEY=<key> SMOKE=1 ./run-matrix.sh    1 minute runs to validate the pipeline
#
# Proxy mode, three runs (A/B/C) through the Selah proxy, which holds the Soniox key and
# sets language_hints_strict and language identification itself, so there is no strict
# on/off axis. HARNESS_JWT comes from mint-jwt.sh, which execs this script with it set:
#   VIA_PROXY=wss://<proxy-host> ./mint-jwt.sh ./run-matrix.sh
#   VIA_PROXY=wss://<proxy-host> SMOKE=1 ./mint-jwt.sh ./run-matrix.sh
# Proxy-mode output goes to $HARNESS_DIR/proxy so it never mixes with direct-mode runs.
#
# Optional: HARNESS_DIR (output root; audio lives in $HARNESS_DIR/audio), MAX_PARALLEL,
# HARNESS_LIVE_SESSIONS (recorded in the summary), RUNS="A|B" (subset; in direct mode append
# --strict inside quotes per entry, e.g. RUNS="A|A --strict"). Credentials are read from the
# environment only; this script never prints or stores them.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HARNESS_DIR="${HARNESS_DIR:-/private/tmp/claude-501/-Users-michaelcolley/09c687da-aa28-4f09-b63f-5172f23505f0/scratchpad/harness}"
MAX="${MAX_PARALLEL:-3}"
VIA_PROXY="${VIA_PROXY:-}"

MODE_ARGS=()
if [ -n "$VIA_PROXY" ]; then
    : "${HARNESS_JWT:?HARNESS_JWT must be set in the environment for proxy mode (run through mint-jwt.sh)}"
    MODE_ARGS=(--via-proxy "$VIA_PROXY")
    OUT="$HARNESS_DIR/proxy"
else
    : "${SONIOX_API_KEY:?SONIOX_API_KEY must be set in the environment}"
    OUT="$HARNESS_DIR"
fi
LOGS="$OUT/logs"
mkdir -p "$LOGS"

SUFFIX=""
EXTRA=()
if [ "${SMOKE:-0}" = "1" ]; then
    SUFFIX="-smoke"
    EXTRA=(--smoke)
fi

if [ -n "${RUNS:-}" ]; then
    IFS='|' read -r -a RUN_LIST <<< "$RUNS"
elif [ -n "$VIA_PROXY" ]; then
    RUN_LIST=("A" "B" "C")
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
    if [ -n "$VIA_PROXY" ]; then
        if [ "${1:-}" = "--strict" ]; then
            echo "proxy mode has no --strict axis (the proxy decides); drop it from RUNS" >&2
            exit 1
        fi
        variant="proxy"
    else
        variant="nostrict"
        [ "${1:-}" = "--strict" ] && variant="strict"
    fi
    label="$cond-$variant$SUFFIX"
    echo "$(date -u +%FT%TZ) start $label"
    # ${X[@]+"${X[@]}"} expands to nothing when the array is empty (bash 3.2 + set -u safe).
    node "$HERE/reproduce-stall.js" --condition "$cond" "$@" ${MODE_ARGS[@]+"${MODE_ARGS[@]}"} ${EXTRA[@]+"${EXTRA[@]}"} \
        --audio-dir "$HARNESS_DIR/audio" --out-dir "$OUT" \
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
    node "$HERE/summarize.js" "$OUT" --smoke
else
    node "$HERE/summarize.js" "$OUT"
fi
