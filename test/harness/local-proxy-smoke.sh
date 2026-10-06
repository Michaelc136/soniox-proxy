#!/bin/bash
# Local smoke of the harness's proxy mode, nothing near production: boots
# test/mock-soniox.js and the real server.js (SONIOX_WS_URL -> the mock, the
# JWT verified against the real Supabase project exactly as production does),
# runs one short proxy-mode run through it, prints the summary fields that
# matter, and checks the server log shows the proxy injected
# language_hints_strict and logged the key redacted.
#
# Usage:
#   ./test/harness/local-proxy-smoke.sh            (re-execs itself through mint-jwt.sh when HARNESS_JWT is unset)
# Optional: HARNESS_DIR (audio must exist in $HARNESS_DIR/audio; output goes to $HARNESS_DIR/proxy-local),
# PHASE_SECONDS (default 10, so 30 s of audio), CONDITION (default A).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
if [ -z "${HARNESS_JWT:-}" ]; then
    exec "$HERE/mint-jwt.sh" "$0" "$@"
fi

HARNESS_DIR="${HARNESS_DIR:-/private/tmp/claude-501/-Users-michaelcolley/09c687da-aa28-4f09-b63f-5172f23505f0/scratchpad/harness}"
OUT="$HARNESS_DIR/proxy-local"
PHASE_SECONDS="${PHASE_SECONDS:-10}"
COND="${CONDITION:-A}"
LABEL="$COND-proxy-local"
ENV_FILE="${HARNESS_ENV_FILE:-$HOME/Desktop/selahtranslate/app.selahtranslate.com/.env.local}"
SUPA_URL="${SUPABASE_URL:-$(sed -n 's/^NEXT_PUBLIC_SUPABASE_URL=//p' "$ENV_FILE" | tail -n 1 | tr -d '"'"'"'\r')}"
SUPA_ANON="${SUPABASE_ANON_KEY:-$(sed -n 's/^NEXT_PUBLIC_SUPABASE_ANON_KEY=//p' "$ENV_FILE" | tail -n 1 | tr -d '"'"'"'\r')}"
[ -n "$SUPA_URL" ] && [ -n "$SUPA_ANON" ] || { echo "Supabase URL or anon key not found (set SUPABASE_URL and SUPABASE_ANON_KEY)" >&2; exit 1; }
[ -s "$HARNESS_DIR/audio/en-pre.raw" ] || { echo "missing $HARNESS_DIR/audio (run gen-audio.sh)" >&2; exit 1; }
mkdir -p "$OUT"

pids=()
cleanup() { for p in ${pids[@]+"${pids[@]}"}; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT

# Mock Soniox on a free port; it prints its URL once listening.
: > "$OUT/mock.log"
node --input-type=module -e "import('$ROOT/test/mock-soniox.js').then(async (m) => { const mock = await m.startMockSoniox(); console.log('MOCK_URL ' + mock.url); })" \
    > "$OUT/mock.log" 2>&1 &
pids+=($!)
MOCK_URL=""
for _ in $(seq 1 100); do
    MOCK_URL="$(sed -n 's/^MOCK_URL //p' "$OUT/mock.log")"
    [ -n "$MOCK_URL" ] && break
    sleep 0.1
done
[ -n "$MOCK_URL" ] || { echo "mock Soniox did not start:" >&2; cat "$OUT/mock.log" >&2; exit 1; }

# The real server.js on a free port, Soniox pointed at the mock.
PORT="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();})")"
: > "$OUT/server.log"
PORT="$PORT" SONIOX_WS_URL="$MOCK_URL" SONIOX_API_KEY="local-smoke-not-real" OPENAI_API_KEY="local-smoke-not-real" \
    SUPABASE_URL="$SUPA_URL" SUPABASE_ANON_KEY="$SUPA_ANON" \
    node "$ROOT/server.js" > "$OUT/server.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 100); do
    grep -q "running on port" "$OUT/server.log" && break
    sleep 0.1
done
grep -q "running on port" "$OUT/server.log" || { echo "server.js did not start:" >&2; cat "$OUT/server.log" >&2; exit 1; }
echo "mock=$MOCK_URL proxy=ws://127.0.0.1:$PORT out=$OUT"

node "$HERE/reproduce-stall.js" --condition "$COND" --via-proxy "ws://127.0.0.1:$PORT" \
    --pre-seconds "$PHASE_SECONDS" --gap-seconds "$PHASE_SECONDS" --post-seconds "$PHASE_SECONDS" \
    --audio-dir "$HARNESS_DIR/audio" --out-dir "$OUT" --label "$LABEL" 2>&1 | tee "$OUT/harness.log"
rc="${PIPESTATUS[0]}"
sleep 0.5

echo "--- summary ($OUT/$LABEL.summary.json), harness exit=$rc"
node -e '
const s = require(process.argv[1]);
const f = (p) => `${p.finals_none}/${p.finals_original}/${p.finals_translation}`;
console.log(JSON.stringify({
    mode: s.mode, proxy_url: s.proxy_url, proxy_ready_count: s.proxy_ready_count, auth_success_wall_ms: s.auth_success_wall_ms,
    ack_wall_ms: s.ack_wall_ms, completed_audio: s.completed_audio, audio_seconds_sent: s.audio_seconds_sent,
    tokens_total: s.tokens_total, final_tokens_total: s.final_tokens_total, fin_tokens: s.fin_tokens,
    finals_none_orig_trans: { pre: f(s.phases.pre), gap: f(s.phases.gap), post: f(s.phases.post) },
    translation_resumed: s.translation_resumed, proxy_notice_counts: s.proxy_notice_counts,
    proxy_error_frames: s.proxy_error_frames, soniox_error_frames: s.soniox_error_frames,
    failed: s.failed, failure_reason: s.failure_reason, close: s.close && s.close.code,
}, null, 2));
' "$OUT/$LABEL.summary.json"

echo "--- server.js checks"
echo "proxy_ready sent: $(grep -c 'sending proxy_ready' "$OUT/server.log")"
echo "strict hints injected upstream: $(grep -c '"language_hints_strict":true' "$OUT/server.log")"
echo "language id injected upstream: $(grep -c '"enable_language_identification":true' "$OUT/server.log")"
echo "api_key redacted in logs: $(grep -c '"api_key":"\*\*\*"' "$OUT/server.log") (raw key occurrences: $(grep -c 'local-smoke-not-real' "$OUT/server.log"))"
echo "files containing the jwt (must be 0): $(grep -F -l -- "$HARNESS_JWT" "$OUT"/* 2>/dev/null | wc -l | tr -d ' ')"
exit "$rc"
