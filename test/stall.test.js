import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockSoniox, waitUntil } from './mock-soniox.js';
import { startRelayHost, connectClient, fastConfig, sleep, DEFAULT_CLIENT_CONFIG } from './helpers.js';

// The mock emits one segment per `endEveryFrames` audio frames. With
// endEveryFrames: 1 every frame is a segment, which keeps the arithmetic
// readable: K untranslated segments = K frames after `stallAfterFrames`.

async function setup(overrides = {}, mockOptions = {}) {
    const mock = await startMockSoniox({ endEveryFrames: 1, ...mockOptions });
    const host = await startRelayHost(fastConfig(mock.url, overrides));
    return { mock, host, async teardown() { await host.close(); await mock.close(); } };
}

test('stall is declared after 6 untranslated segments, not after 5', async () => {
    const env = await setup({ stallSegments: 6 }, { stallAfterFrames: 2 });
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        // 2 translated frames, then untranslated segments. Segment k is judged
        // when segment k+1 begins, so 2 + 5 + 1 frames shows five judged
        // untranslated segments, and one more frame makes six.
        await client.pump(2 + 5 + 1, 15);
        await sleep(100);
        assert.deepEqual(client.notices(), [], 'no stall after five segments');
        assert.equal(env.host.relays[0].stall.streak, 5);

        await client.pump(1, 15);
        await client.waitForNotice('translation_stalled', 2000);
        assert.ok(env.host.logs.some((l) => l.startsWith('[stall]')), '[stall] logged with counters');
        client.close();
    } finally {
        await env.teardown();
    }
});

test('stall requires the quiet window since the last translation token', async () => {
    const env = await setup({ stallSegments: 3, stallQuietMs: 5000 }, { stallAfterFrames: 2 });
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        await client.pump(2 + 10, 10);
        await sleep(100);
        assert.deepEqual(client.notices(), [], 'segments alone do not declare a stall');
        client.close();
    } finally {
        await env.teardown();
    }
});

test('a translated segment resets the streak', async () => {
    const env = await setup({ stallSegments: 4 });
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        const mock = env.mock;
        // Make the stream alternate: stall for 3 frames, then translate again.
        mock.streams[0].behavior.stallAfterFrames = 0;
        await client.pump(3, 15);
        mock.streams[0].behavior.stallAfterFrames = null;
        await client.pump(3, 15);
        mock.streams[0].behavior.stallAfterFrames = 0;
        await client.pump(3, 15);
        await sleep(100);
        assert.deepEqual(client.notices(), []);
        assert.ok(env.host.relays[0].stall.streak < 4);
        client.close();
    } finally {
        await env.teardown();
    }
});

test('the watchdog is off without translation or when disabled', async () => {
    const envA = await setup({ stallSegments: 2 }, { stallAfterFrames: 0 });
    try {
        const client = await connectClient(envA.host.url);
        const { translation, ...noTranslation } = DEFAULT_CLIENT_CONFIG;
        await client.start(noTranslation);
        await client.pump(8, 10);
        await sleep(100);
        assert.deepEqual(client.notices(), []);
        client.close();
    } finally {
        await envA.teardown();
    }
    const envB = await setup({ stallSegments: 2, stallWatchdog: false }, { stallAfterFrames: 0 });
    try {
        const client = await connectClient(envB.host.url);
        await client.start();
        await client.pump(8, 10);
        await sleep(100);
        assert.deepEqual(client.notices(), []);
        client.close();
    } finally {
        await envB.teardown();
    }
});

test('recycle: one proxy_ready, translation_stalled then stream_recycled, continuous audio, no <fin>', async () => {
    const env = await setup({ stallSegments: 3 }, { stallAfterFrames: 1 });
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        // Only the first stream stalls; the replacement translates.
        env.mock.setStream(2, { stallAfterFrames: null });
        const pumping = client.pump(40, 10);
        await client.waitForNotice('translation_stalled', 3000);
        await client.waitForNotice('stream_recycled', 3000);
        await pumping;
        await env.mock.waitForStreams(2);
        await waitUntil(() => env.mock.streams[0].closed, 3000, 'old stream not closed');
        await sleep(100);

        assert.equal(client.ofType('proxy_ready').length, 1, 'exactly one proxy_ready');
        const notices = client.notices();
        assert.deepEqual(notices, ['translation_stalled', 'stream_recycled']);
        assert.equal(env.mock.streams.length, 2, 'one recycle, one new stream');
        assert.equal(env.mock.streams[0].finalizeCount, 1, 'old stream finalized');
        assert.equal(env.mock.streams[0].ended, true, 'old stream ended with the empty text frame');
        const order = env.mock.streams[0].events;
        assert.ok(order.indexOf('finalize') < order.indexOf('end'), 'finalize before end');
        assert.equal(env.mock.totalAudioBytes(), client.sentAudioBytes(), 'every audio byte reached a mock stream');
        assert.ok(env.mock.allAudio().equals(client.allSentAudio()), 'audio order preserved across streams');
        assert.equal(client.tokenTexts().includes('<fin>'), false, '<fin> never reaches the client');
        // The new stream translates again and the relay treats it as current.
        assert.ok(env.mock.streams[1].emittedTranslation > 0);
        assert.equal(env.host.relays[0].current.index, 2);
        client.close();
    } finally {
        await env.teardown();
    }
});

test('recycle cap: after recycleMax recycles in the window, translation_unavailable is sent once and recycling stops', async () => {
    const env = await setup({ stallSegments: 2, recycleMax: 3, recycleWindowMs: 60000, recycleMinIntervalMs: 0 }, { stallAfterFrames: 0 });
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        const pumping = client.pump(120, 10);
        await waitUntil(() => client.notices().filter((n) => n === 'translation_unavailable').length === 1, 4000, 'translation_unavailable not sent');
        await pumping;
        await sleep(150);
        const notices = client.notices();
        assert.equal(notices.filter((n) => n === 'translation_stalled').length, 3, 'three recycles');
        assert.equal(notices.filter((n) => n === 'stream_recycled').length, 3);
        assert.equal(notices.filter((n) => n === 'translation_unavailable').length, 1, 'sent once');
        assert.equal(env.mock.streams.length, 4, 'no further recycles after the cap');
        assert.equal(client.ofType('proxy_ready').length, 1);
        assert.equal(client.closeCode, null, 'captions keep flowing; the client stays connected');
        assert.equal(env.mock.totalAudioBytes(), client.sentAudioBytes());
        client.close();
    } finally {
        await env.teardown();
    }
});

// Soniox tags speech it judges outside the configured pair translation_status
// "none" and sends no translation: captions flow, translation does not, which
// is the stall shape. The watchdog must count those segments too.
test('R3: finals tagged translation_status none count as untranslated segments, unless SONIOX_STALL_COUNT_NONE is off', async () => {
    const frame = (i, status) => JSON.stringify({
        tokens: [
            { text: `x${i} `, is_final: true, translation_status: status, language: 'es', start_ms: i * 500, end_ms: i * 500 + 400 },
            { text: '<end>', is_final: true },
        ],
        final_audio_proc_ms: i * 500, total_audio_proc_ms: i * 500,
    });

    const envA = await setup({ stallSegments: 2, stallQuietMs: 0 }, { endEveryFrames: 0 });
    try {
        const client = await connectClient(envA.host.url);
        await client.start();
        const stream = envA.mock.streams[0];
        for (let i = 0; i < 4; i += 1) { stream.ws.send(frame(i, 'none')); await sleep(15); }
        await client.waitForNotice('translation_stalled', 2000);
        assert.ok(envA.host.logs.some((l) => l.startsWith('[stall]') && l.includes('none=')), '[stall] logged with the none counter');
        client.close();
    } finally {
        await envA.teardown();
    }

    const envB = await setup({ stallSegments: 2, stallQuietMs: 0, stallCountNone: false }, { endEveryFrames: 0 });
    try {
        const client = await connectClient(envB.host.url);
        await client.start();
        const stream = envB.mock.streams[0];
        for (let i = 0; i < 8; i += 1) { stream.ws.send(frame(i, 'none')); await sleep(15); }
        await sleep(150);
        assert.deepEqual(client.notices(), [], 'switched off: none finals are not counted');
        assert.equal(envB.host.relays[0].stall.streak, 0);
        assert.equal(envB.host.relays[0].current.counters.finals.none, 8, 'the counters still record them');
        client.close();
    } finally {
        await envB.teardown();
    }
});

test('recycle rate cap: at most one recycle per recycleMinIntervalMs', async () => {
    const env = await setup({ stallSegments: 2, recycleMinIntervalMs: 60000 }, { stallAfterFrames: 0 });
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        await client.pump(60, 10);
        await sleep(150);
        assert.equal(client.notices().filter((n) => n === 'translation_stalled').length, 1);
        assert.equal(env.mock.streams.length, 2);
        assert.ok(env.host.logs.some((l) => l.includes('recycle suppressed')));
        client.close();
    } finally {
        await env.teardown();
    }
});
