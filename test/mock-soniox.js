// A stand-in for wss://stt-rt.soniox.com/transcribe-websocket used by the
// node --test suite. Speaks just enough of the real protocol:
//   * first text frame is the start JSON (needs api_key) -> ack frame
//   * every non-empty binary frame is an audio chunk -> a final original
//     token, a translation token (unless stalled), and an <end> token every
//     `endEveryFrames` frames
//   * {"type":"finalize"} -> a <fin> token;  {"type":"keepalive"} -> counted
//   * an empty TEXT frame ends the stream -> {"finished":true} then close
// Behaviors are per stream index (1-based, in connection order) so a test
// can make the second connection fail while the first behaves.

import { WebSocketServer } from 'ws';

const DEFAULT_BEHAVIOR = {
    endEveryFrames: 3,          // <end> token after every N audio frames
    stallAfterFrames: null,     // stop emitting translation tokens after K frames
    maxDurationAfterBytes: null, // send max_duration_reached + close after B bytes
    dropAfterFrames: null,      // terminate the socket after X audio frames
    dropAfterMs: null,          // terminate the socket X ms after the ack
    rejectStart: null,          // { error_code, error_type, error_message } instead of an ack
    refuseConnection: false,    // close immediately on connect, before any frame
    ackDelayMs: 0,              // delay the ack
    language: 'en',
    targetLanguage: 'es',
};

export async function startMockSoniox(options = {}) {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => wss.once('listening', resolve));
    const port = wss.address().port;

    const mock = {
        url: `ws://127.0.0.1:${port}`,
        port,
        streams: [],
        defaults: { ...DEFAULT_BEHAVIOR, ...options },
        perStream: new Map(),
        setDefaults(patch) { Object.assign(mock.defaults, patch); },
        setStream(index, patch) { mock.perStream.set(index, { ...(mock.perStream.get(index) || {}), ...patch }); },
        behaviorFor(index) { return { ...mock.defaults, ...(mock.perStream.get(index) || {}) }; },
        totalAudioBytes() { return mock.streams.reduce((n, s) => n + s.audioBytes, 0); },
        allAudio() { return Buffer.concat(mock.streams.map((s) => Buffer.concat(s.audioChunks))); },
        waitForStreams(n, timeoutMs = 5000) {
            return waitUntil(() => mock.streams.length >= n, timeoutMs, `mock: expected ${n} streams, have ${mock.streams.length}`);
        },
        async close() {
            for (const s of mock.streams) {
                try { s.ws.terminate(); } catch (e) { /* ignore */ }
            }
            await new Promise((resolve) => wss.close(() => resolve()));
        },
    };

    wss.on('connection', (ws) => {
        const index = mock.streams.length + 1;
        const behavior = mock.behaviorFor(index);
        const stream = {
            index,
            ws,
            behavior,
            startConfig: null,
            acked: false,
            audioFrames: 0,
            audioBytes: 0,
            audioChunks: [],
            events: [],       // 'start' | 'audio' | 'finalize' | 'keepalive' | 'end' | 'other'
            finalizeCount: 0,
            keepalives: 0,
            ended: false,
            closed: false,
            closeCode: null,
            emittedTranslation: 0,
            emittedOriginal: 0,
            tokenCounter: 0,
            timers: [],
        };
        mock.streams.push(stream);

        const send = (obj) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
        };
        const later = (ms, fn) => {
            const t = setTimeout(fn, ms);
            stream.timers.push(t);
            return t;
        };

        if (behavior.refuseConnection) {
            ws.close(1008, 'refused by mock');
            return;
        }

        ws.on('message', (data, isBinary) => {
            if (!stream.acked) {
                // Start request.
                let config = null;
                try { config = JSON.parse(data.toString()); } catch (e) { config = null; }
                stream.startConfig = config;
                stream.events.push('start');
                if (!config || !config.api_key) {
                    send({ tokens: [], error_code: 401, error_type: 'unauthorized', error_message: 'Missing api_key', request_id: `mock-${index}` });
                    ws.close(1000);
                    return;
                }
                if (behavior.rejectStart) {
                    send({ tokens: [], request_id: `mock-${index}`, ...behavior.rejectStart });
                    ws.close(1000);
                    return;
                }
                const ack = () => {
                    stream.acked = true;
                    send({ tokens: [], final_audio_proc_ms: 0, total_audio_proc_ms: 0 });
                    if (behavior.dropAfterMs !== null) later(behavior.dropAfterMs, () => ws.terminate());
                };
                if (behavior.ackDelayMs > 0) later(behavior.ackDelayMs, ack); else ack();
                return;
            }

            if (isBinary) {
                if (data.length === 0) return; // empty audio chunk, not end of stream
                stream.audioFrames += 1;
                stream.audioBytes += data.length;
                stream.audioChunks.push(Buffer.from(data));
                stream.events.push('audio');
                const n = stream.audioFrames;
                const tokens = [];
                stream.tokenCounter += 1;
                const k = stream.tokenCounter;
                tokens.push({ text: `w${k} `, start_ms: n * 100, end_ms: n * 100 + 90, is_final: true, translation_status: 'original', language: behavior.language });
                stream.emittedOriginal += 1;
                const stalled = behavior.stallAfterFrames !== null && n > behavior.stallAfterFrames;
                if (!stalled) {
                    tokens.push({ text: `t${k} `, is_final: true, translation_status: 'translation', language: behavior.targetLanguage, source_language: behavior.language });
                    stream.emittedTranslation += 1;
                }
                if (behavior.endEveryFrames && n % behavior.endEveryFrames === 0) {
                    tokens.push({ text: '<end>', is_final: true, start_ms: n * 100 + 90, end_ms: n * 100 + 90 });
                }
                send({ tokens, final_audio_proc_ms: n * 100, total_audio_proc_ms: n * 100 });

                if (behavior.maxDurationAfterBytes !== null && stream.audioBytes >= behavior.maxDurationAfterBytes) {
                    send({ tokens: [], error_code: 413, error_type: 'max_duration_reached',
                        error_message: 'This WebSocket connection has reached the maximum allowed duration and was closed.', request_id: `mock-${index}` });
                    ws.close(1000);
                    return;
                }
                if (behavior.dropAfterFrames !== null && n >= behavior.dropAfterFrames) {
                    ws.terminate();
                }
                return;
            }

            const text = data.toString();
            if (text.length === 0) {
                stream.ended = true;
                stream.events.push('end');
                send({ tokens: [], final_audio_proc_ms: stream.audioFrames * 100, total_audio_proc_ms: stream.audioFrames * 100, finished: true });
                ws.close(1000);
                return;
            }
            let msg = null;
            try { msg = JSON.parse(text); } catch (e) { msg = null; }
            if (msg && msg.type === 'finalize') {
                stream.finalizeCount += 1;
                stream.events.push('finalize');
                send({ tokens: [{ text: '<fin>', is_final: true }], final_audio_proc_ms: stream.audioFrames * 100, total_audio_proc_ms: stream.audioFrames * 100 });
                return;
            }
            if (msg && msg.type === 'keepalive') {
                stream.keepalives += 1;
                stream.events.push('keepalive');
                return;
            }
            stream.events.push('other');
        });

        ws.on('close', (code) => {
            stream.closed = true;
            stream.closeCode = code;
            for (const t of stream.timers) clearTimeout(t);
        });
        ws.on('error', () => { /* ignore */ });
    });

    return mock;
}

export function waitUntil(predicate, timeoutMs = 5000, message = 'condition not met') {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            let v;
            try { v = predicate(); } catch (e) { reject(e); return; }
            if (v) { resolve(v); return; }
            if (Date.now() - started > timeoutMs) { reject(new Error(message)); return; }
            setTimeout(tick, 10);
        };
        tick();
    });
}
