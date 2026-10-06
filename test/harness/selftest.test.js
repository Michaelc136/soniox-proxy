/**
 * Self-test for the reproduction harness: runs reproduce-stall.js against an
 * in-process mock of the Soniox WebSocket API and checks the start config,
 * per-phase counters, stall detection, key redaction, the token log, and
 * summarize.js. Audio is 1 s per phase, so the whole file takes a few seconds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { startMockSoniox } from '../mock-soniox.js';
import { startRelayHost, fastConfig, TEST_API_KEY } from '../helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_JWT = 'selftest-jwt-not-real';
const SCRIPT = path.join(HERE, 'reproduce-stall.js');
const SUMMARIZE = path.join(HERE, 'summarize.js');
const BYTES_PER_SECOND = 32000;
const GOOD_KEY = 'selftest-key';
const BAD_KEY = 'bad-key';

// Mock Soniox: acks the start request, emits one final original token per
// audio frame plus a translation token (unless the client_reference_id
// contains "stall", in which case after 1 s of audio the originals come back
// tagged language es with translation_status none and no translation follows),
// an <end> token every 1.5 s, <fin> on finalize, and finished on the empty frame.
function startMock() {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const seen = [];
    wss.on('connection', (ws) => {
        let started = false;
        let stall = false;
        let audioBytes = 0;
        let audioMs = 0;
        let lastEmitMs = 0;
        let lastEndMs = 0;
        ws.on('message', (data, isBinary) => {
            if (!started) {
                const cfg = JSON.parse(data.toString());
                seen.push(cfg);
                started = true;
                stall = String(cfg.client_reference_id || '').includes('stall');
                if (cfg.api_key !== GOOD_KEY) {
                    ws.send(JSON.stringify({ tokens: [], error_code: 401, error_type: 'unauthenticated', error_message: 'Incorrect API key provided.', request_id: 'mock' }));
                    setTimeout(() => ws.close(1000), 20);
                    return;
                }
                ws.send(JSON.stringify({ tokens: [], final_audio_proc_ms: 0, total_audio_proc_ms: 0 }));
                return;
            }
            if (!isBinary) {
                const text = data.toString();
                if (text === '') {
                    ws.send(JSON.stringify({ tokens: [], final_audio_proc_ms: audioMs, total_audio_proc_ms: audioMs, finished: true }));
                    setTimeout(() => ws.close(1000), 50);
                    return;
                }
                try {
                    if (JSON.parse(text).type === 'finalize') {
                        ws.send(JSON.stringify({ tokens: [{ text: '<fin>', is_final: true }], final_audio_proc_ms: audioMs, total_audio_proc_ms: audioMs }));
                    }
                } catch { /* ignore */ }
                return;
            }
            audioBytes += data.length;
            audioMs = Math.round((audioBytes / BYTES_PER_SECOND) * 1000);
            if (audioMs - lastEmitMs < 100) return;
            const stalled = stall && audioMs > 1000;
            const tokens = [{
                text: 'word', is_final: true, language: stalled ? 'es' : 'en',
                translation_status: stalled ? 'none' : 'original', start_ms: lastEmitMs, end_ms: audioMs,
            }];
            if (!stalled) tokens.push({ text: 'palabra', is_final: true, language: 'es', translation_status: 'translation', source_language: 'en' });
            if (audioMs - lastEndMs >= 1500) {
                tokens.push({ text: '<end>', is_final: true, start_ms: audioMs, end_ms: audioMs });
                lastEndMs = audioMs;
            }
            ws.send(JSON.stringify({ tokens, final_audio_proc_ms: audioMs, total_audio_proc_ms: audioMs }));
            lastEmitMs = audioMs;
        });
    });
    return new Promise((resolve) => wss.on('listening', () => resolve({ wss, port: wss.address().port, seen })));
}

function run(script, args, env) {
    return new Promise((resolve, reject) => {
        const childEnv = { ...process.env, ...env };
        delete childEnv.NODE_TEST_CONTEXT;
        const child = spawn(process.execPath, [script, ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', reject);
        child.on('exit', (code) => resolve({ code, stdout, stderr }));
    });
}

function makeAudio(dir) {
    const audioDir = path.join(dir, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    for (const f of ['en-pre.raw', 'gap-A-silence.raw', 'en-post.raw']) {
        fs.writeFileSync(path.join(audioDir, f), Buffer.alloc(BYTES_PER_SECOND));
    }
    return audioDir;
}

test('harness: counters, stall detection, strict flag, redaction, token log, summarize', async (t) => {
    const { wss, port, seen } = await startMock();
    t.after(() => wss.close());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soniox-harness-selftest-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const audioDir = makeAudio(dir);
    const env = { SONIOX_API_KEY: GOOD_KEY, SONIOX_WS_URL: `ws://127.0.0.1:${port}` };
    const common = ['--audio-dir', audioDir, '--out-dir', dir, '--condition', 'A'];

    const [stalled, healthy] = await Promise.all([
        run(SCRIPT, [...common, '--label', 'A-nostrict-stall-selftest'], env),
        run(SCRIPT, [...common, '--strict', '--label', 'A-strict-selftest'], env),
    ]);
    assert.equal(stalled.code, 0, stalled.stderr);
    assert.equal(healthy.code, 0, healthy.stderr);

    assert.equal(seen.length, 2);
    const strictCfg = seen.find((c) => c.client_reference_id === 'selah-harness-A-strict-selftest');
    const plainCfg = seen.find((c) => c.client_reference_id === 'selah-harness-A-nostrict-stall-selftest');
    assert.equal(strictCfg.language_hints_strict, true);
    assert.equal(plainCfg.language_hints_strict, undefined);
    for (const c of [strictCfg, plainCfg]) {
        assert.equal(c.api_key, GOOD_KEY);
        assert.equal(c.model, 'stt-rt-v5');
        assert.equal(c.audio_format, 'pcm_s16le');
        assert.equal(c.sample_rate, 16000);
        assert.equal(c.num_channels, 1);
        assert.deepEqual(c.language_hints, ['en']);
        assert.equal(c.enable_endpoint_detection, true);
        assert.equal(c.enable_language_identification, true);
        assert.equal(c.translation.type, 'one_way');
        assert.equal(c.translation.target_language, 'es');
    }

    const s1 = JSON.parse(fs.readFileSync(path.join(dir, 'A-nostrict-stall-selftest.summary.json'), 'utf8'));
    const s2 = JSON.parse(fs.readFileSync(path.join(dir, 'A-strict-selftest.summary.json'), 'utf8'));
    for (const s of [s1, s2]) {
        assert.equal(s.config.api_key, '***');
        assert.equal(s.completed_audio, true);
        assert.equal(s.finished, true);
        assert.equal(s.close.code, 1000);
        assert.equal(s.errors.length, 0);
        assert.equal(s.audio_seconds_sent, 3);
        assert.ok(s.phases.pre.finals_original >= 5, `pre originals ${s.phases.pre.finals_original}`);
        assert.ok(s.phases.pre.finals_translation >= 5, `pre translations ${s.phases.pre.finals_translation}`);
        assert.ok(s.phases.pre.languages.en >= 5);
        assert.ok(s.phases.pre.end_tokens + s.phases.gap.end_tokens + s.phases.post.end_tokens >= 1);
    }
    assert.equal(s1.phases.post.finals_translation, 0);
    assert.ok(s1.phases.post.finals_none >= 5, `post none ${s1.phases.post.finals_none}`);
    assert.ok(s1.phases.post.languages.es >= 5);
    assert.equal(s1.translation_resumed, false);
    assert.equal(s1.stall_reproduced, true);
    assert.equal(s1.seconds_to_first_post_gap_translation, null);
    assert.ok(s2.phases.post.finals_translation >= 5, `post translations ${s2.phases.post.finals_translation}`);
    assert.equal(s2.translation_resumed, true);
    assert.equal(s2.stall_reproduced, false);
    assert.ok(s2.seconds_to_first_post_gap_translation >= 0);

    const raw = fs.readFileSync(path.join(dir, 'A-strict-selftest.tokens.jsonl'), 'utf8');
    assert.ok(!raw.includes(GOOD_KEY), 'token log must not contain the key');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'meta');
    assert.equal(lines[0].config.api_key, '***');
    const tokens = lines.filter((l) => l.type === 'token');
    assert.ok(tokens.length >= 40, `tokens ${tokens.length}`);
    const fields = ['t_wall_ms', 'audio_sent_ms', 'phase', 'text', 'is_final', 'language', 'translation_status', 'source_language', 'start_ms', 'end_ms'];
    for (const tk of tokens) for (const k of fields) assert.ok(k in tk, `token missing ${k}`);
    assert.ok(tokens.some((tk) => tk.translation_status === 'translation' && tk.source_language === 'en' && tk.start_ms === null));
    assert.deepEqual([...new Set(tokens.map((tk) => tk.phase))].sort(), ['gap', 'post', 'pre']);
    const events = lines.filter((l) => l.type === 'event').map((l) => l.event);
    for (const e of ['open', 'start_sent', 'ack', 'streaming_start', 'audio_done', 'end_frame_sent', 'finished', 'close']) {
        assert.ok(events.includes(e), `missing event ${e}`);
    }

    const sum = await run(SUMMARIZE, [dir], {});
    assert.equal(sum.code, 0, sum.stderr);
    const md = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
    assert.match(md, /Stall reproduced[^\n]*\*\*yes\*\*/);
    assert.match(md, /prevented the stall[^\n]*\*\*yes\*\*/);
    assert.ok(!md.includes(GOOD_KEY));
    const matrix = JSON.parse(fs.readFileSync(path.join(dir, 'matrix.json'), 'utf8'));
    assert.equal(matrix.reproduced_stall, true);
    assert.equal(matrix.strict_prevented_stall, true);
    assert.equal(matrix.runs.length, 2);
});

test('harness: a rejected start request is recorded as an error frame and exits 3', async (t) => {
    const { wss, port } = await startMock();
    t.after(() => wss.close());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soniox-harness-selftest-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const audioDir = makeAudio(dir);
    const res = await run(SCRIPT, ['--audio-dir', audioDir, '--out-dir', dir, '--condition', 'A', '--label', 'A-rejected-selftest'],
        { SONIOX_API_KEY: BAD_KEY, SONIOX_WS_URL: `ws://127.0.0.1:${port}` });
    assert.equal(res.code, 3, res.stderr);
    assert.ok(!res.stderr.includes(BAD_KEY), 'stderr must not contain the key');
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'A-rejected-selftest.summary.json'), 'utf8'));
    assert.equal(s.start_failed, true);
    assert.equal(s.bytes_sent, 0);
    assert.equal(s.errors.length, 1);
    assert.equal(s.errors[0].error_code, 401);
    assert.equal(s.errors[0].error_type, 'unauthenticated');
    assert.equal(s.translation_resumed, false);
    assert.equal(s.stall_reproduced, false);
});

// Proxy mode runs through the real relay (helpers.startRelayHost: auth_success,
// then a Relay per client, exactly what server.js does after the JWT check)
// with the mock Soniox behind it, so the proxy protocol is exercised end to end.
test('harness proxy mode: auth_success, studio-shaped start, one proxy_ready, notices and tail, no secrets in files', async (t) => {
    const mock = await startMockSoniox();
    t.after(() => mock.close());
    // Stream 1 dies after 8 audio frames: the relay buffers, re-dials, adopts
    // stream 2 and sends one stream_recycled notice. The run still completes.
    mock.setStream(1, { dropAfterFrames: 8 });
    const host = await startRelayHost(fastConfig(mock.url));
    t.after(() => host.close());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soniox-harness-selftest-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const audioDir = makeAudio(dir);

    const res = await run(SCRIPT, ['--audio-dir', audioDir, '--out-dir', dir, '--condition', 'A', '--via-proxy', host.url, '--label', 'A-proxy-selftest'],
        { HARNESS_JWT: FAKE_JWT });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(!res.stderr.includes(FAKE_JWT), 'stderr must not contain the jwt');
    assert.ok(!res.stderr.includes(TEST_API_KEY), 'stderr must not contain the api key');

    // What the proxy sent upstream: the key and the strict/langId flags come from the proxy, not the harness.
    await mock.waitForStreams(2);
    for (const stream of mock.streams) {
        const cfg = stream.startConfig;
        assert.equal(cfg.api_key, TEST_API_KEY);
        assert.equal(cfg.language_hints_strict, true);
        assert.equal(cfg.enable_language_identification, true);
        assert.deepEqual(cfg.language_hints, ['en']);
        assert.equal(cfg.translation.target_language, 'es');
        assert.equal(cfg.translation.source_language, undefined, 'the proxy strips source_language');
        assert.equal(cfg.client_reference_id, undefined);
    }
    assert.ok(mock.streams[1].audioFrames > 0, 'audio continued on the replacement stream');

    const s = JSON.parse(fs.readFileSync(path.join(dir, 'A-proxy-selftest.summary.json'), 'utf8'));
    assert.equal(s.mode, 'proxy');
    assert.ok(s.proxy_url.startsWith(host.url));
    assert.equal(s.soniox_url, null);
    assert.equal(s.strict, null);
    assert.equal(s.start_failed, false);
    assert.equal(s.failed, false);
    assert.equal(s.failure_reason, null);
    assert.equal(s.proxy_ready_count, 1);
    assert.ok(s.auth_success_wall_ms != null && s.ack_wall_ms >= s.auth_success_wall_ms);
    assert.equal(s.completed_audio, true);
    assert.equal(s.audio_seconds_sent, 3);
    assert.equal(s.close.code, 1000);
    assert.equal(s.finished, false, 'the proxy never forwards a finished frame');
    assert.equal(s.fin_tokens, 0, 'the proxy strips <fin>');
    assert.ok(s.tokens_total >= 20, `tokens ${s.tokens_total}`);
    assert.ok(s.phases.pre.finals_translation >= 3, `pre translations ${s.phases.pre.finals_translation}`);
    assert.equal(s.errors.length, 0);
    assert.equal(s.proxy_error_frames, 0);
    assert.deepEqual(s.proxy_notice_counts, { stream_recycled: 1 });
    assert.equal(s.proxy_notices.length, 1);
    assert.equal(s.proxy_notices[0].notice, 'stream_recycled');
    assert.equal(typeof s.proxy_notices[0].t_wall_ms, 'number');
    assert.equal(typeof s.proxy_notices[0].audio_sent_ms, 'number');
    // The config the harness sent is the studio's shape: nothing the proxy owns.
    assert.deepEqual(Object.keys(s.config).sort(), ['audio_format', 'enable_endpoint_detection', 'include_nonfinal', 'language_hints', 'model', 'sample_rate', 'translation']);
    assert.deepEqual(s.config.translation, { source_language: 'en', target_language: 'es', type: 'one_way' });

    const raw = fs.readFileSync(path.join(dir, 'A-proxy-selftest.tokens.jsonl'), 'utf8');
    assert.ok(!raw.includes(FAKE_JWT), 'token log must not contain the jwt');
    assert.ok(!raw.includes(TEST_API_KEY), 'token log must not contain the api key');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'meta');
    assert.equal(lines[0].mode, 'proxy');
    assert.equal(lines[0].endpoint, s.proxy_url);
    const events = lines.filter((l) => l.type === 'event');
    const names = events.map((l) => l.event);
    for (const e of ['open', 'auth_success', 'start_sent', 'proxy_ready', 'streaming_start', 'audio_done', 'finalize_sent', 'tail_done', 'close']) {
        assert.ok(names.includes(e), `missing event ${e}`);
    }
    assert.equal(names.filter((e) => e === 'proxy_ready').length, 1);
    const notice = events.find((l) => l.event === 'proxy_notice');
    assert.equal(notice.notice, 'stream_recycled');
    assert.equal(typeof notice.t_wall_ms, 'number');
    assert.ok(lines.filter((l) => l.type === 'token').length >= 20);

    const sum = await run(SUMMARIZE, [dir], {});
    assert.equal(sum.code, 0, sum.stderr);
    const md = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
    assert.match(md, /through the Selah proxy/);
    assert.match(md, /stream_recycled:1/);
    assert.match(md, /proxy_ready x1/);
    assert.ok(!md.includes(FAKE_JWT));
    const matrix = JSON.parse(fs.readFileSync(path.join(dir, 'matrix.json'), 'utf8'));
    assert.equal(matrix.runs[0].mode, 'proxy');
    assert.equal(matrix.runs[0].proxy_ready_count, 1);
    assert.equal(matrix.runs[0].failed, false);
});

test('harness proxy mode: an exhausted re-dial is a run failure with the 1011 reason and exit 4', async (t) => {
    const mock = await startMockSoniox();
    t.after(() => mock.close());
    mock.setStream(1, { dropAfterFrames: 5 });
    mock.setStream(2, { refuseConnection: true });
    mock.setStream(3, { refuseConnection: true });
    const host = await startRelayHost(fastConfig(mock.url));
    t.after(() => host.close());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soniox-harness-selftest-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const audioDir = makeAudio(dir);

    const res = await run(SCRIPT, ['--audio-dir', audioDir, '--out-dir', dir, '--condition', 'A', '--via-proxy', host.url, '--label', 'A-proxy-loss-selftest'],
        { HARNESS_JWT: FAKE_JWT });
    assert.equal(res.code, 4, res.stderr);
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'A-proxy-loss-selftest.summary.json'), 'utf8'));
    assert.equal(s.proxy_ready_count, 1);
    assert.equal(s.start_failed, false);
    assert.equal(s.failed, true);
    assert.match(s.failure_reason, /1011/);
    assert.match(s.failure_reason, /upstream failed/);
    assert.equal(s.completed_audio, false);
    assert.equal(s.close.code, 1011);
    assert.equal(s.proxy_error_frames, 1);
    assert.equal(s.errors[0].source, 'proxy');
    assert.equal(s.errors[0].code, 1011);
    assert.equal(typeof s.errors[0].t_wall_ms, 'number');
    const names = s.events.map((e) => e.event);
    assert.ok(names.includes('error_frame'));
    assert.ok(names.includes('run_failed'));
    const raw = fs.readFileSync(path.join(dir, 'A-proxy-loss-selftest.tokens.jsonl'), 'utf8');
    assert.ok(raw.split('\n').some((l) => l.includes('"event":"error_frame"') && l.includes('"source":"proxy"')));
});

test('harness proxy mode: refuses --strict, requires HARNESS_JWT, and never needs SONIOX_API_KEY', async () => {
    const base = { ...process.env, SONIOX_WS_URL: 'ws://127.0.0.1:9' };
    delete base.SONIOX_API_KEY;
    delete base.HARNESS_JWT;
    const spawnHarness = (args, env) => new Promise((resolve) => {
        const childEnv = { ...env };
        delete childEnv.NODE_TEST_CONTEXT;
        const child = spawn(process.execPath, [SCRIPT, ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('exit', (code) => resolve({ code, stderr }));
    });
    const strict = await spawnHarness(['--condition', 'A', '--via-proxy', 'ws://127.0.0.1:9', '--strict'], { ...base, HARNESS_JWT: FAKE_JWT });
    assert.equal(strict.code, 2);
    assert.match(strict.stderr, /--strict cannot be combined with --via-proxy/);
    const noJwt = await spawnHarness(['--condition', 'A', '--via-proxy', 'ws://127.0.0.1:9'], base);
    assert.equal(noJwt.code, 2);
    assert.match(noJwt.stderr, /HARNESS_JWT is not set/);
    assert.ok(!noJwt.stderr.includes('SONIOX_API_KEY'));
    const badUrl = await spawnHarness(['--condition', 'A', '--via-proxy', 'https://example.com'], { ...base, HARNESS_JWT: FAKE_JWT });
    assert.equal(badUrl.code, 2);
    assert.match(badUrl.stderr, /ws:\/\/ or wss:\/\//);
});

test('harness: missing SONIOX_API_KEY exits 2 without connecting', async () => {
    const env = { ...process.env, SONIOX_WS_URL: 'ws://127.0.0.1:9' };
    delete env.SONIOX_API_KEY;
    const res = await new Promise((resolve) => {
        const childEnv = { ...env };
        delete childEnv.NODE_TEST_CONTEXT;
        const child = spawn(process.execPath, [SCRIPT, '--condition', 'A'], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('exit', (code) => resolve({ code, stderr }));
    });
    assert.equal(res.code, 2);
    assert.match(res.stderr, /SONIOX_API_KEY is not set/);
});
