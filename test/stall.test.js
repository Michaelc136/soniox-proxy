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

// Speech or singing in the TARGET language comes back as finals tagged
// translation_status none with language equal to the target, which is the
// same shape as a real stall (English mislabeled as the target). The cap
// therefore must not disarm the watchdog or tell the operator translation is
// unavailable: it switches to a slow mode that keeps recycling, just rarely.
//
// Leaving slow mode takes a CLOSED segment that had translation, judged when
// the next segment begins, not a lone translation token: a sporadic translated
// phrase inside a Spanish worship set must not drop the watchdog back to the
// normal interval. The recycle window is never cleared on the way out; if it
// still holds recycleMax recycles the next stall simply re-enters slow mode.
test('recycle cap: after recycleMax recycles in the window the watchdog enters slow mode, never sends translation_unavailable, leaves only on a translated segment, keeps the window, and re-enters while the window is full', async () => {
    const slowMs = 2500;
    const env = await setup({ stallSegments: 2, recycleMax: 3, recycleWindowMs: 60000, recycleMinIntervalMs: 0, stallSlowIntervalMs: slowMs }, { stallAfterFrames: 0 });
    let pumping = true;
    let paused = false;
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        const relay = env.host.relays[0];
        // Open-ended pump (client.pump needs a frame count up front); stops on
        // request or when the socket is no longer open; pauses on request so
        // single frames can be sent by hand.
        const pumpLoop = (async () => { while (pumping && client.ws.readyState === 1) { if (!paused) client.sendAudio(); await sleep(10); } })();

        // Three recycles come as fast as the min interval (0) allows; the
        // fourth stall meets the cap and enters slow mode.
        await waitUntil(() => relay.slowMode === true, 4000, 'slow mode not entered');
        const thirdRecycleAt = relay.lastRecycleAt;
        assert.equal(env.mock.streams.length, 4, 'three recycles happened before slow mode');
        assert.equal(relay.watchdogActive, true, 'the watchdog stays armed in slow mode');
        assert.equal(env.host.logs.filter((l) => l.startsWith('[stall] slow mode')).length, 1, '[stall] slow mode logged once');

        // Inside the slow interval stalls keep being declared and suppressed,
        // and no recycle happens.
        await sleep(Math.round(slowMs * 0.5));
        assert.equal(env.mock.streams.length, 4, 'no recycle inside the slow interval');
        assert.ok(env.host.logs.some((l) => l.includes('recycle suppressed') && l.includes('slow mode')), 'stalls are still declared and suppressed');
        assert.equal(env.host.logs.filter((l) => l.startsWith('[stall] slow mode')).length, 1, 'slow mode is logged only on entry');

        // Exactly one recycle once the slow interval has passed, then quiet again.
        await env.mock.waitForStreams(5, slowMs + 2000);
        assert.ok(relay.lastRecycleAt - thirdRecycleAt >= slowMs, `slow recycle waited ${relay.lastRecycleAt - thirdRecycleAt} ms, expected >= ${slowMs}`);
        const fourthRecycleAt = relay.lastRecycleAt;
        assert.equal(relay.slowMode, true, 'still slow: the replacement stalls too');
        assert.equal(relay.recycleTimes.length, 4, 'four recycles inside the window');
        await sleep(800);
        assert.equal(env.mock.streams.length, 5, 'only one recycle per slow interval');

        // One translated frame = original + translation + <end>: the segment
        // closes but is not judged until the next segment begins, so slow mode
        // must still be on after it.
        paused = true;
        await sleep(60);
        const live = env.mock.streams[4];
        assert.equal(relay.current.index, 5);
        live.behavior.stallAfterFrames = null;
        client.sendAudio();
        await sleep(150);
        assert.equal(relay.slowMode, true, 'a translation token alone does not leave slow mode');
        assert.equal(env.host.logs.some((l) => l.startsWith('[stall] normal mode')), false);

        // The next segment judges the closed translated one: now slow mode ends,
        // and the recycle window is kept as it is.
        client.sendAudio();
        await waitUntil(() => relay.slowMode === false, 2000, 'slow mode not left after a translated segment closed');
        assert.equal(relay.recycleTimes.length, 4, 'recycleTimes retained: the window expires on its own');
        assert.equal(relay.lastRecycleAt, fourthRecycleAt, 'lastRecycleAt kept');
        const normalLines = env.host.logs.filter((l) => l.startsWith('[stall] normal mode'));
        assert.equal(normalLines.length, 1, 'leaving slow mode is logged once');
        assert.ok(normalLines[0].includes('translated segment on stream 5'), normalLines[0]);

        // The window still holds recycleMax recycles, so the next stall
        // re-enters slow mode instead of recycling on the normal interval.
        live.behavior.stallAfterFrames = 0;
        paused = false;
        await waitUntil(() => relay.slowMode === true, 2000, 'slow mode not re-entered while the window is full');
        assert.equal(env.host.logs.filter((l) => l.startsWith('[stall] slow mode')).length, 2, '[stall] slow mode logged again on re-entry');
        await sleep(400);
        assert.equal(env.mock.streams.length, 5, 'no recycle on the normal interval after re-entry');
        assert.equal(relay.lastRecycleAt, fourthRecycleAt, 'the slow interval still counts from the last real recycle');

        pumping = false;
        await pumpLoop;
        await sleep(150);
        const notices = client.notices();
        assert.equal(notices.includes('translation_unavailable'), false, 'translation_unavailable is never sent from the stall path');
        assert.equal(notices.filter((n) => n === 'translation_stalled').length, 4, 'four recycles in total');
        assert.equal(notices.filter((n) => n === 'stream_recycled').length, 4, 'every translation_stalled was followed by a recycle');
        assert.equal(env.mock.streams.length, 5);
        assert.equal(client.ofType('proxy_ready').length, 1);
        assert.equal(client.closeCode, null, 'captions keep flowing; the client stays connected');
        assert.equal(env.mock.totalAudioBytes(), client.sentAudioBytes());
        client.close();
    } finally {
        pumping = false;
        await env.teardown();
    }
});

// The other way out of the window: time. With a window shorter than the slow
// interval, the three fast recycles have expired by the time the slow recycle
// happens, so once a translated segment ends slow mode the next stall recycles
// on the normal interval again. Nothing is cleared to get there.
test('recycle cap: after slow mode ends, a stall recycles on the normal interval once the window has expired on its own', async () => {
    const slowMs = 2500;
    const env = await setup({ stallSegments: 2, recycleMax: 3, recycleWindowMs: 2000, recycleMinIntervalMs: 0, stallSlowIntervalMs: slowMs }, { stallAfterFrames: 0 });
    let pumping = true;
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        const relay = env.host.relays[0];
        const pumpLoop = (async () => { while (pumping && client.ws.readyState === 1) { client.sendAudio(); await sleep(10); } })();

        await waitUntil(() => relay.slowMode === true, 4000, 'slow mode not entered');
        assert.equal(env.mock.streams.length, 4);
        await env.mock.waitForStreams(5, slowMs + 2000);
        const slowRecycleAt = relay.lastRecycleAt;
        assert.equal(relay.slowMode, true);
        assert.equal(relay.recycleTimes.length, 1, 'the three fast recycles have left the window; only the slow one remains');

        // Translation resumes on the live stream: the next segment judges a
        // translated one and slow mode ends with the window untouched.
        const live = env.mock.streams[4];
        live.behavior.stallAfterFrames = null;
        await waitUntil(() => relay.slowMode === false, 2000, 'slow mode not left');
        assert.equal(relay.recycleTimes.length, 1, 'recycleTimes retained');

        // Stall again: one recycle in the window is under the cap, so the
        // normal interval (0) applies and the recycle comes at once.
        live.behavior.stallAfterFrames = 0;
        await env.mock.waitForStreams(6, 2000);
        assert.ok(relay.lastRecycleAt - slowRecycleAt < slowMs, `normal interval restored: recycled ${relay.lastRecycleAt - slowRecycleAt} ms after the slow recycle`);
        assert.equal(relay.slowMode, false);
        assert.equal(env.host.logs.filter((l) => l.startsWith('[stall] slow mode')).length, 1, 'no re-entry: the window was under the cap');

        pumping = false;
        await pumpLoop;
        await sleep(150);
        assert.equal(client.notices().filter((n) => n === 'translation_stalled').length, 5);
        assert.equal(client.notices().filter((n) => n === 'stream_recycled').length, 5);
        assert.equal(client.notices().includes('translation_unavailable'), false);
        assert.equal(env.mock.totalAudioBytes(), client.sentAudioBytes());
        client.close();
    } finally {
        pumping = false;
        await env.teardown();
    }
});

// SONIOX_RECYCLE_MAX=0 means "never recycle for a stall": stalls are still
// declared and logged (the counters are the point), but nothing is dialed,
// slow mode is never entered, and translation_stalled is not sent because no
// recycle follows it.
test('recycleMax=0: stalls are declared and logged but never recycled, no slow mode, no notice', async () => {
    const env = await setup({ stallSegments: 2, recycleMax: 0, recycleMinIntervalMs: 0, stallSlowIntervalMs: 0 }, { stallAfterFrames: 0 });
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        const relay = env.host.relays[0];
        await client.pump(30, 10);
        await sleep(150);
        const stallLines = env.host.logs.filter((l) => l.startsWith('[stall] [') && l.includes('recyclesInWindow='));
        assert.ok(stallLines.length >= 2, `stalls keep being declared and logged (${stallLines.length})`);
        const suppressed = env.host.logs.filter((l) => l.includes('recycle suppressed (recycleMax=0)'));
        assert.equal(suppressed.length, stallLines.length, 'every declared stall is suppressed with the recycleMax=0 reason');
        assert.equal(env.host.logs.some((l) => l.startsWith('[stall] slow mode')), false, 'slow mode is never entered');
        assert.equal(relay.slowMode, false);
        assert.equal(relay.lastRecycleAt, null);
        assert.deepEqual(relay.recycleTimes, []);
        assert.equal(env.mock.streams.length, 1, 'no recycle, not even one');
        assert.equal(relay.current.index, 1);
        assert.deepEqual(client.notices(), [], 'translation_stalled is only sent when a recycle follows');
        assert.equal(client.closeCode, null);
        assert.equal(env.mock.totalAudioBytes(), client.sentAudioBytes());
        client.close();
    } finally {
        await env.teardown();
    }
});

test('translation_unavailable is reserved: part of the notice contract, never sent by any relay path', async () => {
    const { PROXY_NOTICE_EVENTS } = await import('../relay.js');
    assert.ok(PROXY_NOTICE_EVENTS.includes('translation_unavailable'), 'still defined for the clients');
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../relay.js', import.meta.url), 'utf8');
    assert.equal(source.includes("sendNotice('translation_unavailable'"), false, 'no code path sends it');
    assert.equal(source.includes('sendNotice("translation_unavailable"'), false);
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
