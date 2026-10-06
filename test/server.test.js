// End-to-end: the real server.js as a child process, JWT verification against
// a fake Supabase auth endpoint, Soniox replaced by the mock. Proves the
// surgical edits wired the relay in without touching the HTTP routes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startMockSoniox, waitUntil } from './mock-soniox.js';
import { connectClient, sleep, DEFAULT_CLIENT_CONFIG } from './helpers.js';

const SERVER_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');
const GOOD_TOKEN = 'good-jwt-for-tests';

async function freePort() {
    return new Promise((resolve, reject) => {
        const srv = createNetServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

async function startFakeSupabase({ delayMs = 0 } = {}) {
    const requests = [];
    const srv = createServer((req, res) => {
        requests.push({ url: req.url, auth: req.headers.authorization || '' });
        const answer = () => {
            if (req.url.startsWith('/auth/v1/user') && req.method === 'GET') {
                if (req.headers.authorization === `Bearer ${GOOD_TOKEN}`) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ id: 'user-test-1', aud: 'authenticated', role: 'authenticated', email: 'tester@example.com' }));
                    return;
                }
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: 'invalid token', msg: 'invalid token' }));
                return;
            }
            res.writeHead(404);
            res.end();
        };
        if (delayMs > 0) setTimeout(answer, delayMs); else answer();
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    return {
        url: `http://127.0.0.1:${srv.address().port}`,
        requests,
        close: () => new Promise((resolve) => srv.close(() => resolve())),
    };
}

async function startServer(env) {
    const port = await freePort();
    const child = spawn(process.execPath, [SERVER_JS], {
        env: {
            PATH: process.env.PATH,
            PORT: String(port),
            SONIOX_API_KEY: 'test-key-not-real',
            OPENAI_API_KEY: 'test-openai-not-real',
            SUPABASE_ANON_KEY: 'test-anon-not-real',
            SONIOX_KEEPALIVE_MS: '200',
            ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = [];
    child.stdout.on('data', (d) => output.push(d.toString()));
    child.stderr.on('data', (d) => output.push(d.toString()));
    const exited = new Promise((resolve) => child.on('exit', resolve));
    await waitUntil(() => output.join('').includes('running on port'), 8000, `server did not start:\n${output.join('')}`);
    return {
        port,
        url: `ws://127.0.0.1:${port}`,
        httpUrl: `http://127.0.0.1:${port}`,
        output,
        text: () => output.join(''),
        async stop() {
            child.kill('SIGTERM');
            await Promise.race([exited, sleep(3000).then(() => child.kill('SIGKILL'))]);
        },
    };
}

test('server.js end to end: auth, start, proxy_ready, tokens, pong, finalize, keepalive, redacted logs', async () => {
    const mock = await startMockSoniox();
    const supa = await startFakeSupabase();
    const server = await startServer({ SONIOX_WS_URL: mock.url, SUPABASE_URL: supa.url });
    try {
        const health = await fetch(`${server.httpUrl}/health`).then((r) => r.json());
        assert.equal(health.status, 'healthy');

        const client = await connectClient(`${server.url}?token=${GOOD_TOKEN}`);
        assert.ok(supa.requests.some((r) => r.url.startsWith('/auth/v1/user')), 'JWT verified against Supabase');
        await client.start();
        assert.equal(client.ofType('proxy_ready').length, 1);
        await mock.waitForStreams(1);
        assert.equal(mock.streams[0].startConfig.api_key, 'test-key-not-real');
        assert.equal(mock.streams[0].startConfig.language_hints_strict, true);

        client.sendJson({ type: 'ping', ref: 3 });
        const pong = await client.waitForType('pong');
        assert.equal(pong.ref, 3);

        await client.pump(4, 10);
        await waitUntil(() => client.tokenTexts().includes('w1 '), 2000, 'tokens not relayed');
        client.sendJson({ type: 'finalize' });
        await waitUntil(() => mock.streams[0].finalizeCount === 1, 2000, 'finalize not relayed');
        await waitUntil(() => mock.streams[0].keepalives >= 1, 2000, 'keepalive not sent during silence');
        await sleep(50);
        assert.equal(client.tokenTexts().includes('<fin>'), false);
        assert.equal(client.ofType('proxy_ready').length, 1);

        client.close();
        await waitUntil(() => mock.streams[0].closed, 2000, 'upstream not closed after client left');
        const text = server.text();
        assert.equal(text.includes('test-key-not-real'), false, 'api key never logged');
        assert.ok(text.includes('"api_key":"***"'), 'start config logged redacted');
        assert.ok(text.includes('Soniox relay:'), 'effective relay config logged at startup');
        assert.equal(text.includes('w1 '), false, 'no transcript text in logs');
    } finally {
        await server.stop();
        await supa.close();
        await mock.close();
    }
});

test('server.js rejects a bad JWT with 1008 and never dials Soniox', async () => {
    const mock = await startMockSoniox();
    const supa = await startFakeSupabase();
    const server = await startServer({ SONIOX_WS_URL: mock.url, SUPABASE_URL: supa.url });
    try {
        const { WebSocket } = await import('ws');
        const ws = new WebSocket(`${server.url}?token=bad-jwt`);
        const frames = [];
        ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
        const code = await new Promise((resolve) => ws.on('close', resolve));
        assert.equal(code, 1008);
        assert.equal(frames[0].type, 'error');
        assert.equal(frames[0].code, 401);
        assert.equal(mock.streams.length, 0);
    } finally {
        await server.stop();
        await supa.close();
        await mock.close();
    }
});

test('F1: a malformed client frame during the JWT check does not kill the process or the other sessions', async () => {
    const mock = await startMockSoniox();
    const supa = await startFakeSupabase({ delayMs: 400 });
    const server = await startServer({ SONIOX_WS_URL: mock.url, SUPABASE_URL: supa.url });
    try {
        // An innocent bystander session that is fully up and streaming.
        const bystander = await connectClient(`${server.url}?token=${GOOD_TOKEN}`);
        await bystander.start();

        // A second client sends invalid UTF-8 as a TEXT frame while its JWT
        // check is still in flight: the window where no relay exists yet.
        const { WebSocket } = await import('ws');
        const attacker = new WebSocket(`${server.url}?token=${GOOD_TOKEN}`);
        attacker.on('error', () => { /* the server closes it with 1007 */ });
        await new Promise((resolve) => attacker.once('open', resolve));
        attacker.send(Buffer.from([0xc3, 0x28, 0xa0, 0xa1]), { binary: false });
        await sleep(800);

        const health = await fetch(`${server.httpUrl}/health`).then((r) => r.json());
        assert.equal(health.status, 'healthy', 'the process survived');
        assert.equal(bystander.closeCode, null, 'the other session is untouched');
        await bystander.pump(3, 10);
        await waitUntil(() => mock.streams[0].audioFrames >= 3, 2000, 'bystander audio still relayed');
        const text = server.text();
        assert.ok(text.includes('client socket error'), 'the bad frame was logged, not thrown');
        assert.equal(text.includes('Emitted error event'), false);
        assert.ok(text.includes('no relay created'), 'the dead attacker socket got no relay after auth');
        bystander.close();
    } finally {
        await server.stop();
        await supa.close();
        await mock.close();
    }
});

test('F2: clients that leave during the JWT check leave no relay behind', async () => {
    const mock = await startMockSoniox();
    const supa = await startFakeSupabase({ delayMs: 400 });
    const server = await startServer({ SONIOX_WS_URL: mock.url, SUPABASE_URL: supa.url, SONIOX_HEARTBEAT_MS: '200' });
    try {
        const { WebSocket } = await import('ws');
        for (let i = 0; i < 5; i += 1) {
            const ws = new WebSocket(`${server.url}?token=${GOOD_TOKEN}`);
            ws.on('error', () => { /* ignore */ });
            await new Promise((resolve) => ws.once('open', resolve));
            await sleep(30);
            ws.close(1000); // leaves inside the 400 ms auth window
        }
        await sleep(1200);
        const text = server.text();
        const ids = [...text.matchAll(/\[(\w+)\] New client connection/g)].map((m) => m[1]);
        assert.equal(ids.length, 5);
        assert.equal((text.match(/no relay created/g) || []).length, 5, 'every early leaver was skipped after auth');
        assert.equal(text.includes('Auth complete'), false, 'no relay attached to a dead socket');

        await server.stop();
        const after = server.text();
        assert.equal((after.match(/Cleaning up connection/g) || []).length, 0, 'nothing left in the connections map at SIGTERM');
    } finally {
        await server.stop();
        await supa.close();
        await mock.close();
    }
});

test('server.js honors SONIOX_STRICT_HINTS=off and SONIOX_LANG_ID=off', async () => {
    const mock = await startMockSoniox();
    const supa = await startFakeSupabase();
    const server = await startServer({ SONIOX_WS_URL: mock.url, SUPABASE_URL: supa.url, SONIOX_STRICT_HINTS: 'off', SONIOX_LANG_ID: 'off' });
    try {
        const client = await connectClient(`${server.url}?token=${GOOD_TOKEN}`);
        await client.start(DEFAULT_CLIENT_CONFIG);
        await mock.waitForStreams(1);
        const cfg = mock.streams[0].startConfig;
        assert.equal('language_hints_strict' in cfg, false);
        assert.equal('enable_language_identification' in cfg, false);
        client.close();
    } finally {
        await server.stop();
        await supa.close();
        await mock.close();
    }
});
