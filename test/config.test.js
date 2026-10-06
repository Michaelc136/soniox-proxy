import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSonioxConfig, resolveStartFlags, describeStartFlags, redactConfig, bytesPerSecond, isErrorFrame, UpstreamError, DEFAULT_SONIOX_WS_URL } from '../upstream.js';
import { readRelayConfig } from '../relay.js';

const KEY = 'sk-test-not-real';

test('language_hints_strict is sent only when the client sent exactly one hint', () => {
    const one = buildSonioxConfig({ language_hints: ['en'] }, KEY);
    assert.equal(one.language_hints_strict, true);
    assert.deepEqual(one.language_hints, ['en']);

    const many = buildSonioxConfig({ language_hints: ['en', 'es'] }, KEY);
    assert.equal('language_hints_strict' in many, false);

    const none = buildSonioxConfig({ language_hints: [] }, KEY);
    assert.equal('language_hints_strict' in none, false);
    assert.deepEqual(none.language_hints, []);

    // The ['en'] fallback is the proxy's choice, not the client's: no strict.
    const absent = buildSonioxConfig({}, KEY);
    assert.deepEqual(absent.language_hints, ['en']);
    assert.equal('language_hints_strict' in absent, false);

    const off = buildSonioxConfig({ language_hints: ['en'] }, KEY, { strictHints: false });
    assert.equal('language_hints_strict' in off, false);
});

// Control runs: a client may pin language_hints_strict for one session. An
// explicit boolean wins over the proxy default in both directions and
// regardless of the hint count or SONIOX_STRICT_HINTS; anything that is not
// a boolean is "omitted" and the default applies. Both production clients
// omit the field, so their start request is unchanged.
test('an explicit boolean language_hints_strict from the client is honored over the proxy default', () => {
    const clientOff = buildSonioxConfig({ language_hints: ['en'], language_hints_strict: false }, KEY);
    assert.equal(clientOff.language_hints_strict, false, 'client false beats the one-hint default of true');
    assert.equal('language_hints_strict' in clientOff, true, 'sent explicitly so the Soniox log shows it');

    const clientOnManyHints = buildSonioxConfig({ language_hints: ['en', 'es'], language_hints_strict: true }, KEY);
    assert.equal(clientOnManyHints.language_hints_strict, true, 'client true beats the several-hints default of unset');

    const clientOnEnvOff = buildSonioxConfig({ language_hints: ['en'], language_hints_strict: true }, KEY, { strictHints: false });
    assert.equal(clientOnEnvOff.language_hints_strict, true, 'client true beats SONIOX_STRICT_HINTS=off');

    const clientOffNoHints = buildSonioxConfig({ language_hints_strict: false }, KEY);
    assert.equal(clientOffNoHints.language_hints_strict, false);

    for (const notBoolean of ['false', 'true', 0, 1, null]) {
        const cfg = buildSonioxConfig({ language_hints: ['en'], language_hints_strict: notBoolean }, KEY);
        assert.equal(cfg.language_hints_strict, true, `${JSON.stringify(notBoolean)} is not an explicit boolean: default applies`);
    }

    assert.deepEqual(resolveStartFlags({ language_hints: ['en'] }, {}).strictHints, { source: 'default', value: true });
    assert.deepEqual(resolveStartFlags({ language_hints: ['en', 'es'] }, {}).strictHints, { source: 'default', value: false });
    assert.deepEqual(resolveStartFlags({ language_hints: ['en'] }, { strictHints: false }).strictHints, { source: 'default', value: false });
    assert.deepEqual(resolveStartFlags({ language_hints: ['en'], language_hints_strict: false }, {}).strictHints, { source: 'client', value: false });
    assert.deepEqual(resolveStartFlags({ language_hints: ['en', 'es'], language_hints_strict: true }, {}).strictHints, { source: 'client', value: true });
});

test('an explicit boolean enable_language_identification from the client is honored over the proxy default', () => {
    const clientOff = buildSonioxConfig({ enable_language_identification: false }, KEY);
    assert.equal(clientOff.enable_language_identification, false, 'client false beats the default of true');
    assert.equal('enable_language_identification' in clientOff, true, 'sent explicitly so the Soniox log shows it');

    const clientOnEnvOff = buildSonioxConfig({ enable_language_identification: true }, KEY, { langId: false });
    assert.equal(clientOnEnvOff.enable_language_identification, true, 'client true beats SONIOX_LANG_ID=off');

    for (const notBoolean of ['false', 'off', 0, null]) {
        const cfg = buildSonioxConfig({ enable_language_identification: notBoolean }, KEY);
        assert.equal(cfg.enable_language_identification, true, `${JSON.stringify(notBoolean)} is not an explicit boolean: default applies`);
    }
    assert.equal('enable_language_identification' in buildSonioxConfig({ enable_language_identification: 'off' }, KEY, { langId: false }), false);

    assert.deepEqual(resolveStartFlags({}, {}).langId, { source: 'default', value: true });
    assert.deepEqual(resolveStartFlags({}, { langId: false }).langId, { source: 'default', value: false });
    assert.deepEqual(resolveStartFlags({ enable_language_identification: false }, {}).langId, { source: 'client', value: false });
    assert.deepEqual(resolveStartFlags({ enable_language_identification: true }, { langId: false }).langId, { source: 'client', value: true });
});

test('describeStartFlags is the start-line wording: strictHints=<source>:<value> langId=<source>:<value>', () => {
    assert.equal(describeStartFlags(resolveStartFlags({ language_hints: ['en'] }, {})), 'strictHints=default:true langId=default:true');
    assert.equal(describeStartFlags(resolveStartFlags({ language_hints: ['en', 'es'] }, { langId: false })), 'strictHints=default:false langId=default:false');
    assert.equal(describeStartFlags(resolveStartFlags({ language_hints: ['en'], language_hints_strict: false, enable_language_identification: false }, {})), 'strictHints=client:false langId=client:false');
    assert.equal(describeStartFlags(resolveStartFlags({ language_hints: ['en', 'es'], language_hints_strict: true }, {})), 'strictHints=client:true langId=default:true');
});

test('translation keeps type and target_language and drops source_language', () => {
    const cfg = buildSonioxConfig({ translation: { source_language: 'en', target_language: 'es', type: 'one_way' } }, KEY);
    assert.deepEqual(cfg.translation, { type: 'one_way', target_language: 'es' });

    const noTarget = buildSonioxConfig({ translation: { source_language: 'en' } }, KEY);
    assert.equal('translation' in noTarget, false);

    const noTranslation = buildSonioxConfig({}, KEY);
    assert.equal('translation' in noTranslation, false);
});

test('enable_language_identification is on by default and can be switched off', () => {
    assert.equal(buildSonioxConfig({}, KEY).enable_language_identification, true);
    assert.equal('enable_language_identification' in buildSonioxConfig({}, KEY, { langId: false }), false);
});

test('the rest of the start request matches the deployed shape', () => {
    const cfg = buildSonioxConfig({ model: 'stt-rt-v5', sample_rate: 16000, num_channels: 1, include_nonfinal: true, enable_endpoint_detection: true }, KEY);
    assert.equal(cfg.api_key, KEY);
    assert.equal(cfg.model, 'stt-rt-v5');
    assert.equal(cfg.audio_format, 'pcm_s16le');
    assert.equal(cfg.sample_rate, 16000);
    assert.equal(cfg.num_channels, 1);
    assert.equal(cfg.include_nonfinal, true);
    assert.equal(cfg.enable_endpoint_detection, true);
    assert.equal(cfg.max_non_final_tokens_duration_ms, 4000);
    assert.equal(buildSonioxConfig({ include_nonfinal: false, enable_endpoint_detection: false }, KEY).include_nonfinal, false);
    assert.equal(buildSonioxConfig({ include_nonfinal: false, enable_endpoint_detection: false }, KEY).enable_endpoint_detection, false);
});

test('redactConfig replaces the api_key and leaves everything else', () => {
    const cfg = buildSonioxConfig({ language_hints: ['en'] }, KEY);
    const red = redactConfig(cfg);
    assert.equal(red.api_key, '***');
    assert.equal(cfg.api_key, KEY, 'original is untouched');
    assert.equal(JSON.stringify(red).includes(KEY), false);
    assert.equal(red.model, cfg.model);
    assert.deepEqual(red.language_hints, ['en']);
});

test('bytesPerSecond knows raw PCM formats and gives null for the rest', () => {
    assert.equal(bytesPerSecond({ audio_format: 'pcm_s16le', sample_rate: 16000, num_channels: 1 }), 32000);
    assert.equal(bytesPerSecond({}), 32000);
    assert.equal(bytesPerSecond({ audio_format: 'pcm_s16le', sample_rate: 48000, num_channels: 2 }), 192000);
    assert.equal(bytesPerSecond({ audio_format: 'auto' }), null);
});

test('error frames and retryability', () => {
    assert.equal(isErrorFrame({ tokens: [], error_code: 413, error_type: 'max_duration_reached' }), true);
    assert.equal(isErrorFrame({ tokens: [], final_audio_proc_ms: 0 }), false);
    assert.equal(isErrorFrame(null), false);
    assert.equal(new UpstreamError('rejected', 'x', { errorCode: 402 }).retryable, false);
    assert.equal(new UpstreamError('rejected', 'x', { errorCode: 503 }).retryable, true);
    assert.equal(new UpstreamError('ack_timeout', 'x').retryable, true);
});

test('readRelayConfig defaults match the spec', () => {
    const c = readRelayConfig({});
    assert.equal(c.wsUrl, DEFAULT_SONIOX_WS_URL);
    assert.equal(c.langId, true);
    assert.equal(c.strictHints, true);
    assert.equal(c.keepaliveMs, 10000);
    assert.equal(c.stallWatchdog, true);
    assert.equal(c.stallSegments, 6);
    assert.equal(c.stallQuietMs, 20000);
    assert.equal(c.segmentGapMs, 700);
    assert.equal(c.recycleMinIntervalMs, 120000);
    assert.equal(c.recycleMax, 3);
    assert.equal(c.recycleWindowMs, 600000);
    assert.equal(c.stallSlowIntervalMs, 600000);
    assert.equal(c.rotation, true);
    assert.equal(c.rotateSoftMin, 270);
    assert.equal(c.rotateHardMin, 290);
    assert.equal(c.rotateBackstopMin, 292);
    assert.equal(c.rotateQuietMs, 600);
    assert.equal(c.finalizeTailMs, 1500);
    assert.equal(c.audioBufferMs, 15000);
    assert.deepEqual(c.redialDelaysMs, [1000, 3000]);
    assert.equal(c.overlapWarnMs, 3000);
    assert.equal(c.summaryMs, 60000);
});

test('readRelayConfig honors env overrides and off switches', () => {
    const c = readRelayConfig({
        SONIOX_WS_URL: 'ws://127.0.0.1:1',
        SONIOX_LANG_ID: 'off',
        SONIOX_STRICT_HINTS: '0',
        SONIOX_STALL_WATCHDOG: 'false',
        SONIOX_ROTATION: 'no',
        SONIOX_ROTATE_SOFT_MIN: '0.02',
        SONIOX_STALL_SEGMENTS: '4',
        SONIOX_KEEPALIVE_MS: '5000',
        SONIOX_REDIAL_DELAYS_MS: '500, 1500,2500',
        SONIOX_STALL_QUIET_MS: 'not-a-number',
        SONIOX_STALL_SLOW_INTERVAL_MS: '300000',
    });
    assert.equal(c.stallSlowIntervalMs, 300000);
    assert.equal(c.wsUrl, 'ws://127.0.0.1:1');
    assert.equal(c.langId, false);
    assert.equal(c.strictHints, false);
    assert.equal(c.stallWatchdog, false);
    assert.equal(c.rotation, false);
    assert.equal(c.rotateSoftMin, 0.02);
    assert.equal(c.stallSegments, 4);
    assert.equal(c.keepaliveMs, 5000);
    assert.deepEqual(c.redialDelaysMs, [500, 1500, 2500]);
    assert.equal(c.stallQuietMs, 20000, 'garbage falls back to the default');
    assert.equal(readRelayConfig({ SONIOX_LANG_ID: 'true' }).langId, true);
    assert.equal(readRelayConfig({ SONIOX_LANG_ID: '' }).langId, true);
});
