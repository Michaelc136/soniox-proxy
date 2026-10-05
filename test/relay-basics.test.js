import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockSoniox, waitUntil } from './mock-soniox.js';
import { startRelayHost, connectClient, fastConfig, sleep, TEST_API_KEY, DEFAULT_CLIENT_CONFIG } from './helpers.js';

async function setup(overrides = {}, mockOptions = {}) {
    const mock = await startMockSoniox(mockOptions);
    const host = await startRelayHost(fastConfig(mock.url, overrides));
    return { mock, host, async teardown() { await host.close(); await mock.close(); } };
}

test('handshake: auth_success, start, exactly one proxy_ready, tokens forwarded with language fields', async () => {
    const env = await setup();
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        assert.equal(client.ofType('proxy_ready').length, 1);
        assert.equal(client.ofType('proxy_ready')[0].connection_id, 'c1');

        await env.mock.waitForStreams(1);
        const stream = env.mock.streams[0];
        await waitUntil(() => stream.acked, 2000, 'mock did not ack');
        assert.equal(stream.startConfig.api_key, TEST_API_KEY);
        assert.equal(stream.startConfig.language_hints_strict, true);
        assert.equal(stream.startConfig.enable_language_identification, true);
        assert.deepEqual(stream.startConfig.translation, { type: 'one_way', target_language: 'es' });
        assert.equal('source_language' in stream.startConfig.translation, false);

        await client.pump(6, 5);
        await waitUntil(() => client.tokenTexts().includes('<end>'), 2000, 'no <end> forwarded');
        const texts = client.tokenTexts();
        assert.ok(texts.includes('w1 '), 'original token forwarded');
        assert.ok(texts.includes('t1 '), 'translation token forwarded');
        const frame = client.frames.find((f) => Array.isArray(f.tokens) && f.tokens.length > 0);
        assert.equal(frame.tokens[0].language, 'en', 'token fields pass through unchanged');
        assert.equal(client.ofType('proxy_ready').length, 1);
        client.close();
        await client.waitForClose();
    } finally {
        await env.teardown();
    }
});

test('the Soniox api_key never appears in log output; the start config is logged redacted', async () => {
    const env = await setup();
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        await sleep(50);
        const leaked = env.host.logs.filter((l) => l.includes(TEST_API_KEY));
        assert.deepEqual(leaked, []);
        const cfgLine = env.host.logs.find((l) => l.includes('sent start config'));
        assert.ok(cfgLine, 'start config is logged');
        assert.ok(cfgLine.includes('"api_key":"***"'), cfgLine);
        assert.ok(cfgLine.includes('"language_hints_strict":true'));
        assert.ok(cfgLine.includes('"enable_language_identification":true'));
        client.close();
    } finally {
        await env.teardown();
    }
});

test('ping/pong and finalize still work; <fin> never reaches the client', async () => {
    const env = await setup();
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        client.sendJson({ type: 'ping', ref: 7 });
        const pong = await client.waitForType('pong');
        assert.equal(pong.ref, 7);

        await client.pump(2, 5);
        client.sendJson({ type: 'finalize' });
        const stream = env.mock.streams[0];
        await waitUntil(() => stream.finalizeCount === 1, 2000, 'finalize not forwarded');
        await sleep(60);
        assert.equal(client.tokenTexts().includes('<fin>'), false, '<fin> stripped');
        assert.ok(client.tokenTexts().includes('w1 '));
        client.close();
    } finally {
        await env.teardown();
    }
});

test('keepalive is sent after the keepalive interval without audio and stops when audio resumes', async () => {
    const env = await setup({ keepaliveMs: 120 });
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        const stream = env.mock.streams[0];
        await client.pump(3, 5);
        assert.equal(stream.keepalives, 0);
        await waitUntil(() => stream.keepalives >= 2, 1500, 'no keepalives during silence');
        const idleCount = stream.keepalives;
        // Audio resumes: no new keepalive while frames are flowing.
        await client.pump(30, 10);
        assert.equal(stream.keepalives, idleCount, 'keepalive paused while audio flows');
        client.close();
    } finally {
        await env.teardown();
    }
});

test('no keepalive before the first ack and none after the client leaves', async () => {
    const env = await setup({ keepaliveMs: 60 }, { ackDelayMs: 200 });
    try {
        const client = await connectClient(env.host.url);
        client.sendJson({ action: 'start', config: DEFAULT_CLIENT_CONFIG });
        await env.mock.waitForStreams(1);
        await sleep(150);
        assert.equal(env.mock.streams[0].keepalives, 0, 'legacy auth rejects pre-start keepalives, so none are sent');
        await client.waitForType('proxy_ready');
        client.close();
        await client.waitForClose();
        await waitUntil(() => env.mock.streams[0].closed, 2000, 'upstream not closed after client left');
        const after = env.mock.streams[0].keepalives;
        await sleep(150);
        assert.equal(env.mock.streams[0].keepalives, after);
    } finally {
        await env.teardown();
    }
});

test('a client that sends action:start twice does not leak upstreams and gets one proxy_ready', async () => {
    const env = await setup();
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        client.sendJson({ action: 'start', config: { ...DEFAULT_CLIENT_CONFIG, language_hints: ['fr'] } });
        await env.mock.waitForStreams(2);
        await waitUntil(() => env.mock.streams[1].acked, 2000, 'second stream not acked');
        await waitUntil(() => env.mock.streams[0].closed, 2000, 'first stream not closed');
        assert.deepEqual(env.mock.streams[1].startConfig.language_hints, ['fr']);
        assert.equal(env.mock.streams[0].ended, true, 'first stream ended with the empty text frame');
        assert.equal(env.mock.streams[0].finalizeCount, 1, 'first stream finalized before the end');
        await client.pump(3, 5);
        await waitUntil(() => env.mock.streams[1].audioFrames >= 3, 2000, 'audio not on the replacement stream');
        assert.equal(env.mock.streams.length, 2);
        assert.equal(client.ofType('proxy_ready').length, 1);
        assert.equal(env.host.relays[0].current.index, 2);
        assert.equal(env.host.relays[0].pending, null);
        client.close();
    } finally {
        await env.teardown();
    }
});

test('a second start while the first dial is still in flight supersedes it (no leak, one proxy_ready)', async () => {
    const env = await setup({}, { ackDelayMs: 150 });
    try {
        const client = await connectClient(env.host.url);
        client.sendJson({ action: 'start', config: DEFAULT_CLIENT_CONFIG });
        await sleep(20);
        client.sendJson({ action: 'start', config: { ...DEFAULT_CLIENT_CONFIG, language_hints: ['de'] } });
        await client.waitForType('proxy_ready');
        await sleep(250);
        assert.equal(client.ofType('proxy_ready').length, 1);
        assert.equal(env.mock.streams.length, 2);
        assert.equal(env.mock.streams[0].closed, true, 'stale dial closed');
        assert.deepEqual(env.mock.streams[1].startConfig.language_hints, ['de']);
        assert.equal(env.host.relays[0].current.index, 2);
        client.close();
    } finally {
        await env.teardown();
    }
});

test('audio before start is dropped silently and the client socket stays open', async () => {
    const env = await setup();
    try {
        const client = await connectClient(env.host.url);
        client.sendAudio();
        client.sendAudio();
        await sleep(30);
        assert.equal(env.mock.streams.length, 0);
        assert.equal(client.closeCode, null);
        await client.start();
        client.close();
    } finally {
        await env.teardown();
    }
});

test('a binary frame that starts with a brace but is not JSON is treated as audio, not dropped', async () => {
    const env = await setup();
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        const buf = Buffer.alloc(320);
        buf[0] = 0x7b; // '{' as the low byte of a PCM sample
        client.ws.send(buf, { binary: true });
        await waitUntil(() => env.mock.streams[0].audioBytes === 320, 2000, 'brace-led audio frame was dropped');
        client.close();
    } finally {
        await env.teardown();
    }
});

test('unknown JSON control messages are forwarded to the live upstream as before', async () => {
    const env = await setup();
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        client.sendJson({ type: 'keepalive' });
        await waitUntil(() => env.mock.streams[0].keepalives === 1, 2000, 'client keepalive not forwarded');
        client.close();
    } finally {
        await env.teardown();
    }
});

test('client disconnect closes the upstream and clears the relay', async () => {
    const env = await setup();
    try {
        const client = await connectClient(env.host.url);
        await client.start();
        client.close();
        await waitUntil(() => env.mock.streams[0].closed, 2000, 'upstream not closed');
        assert.equal(env.host.relays[0].closed, true);
        assert.equal(env.host.relays[0].current, null);
    } finally {
        await env.teardown();
    }
});
