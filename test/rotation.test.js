import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockSoniox, waitUntil } from './mock-soniox.js';
import { startRelayHost, connectClient, fastConfig, sleep } from './helpers.js';

async function setup(overrides = {}, mockOptions = {}) {
    const mock = await startMockSoniox(mockOptions);
    const host = await startRelayHost(fastConfig(mock.url, { rotation: true, ...overrides }));
    return { mock, host, async teardown() { await host.close(); await mock.close(); } };
}

test('rotation at tiny thresholds: pre-dial at soft mark, switch at the next endpoint, old stream finalized and ended, audio in order', async () => {
    // 0.02 min = 1.2 s wall. Hard at 0.1 min, backstop at 0.12 min.
    const env = await setup({ rotateSoftMin: 0.02, rotateHardMin: 0.1, rotateBackstopMin: 0.12 }, { endEveryFrames: 3 });
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        const pumping = client.pump(200, 10); // 2 s of frames
        const notice = await client.waitForNotice('stream_rotated', 4000);
        assert.ok(typeof notice.minutes === 'number' && notice.minutes >= 0.02, `minutes carried: ${JSON.stringify(notice)}`);
        await pumping;
        await waitUntil(() => env.mock.streams[0].closed, 3000, 'old stream not closed');
        await sleep(100);

        assert.equal(client.ofType('proxy_ready').length, 1);
        const first = env.mock.streams[0];
        assert.equal(first.finalizeCount, 1, 'old stream finalized');
        assert.equal(first.ended, true, 'old stream ended');
        assert.ok(first.events.indexOf('finalize') < first.events.indexOf('end'));
        assert.ok(first.events.lastIndexOf('audio') < first.events.indexOf('finalize'), 'no audio to the old stream after the switch');
        assert.equal(env.mock.totalAudioBytes(), client.sentAudioBytes(), 'no audio lost across the rotation');
        assert.ok(env.mock.allAudio().equals(client.allSentAudio()), 'audio flushed in order');
        assert.ok(env.host.logs.some((l) => l.includes('rotation commit (endpoint)')), 'switched at an endpoint');
        assert.equal(client.tokenTexts().includes('<fin>'), false);
        client.close();
    } finally {
        await env.teardown();
    }
});

test('hard mark with a slow replacement: audio is buffered after the forced switch and flushed in order', async () => {
    // Marks driven by audio minutes: a burst of 500 frames (5 s of audio at
    // 16 kHz mono) passes the soft mark at frame 300 (pre-dial) and the hard
    // mark at frame 420. The replacement acks only 600 ms later, so endpoints
    // defer the switch and the hard mark forces it into the buffer; the ack
    // then flushes the 80 buffered frames in order (0.013 min, well under
    // the replacement's own soft mark).
    const env = await setup({ rotateSoftMin: 0.05, rotateHardMin: 0.07, rotateBackstopMin: 0.2, rotateQuietMs: 60000 }, { endEveryFrames: 2 });
    try {
        env.mock.setStream(2, { ackDelayMs: 600 });
        const client = await connectClient(env.host.url);
        await client.start();
        for (let i = 0; i < 500; i += 1) client.sendAudio(320);
        await client.waitForNotice('stream_rotated', 5000);
        await waitUntil(() => env.mock.streams[0].closed, 3000, 'old stream not closed');
        await sleep(100);
        assert.equal(env.mock.streams.length, 2);
        assert.ok(env.host.logs.some((l) => l.includes('rotation commit (hard mark)')), 'the hard mark forced the switch');
        assert.ok(env.host.logs.some((l) => l.includes('flushed') && l.includes('buffered audio frames')), 'buffer was used and flushed');
        assert.ok(env.mock.streams[1].audioFrames >= 70, `the buffered tail reached the replacement (${env.mock.streams[1].audioFrames} frames)`);
        assert.equal(env.mock.totalAudioBytes(), client.sentAudioBytes());
        assert.ok(env.mock.allAudio().equals(client.allSentAudio()), 'buffered audio flushed in order');
        client.close();
    } finally {
        await env.teardown();
    }
});

test('hard mark rotates immediately when no endpoint arrives', async () => {
    // No <end> tokens and a quiet window longer than the test, so only the
    // hard mark can trigger the commit.
    const env = await setup({ rotateSoftMin: 0.005, rotateHardMin: 0.015, rotateBackstopMin: 0.2, rotateQuietMs: 60000 }, { endEveryFrames: 0 });
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        const pumping = client.pump(150, 10);
        await client.waitForNotice('stream_rotated', 4000);
        await pumping;
        assert.ok(env.host.logs.some((l) => l.includes('rotation commit (hard mark)')), env.host.logs.filter((l) => l.includes('rotation')).join('\n'));
        assert.equal(env.mock.totalAudioBytes(), client.sentAudioBytes());
        client.close();
    } finally {
        await env.teardown();
    }
});

test('backstop wall-clock timer rotates even without audio', async () => {
    const env = await setup({ rotateSoftMin: 10, rotateHardMin: 10, rotateBackstopMin: 0.005, rotateQuietMs: 60000 });
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        await client.waitForNotice('stream_rotated', 4000);
        assert.ok(env.host.logs.some((l) => l.includes('rotation backstop fired')));
        assert.equal(client.ofType('proxy_ready').length, 1);
        client.close();
    } finally {
        await env.teardown();
    }
});

test('rotation uses audio minutes when they exceed wall minutes', async () => {
    // 0.01 min of audio = 0.6 s = 19200 bytes at 16 kHz mono; send it in a
    // burst far faster than real time so audio minutes lead wall minutes.
    const env = await setup({ rotateSoftMin: 0.01, rotateHardMin: 0.011, rotateBackstopMin: 5, rotateQuietMs: 60000 }, { endEveryFrames: 0 });
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        for (let i = 0; i < 70; i += 1) client.sendAudio(320);
        await client.waitForNotice('stream_rotated', 4000);
        assert.ok(env.host.logs.some((l) => l.includes('rotation started')));
        client.close();
    } finally {
        await env.teardown();
    }
});

test('rotation disabled: no pre-dial even past the marks', async () => {
    const env = await setup({ rotation: false, rotateSoftMin: 0.001, rotateHardMin: 0.002, rotateBackstopMin: 0.003 });
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        await client.pump(40, 10);
        await sleep(100);
        assert.equal(env.mock.streams.length, 1);
        assert.deepEqual(client.notices(), []);
        client.close();
    } finally {
        await env.teardown();
    }
});

// A rotation whose replacement has acked but is still waiting for its commit
// trigger: no <end> tokens, a quiet window longer than the test, hard mark
// far away. This is the state the review findings R1 and R2 are about.
const ROTATION_WAITING = { rotateSoftMin: 0.004, rotateHardMin: 10, rotateBackstopMin: 10, rotateQuietMs: 60000 };

const REFUSED = { rejectStart: { error_code: 429, error_type: 'too_many_requests', error_message: 'concurrent request limit reached' } };

test('R1: the current stream dies while an acked replacement waits for its trigger: the replacement is adopted at once', async () => {
    // Soft mark by audio minutes (0.02 min = 120 frames) so the replacement,
    // whose own audio count starts at zero, does not rotate again during the
    // test. No <end> tokens and a long quiet window keep it waiting.
    const env = await setup({ ...ROTATION_WAITING, rotateSoftMin: 0.02 }, { endEveryFrames: 0 });
    try {
        env.mock.setStream(1, { dropAfterFrames: 150 });
        const client = await connectClient(env.host.url);
        await client.start();
        for (let i = 0; i < 120; i += 1) client.sendAudio(320);
        await env.mock.waitForStreams(2);
        await waitUntil(() => env.mock.streams[1].acked, 2000, 'replacement did not ack');
        const relay = env.host.relays[0];
        await waitUntil(() => relay.pending && relay.pending.acked && relay.current && relay.current.index === 1, 1000, 'replacement should be waiting as pending');
        assert.equal(relay.rotation.phase, 'predial');
        // Thirty more frames: the mock drops stream 1 after the 150th.
        for (let i = 0; i < 30; i += 1) client.sendAudio(320);
        const notice = await client.waitForNotice('stream_rotated', 3000);
        await client.pump(20, 10);
        await sleep(50);

        assert.ok(notice.minutes > 0, `minutes of the lost stream carried: ${JSON.stringify(notice)}`);
        assert.equal(relay.current && relay.current.index, 2, 'the acked replacement is live');
        assert.equal(relay.pending, null);
        assert.equal(relay.rotation.phase, 'none');
        assert.equal(relay.buffering, false);
        assert.ok(env.mock.streams[1].audioFrames > 0, 'audio flows to the adopted replacement');
        assert.equal(env.mock.streams.length, 2, 'no re-dial was needed');
        assert.equal(client.closeCode, null);
        assert.equal(client.ofType('error').length, 0);
        assert.equal(env.mock.totalAudioBytes(), client.sentAudioBytes(), 'no audio lost');
        assert.ok(env.mock.allAudio().equals(client.allSentAudio()), 'audio in order across the switch');
        assert.ok(env.host.logs.some((l) => l.includes('adopting acked pending stream 2')));
        client.close();
    } finally {
        await env.teardown();
    }
});

test('R2: an acked replacement waiting for the rotation trigger receives keepalives, and they stop once it is adopted', async () => {
    const env = await setup({ ...ROTATION_WAITING, keepaliveMs: 100 }, { endEveryFrames: 0 });
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        const pumping = client.pump(150, 10); // 1.5 s of continuous speech: no endpoint, no quiet gap
        await env.mock.waitForStreams(2);
        await waitUntil(() => env.mock.streams[1].acked, 2000, 'replacement did not ack');
        await pumping;
        const relay = env.host.relays[0];
        assert.equal(relay.rotation.phase, 'predial', 'still waiting for the trigger');
        assert.equal(relay.pending && relay.pending.index, 2);
        assert.equal(env.mock.streams[1].audioFrames, 0, 'the pending stream gets no audio');
        assert.ok(env.mock.streams[1].keepalives >= 5, `the pending stream is kept alive (${env.mock.streams[1].keepalives} keepalives)`);
        assert.equal(env.mock.streams[0].keepalives, 0, 'the current stream needs none while audio flows');

        // An endpoint arrives: the switch commits and the pending keepalive stops.
        env.mock.streams[0].behavior.endEveryFrames = 1;
        client.sendAudio();
        await client.waitForNotice('stream_rotated', 3000);
        assert.equal(relay.pendingKeepaliveTimer, null, 'pending keepalive cleared on adoption');
        assert.equal(relay.current && relay.current.index, 2);
        const after = env.mock.streams[1].keepalives;
        await client.pump(20, 10);
        assert.equal(env.mock.streams[1].keepalives, after, 'no keepalive to the live stream while audio flows');
        client.close();
    } finally {
        await env.teardown();
    }
});

test('F3: a refused soft pre-dial keeps the healthy stream and retries with backoff; the switch waits for an acked replacement', async () => {
    // Soft mark by audio minutes: a burst of 120 frames pre-dials; the mock
    // refuses streams 2 and 3 (429) and accepts stream 4. Real-time frames
    // keep flowing to stream 1 through the 100 ms and 200 ms backoffs.
    const env = await setup({ rotateSoftMin: 0.02, rotateHardMin: 0.2, rotateBackstopMin: 0.25 }, { endEveryFrames: 3 });
    try {
        env.mock.setStream(2, REFUSED);
        env.mock.setStream(3, REFUSED);
        const client = await connectClient(env.host.url);
        await client.start();
        for (let i = 0; i < 120; i += 1) client.sendAudio(320);
        const pumping = client.pump(100, 10);
        await env.mock.waitForStreams(3, 4000);
        await waitUntil(() => env.mock.streams[2].closed, 2000, 'third dial not refused');
        const framesAtRefusal = env.mock.streams[0].audioFrames;
        await env.mock.waitForStreams(4, 4000);
        await waitUntil(() => env.mock.streams[3].acked, 2000, 'stream 4 did not ack');
        await client.waitForNotice('stream_rotated', 4000);
        await pumping;
        await waitUntil(() => env.mock.streams[0].closed, 3000, 'old stream not closed');
        await sleep(100);

        const first = env.mock.streams[0];
        assert.equal(first.finalizeCount, 1, 'old stream retired exactly once');
        const audioBeforeFinalize = first.events.slice(0, first.events.indexOf('finalize')).filter((e) => e === 'audio').length;
        assert.ok(audioBeforeFinalize > framesAtRefusal, `stream 1 kept receiving audio after the refusals (${audioBeforeFinalize} > ${framesAtRefusal})`);
        assert.ok(env.host.logs.some((l) => l.includes('old stream kept, retry 1 in 100 ms')), 'first backoff');
        assert.ok(env.host.logs.some((l) => l.includes('old stream kept, retry 2 in 200 ms')), 'second backoff doubles');
        assert.deepEqual(client.notices(), ['stream_rotated']);
        assert.equal(client.closeCode, null);
        assert.equal(client.ofType('error').length, 0, 'the 429s never reach the client');
        assert.equal(env.mock.streams.length, 4);
        assert.equal(env.host.relays[0].current.index, 4);
        assert.equal(env.mock.totalAudioBytes(), client.sentAudioBytes());
        assert.ok(env.mock.allAudio().equals(client.allSentAudio()));
        client.close();
    } finally {
        await env.teardown();
    }
});

test('F3: endpoint and quiet triggers defer until the replacement acks, so no gap opens on a healthy stream', async () => {
    const env = await setup({ ...ROTATION_WAITING, rotateQuietMs: 100 }, { endEveryFrames: 2 });
    try {
        env.mock.setStream(2, { ackDelayMs: 600 });
        const client = await connectClient(env.host.url);
        await client.start();
        const pumping = client.pump(150, 10);
        await env.mock.waitForStreams(2);
        await waitUntil(() => env.host.logs.some((l) => l.includes('deferred: replacement not acked')), 2000, 'no deferred commit logged');
        const relay = env.host.relays[0];
        assert.equal(relay.current && relay.current.index, 1, 'old stream still live while the replacement dials');
        assert.equal(relay.buffering, false);
        await waitUntil(() => env.mock.streams[1].acked, 2000, 'replacement did not ack');
        const logsAtAck = env.host.logs.length;
        await client.waitForNotice('stream_rotated', 3000);
        await pumping;
        const commitIndex = env.host.logs.findIndex((l) => l.includes('rotation commit (') && !l.includes('deferred'));
        assert.ok(commitIndex >= logsAtAck, 'the commit happened only after the ack');
        assert.equal(env.host.logs.some((l) => l.includes('buffered audio frames')), false, 'no buffering gap on a healthy stream');
        assert.equal(env.mock.totalAudioBytes(), client.sentAudioBytes());
        assert.ok(env.mock.allAudio().equals(client.allSentAudio()));
        client.close();
    } finally {
        await env.teardown();
    }
});

test('F3: the hard mark forces the switch even while soft pre-dials are being refused and backed off', async () => {
    const env = await setup({ rotateSoftMin: 0.005, rotateHardMin: 0.03, rotateBackstopMin: 0.2, rotateRetryMaxMs: 400 }, { endEveryFrames: 3 });
    try {
        for (let i = 2; i <= 12; i += 1) env.mock.setStream(i, REFUSED);
        const client = await connectClient(env.host.url);
        await client.start();
        const pumping = client.pump(250, 10);
        await sleep(1500); // several refused retries in, hard mark at 1.8 s still ahead
        const relay = env.host.relays[0];
        assert.equal(relay.current && relay.current.index, 1, 'healthy stream kept through the refused pre-dials');
        assert.ok(env.mock.streams.length >= 3, `pre-dial retried (${env.mock.streams.length} dials)`);
        assert.deepEqual(client.notices(), []);
        assert.equal(client.closeCode, null);

        const closed = await client.waitForClose(3000);
        await pumping;
        assert.ok(env.host.logs.some((l) => l.includes('rotation commit (hard mark)')), 'the hard mark committed regardless of the backoff');
        assert.equal(closed.code, 1011, 'with every dial refused, the client is told to reconnect');
        assert.equal(client.ofType('error')[0].code, 429);
    } finally {
        await env.teardown();
    }
});
