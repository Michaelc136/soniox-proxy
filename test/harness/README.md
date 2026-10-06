# Soniox translation-stall reproduction harness

Spec: `docs/reliability-2026-10.md`, section "Reproduction harness". This directory
streams scripted audio to Soniox, either directly (to find out what the tokens of a
stalled stream actually carry, and whether `language_hints_strict` changes the
outcome) or through the Selah proxy (to exercise the deployed relay with the key it
holds, since the key is not available locally).

Each run streams, at real-time pace in 100 ms frames of 16 kHz PCM:

1. 2 minutes of English speech (`say -v Samantha`),
2. a 12 minute gap: A digital silence, B synthetic instrumental (`gen-music.py`),
   C Spanish speech (`say -v Paulina`, looped),
3. 3 minutes of English speech.

## Files

- `gen-audio.sh`, `gen-music.py`, `fit-raw.py`, `audio-stats.py`, `passages/`: audio generation.
- `reproduce-stall.js`: one run. Writes `<label>.tokens.jsonl` (every token with
  text, is_final, language, translation_status, source_language, wall time, audio
  time, plus event lines) and `<label>.summary.json`.
- `run-matrix.sh`: the matrix (six direct runs, or three proxy runs), 3 at a time, then `summarize.js`.
- `summarize.js`: `summary.md` table and `matrix.json` across the runs.
- `mint-jwt.sh`: signs the test account in to Supabase and hands the access token to a
  command as `HARNESS_JWT` (proxy mode only).
- `local-proxy-smoke.sh`: proxy mode end to end on this machine against the mock Soniox.
- `selftest.test.js`: runs both modes against in-process mocks (`npm test`).

## Direct mode

The start config mirrors `server.js` at a171dfd (model `stt-rt-v5`, pcm_s16le 16000
mono, `include_nonfinal`, hints `['en']`, endpoint detection,
`max_non_final_tokens_duration_ms` 4000, one_way translation to `es` with the legacy
`source_language`) plus `enable_language_identification: true` and a
`client_reference_id` of `selah-harness-<label>` so streams are traceable in Soniox
usage logs. `--strict` adds `language_hints_strict: true`.

```
./test/harness/gen-audio.sh                                # once, ~1 minute
SONIOX_API_KEY=<key> SMOKE=1 ./test/harness/run-matrix.sh  # 1 minute runs, validates the pipeline
SONIOX_API_KEY=<key> ./test/harness/run-matrix.sh          # six 17 minute runs, ~36 minutes wall
```

## Proxy mode (`--via-proxy`)

`reproduce-stall.js --via-proxy wss://<proxy-host>` speaks the proxy's client
protocol instead of Soniox's: it connects to `wss://<host>?token=<Supabase JWT>`,
waits for `{"type":"auth_success"}`, sends `{"action":"start","config":{...}}` in the
exact shape the web studio sends (model, audio_format, sample_rate, language_hints,
include_nonfinal, enable_endpoint_detection, translation with type/target_language
and the legacy source_language), waits for `{"type":"proxy_ready"}`, then streams
binary audio frames. Token frames come back as Soniox JSON and are logged exactly as
in direct mode. The proxy injects `api_key`, `language_hints_strict` and
`enable_language_identification` itself, so the harness never sends them and
`--strict` is refused: there is no strict on/off axis, the matrix is the three gap
conditions (3 runs, labels `A-proxy`, `B-proxy`, `C-proxy`). At the end of the audio
the harness sends `{"type":"finalize"}`, waits 3 s for the tail, and closes (the
proxy ignores the empty end frame and never forwards `finished`, so `finished` is
always `false` in proxy summaries).

What proxy mode records on top of the direct-mode fields:

- `{"type":"proxy_notice"}` frames: an `event` line `proxy_notice` in the JSONL with
  `notice` (translation_stalled, stream_recycled, stream_rotated,
  translation_unavailable), wall time, audio time, phase and the notice's extra
  fields; `proxy_notices` and `proxy_notice_counts` in the summary.
- `{"type":"error"}` frames from the proxy: an `error_frame` event with `source:
  "proxy"`, `code`, `message`; counted in `proxy_error_frames` (Soniox-shaped error
  frames forwarded by the proxy are `source: "soniox"`, `soniox_error_frames`).
- `proxy_ready_count` (must be 1; a second one is logged as `proxy_ready_duplicate`),
  `auth_success_wall_ms`, `ack_wall_ms` (the proxy_ready time).
- A 1011 close is a run failure: `failed: true`, `failure_reason` (the close reason
  plus the last proxy error message), event `run_failed`, exit code 4. A 1008 close
  (bad JWT) or no `proxy_ready` is a start failure, exit code 3.

The JWT comes from `mint-jwt.sh`, which POSTs the test account's credentials to
`<SUPABASE_URL>/auth/v1/token?grant_type=password` with the anon key (URL and anon
key from the web studio's `.env.local`, account from the onboarding-test line of
MEMORY.md; all overridable, see the script header), verifies the token with one
`GET /auth/v1/user`, prints `jwt ok` or the error, and execs the command you give it
with `HARNESS_JWT` set. It never prints the token. Sessions last one hour.

```
./test/harness/mint-jwt.sh                                                   # "jwt ok" or the error
./test/harness/local-proxy-smoke.sh                                          # 30 s through server.js + mock Soniox, locally
VIA_PROXY=wss://<proxy-host> SMOKE=1 ./test/harness/mint-jwt.sh ./test/harness/run-matrix.sh   # 1 minute runs, 3 streams
VIA_PROXY=wss://<proxy-host> ./test/harness/mint-jwt.sh ./test/harness/run-matrix.sh           # three 17 minute runs
```

A single proxy run by hand:

```
./test/harness/mint-jwt.sh node test/harness/reproduce-stall.js --condition A --via-proxy wss://<proxy-host> --smoke
```

Proxy-mode matrix output goes to `$HARNESS_DIR/proxy` (logs in `proxy/logs`), the
local smoke to `$HARNESS_DIR/proxy-local`, so proxy and direct summaries never mix.
`summarize.js` shows "proxy" in the Strict column, adds "Proxy notices" and "Failed"
columns, and lists failed runs and any run with more than one `proxy_ready` in the
verdict.

## Before any run against real Soniox

Output root defaults to the session scratchpad `harness/` directory (override with
`HARNESS_DIR`). Check live Selah sessions in Supabase
(`select count(*) from active_translation_sessions where ended_at is null and
last_heartbeat > now() - interval '2 minutes'`) and keep live + harness streams at or
below 7 (Soniox concurrency limit is 10). Through the production proxy each harness
run is one live proxy session and one Soniox stream, the same as a studio operator.

Credentials (the Soniox key, the JWT, the anon key, the test account password) are
read from the environment or the named files only; nothing here prints or stores
them. Audio and token logs stay in the scratchpad and are not committed.

Requires macOS `say`, `ffmpeg`, `python3` with numpy, and Node 18+ with `ws`
installed in the repo (falls back to the global WebSocket on Node 22+).
