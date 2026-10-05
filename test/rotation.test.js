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

test('rotation with a slow replacement: audio is buffered after the switch and flushed in order', async () => {
    const env = await setup({ rotateSoftMin: 0.01, rotateHardMin: 0.1, rotateBackstopMin: 0.12 }, { endEveryFrames: 2 });
    try {
        env.mock.setStream(2, { ackDelayMs: 400 });
        const client = await connectClient(env.host.url);
        await client.start();
        const pumping = client.pump(150, 10);
        await client.waitForNotice('stream_rotated', 5000);
        await pumping;
        await waitUntil(() => env.mock.streams[0].closed, 3000, 'old stream not closed');
        await sleep(100);
        assert.equal(env.mock.streams.length >= 2, true);
        assert.ok(env.host.logs.some((l) => l.includes('flushed') && l.includes('buffered audio frames')), 'buffer was used and flushed');
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
