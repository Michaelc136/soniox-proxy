import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockSoniox, waitUntil } from './mock-soniox.js';
import { startRelayHost, connectClient, fastConfig, sleep, DEFAULT_CLIENT_CONFIG } from './helpers.js';

async function setup(overrides = {}, mockOptions = {}) {
    const mock = await startMockSoniox(mockOptions);
    const host = await startRelayHost(fastConfig(mock.url, overrides));
    return { mock, host, async teardown() { await host.close(); await mock.close(); } };
}

test('max_duration_reached triggers an immediate recycle with no audio loss and one proxy_ready', async () => {
    const env = await setup({ redialDelaysMs: [500, 1500] });
    try {
        env.mock.setStream(1, { maxDurationAfterBytes: 320 * 10 });
        const client = await connectClient(env.host.url);
        await client.start();
        const t0 = Date.now();
        const pumping = client.pump(40, 10);
        await client.waitForNotice('stream_recycled', 3000);
        const elapsed = Date.now() - t0;
        await pumping;
        await sleep(100);
        assert.ok(elapsed < 500, `recycled immediately, not after the re-dial delay (${elapsed} ms)`);
        assert.equal(client.ofType('proxy_ready').length, 1);
        assert.deepEqual(client.notices(), ['stream_recycled']);
        assert.equal(env.mock.streams.length, 2);
        assert.equal(env.mock.totalAudioBytes(), client.sentAudioBytes(), 'audio buffered during the re-dial');
        assert.ok(env.mock.allAudio().equals(client.allSentAudio()), 'buffered audio flushed in order');
        assert.equal(client.frames.some((f) => f.error_type === 'max_duration_reached'), false, 'the 413 frame is handled, not forwarded');
        assert.ok(env.host.logs.some((l) => l.includes('missed rotation')));
        client.close();
    } finally {
        await env.teardown();
    }
});

test('upstream drop re-dials after the first delay, buffers audio, and continues', async () => {
    const env = await setup({ redialDelaysMs: [100, 300] });
    try {
        env.mock.setStream(1, { dropAfterFrames: 5 });
        const client = await connectClient(env.host.url);
        await client.start();
        const pumping = client.pump(40, 10);
        await client.waitForNotice('stream_recycled', 3000);
        await pumping;
        await sleep(100);
        assert.equal(client.ofType('proxy_ready').length, 1);
        assert.equal(env.mock.streams.length, 2);
        assert.equal(env.mock.totalAudioBytes(), client.sentAudioBytes());
        assert.ok(env.mock.allAudio().equals(client.allSentAudio()));
        assert.equal(client.closeCode, null);
        assert.equal(client.ofType('error').length, 0, 'no error frame for a recovered drop');
        client.close();
    } finally {
        await env.teardown();
    }
});

test('re-dial failure after every attempt sends an error frame and closes the client with 1011', async () => {
    const env = await setup({ redialDelaysMs: [30, 60] });
    try {
        env.mock.setStream(1, { dropAfterFrames: 3 });
        env.mock.setStream(2, { refuseConnection: true });
        env.mock.setStream(3, { refuseConnection: true });
        const client = await connectClient(env.host.url);
        await client.start();
        await client.pump(5, 10);
        const closed = await client.waitForClose(3000);
        assert.equal(closed.code, 1011);
        const errors = client.ofType('error');
        assert.equal(errors.length, 1);
        assert.ok(errors[0].message.includes('Soniox upstream failed'));
        assert.equal(typeof errors[0].code, 'number');
        assert.equal(env.mock.streams.length, 3, 'two re-dial attempts');
        assert.equal(client.notices().length, 0);
        assert.equal(client.ofType('proxy_ready').length, 1);
    } finally {
        await env.teardown();
    }
});

test('a 402 budget error on the first start is reported as an error and the client is closed, never proxy_ready', async () => {
    const env = await setup();
    try {
        env.mock.setStream(1, { rejectStart: { error_code: 402, error_type: 'organization_balance_exhausted', error_message: 'The available balance has dropped to zero.' } });
        const client = await connectClient(env.host.url);
        client.sendJson({ action: 'start', config: DEFAULT_CLIENT_CONFIG });
        const closed = await client.waitForClose(3000);
        assert.equal(closed.code, 1011);
        assert.equal(client.ofType('proxy_ready').length, 0);
        const errors = client.ofType('error');
        assert.equal(errors.length, 1);
        assert.equal(errors[0].code, 402);
        assert.ok(errors[0].message.includes('balance'));
        assert.equal(env.mock.streams.length, 1);
    } finally {
        await env.teardown();
    }
});

test('a 402 during a re-dial is not retried: error then close 1011', async () => {
    const env = await setup({ redialDelaysMs: [30, 60] });
    try {
        env.mock.setStream(1, { dropAfterFrames: 2 });
        env.mock.setStream(2, { rejectStart: { error_code: 402, error_type: 'organization_monthly_budget_exhausted', error_message: 'Budget exhausted' } });
        const client = await connectClient(env.host.url);
        await client.start();
        await client.pump(4, 10);
        const closed = await client.waitForClose(3000);
        assert.equal(closed.code, 1011);
        assert.equal(client.ofType('error')[0].code, 402);
        assert.equal(env.mock.streams.length, 2, 'no third attempt after a budget error');
        assert.equal(client.ofType('proxy_ready').length, 1);
    } finally {
        await env.teardown();
    }
});

test('ack timeout on the first start closes the client with 1011', async () => {
    const env = await setup({ ackTimeoutMs: 150 });
    try {
        env.mock.setStream(1, { ackDelayMs: 5000 });
        const client = await connectClient(env.host.url);
        client.sendJson({ action: 'start', config: DEFAULT_CLIENT_CONFIG });
        const closed = await client.waitForClose(3000);
        assert.equal(closed.code, 1011);
        assert.equal(client.ofType('proxy_ready').length, 0);
        assert.ok(client.ofType('error')[0].message.includes('timeout'));
    } finally {
        await env.teardown();
    }
});

test('other Soniox error frames are forwarded to the client', async () => {
    const env = await setup({ redialDelaysMs: [30, 60] });
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        const stream = env.mock.streams[0];
        await waitUntil(() => stream.acked, 2000);
        stream.ws.send(JSON.stringify({ tokens: [], error_code: 503, error_type: 'service_unavailable', error_message: 'overloaded', request_id: 'r1' }));
        await waitUntil(() => client.frames.some((f) => f.error_type === 'service_unavailable'), 2000, 'error frame not forwarded');
        client.close();
    } finally {
        await env.teardown();
    }
});

test('audio buffer is capped: oldest frames are dropped past the cap', async () => {
    const env = await setup({ redialDelaysMs: [200, 300], audioBufferMs: 100 });
    try {
        env.mock.setStream(1, { dropAfterFrames: 1 });
        const client = await connectClient(env.host.url);
        await client.start();
        // 100 ms cap at 32000 B/s = 3200 bytes = 10 frames of 320 bytes.
        await client.pump(30, 5);
        await client.waitForNotice('stream_recycled', 3000);
        await sleep(50);
        const relay = env.host.relays[0];
        assert.ok(relay.buffer.droppedBytes > 0, 'some audio was dropped');
        assert.ok(env.mock.streams[1].audioBytes <= 3200 + 320, 'flush bounded by the cap');
        client.close();
    } finally {
        await env.teardown();
    }
});
