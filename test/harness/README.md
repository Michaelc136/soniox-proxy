# Soniox translation-stall reproduction harness

Spec: `docs/reliability-2026-10.md`, section "Reproduction harness". This directory
talks to Soniox directly (no proxy) to find out what the tokens of a stalled stream
actually carry, and whether `language_hints_strict` changes the outcome.

Each run streams, at real-time pace in 100 ms frames of 16 kHz PCM:

1. 2 minutes of English speech (`say -v Samantha`),
2. a 12 minute gap: A digital silence, B synthetic instrumental (`gen-music.py`),
   C Spanish speech (`say -v Paulina`, looped),
3. 3 minutes of English speech.

The start config mirrors `server.js` at a171dfd (model `stt-rt-v5`, pcm_s16le 16000
mono, `include_nonfinal`, hints `['en']`, endpoint detection,
`max_non_final_tokens_duration_ms` 4000, one_way translation to `es` with the legacy
`source_language`) plus `enable_language_identification: true` and a
`client_reference_id` of `selah-harness-<label>` so streams are traceable in Soniox
usage logs. `--strict` adds `language_hints_strict: true`.

## Files

- `gen-audio.sh`, `gen-music.py`, `fit-raw.py`, `audio-stats.py`, `passages/`: audio generation.
- `reproduce-stall.js`: one run. Writes `<label>.tokens.jsonl` (every token with
  text, is_final, language, translation_status, source_language, wall time, audio
  time, plus event lines) and `<label>.summary.json`.
- `run-matrix.sh`: the six runs (A/B/C x strict off/on), 3 at a time, then `summarize.js`.
- `summarize.js`: `summary.md` table and `matrix.json` across the runs.

## Running

```
./test/harness/gen-audio.sh                                # once, ~1 minute
SONIOX_API_KEY=<key> SMOKE=1 ./test/harness/run-matrix.sh  # 1 minute runs, validates the pipeline
SONIOX_API_KEY=<key> ./test/harness/run-matrix.sh          # six 17 minute runs, ~36 minutes wall
```

Output root defaults to the session scratchpad `harness/` directory (override with
`HARNESS_DIR`). Before a full run check live Selah sessions in Supabase
(`select count(*) from active_translation_sessions where ended_at is null and
last_heartbeat > now() - interval '2 minutes'`) and keep live + harness streams at or
below 7 (Soniox concurrency limit is 10).

The key is read from the environment only; nothing here prints or stores it. Audio
and token logs stay in the scratchpad and are not committed.

Requires macOS `say`, `ffmpeg`, `python3` with numpy, and Node 18+ with `ws`
installed in the repo (falls back to the global WebSocket on Node 22+).
