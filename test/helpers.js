// Shared plumbing for the relay tests: a tiny WebSocket host that wraps each
// client connection in a Relay (what server.js does after JWT auth), and a
// client wrapper that records frames and sends audio with a sequence stamp.

import { WebSocketServer, WebSocket } from 'ws';
import { Relay, readRelayConfig } from '../relay.js';
import { waitUntil } from './mock-soniox.js';

export { waitUntil };

export const TEST_API_KEY = 'test-key-not-real';

// Fast defaults so the whole suite runs in seconds. Anything a test cares
// about is overridden explicitly.
export function fastConfig(mockUrl, overrides = {}) {
    const base = readRelayConfig({ SONIOX_WS_URL: mockUrl });
    return {
        ...base,
        keepaliveMs: 150,
        segmentGapMs: 80,
        stallQuietMs: 50,
        recycleMinIntervalMs: 0,
        finalizeTailMs: 300,
        endGraceMs: 200,
        rotation: false,
        rotateQuietMs: 100,
        redialDelaysMs: [30, 60],
        ackTimeoutMs: 2000,
        heartbeatMs: 20000,
        rotationTickMs: 50,
        summaryMs: 60000,
        ...overrides,
    };
}

export async function startRelayHost(config, hostOptions = {}) {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => wss.once('listening', resolve));
    const port = wss.address().port;
    const host = {
        url: `ws://127.0.0.1:${port}`,
        relays: [],
        logs: [],
        log: (line) => { host.logs.push(String(line)); if (hostOptions.verbose) console.log(line); },
        async close() {
            for (const r of host.relays) r.destroy('host closing');
            for (const c of wss.clients) { try { c.terminate(); } catch (e) { /* ignore */ } }
            await new Promise((resolve) => wss.close(() => resolve()));
        },
    };
    let counter = 0;
    wss.on('connection', (clientWs) => {
        counter += 1;
        const connectionId = `c${counter}`;
        const relay = new Relay({ clientWs, connectionId, apiKey: TEST_API_KEY, config, log: host.log });
        host.relays.push(relay);
        relay.attach();
        clientWs.send(JSON.stringify({ type: 'auth_success', message: 'Authenticated, ready for start message', connectionId }));
    });
    return host;
}

export const DEFAULT_CLIENT_CONFIG = {
    model: 'stt-rt-v5',
    audio_format: 'pcm_s16le',
    sample_rate: 16000,
    num_channels: 1,
    language_hints: ['en'],
    include_nonfinal: true,
    enable_endpoint_detection: true,
    translation: { source_language: 'en', target_language: 'es', type: 'one_way' },
};

export async function connectClient(url) {
    const ws = new WebSocket(url);
    const client = {
        ws,
        frames: [],          // every parsed JSON frame in arrival order
        raw: [],
        closeCode: null,
        closeReason: null,
        sentAudio: [],
        seq: 0,
        sendJson(obj) { ws.send(JSON.stringify(obj)); },
        // Each frame carries its sequence number in every 4 byte word so the
        // mock side can be checked for order and completeness.
        sendAudio(bytes = 320) {
            const buf = Buffer.alloc(bytes);
            for (let i = 0; i + 4 <= bytes; i += 4) buf.writeUInt32LE(client.seq, i);
            client.seq += 1;
            client.sentAudio.push(buf);
            ws.send(buf, { binary: true });
            return buf;
        },
        sentAudioBytes() { return client.sentAudio.reduce((n, b) => n + b.length, 0); },
        allSentAudio() { return Buffer.concat(client.sentAudio); },
        ofType(type) { return client.frames.filter((f) => f.type === type); },
        notices() { return client.frames.filter((f) => f.type === 'proxy_notice').map((f) => f.event); },
        tokenTexts() {
            const out = [];
            for (const f of client.frames) if (Array.isArray(f.tokens)) for (const t of f.tokens) out.push(t.text);
            return out;
        },
        waitForType(type, timeoutMs = 5000, minCount = 1) {
            return waitUntil(() => client.ofType(type).length >= minCount && client.ofType(type)[minCount - 1], timeoutMs, `client: no ${type} frame within ${timeoutMs} ms`);
        },
        waitForNotice(event, timeoutMs = 5000) {
            return waitUntil(() => client.frames.find((f) => f.type === 'proxy_notice' && f.event === event), timeoutMs, `client: no proxy_notice ${event} within ${timeoutMs} ms`);
        },
        waitForClose(timeoutMs = 5000) {
            return waitUntil(() => client.closeCode !== null && { code: client.closeCode, reason: client.closeReason }, timeoutMs, 'client: socket did not close');
        },
        // Start the session and wait for proxy_ready.
        async start(config = DEFAULT_CLIENT_CONFIG) {
            client.sendJson({ action: 'start', config });
            await client.waitForType('proxy_ready');
        },
        // Send `frames` audio frames `intervalMs` apart; resolves when done.
        pump(frames, intervalMs = 10, bytes = 320) {
            return new Promise((resolve) => {
                let n = 0;
                const tick = () => {
                    if (ws.readyState !== WebSocket.OPEN || n >= frames) { resolve(); return; }
                    client.sendAudio(bytes);
                    n += 1;
                    setTimeout(tick, intervalMs);
                };
                tick();
            });
        },
        close() { try { ws.close(1000); } catch (e) { /* ignore */ } },
    };
    ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const text = data.toString();
        client.raw.push(text);
        try { client.frames.push(JSON.parse(text)); } catch (e) { /* ignore */ }
    });
    ws.on('close', (code, reason) => { client.closeCode = code; client.closeReason = reason ? reason.toString() : ''; });
    ws.on('error', () => { /* close follows */ });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await client.waitForType('auth_success');
    return client;
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
