#!/usr/bin/env node
/**
 * Soniox translation-stall reproduction harness.
 *
 * Direct mode connects straight to Soniox (no proxy) with the same start config
 * the proxy sends (plus enable_language_identification so tokens carry
 * `language`), streams 16 kHz PCM at real-time pace in 100 ms frames through
 * three phases (English speech, a long gap, English speech) and writes every
 * token to a JSONL file with text, is_final, language, translation_status,
 * source_language, wall time and audio time. A per-run summary JSON records
 * final-token counts per phase split by translation_status, languages seen,
 * whether translation resumed after the gap, time to the first post-gap
 * translation, and every error frame.
 *
 * Proxy mode (--via-proxy <ws(s)-url>) speaks the Selah proxy's client protocol
 * instead, so the run uses the key the proxy holds: connect with
 * ?token=<Supabase JWT> (env HARNESS_JWT), wait for {"type":"auth_success"},
 * send {"action":"start","config":{...}} in the exact shape the web studio
 * sends, wait for {"type":"proxy_ready"}, then stream. The proxy injects
 * api_key, language_hints_strict and enable_language_identification itself, so
 * proxy mode never sends those and --strict is refused. {"type":"proxy_notice"}
 * and {"type":"error"} frames are logged to the JSONL with timestamps and
 * counted in the summary; a second proxy_ready is logged as a duplicate; a 1011
 * close is recorded as a run failure with its reason.
 *
 * Credentials are read from the environment only (SONIOX_API_KEY in direct
 * mode, HARNESS_JWT in proxy mode) and are never written to any file or log.
 *
 * Usage:
 *   SONIOX_API_KEY=... node reproduce-stall.js --condition A|B|C [--strict] [--smoke]
 *       [--out-dir DIR] [--audio-dir DIR] [--pre-seconds N] [--gap-seconds N]
 *       [--post-seconds N] [--model stt-rt-v5] [--target es] [--no-source-language]
 *       [--label NAME]
 *   HARNESS_JWT=... node reproduce-stall.js --condition A|B|C --via-proxy wss://host [--smoke] [options]
 *
 * Conditions: A gap = digital silence, B gap = synthetic instrumental,
 * C gap = Spanish speech. Audio files come from gen-audio.sh.
 *
 * Exit codes: 0 all audio sent, 2 audio incomplete, 3 start failed (no ack or
 * no proxy_ready), 4 proxy mode loss (the proxy closed with 1011).
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Not a test: when `node --test` sweeps test/**, exit cleanly instead of running the tool.
if (process.env.NODE_TEST_CONTEXT) process.exit(0);

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const FRAME_MS = 100;
const FRAME_BYTES = (BYTES_PER_SECOND * FRAME_MS) / 1000;
const DEFAULT_OUT = '/private/tmp/claude-501/-Users-michaelcolley/09c687da-aa28-4f09-b63f-5172f23505f0/scratchpad/harness';
const SONIOX_URL = process.env.SONIOX_WS_URL || 'wss://stt-rt.soniox.com/transcribe-websocket';
const ACK_TIMEOUT_MS = 15000;
const FINISH_TIMEOUT_MS = 15000;
const PROXY_READY_TIMEOUT_MS = 30000; // start sent -> proxy dials Soniox -> ack -> proxy_ready
const PROXY_TAIL_MS = 3000;           // after finalize, wait this long for the tail, then close
const PROGRESS_MS = 60000;
const UPSTREAM_SILENT_WARN_MS = 60000;
const WS_OPEN = 1;

const GAP = {
    A: { file: 'gap-A-silence.raw', name: 'digital silence' },
    B: { file: 'gap-B-music.raw', name: 'synthetic instrumental' },
    C: { file: 'gap-C-spanish.raw', name: 'Spanish speech' },
};

function usage(message) {
    if (message) console.error(`error: ${message}`);
    console.error('usage: SONIOX_API_KEY=... node reproduce-stall.js --condition A|B|C [--strict] [--smoke] [options]');
    console.error('       HARNESS_JWT=... node reproduce-stall.js --condition A|B|C --via-proxy wss://host [--smoke] [options]');
    process.exit(2);
}

function parseArgs(argv) {
    const o = {
        condition: null, strict: false, smoke: false, outDir: DEFAULT_OUT, audioDir: null,
        model: 'stt-rt-v5', target: 'es', preSeconds: null, gapSeconds: null, postSeconds: null,
        sourceLanguage: true, label: null, viaProxy: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) usage(`missing value for ${a}`);
            return argv[++i];
        };
        switch (a) {
            case '--condition': o.condition = next().toUpperCase(); break;
            case '--strict': o.strict = true; break;
            case '--smoke': o.smoke = true; break;
            case '--via-proxy': o.viaProxy = next(); break;
            case '--out-dir': o.outDir = next(); break;
            case '--audio-dir': o.audioDir = next(); break;
            case '--model': o.model = next(); break;
            case '--target': o.target = next(); break;
            case '--pre-seconds': o.preSeconds = Number(next()); break;
            case '--gap-seconds': o.gapSeconds = Number(next()); break;
            case '--post-seconds': o.postSeconds = Number(next()); break;
            case '--no-source-language': o.sourceLanguage = false; break;
            case '--label': o.label = next(); break;
            case '-h': case '--help': usage(); break;
            default: usage(`unknown argument ${a}`);
        }
    }
    if (!GAP[o.condition]) usage('--condition must be A, B or C');
    if (o.viaProxy) {
        if (o.strict) usage('--strict cannot be combined with --via-proxy: the proxy sets language_hints_strict itself');
        let ok = false;
        try { ok = /^wss?:$/.test(new URL(o.viaProxy).protocol); } catch { ok = false; }
        if (!ok) usage('--via-proxy needs a ws:// or wss:// URL');
    }
    if (o.smoke) {
        o.preSeconds ??= 20;
        o.gapSeconds ??= 20;
        o.postSeconds ??= 20;
    }
    o.audioDir ??= path.join(o.outDir, 'audio');
    o.label ??= `${o.condition}-${o.viaProxy ? 'proxy' : o.strict ? 'strict' : 'nostrict'}${o.smoke ? '-smoke' : ''}`;
    return o;
}

async function loadWebSocket() {
    try {
        const mod = await import('ws');
        return { WS: mod.default ?? mod.WebSocket, impl: 'ws' };
    } catch {
        if (typeof globalThis.WebSocket === 'function') return { WS: globalThis.WebSocket, impl: 'global' };
        throw new Error('no WebSocket implementation available: npm install ws, or use Node 22+');
    }
}

function readPhaseFile(file, seconds, name) {
    if (!fs.existsSync(file)) {
        console.error(`error: missing audio file ${file} (run gen-audio.sh first)`);
        process.exit(2);
    }
    let buf = fs.readFileSync(file);
    if (seconds != null) {
        const want = Math.floor(seconds * BYTES_PER_SECOND);
        if (buf.length < want) {
            console.error(`warn: ${name}: file holds ${(buf.length / BYTES_PER_SECOND).toFixed(1)}s, wanted ${seconds}s`);
        }
        buf = buf.subarray(0, Math.min(want, buf.length));
    }
    if (buf.length % 2) buf = buf.subarray(0, buf.length - 1);
    return buf;
}

function loadAudio(opts) {
    const specs = [
        { name: 'pre', file: 'en-pre.raw', seconds: opts.preSeconds },
        { name: 'gap', file: GAP[opts.condition].file, seconds: opts.gapSeconds },
        { name: 'post', file: 'en-post.raw', seconds: opts.postSeconds },
    ];
    const phases = [];
    const buffers = [];
    let offset = 0;
    for (const s of specs) {
        const buf = readPhaseFile(path.join(opts.audioDir, s.file), s.seconds, s.name);
        phases.push({
            name: s.name, file: s.file, startByte: offset, endByte: offset + buf.length,
            startMs: (offset / BYTES_PER_SECOND) * 1000, endMs: ((offset + buf.length) / BYTES_PER_SECOND) * 1000,
        });
        buffers.push(buf);
        offset += buf.length;
    }
    return { phases, buffer: Buffer.concat(buffers) };
}

function buildStartConfig(opts) {
    // Mirrors server.js at a171dfd (lines 908-941) plus enable_language_identification,
    // which the reliability work adds so every token carries `language`.
    const cfg = {
        api_key: process.env.SONIOX_API_KEY,
        model: opts.model,
        audio_format: 'pcm_s16le',
        sample_rate: SAMPLE_RATE,
        num_channels: 1,
        include_nonfinal: true,
        language_hints: ['en'],
        enable_endpoint_detection: true,
        max_non_final_tokens_duration_ms: 4000,
        enable_language_identification: true,
        client_reference_id: `selah-harness-${opts.label}`,
        translation: { type: 'one_way', target_language: opts.target },
    };
    if (opts.sourceLanguage) cfg.translation.source_language = 'en';
    if (opts.strict) cfg.language_hints_strict = true;
    return cfg;
}

// Proxy mode: the config the web studio sends, field for field
// (useSonioxConnection.ts). No api_key, language_hints_strict,
// enable_language_identification or client_reference_id: the proxy adds the
// first three and drops the rest (upstream.js buildSonioxConfig). The legacy
// translation.source_language is sent because the studio sends it; the proxy
// strips it before Soniox sees it.
function buildProxyClientConfig(opts) {
    const translation = {};
    if (opts.sourceLanguage) translation.source_language = 'en';
    translation.target_language = opts.target;
    translation.type = 'one_way';
    return {
        model: opts.model,
        audio_format: 'pcm_s16le',
        sample_rate: SAMPLE_RATE,
        language_hints: ['en'],
        include_nonfinal: true,
        enable_endpoint_detection: true,
        translation,
    };
}

function redact(cfg) {
    return 'api_key' in cfg ? { ...cfg, api_key: '***' } : cfg;
}

// The proxy URL as it may be logged: never with a token in it.
function stripToken(base) {
    const u = new URL(base);
    u.searchParams.delete('token');
    return u.toString();
}

function proxyUrlWithToken(base, jwt) {
    const u = new URL(base);
    u.searchParams.set('token', jwt);
    return u.toString();
}

function newPhaseStats() {
    return {
        finals_none: 0, finals_original: 0, finals_translation: 0,
        nonfinal_tokens: 0, end_tokens: 0,
        languages: {}, translation_languages: {},
        audio_start_wall_ms: null, first_original_wall_ms: null, first_translation_wall_ms: null,
        last_original_wall_ms: null, last_translation_wall_ms: null,
    };
}

function bump(map, key) {
    const k = key == null || key === '' ? '?' : String(key);
    map[k] = (map[k] || 0) + 1;
}

function fmtLangs(map) {
    const parts = Object.entries(map).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`);
    return `{${parts.join(',')}}`;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const proxyMode = !!opts.viaProxy;
    if (proxyMode) {
        if (!process.env.HARNESS_JWT) {
            console.error('error: HARNESS_JWT is not set in the environment (run through test/harness/mint-jwt.sh)');
            process.exit(2);
        }
    } else if (!process.env.SONIOX_API_KEY) {
        console.error('error: SONIOX_API_KEY is not set in the environment');
        process.exit(2);
    }
    const { WS, impl } = await loadWebSocket();
    const audio = loadAudio(opts);
    const totalBytes = audio.buffer.length;
    const totalSeconds = totalBytes / BYTES_PER_SECOND;

    fs.mkdirSync(opts.outDir, { recursive: true });
    const tokensPath = path.join(opts.outDir, `${opts.label}.tokens.jsonl`);
    const summaryPath = path.join(opts.outDir, `${opts.label}.summary.json`);
    const jsonl = fs.createWriteStream(tokensPath, { flags: 'w' });

    const endpoint = proxyMode ? stripToken(opts.viaProxy) : SONIOX_URL;
    const connectUrl = proxyMode ? proxyUrlWithToken(opts.viaProxy, process.env.HARNESS_JWT) : SONIOX_URL;
    const startConfig = proxyMode ? buildProxyClientConfig(opts) : buildStartConfig(opts);
    const startMessage = proxyMode ? { action: 'start', config: startConfig } : startConfig;
    const strict = proxyMode ? null : opts.strict; // null: the proxy decides
    const state = {
        t0: Date.now(), startedAt: new Date().toISOString(),
        ackWallMs: null, startFailed: false, authWallMs: null,
        bytesSent: 0, framesSent: 0, streamStartWall: null, audioDoneWall: null, streamingDone: false,
        finished: false, closed: false, closeInfo: null, summaryWritten: false,
        lastSpokenPhase: null, lastTranslationWall: null, lastOriginalWall: null, lastUpstreamWall: null,
        tokens: 0, finalTokens: 0, finTokens: 0, errors: [], events: [],
        proxyReadyCount: 0, notices: [], noticeCounts: {}, lastProxyError: null,
        failed: false, failureReason: null,
        phases: { pre: newPhaseStats(), gap: newPhaseStats(), post: newPhaseStats() },
        timers: {},
        upstreamSilentWarned: false,
    };

    const wallMs = () => Date.now() - state.t0;
    const audioSentMs = () => (state.bytesSent / BYTES_PER_SECOND) * 1000;
    const phaseAtAudio = (ms) => {
        for (const p of audio.phases) if (ms < p.endMs) return p.name;
        return 'post';
    };
    const currentPhase = () => (state.streamingDone ? 'done' : state.streamStartWall == null ? 'waiting' : phaseAtAudio(audioSentMs()));

    const writeLine = (obj) => { jsonl.write(`${JSON.stringify(obj)}\n`); };
    const logEvent = (event, extra = {}) => {
        const rec = { type: 'event', event, t_wall_ms: wallMs(), audio_sent_ms: Math.round(audioSentMs()), ...extra };
        state.events.push(rec);
        writeLine(rec);
        console.error(`[${opts.label}] ${event} ${JSON.stringify(extra)}`);
        return rec;
    };

    console.error(`[${opts.label}] mode=${proxyMode ? 'proxy' : 'direct'} gap=${GAP[opts.condition].name} strict=${proxyMode ? 'proxy' : opts.strict} impl=${impl} url=${endpoint}`);
    console.error(`[${opts.label}] schedule: ${audio.phases.map((p) => `${p.name}=${((p.endMs - p.startMs) / 1000).toFixed(0)}s`).join(' ')} total=${totalSeconds.toFixed(0)}s`);
    console.error(`[${opts.label}] start config: ${JSON.stringify(redact(startConfig))}`);
    writeLine({
        type: 'meta', label: opts.label, mode: proxyMode ? 'proxy' : 'direct', endpoint, condition: opts.condition,
        gap: GAP[opts.condition].name, strict, smoke: opts.smoke, started_at: state.startedAt,
        config: redact(startConfig), schedule: audio.phases,
    });

    const progress = (why = 'progress') => {
        const p = state.phases;
        const lastTrans = state.lastTranslationWall == null ? 'never' : `${((wallMs() - state.lastTranslationWall) / 1000).toFixed(0)}s ago`;
        const sum = (k) => p.pre[k] + p.gap[k] + p.post[k];
        const langs = {};
        for (const ph of Object.values(p)) for (const [k, v] of Object.entries(ph.languages)) langs[k] = (langs[k] || 0) + v;
        console.error(
            `[${opts.label}] ${why} wall=${(wallMs() / 1000).toFixed(0)}s audio=${(audioSentMs() / 1000).toFixed(0)}s phase=${currentPhase()} ` +
            `finals none=${sum('finals_none')} orig=${sum('finals_original')} trans=${sum('finals_translation')} ` +
            `langs=${fmtLangs(langs)} lastTrans=${lastTrans} errors=${state.errors.length}` +
            `${proxyMode ? ` notices=${state.notices.length}` : ''} buffered=${ws.bufferedAmount ?? 0}`,
        );
    };

    const clearTimers = () => {
        for (const t of Object.values(state.timers)) { clearTimeout(t); clearInterval(t); }
        state.timers = {};
    };

    const writeSummary = () => {
        if (state.summaryWritten) return;
        state.summaryWritten = true;
        const post = state.phases.post;
        const pre = state.phases.pre;
        const postSpoken = post.finals_original + post.finals_none;
        const preSpoken = pre.finals_original + pre.finals_none;
        const summary = {
            label: opts.label, mode: proxyMode ? 'proxy' : 'direct', condition: opts.condition, gap: GAP[opts.condition].name,
            strict, smoke: opts.smoke,
            model: opts.model, target: opts.target, endpoint,
            soniox_url: proxyMode ? null : SONIOX_URL, proxy_url: proxyMode ? endpoint : null, websocket_impl: impl,
            started_at: state.startedAt, ended_at: new Date().toISOString(),
            ack_wall_ms: state.ackWallMs, start_failed: state.startFailed,
            auth_success_wall_ms: state.authWallMs, proxy_ready_count: state.proxyReadyCount,
            config: redact(startConfig),
            schedule: audio.phases.map((p) => ({ name: p.name, file: p.file, seconds: (p.endMs - p.startMs) / 1000 })),
            bytes_sent: state.bytesSent, audio_seconds_sent: state.bytesSent / BYTES_PER_SECOND,
            audio_seconds_planned: totalSeconds, wall_seconds: wallMs() / 1000,
            completed_audio: state.bytesSent >= totalBytes, finished: state.finished, close: state.closeInfo,
            failed: state.failed, failure_reason: state.failureReason,
            tokens_total: state.tokens, final_tokens_total: state.finalTokens, fin_tokens: state.finTokens,
            phases: state.phases,
            translation_resumed: post.finals_translation > 0,
            seconds_to_first_post_gap_translation:
                post.first_translation_wall_ms != null && post.audio_start_wall_ms != null
                    ? (post.first_translation_wall_ms - post.audio_start_wall_ms) / 1000 : null,
            pre_translation_per_spoken: preSpoken ? pre.finals_translation / preSpoken : null,
            post_translation_per_spoken: postSpoken ? post.finals_translation / postSpoken : null,
            stall_reproduced: postSpoken >= 5 && post.finals_translation === 0,
            errors: state.errors,
            proxy_error_frames: state.errors.filter((e) => e.source === 'proxy').length,
            soniox_error_frames: state.errors.filter((e) => e.source === 'soniox').length,
            proxy_notices: state.notices.map(({ type, event, ...rest }) => rest),
            proxy_notice_counts: state.noticeCounts,
            events: state.events.filter((e) => e.event !== 'phase_start').map(({ type, ...rest }) => rest),
            tokens_file: tokensPath,
        };
        fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
        console.error(`[${opts.label}] summary written: ${summaryPath}`);
    };

    const exitCode = () => (state.startFailed ? 3 : state.failed ? 4 : state.bytesSent >= totalBytes ? 0 : 2);

    const shutdown = () => {
        clearTimers();
        writeSummary();
        jsonl.end(() => process.exit(exitCode()));
    };

    const ws = new WS(connectUrl);

    const finishStreaming = (aborted = false) => {
        if (state.streamingDone) return;
        state.streamingDone = true;
        state.audioDoneWall = wallMs();
        logEvent('audio_done', { bytes: state.bytesSent, audio_s: Number((state.bytesSent / BYTES_PER_SECOND).toFixed(1)), aborted });
        progress('audio_done');
        let waitMs = FINISH_TIMEOUT_MS;
        let timeoutEvent = 'finish_timeout';
        if (!aborted && ws.readyState === WS_OPEN) {
            if (proxyMode) {
                // The proxy ignores an empty text frame (it is not JSON) and never
                // forwards a finished frame, so ask it to finalize the tail, give
                // the tail a moment to arrive, then close from this side.
                try { ws.send(JSON.stringify({ type: 'finalize' })); logEvent('finalize_sent'); } catch (e) { logEvent('finalize_error', { message: e.message }); }
                waitMs = PROXY_TAIL_MS;
                timeoutEvent = 'tail_done';
            } else {
                try { ws.send(''); logEvent('end_frame_sent'); } catch (e) { logEvent('end_frame_error', { message: e.message }); }
            }
        }
        state.timers.finish = setTimeout(() => {
            if (!state.closed) { logEvent(timeoutEvent); try { ws.close(1000, 'harness done'); } catch {} }
        }, waitMs);
    };

    const startStreaming = () => {
        state.streamStartWall = Date.now();
        logEvent('streaming_start');
        const tick = () => {
            if (state.closed) return;
            const off = state.bytesSent;
            if (off >= totalBytes) { finishStreaming(); return; }
            const end = Math.min(off + FRAME_BYTES, totalBytes);
            const ph = phaseAtAudio((off / BYTES_PER_SECOND) * 1000);
            if (state.phases[ph].audio_start_wall_ms == null) {
                state.phases[ph].audio_start_wall_ms = wallMs();
                logEvent('phase_start', { phase: ph, audio_ms: Math.round((off / BYTES_PER_SECOND) * 1000) });
                if (ph !== 'pre') progress(`phase_${ph}`);
            }
            try { ws.send(audio.buffer.subarray(off, end)); } catch (e) {
                logEvent('send_error', { message: e.message });
                finishStreaming(true);
                return;
            }
            state.bytesSent = end;
            state.framesSent++;
            const nextAt = state.streamStartWall + state.framesSent * FRAME_MS;
            state.timers.send = setTimeout(tick, Math.max(0, nextAt - Date.now()));
        };
        tick();
    };

    const onTokens = (msg) => {
        const now = wallMs();
        const sentMs = audioSentMs();
        for (const tok of msg.tokens) {
            const text = tok.text ?? '';
            const status = tok.translation_status ?? null;
            const hasStart = typeof tok.start_ms === 'number';
            let phase;
            if (hasStart) phase = phaseAtAudio(tok.start_ms);
            else if (status === 'translation' && state.lastSpokenPhase) phase = state.lastSpokenPhase;
            else phase = phaseAtAudio(sentMs);
            state.tokens++;
            writeLine({
                type: 'token', t_wall_ms: now, audio_sent_ms: Math.round(sentMs), phase,
                text, is_final: !!tok.is_final, language: tok.language ?? null, translation_status: status,
                source_language: tok.source_language ?? null,
                start_ms: hasStart ? tok.start_ms : null, end_ms: typeof tok.end_ms === 'number' ? tok.end_ms : null,
                final_audio_proc_ms: msg.final_audio_proc_ms ?? null, total_audio_proc_ms: msg.total_audio_proc_ms ?? null,
            });
            const ps = state.phases[phase];
            if (text === '<end>') { ps.end_tokens++; continue; }
            if (text === '<fin>') { state.finTokens++; continue; }
            if (status !== 'translation' && hasStart) state.lastSpokenPhase = phase;
            if (!tok.is_final) { ps.nonfinal_tokens++; continue; }
            state.finalTokens++;
            if (status === 'translation') {
                ps.finals_translation++;
                bump(ps.translation_languages, tok.language);
                state.lastTranslationWall = now;
                ps.last_translation_wall_ms = now;
                if (ps.first_translation_wall_ms == null) ps.first_translation_wall_ms = now;
            } else {
                if (status === 'original') ps.finals_original++; else ps.finals_none++;
                bump(ps.languages, tok.language);
                state.lastOriginalWall = now;
                ps.last_original_wall_ms = now;
                if (ps.first_original_wall_ms == null) ps.first_original_wall_ms = now;
            }
        }
    };

    const failStart = (reason, event) => {
        if (state.ackWallMs != null) return;
        state.startFailed = true;
        state.failureReason ??= reason;
        logEvent(event, { reason });
    };

    // Proxy control frames. Returns true when the frame was one of them.
    const onProxyControl = (msg) => {
        switch (msg.type) {
            case 'auth_success':
                state.authWallMs = wallMs();
                clearTimeout(state.timers.auth);
                logEvent('auth_success', { connection_id: msg.connectionId ?? null });
                try { ws.send(JSON.stringify(startMessage)); logEvent('start_sent'); } catch (e) { logEvent('start_send_error', { message: e.message }); }
                state.timers.ack = setTimeout(() => {
                    if (state.ackWallMs == null) {
                        failStart(`no proxy_ready within ${PROXY_READY_TIMEOUT_MS} ms`, 'proxy_ready_timeout');
                        try { ws.close(1000, 'proxy_ready timeout'); } catch {}
                    }
                }, PROXY_READY_TIMEOUT_MS);
                return true;
            case 'proxy_ready':
                state.proxyReadyCount++;
                if (state.proxyReadyCount === 1) {
                    state.ackWallMs = wallMs();
                    clearTimeout(state.timers.ack);
                    logEvent('proxy_ready', { connection_id: msg.connection_id ?? null });
                    startStreaming();
                } else {
                    // The relay promises exactly one per client connection; a second
                    // one would make the web studio treat it as a fresh session.
                    logEvent('proxy_ready_duplicate', { count: state.proxyReadyCount });
                }
                return true;
            case 'proxy_notice': {
                const extra = { ...msg };
                delete extra.type;
                delete extra.event;
                const notice = msg.event ?? '?';
                bump(state.noticeCounts, notice);
                state.notices.push(logEvent('proxy_notice', { notice, phase: currentPhase(), ...extra }));
                return true;
            }
            case 'error': {
                const err = {
                    source: 'proxy', t_wall_ms: wallMs(), audio_sent_ms: Math.round(audioSentMs()),
                    code: msg.code ?? null, message: msg.message ?? null,
                };
                state.errors.push(err);
                state.lastProxyError = err;
                logEvent('error_frame', err);
                failStart(`proxy error before ready: ${[err.code, err.message].filter((v) => v != null).join(' ')}`, 'start_rejected');
                return true;
            }
            case 'pong':
                return true;
            default:
                return false;
        }
    };

    const onMessage = (raw) => {
        const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
        state.lastUpstreamWall = wallMs();
        state.upstreamSilentWarned = false;
        let msg;
        try { msg = JSON.parse(text); } catch { logEvent('unparseable_message', { length: text.length }); return; }
        if (!msg || typeof msg !== 'object') { logEvent('unexpected_message', { length: text.length }); return; }
        if (proxyMode && typeof msg.type === 'string' && onProxyControl(msg)) return;
        const isError = msg.error_code != null || msg.error_type != null;
        if (isError) {
            const err = {
                source: 'soniox', t_wall_ms: wallMs(), audio_sent_ms: Math.round(audioSentMs()),
                error_code: msg.error_code ?? null, error_type: msg.error_type ?? null,
                error_message: msg.error_message ?? msg.message ?? null, request_id: msg.request_id ?? null, more_info: msg.more_info ?? null,
            };
            state.errors.push(err);
            logEvent('error_frame', err);
        }
        if (!proxyMode && state.ackWallMs == null) {
            state.ackWallMs = wallMs();
            clearTimeout(state.timers.ack);
            if (isError) {
                state.startFailed = true;
                logEvent('start_rejected');
            } else {
                logEvent('ack', { final_audio_proc_ms: msg.final_audio_proc_ms ?? null, total_audio_proc_ms: msg.total_audio_proc_ms ?? null, keys: Object.keys(msg) });
                startStreaming();
            }
        }
        if (Array.isArray(msg.tokens) && msg.tokens.length) onTokens(msg);
        if (msg.finished) {
            state.finished = true;
            logEvent('finished', { final_audio_proc_ms: msg.final_audio_proc_ms ?? null, total_audio_proc_ms: msg.total_audio_proc_ms ?? null });
            clearTimeout(state.timers.finish);
            setTimeout(() => { if (!state.closed) { try { ws.close(1000, 'finished'); } catch {} } }, 200);
        }
    };

    ws.onopen = () => {
        logEvent('open');
        if (proxyMode) {
            // The start message goes out on auth_success (see onProxyControl).
            state.timers.auth = setTimeout(() => {
                if (state.authWallMs == null) {
                    failStart(`no auth_success within ${ACK_TIMEOUT_MS} ms`, 'auth_timeout');
                    try { ws.close(1000, 'auth timeout'); } catch {}
                }
            }, ACK_TIMEOUT_MS);
            return;
        }
        try { ws.send(JSON.stringify(startMessage)); } catch (e) { logEvent('start_send_error', { message: e.message }); }
        logEvent('start_sent');
        state.timers.ack = setTimeout(() => {
            if (state.ackWallMs == null) {
                logEvent('ack_timeout');
                state.startFailed = true;
                try { ws.close(1000, 'ack timeout'); } catch {}
            }
        }, ACK_TIMEOUT_MS);
    };
    ws.onmessage = (ev) => onMessage(ev.data);
    ws.onerror = (ev) => {
        const message = ev?.message || ev?.error?.message || 'websocket error';
        logEvent('ws_error', { message });
        if (state.ackWallMs == null) state.startFailed = true;
    };
    ws.onclose = (ev) => {
        if (state.closed) return;
        state.closed = true;
        const code = ev?.code ?? null;
        const reason = String(ev?.reason ?? '');
        state.closeInfo = { code, reason, t_wall_ms: wallMs(), audio_sent_ms: Math.round(audioSentMs()), completed_audio: state.bytesSent >= totalBytes };
        if (proxyMode) {
            if (code === 1011) {
                // The relay gave up on Soniox (re-dials exhausted or a non-retryable
                // account error): the error frame before this close says why.
                state.failed = true;
                const last = state.lastProxyError;
                state.failureReason ??= `proxy closed 1011${reason ? ` (${reason})` : ''}${last?.message ? `: ${last.message}` : ''}`;
                logEvent('run_failed', { reason: state.failureReason });
            } else if (state.ackWallMs == null) {
                failStart(`closed with ${code} before proxy_ready${reason ? ` (${reason})` : ''}`, 'closed_before_ready');
            }
        }
        logEvent('close', state.closeInfo);
        progress('final');
        shutdown();
    };

    state.timers.progress = setInterval(() => progress(), PROGRESS_MS);
    state.timers.silence = setInterval(() => {
        if (state.lastUpstreamWall == null || state.closed || state.streamingDone) return;
        if (wallMs() - state.lastUpstreamWall > UPSTREAM_SILENT_WARN_MS && !state.upstreamSilentWarned) {
            state.upstreamSilentWarned = true;
            logEvent('upstream_silent', { seconds: Math.round((wallMs() - state.lastUpstreamWall) / 1000) });
        }
    }, 10000);

    const onSignal = (sig) => {
        logEvent('signal', { signal: sig });
        try { ws.close(1000, 'signal'); } catch {}
        setTimeout(() => { if (!state.closed) { state.closed = true; shutdown(); } }, 2000);
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
}

main().catch((err) => {
    console.error(`fatal: ${err?.stack || err}`);
    process.exit(3);
});
