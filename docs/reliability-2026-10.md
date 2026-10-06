# Live translation reliability fix (Soniox stall + 300 minute cap), 2026-10-05

Owner: Michael Colley. Status: BUILD LOCALLY FOR REVIEW. Nothing deploys, nothing is pushed
to the deployed branch, no app is packaged. Michael reviews, then decides.

## Non-negotiable rules

- No em dashes anywhere (no U+2014, no U+2013 as a dash). Commas or periods.
- Proxy work happens in a NEW git worktree: `git -C ~/Desktop/selahtranslate/soniox-proxy worktree add
  ~/soniox-proxy-reliability -b reliability/stall-and-rotation a171dfd`. a171dfd is the deployed
  commit. The Desktop checkout has unrelated uncommitted work (context.js, server.js edits,
  Dockerfile, package.json): do not touch it, do not stash it, do not commit it. Commit freely on
  the new branch inside the worktree. Never push.
- Never deploy to DigitalOcean. Never touch root@138.197.91.8. Never restart production pm2.
- The Soniox production API key lives in the Supabase vault (project vhnkwkvonudubyteespy, name
  `soniox_api_key`). It may be read through the Supabase MCP for the reproduction harness ONLY and
  used as a process environment variable for that run. Never write it to any file, never commit
  it, never print it in a result. Michael approved this use on 2026-10-01.
- Web studio tree `~/Desktop/selahtranslate/app.selahtranslate.com`: edit only
  `src/app/(dashboard)/translate/hooks/useSonioxConnection.ts` and new files; no git checkout or
  stash (58 pre-existing uncommitted files). Mac tree `~/SelahStudio`: NEVER git checkout / stash /
  reset / clean; build only via the incremental DerivedData/SelahLocal command (see below); run
  `xcodegen generate --quiet` after adding files; tests in batches of 2 to 4 classes.
- Match surrounding style. Return raw structured data from agent tasks.

## Facts established today (do not re-derive)

Symptom: in a long-running stream, after a 10 to 40 minute no-speech gap, Soniox keeps sending
final transcription tokens but no translation tokens for the rest of the stream. A fresh stream
translates. Confirmed on 2026-09-13, 09-27 and twice on 10-04 (Promise Center, Mac, en->es), plus
two web sessions. Concurrency ruled out (one failure happened with a single stream on the whole
platform; platform peak ever is 7 of 10). The 300 minute cap killed captions on 09-27 at 12:13.

Official Soniox docs (fetched 2026-10-05):
- Only real-time model: `stt-rt-v5`. Translation is a flag of that model.
- Start request fields: model, audio_format, num_channels, sample_rate, language_hints,
  language_hints_strict, context, enable_speaker_diarization, enable_language_identification,
  enable_endpoint_detection, max_endpoint_delay_ms, endpoint_sensitivity,
  endpoint_latency_adjustment_level, client_reference_id, translation. `translation.one_way` has
  ONLY `target_language`; our `source_language` field is undocumented and ignored.
- `language_hints` only bias. `language_hints_strict: true` restricts output to the hinted
  languages, best effort, "most robust when only one language is provided... strongly recommended
  for production". Language identification stays active underneath.
- Token fields: text, is_final, language (with enable_language_identification),
  translation_status in {none, original, translation}, source_language on translated tokens.
  Tokens outside the configured pair come back with translation_status none and no translation
  follows. A third-party report says speech detected as already being the target language
  produces no translation tokens at all.
- In-session idle rule: send `{"type":"keepalive"}` at least every 20 s when not sending audio.
  Keepalive preserves "language tracking" state. 40 s rule applies only before the start request.
- 300 minute cap is fixed: error frame with error_type `max_duration_reached` (HTTP-style code
  413) then close. Official guidance: roll to a fresh connection BEFORE the cap. Branch on
  error_type, not close code. End a stream by sending an empty binary frame; the server then sends
  `finished: true`. `{"type":"finalize"}` makes the server finalize pending tokens and emit a token
  whose text is `<fin>`; our clients do not handle `<fin>`, the proxy must strip it.
- Limits: 10 concurrent requests, 100 RPM, raisable in the Console
  (console.soniox.com/org/limits). Pricing pay-as-you-go, $0.12 to $0.18 per hour.

Proxy at a171dfd (file server.js, 1088 lines), relevant behavior:
- Legacy auth: `api_key` inside the start JSON (line 909). Config built at 908-947; the client's
  `config.language_hints` is forwarded as is; `language_hints_strict` and
  `enable_language_identification` are never sent; `source_language` is forwarded (ignored by
  Soniox). Line 951 logs the full config INCLUDING the api_key (truncated to 300 chars, key is
  near the start, so it leaks into DO logs). Line 919 sends `max_non_final_tokens_duration_ms`,
  which is not in the documented field list; leave it, note it.
- First upstream message after connect flips `conn.isReady` and sends `proxy_ready` (961-969);
  on upstream close `isReady` resets (987), so any reconnect would send a SECOND `proxy_ready`,
  which the web client treats as a fresh session start. Never do that.
- Upstream close (977-997): sends `{type:'error', message:'Soniox connection closed...'}` and
  leaves the client socket OPEN; audio is then silently dropped at 819. Upstream error (999-1011)
  same. Web client recovers only because its supervisor reacts to the error frame; the Mac app
  shows a banner and keeps billing.
- Client messages: `{action:'start', config}` (846-859), `{type:'ping'}` -> pong, `{type:'finalize'}`
  forwarded, binary = audio forwarded (813-822). Heartbeat pings both legs every 20 s (784-797).
- `cleanupConnection` (1026-1049), `sendToClient`, `sendError`.

## Proxy changes (worktree, branch reliability/stall-and-rotation)

Structure: add `upstream.js` (one Soniox stream: dial, start config, ack wait, token parsing,
counters, finalize/end, close) and `relay.js` (per-client session: current upstream, pending
upstream, audio accounting, stall detection, rotation, re-dial, notices), and make the minimal
surgical edits in server.js so the WebSocket handling delegates to relay.js. Keep all HTTP routes
(TTS, DeepL, chat) untouched. All behavior behind env vars with the defaults shown.

1. Instrumentation and redaction.
   - Build the Soniox config with `api_key` and log it with the key replaced by `***`.
   - Parse every upstream frame (JSON). Per upstream stream keep counters: final tokens by
     translation_status (none/original/translation), tokens by `language`, last translation token
     time, last final original time, audio bytes forwarded, audio seconds, wall seconds, endpoint
     count. Log a one-line summary every 60 s and at stream end:
     `[conn] [stream n] wall=.. audio=.. finals orig=.. trans=.. none=.. langs={en:..,es:..} lastTrans=..s ago`.
     Never log transcript text.
   - Add `enable_language_identification: true` (env SONIOX_LANG_ID, default on) so tokens carry
     `language`. Confirm both clients ignore unknown token fields (web reader: check the token
     type in useSonioxConnection.ts; Mac: SonioxWire.swift decodes known keys only). An explicit
     boolean `enable_language_identification` in the client's start config wins over that
     default, true or false (control runs; see the 2026-10-05 follow-up below).
2. Language restriction.
   - When the client sends exactly one language hint, send `language_hints_strict: true`
     (env SONIOX_STRICT_HINTS, default on). With zero or several hints, do not set it. An
     explicit boolean `language_hints_strict` in the client's start config wins over that
     default, true or false, regardless of the hint count (control runs; see below).
   - Stop forwarding `translation.source_language` (undocumented). Keep `type` and
     `target_language`.
3. Keepalive during audio silence: if no audio frame has been forwarded to the current upstream
   for 10 s, send `{"type":"keepalive"}` every 10 s until audio resumes (env
   SONIOX_KEEPALIVE_MS=10000).
4. Stall watchdog (env SONIOX_STALL_WATCHDOG default on). Only when translation is configured.
   Rule: count endpoint-delimited segments (an `<end>` token with endpoint detection, else a run
   of final original tokens followed by >= 700 ms with no tokens) that contained final original
   text and were followed by NO translation token before the next segment began. When
   SONIOX_STALL_SEGMENTS (default 6) consecutive such segments occur AND at least 20 s have
   passed since the last translation token, declare a stall: log `[stall]` with the counters,
   send the client `{"type":"proxy_notice","event":"translation_stalled"}`, and RECYCLE: dial a
   new upstream with the same config, wait for its ack, then switch audio to it, send
   `{"type":"finalize"}` to the old, forward its final tail (strip `<fin>`) for up to 1.5 s, send
   the empty frame, close it. Then `{"type":"proxy_notice","event":"stream_recycled"}`. Cap: at
   most one recycle per 120 s per client (SONIOX_RECYCLE_MIN_INTERVAL_MS); after 3 recycles in
   10 minutes (SONIOX_RECYCLE_MAX in SONIOX_RECYCLE_WINDOW_MS) enter SLOW MODE: the watchdog
   stays armed, the minimum interval between recycles becomes SONIOX_STALL_SLOW_INTERVAL_MS
   (default 600000, 10 minutes), and `[stall] slow mode` is logged once. Leave slow mode (back to
   the normal interval) when a CLOSED segment on the current stream is judged to have had
   translation; a lone translation token is not enough. The recycle window is not cleared on the
   way out, it expires on its own, and if it still holds SONIOX_RECYCLE_MAX recycles the next
   stall simply re-enters slow mode. SONIOX_RECYCLE_MAX=0 means never recycle for a stall (the
   stall is still declared and logged). The stall path never sends `translation_unavailable`
   (see the 2026-10-05 slow mode note below). Never send a second `proxy_ready`.
5. Rotation before the cap (env SONIOX_ROTATION default on, SONIOX_ROTATE_SOFT_MIN=270,
   SONIOX_ROTATE_HARD_MIN=290, SONIOX_ROTATE_BACKSTOP_MIN=292). Measure both audio minutes
   forwarded and wall minutes since the upstream opened; use whichever is larger. At the soft
   mark, rotate at the next endpoint (`<end>` token) or after 600 ms with no tokens; at the hard
   mark rotate immediately; the backstop is a wall-clock timer. Mechanics identical to the
   recycle above (pre-dial, ack, switch, finalize old, strip `<fin>`, end, close), plus: audio that
   arrives between "switch" and the new stream's readiness must be buffered (cap 15 s) and flushed
   to the new stream in order; while pre-dialing, audio continues to the old stream. Notice
   `{"type":"proxy_notice","event":"stream_rotated","minutes":n}`. Overlap of two upstream
   connections is allowed ONLY here and only for the ack wait (log if it exceeds 3 s).
6. Upstream loss. On upstream close or error after ack: if the error frame has error_type
   `max_duration_reached`, treat as a missed rotation and recycle immediately. Otherwise re-dial
   up to 2 attempts (1 s, 3 s) with audio buffered (cap 15 s); on success send
   `proxy_notice stream_recycled` and continue; on failure send `{type:'error', code, message}`
   AND close the client socket with 1011 so both clients run their own reconnect. Also handle
   HTTP-402-style budget errors the same way (error then close), never masking them as ready.
7. Compatibility: `auth_success`, `proxy_ready` (exactly once per client connection, on the first
   upstream ack), `ping`/`pong`, `finalize` forwarding, error frames forwarded, token frames
   forwarded unchanged except `<fin>` tokens removed. Existing clients that do not know
   `proxy_notice` must be unaffected (they ignore unknown types; verify by reading both clients'
   message switch).
8. Docs: copy this spec into the worktree as `docs/reliability-2026-10.md` and add an env var
   table to DEPLOYMENT_GUIDE.md.

Tests (`node --test`, directory `test/`): `test/mock-soniox.js` is a WebSocket server that accepts
the start JSON, replies with an ack frame `{"tokens":[],"final_audio_proc_ms":0,"total_audio_proc_ms":0}`,
then for every audio frame emits a final `original` token and (unless told to stall) a
`translation` token, emits an `<end>` token every N frames, answers `{"type":"finalize"}` with a
`<fin>` token, answers an empty frame with `{"finished":true}`, can be told to stop emitting
translation tokens after K frames, to close with `{"error_type":"max_duration_reached","error_code":413,...}`
after B bytes, to drop the connection, or to reject the second connection. Tests must cover:
config carries `language_hints_strict` only with one hint and drops `source_language`; key
redacted in logs; `enable_language_identification` set; stall detected after 6 segments and not
before; recycle produces exactly one `proxy_ready` total, a `translation_stalled` then
`stream_recycled` notice, continuous audio delivery (count bytes received by mock streams equals
bytes sent), `<fin>` never reaches the client; recycle cap enters slow mode (no recycle inside the
slow interval, exactly one after it, never `translation_unavailable`, a translation token restores
the normal interval); rotation
at tiny env thresholds (e.g. SONIOX_ROTATE_SOFT_MIN=0.02) with buffered audio flushed in order and
old stream finalized and ended; max_duration_reached triggers immediate recycle; upstream drop
re-dials; re-dial failure closes the client with 1011; keepalive sent after 10 s without audio;
ping/pong and finalize still work; a client that sends `action:start` twice does not leak
upstreams. Run with SONIOX_WS_URL pointing at the mock. All green, zero warnings.

## Reproduction harness (item 3), `test/harness/` in the worktree

`reproduce-stall.js`: connects DIRECTLY to `wss://stt-rt.soniox.com/transcribe-websocket` with
the key from env `SONIOX_API_KEY`, sends the SAME start config the proxy would (model stt-rt-v5,
pcm_s16le 16000 mono, language_hints ['en'], enable_endpoint_detection, enable_language_identification,
translation one_way target es; `language_hints_strict` per a `--strict` flag), streams 16 kHz
PCM at real-time pace in 100 ms frames, and writes every token to a JSONL file in
`/private/tmp/claude-501/-Users-michaelcolley/09c687da-aa28-4f09-b63f-5172f23505f0/scratchpad/harness/`
with text, is_final, language, translation_status, source_language, wall time, audio time.
Conditions (each: 2 min English speech, then a 12 minute GAP, then 3 min English speech):
  A. gap = digital silence (zeros)
  B. gap = synthetic instrumental audio (sum of slowly changing sine chords plus low noise,
     generated with python, about -20 dBFS)
  C. gap = Spanish speech (`say` with a Spanish voice, a long neutral passage, looped)
English speech: `say -v Samantha` (or any installed English voice) reading a long neutral passage,
exported with `--data-format=LEI16@16000`, converted to raw PCM. Run each condition with strict
off and strict on: six runs. Before starting, check live sessions in Supabase
(`select count(*) from active_translation_sessions where ended_at is null and last_heartbeat > now() - interval '2 minutes'`)
and run at most 3 harness streams at once, fewer if live sessions + harness would exceed 7.
Report per run: finals in the pre-gap, gap, and post-gap phases split by translation_status,
languages seen per phase, whether translation resumed after the gap (translation tokens in the
post-gap phase), time to first post-gap translation, any error frames. Also produce one summary
table across the six runs. Total audio about 100 minutes; cost under a dollar.

## Web studio (item 8), local only

In `useSonioxConnection.ts`: handle incoming `{"type":"proxy_notice"}` messages. Map
`translation_stalled` -> a transient status string "Translation reconnecting", `stream_recycled`
and `stream_rotated` -> "Connection renewed", `translation_unavailable` -> a persistent warning
"Translation unavailable, restart the session" (keep the handler; the event is reserved and the
proxy does not send it today, see the slow mode note). Surface them through whatever status surface the
hook already exposes to the UI (read the hook: there is a connection status like
Connecting/Listening/Live and a banner/error path). Do not change the audio path, reconnect
logic, or StudioEngine.tsx. Add a vitest for the pure mapping. `npx tsc --noEmit` clean.

## Mac app (item 8), local only, no build published

- `Selah/Features/Studio/Pipeline/SonioxSocket.swift` (and SonioxWire.swift): decode
  `proxy_notice` frames into a typed event; StudioModel shows them as a transient banner using
  the existing in-page banner idiom (StudioErrorBanner / TeammateLiveBanner style) with the same
  strings as the web, via `lang.t`, with the 9 offered translations added to Localizable.xcstrings
  (back it up to the scratchpad first; same entry shape as the key "or continue with").
- Treat an upstream `error` frame received AFTER proxy_ready as a connection drop: route it to
  the same path a socket close takes (the capture supervisor's reconnect), instead of a banner
  only. Confirm by reading the supervisor code that a socket close already triggers a planned
  reconnect; if it does not, implement the reconnect through the supervisor and add a test.
- Tests: a wire-decoding test for proxy_notice, a StudioModel test that an error frame after
  ready triggers the reconnect path, a localization scan pass. Build command:
  `cd ~/SelahStudio && xcodegen generate --quiet && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project Selah.xcodeproj -scheme Selah -destination 'platform=macOS' -derivedDataPath "$HOME/SelahStudio/DerivedData/SelahLocal" build`;
  tests with `test -parallel-testing-enabled NO -only-testing:SelahTests/<Class>` in small batches.

## Soniox texts (item 7), scratchpad files

- `soniox-limit-request.txt`: the text for the Console limit-increase form: raise concurrent
  real-time requests from 10 to 30 and RPM to 300 for org/project, with a two-sentence
  justification (live church and event translation, Sunday peaks, growth).
- `soniox-support-email.txt`: to support@soniox.com from Michael: describe the symptom with exact
  UTC windows (2026-09-13 ~17:37, 2026-09-27 18:25:53 to stream end, 2026-10-04 16:12:40 and
  17:51:29), the config sent (stt-rt-v5, hints ['en'], endpoint detection, one_way es, legacy
  api_key auth), that captions continued and translation tokens stopped after a long no-speech
  gap, concurrency at those moments (5, 2, 5, 1), ask: is this a known behavior of one-way
  translation when language identification drifts during non-speech audio, is
  `language_hints_strict` the recommended remedy, and whether keepalive versus silent audio during
  gaps matters; note our stream rotation plan; ask them to check their side for those streams.
  Plain text, no em dashes, signed Michael Colley, Selah Translate.

## Review fixes applied 2026-10-05 (worktree, local only)

Confirmed findings from the adversarial review of the branch, each with a regression test in
`test/` (test names carry the finding id):

- R1 (relay.js, handleUpstreamClose): when the current stream dies while a rotation
  replacement is already acked and waiting for its trigger, the replacement is adopted at
  once (notice `stream_rotated` with the lost stream's minutes). A still-dialing replacement
  is adopted by its continuation as before.
- R2 (relay.js, armPendingKeepalive): an acked rotation replacement receives
  `{"type":"keepalive"}` on SONIOX_KEEPALIVE_MS while it waits, so Soniox's 20 s idle rule
  cannot close it; cleared on adoption, drop, or relay close.
- R3 (relay.js, observeTokens): finals tagged `translation_status: none` count as
  untranslated segment content for the stall watchdog (SONIOX_STALL_COUNT_NONE, default on).
- F1 (server.js): `error` and `close` listeners are attached to the client socket before the
  JWT await and before the early returns; a malformed frame during auth is logged, not thrown.
  `uncaughtException` and `unhandledRejection` are logged and the process kept alive as a last
  line of defense.
- F2 (server.js + relay.js attach): no relay is created for a socket that closed during auth;
  `attach()` on a non-open socket destroys the relay and returns false.
- F3 (relay.js, commitRotation + checkRotation): endpoint and quiet triggers only commit when
  the replacement has acked; a refused soft pre-dial keeps the old stream and retries with
  exponential backoff (SONIOX_ROTATE_RETRY_MS doubling, capped at SONIOX_ROTATE_RETRY_MAX_MS);
  the hard mark and backstop still switch unacked and ignore the backoff. The quiet window is
  re-armed from the ack so an idle replacement is adopted within SONIOX_ROTATE_QUIET_MS.
- F4 (relay.js, handleStart): a repeated `action:start` with an identical config is suppressed
  and counted (`suppressedStarts` in the relay closing line); a changed config re-dials at most
  once per SONIOX_MIN_DIAL_INTERVAL_MS with the latest config.
- BC-1 (DEPLOYMENT_GUIDE.md): Rollback subsection with the env kill switches and the a171dfd
  redeploy.

Not done, noted for later: a process-wide count of open upstream sockets so a soft pre-dial is
skipped rather than attempted when the platform is near the 10-concurrent limit.

## Slow mode replaces the recycle hard stop (2026-10-05, after the live smoke runs)

Live smoke runs through the production proxy showed that when the speaker is genuinely talking
or singing in the TARGET language, Soniox returns final tokens with translation_status `none` and
`language` equal to the target. The watchdog counts those as untranslated segments, and must keep
doing so, because a real stall (English mislabeled as the target) looks identical. The old cap
then disarmed the watchdog for the rest of the connection after SONIOX_RECYCLE_MAX recycles in
SONIOX_RECYCLE_WINDOW_MS and sent `translation_unavailable`, which (a) removed protection against
a real stall later in the same session and (b) would have shown operators a false "Translation
unavailable, restart the session" banner during Spanish worship singing once the clients ship.

Change (relay.js, declareStall / onTranslationToken, with the regression test in
`test/stall.test.js`):

- When the cap is reached the relay enters slow mode instead of stopping: the watchdog stays
  armed, the minimum interval between recycles rises to SONIOX_STALL_SLOW_INTERVAL_MS (default
  600000, 10 minutes), and `[stall] slow mode` is logged once. Stalls declared inside the slow
  interval are logged as `recycle suppressed (slow mode)`.
- Slow mode ends when a closed segment on the current stream is judged to have had translation
  (the first version left on any translation token and cleared the window; corrected the same
  day, see the follow-up below): back to SONIOX_RECYCLE_MIN_INTERVAL_MS, `recycleTimes` kept,
  `lastRecycleAt` kept so the normal interval still counts from the last real recycle. Logged as
  `[stall] normal mode`.
- The stall path never sends `translation_unavailable`. The event stays in the notice contract
  (`PROXY_NOTICE_EVENTS` in relay.js, the DEPLOYMENT_GUIDE table) as RESERVED for a future "the
  engine cannot be reached" condition. No other path in the tree sent it before this change, so
  nothing else was touched.
- `translation_stalled` and `stream_recycled` are unchanged, including the rule that
  `translation_stalled` is sent only when a recycle actually follows.

## Follow-up 2026-10-05: slow mode exit, SONIOX_RECYCLE_MAX=0, client-pinned start flags

Three defects or gaps found in review of the slow mode change, each with a regression test:

1. Slow mode exit (relay.js, evaluateClosedSegment / leaveSlowMode; test/stall.test.js).
   The first version left slow mode on ANY translation token and cleared `recycleTimes`. During
   singing in the target language Soniox returns the odd translated phrase, so every such token
   reset the cap window and the next stall recycled on the normal interval again: the cap was
   effectively unbounded. Now:
   - Slow mode is left only when a CLOSED segment that had translation is judged (in
     `evaluateClosedSegment`, the `seg.hadTranslation` branch, which is also where the streak
     resets). A lone translation token no longer does anything beyond marking its segment.
   - `recycleTimes` is NOT cleared on exit. The window expires on its own. If it still holds
     SONIOX_RECYCLE_MAX recycles when the next stall is declared, slow mode is simply re-entered
     (and `[stall] slow mode` logged again). `lastRecycleAt` is kept as before.
   - Log line on exit: `[stall] normal mode [<conn>]: translated segment on stream <K>`.
2. SONIOX_RECYCLE_MAX=0 (relay.js, declareStall; test/stall.test.js). The first version
   recycled once (nothing had happened yet, so the interval check passed) and then entered slow
   mode. Zero or less now means "never recycle for a stall": the stall is still declared and
   logged with its counters, then `[<conn>] recycle suppressed (recycleMax=0)` is logged and the
   watchdog returns. No stream is dialed, slow mode is never entered, and no notice is sent
   (`translation_stalled` is only sent when a recycle follows). Documented in the
   DEPLOYMENT_GUIDE row.
3. Control runs (upstream.js, resolveStartFlags / buildSonioxConfig; relay.js, handleStart;
   test/config.test.js, test/relay-basics.test.js). If the client's start config carries an
   explicit boolean `language_hints_strict`, it is sent as is, true or false, instead of the
   proxy default (strict when exactly one hint, controlled by SONIOX_STRICT_HINTS). The same rule
   applies to `enable_language_identification` (default controlled by SONIOX_LANG_ID). Only a
   real boolean counts; absent, null or a string means "omitted" and the default applies. Both
   production clients omit both fields, so nothing changes for them. The relay's start line now
   ends with the provenance of each flag:
   `[<conn>] start: model=... hints=[...] translation=... endpointing=... strictHints=client:<value> langId=default:<value>`
   where each of the two reads `client:<true|false>` when the client pinned it and
   `default:<true|false>` otherwise (`default:false` means the field is not sent). The
   `[stream n] sent start config` line still shows the redacted config that actually went out.
