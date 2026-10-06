// One Soniox real-time stream: dial, start config, ack wait, token parsing,
// counters, finalize/end, close. Owns nothing about the client; relay.js
// decides what to forward. Every log line goes through the injected `log`
// and never contains transcript text or the API key.

import { EventEmitter } from 'events';
import { WebSocket } from 'ws';

export const DEFAULT_SONIOX_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';

// Bytes per sample for the raw PCM formats Soniox accepts. Anything else
// (compressed or "auto") has no fixed byte rate, so audio seconds are unknown
// and rotation falls back to wall time alone.
const BYTES_PER_SAMPLE = {
    pcm_s16le: 2, pcm_s16be: 2,
    pcm_s32le: 4, pcm_s32be: 4,
    pcm_f32le: 4, pcm_f32be: 4,
    pcm_s8: 1, pcm_u8: 1, mulaw: 1, alaw: 1,
};

export function bytesPerSecond(clientConfig = {}) {
    const bytes = BYTES_PER_SAMPLE[clientConfig.audio_format || 'pcm_s16le'];
    if (!bytes) return null;
    const rate = Number(clientConfig.sample_rate) || 16000;
    const channels = Number(clientConfig.num_channels) || 1;
    return bytes * rate * channels;
}

// Where language_hints_strict and enable_language_identification come from
// and what they are. An explicit boolean in the client's start config wins,
// true or false, so a control run can pin either for one session; anything
// else (absent, null, a string) is "omitted" and the proxy default applies:
// strict when exactly one hint was sent and SONIOX_STRICT_HINTS is on,
// language identification when SONIOX_LANG_ID is on. Both production clients
// omit both fields, so their start request is unchanged.
export function resolveStartFlags(clientConfig = {}, opts = {}) {
    const clientHints = Array.isArray(clientConfig.language_hints) ? clientConfig.language_hints : null;
    const strictHints = typeof clientConfig.language_hints_strict === 'boolean'
        ? { source: 'client', value: clientConfig.language_hints_strict }
        : { source: 'default', value: opts.strictHints !== false && !!clientHints && clientHints.length === 1 };
    const langId = typeof clientConfig.enable_language_identification === 'boolean'
        ? { source: 'client', value: clientConfig.enable_language_identification }
        : { source: 'default', value: opts.langId !== false };
    return { strictHints, langId };
}

// The wording on the relay's start line, e.g. `strictHints=default:true langId=client:false`.
export function describeStartFlags(flags) {
    return `strictHints=${flags.strictHints.source}:${flags.strictHints.value} langId=${flags.langId.source}:${flags.langId.value}`;
}

// Builds the start request Soniox expects from the config the client sent.
// Mirrors the a171dfd shape field for field, with the reliability changes:
// language_hints_strict when the client sent exactly one hint,
// enable_language_identification so tokens carry `language` (both subject to
// a client-pinned boolean, see resolveStartFlags), and no undocumented
// translation.source_language.
export function buildSonioxConfig(clientConfig, apiKey, opts = {}) {
    const flags = resolveStartFlags(clientConfig, opts);
    const clientHints = Array.isArray(clientConfig.language_hints) ? clientConfig.language_hints : null;

    const sonioxConfig = {
        api_key: apiKey,
        model: clientConfig.model || 'stt-rt-v5',
        audio_format: clientConfig.audio_format || 'pcm_s16le',
        sample_rate: clientConfig.sample_rate || 16000,
        num_channels: clientConfig.num_channels || 1,
        include_nonfinal: clientConfig.include_nonfinal !== false,
        language_hints: clientHints || ['en'],
        // Endpoint detection finalizes tokens on speech pauses and gives the
        // relay its <end> segment markers.
        enable_endpoint_detection: clientConfig.enable_endpoint_detection !== false,
        // Not in the documented field list as of 2026-10-05; kept because the
        // deployed proxy has always sent it and Soniox accepts it.
        max_non_final_tokens_duration_ms: clientConfig.max_non_final_tokens_duration_ms || 4000,
    };

    // A client-pinned value is sent as is, false included, so the redacted
    // config line shows exactly what the control run asked for. The default
    // only ever adds the field when it is true, as before.
    if (flags.strictHints.source === 'client' || flags.strictHints.value) {
        sonioxConfig.language_hints_strict = flags.strictHints.value;
    }
    if (flags.langId.source === 'client' || flags.langId.value) {
        sonioxConfig.enable_language_identification = flags.langId.value;
    }

    const translation = clientConfig.translation;
    if (translation && translation.target_language) {
        sonioxConfig.translation = {
            type: translation.type || 'one_way',
            target_language: translation.target_language,
        };
    }
    return sonioxConfig;
}

export function redactConfig(sonioxConfig) {
    if (!sonioxConfig || typeof sonioxConfig !== 'object') return sonioxConfig;
    const copy = { ...sonioxConfig };
    if ('api_key' in copy) copy.api_key = '***';
    return copy;
}

export function isErrorFrame(frame) {
    return !!frame && typeof frame === 'object'
        && (frame.error_type !== undefined || frame.error_code !== undefined);
}

export class UpstreamError extends Error {
    constructor(kind, message, extra = {}) {
        super(message);
        this.name = 'UpstreamError';
        this.kind = kind;
        this.errorType = extra.errorType || null;
        this.errorCode = extra.errorCode || null;
        this.closeCode = extra.closeCode || null;
    }

    // 401/402/403 come from the account, not the network; retrying only
    // delays the error the client needs to see.
    get retryable() {
        return !(this.errorCode === 401 || this.errorCode === 402 || this.errorCode === 403);
    }
}

function fmtSeconds(ms) {
    return (ms / 1000).toFixed(1);
}

export class Upstream extends EventEmitter {
    constructor({ url, apiKey, clientConfig, connectionId, index, options = {}, log = console.log, now = Date.now }) {
        super();
        this.url = url || DEFAULT_SONIOX_WS_URL;
        this.apiKey = apiKey;
        this.clientConfig = clientConfig || {};
        this.connectionId = connectionId;
        this.index = index;
        this.options = options;
        this.log = log;
        this.now = now;
        this.tag = `[${connectionId}] [stream ${index}]`;

        this.ws = null;
        this.acked = false;
        this.ackedAt = null;
        this.openedAt = null;
        this.closed = false;
        this.closeInfo = null;
        this.closeRequested = false;
        this.finSeen = false;
        this.finished = false;
        this.lastErrorFrame = null;
        this.bytesPerSecond = bytesPerSecond(this.clientConfig);

        this.counters = {
            finals: { none: 0, original: 0, translation: 0 },
            langs: {},
            lastTranslationAt: null,
            lastFinalOriginalAt: null,
            audioBytes: 0,
            audioFrames: 0,
            endpoints: 0,
            keepalives: 0,
            frames: 0,
        };
        this.summaryTimer = null;
        this.dialTimer = null;
    }

    get isOpen() {
        return !!this.ws && this.ws.readyState === WebSocket.OPEN && !this.closed;
    }

    wallMs() {
        if (!this.openedAt) return 0;
        const end = this.closeInfo ? this.closeInfo.at : this.now();
        return end - this.openedAt;
    }

    audioMs() {
        if (!this.bytesPerSecond) return 0;
        return (this.counters.audioBytes / this.bytesPerSecond) * 1000;
    }

    // Minutes toward the 300 minute cap: the larger of audio forwarded and
    // wall time since the start request went out.
    elapsedMinutes() {
        return Math.max(this.wallMs(), this.audioMs()) / 60000;
    }

    dial() {
        if (this.ws) return Promise.reject(new UpstreamError('already_dialed', 'dial() called twice'));
        const ackTimeoutMs = this.options.ackTimeoutMs || 10000;

        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (err, frame) => {
                if (settled) return;
                settled = true;
                if (this.dialTimer) { clearTimeout(this.dialTimer); this.dialTimer = null; }
                if (err) reject(err); else resolve(frame);
            };

            let ws;
            try {
                ws = new WebSocket(this.url);
            } catch (err) {
                this.closed = true;
                settle(new UpstreamError('dial_failed', err.message));
                return;
            }
            this.ws = ws;

            this.dialTimer = setTimeout(() => {
                this.log(`${this.tag} ack timeout after ${ackTimeoutMs} ms`);
                this.closeRequested = true;
                try { ws.terminate(); } catch (e) { /* ignore */ }
                settle(new UpstreamError('ack_timeout', 'Soniox connection timeout'));
            }, ackTimeoutMs);

            ws.on('open', () => {
                this.openedAt = this.now();
                const sonioxConfig = buildSonioxConfig(this.clientConfig, this.apiKey, this.options);
                try {
                    ws.send(JSON.stringify(sonioxConfig));
                } catch (err) {
                    settle(new UpstreamError('send_failed', err.message));
                    return;
                }
                this.log(`${this.tag} sent start config: ${JSON.stringify(redactConfig(sonioxConfig))}`);
            });

            ws.on('message', (data, isBinary) => {
                if (isBinary) return; // Soniox never sends binary
                const raw = data.toString();
                let frame;
                try {
                    frame = JSON.parse(raw);
                } catch (err) {
                    this.log(`${this.tag} non-JSON frame (${raw.length} chars)`);
                    this.emit('frame', { upstream: this, frame: null, raw, tokens: [], isAck: false });
                    return;
                }
                this.counters.frames += 1;

                if (!this.acked) {
                    if (isErrorFrame(frame)) {
                        const err = new UpstreamError('rejected', frame.error_message || `Soniox error ${frame.error_code || ''}`.trim(), {
                            errorType: frame.error_type, errorCode: frame.error_code,
                        });
                        this.lastErrorFrame = frame;
                        this.log(`${this.tag} start rejected: code=${frame.error_code} type=${frame.error_type} request_id=${frame.request_id || '-'}`);
                        this.closeRequested = true;
                        try { ws.close(1000); } catch (e) { /* ignore */ }
                        settle(err);
                        return;
                    }
                    this.acked = true;
                    this.ackedAt = this.now();
                    this.startSummaryTimer();
                    settle(null, frame);
                    this.emit('ack', frame);
                    this.emit('frame', this.ingest(frame, raw, true));
                    return;
                }

                if (isErrorFrame(frame)) {
                    this.lastErrorFrame = frame;
                    this.log(`${this.tag} error frame: code=${frame.error_code} type=${frame.error_type} request_id=${frame.request_id || '-'}`);
                    this.emit('error_frame', frame);
                    this.emit('frame', { upstream: this, frame, raw, tokens: [], isAck: false, isError: true });
                    return;
                }
                if (frame.finished === true) {
                    this.finished = true;
                    this.emit('finished', frame);
                }
                this.emit('frame', this.ingest(frame, raw, false));
            });

            ws.on('close', (code, reasonBuf) => {
                const reason = reasonBuf ? reasonBuf.toString() : '';
                this.closed = true;
                this.closeInfo = { code, reason, at: this.now(), initiated: this.closeRequested };
                this.stopSummaryTimer();
                this.log(`${this.tag} closed code=${code} reason="${reason}" acked=${this.acked} initiated=${this.closeRequested}`);
                this.log(this.summaryLine());
                if (!this.acked) {
                    settle(new UpstreamError('closed_before_ack', `Soniox closed before acknowledging config (code ${code}${reason ? ', ' + reason : ''})`, {
                        closeCode: code,
                        errorType: this.lastErrorFrame?.error_type,
                        errorCode: this.lastErrorFrame?.error_code,
                    }));
                }
                this.emit('close', { ...this.closeInfo, acked: this.acked, lastErrorFrame: this.lastErrorFrame });
            });

            ws.on('error', (err) => {
                this.log(`${this.tag} socket error: ${err.message}`);
                this.emit('socket_error', err);
                if (!this.acked) {
                    settle(new UpstreamError('socket_error', 'Soniox connection error: ' + err.message));
                }
                // ws emits 'close' after 'error'; the close handler finishes the bookkeeping.
            });
        });
    }

    // Parses one token frame: updates counters, strips <fin>, and returns
    // what the relay needs to forward. `raw` is passed through untouched
    // unless a <fin> token had to be removed.
    ingest(frame, raw, isAck) {
        const now = this.now();
        const tokens = Array.isArray(frame.tokens) ? frame.tokens : [];
        let hadFin = false;
        const kept = [];
        for (const token of tokens) {
            if (!token || typeof token !== 'object') { kept.push(token); continue; }
            const text = token.text;
            if (text === '<fin>') { hadFin = true; this.finSeen = true; continue; }
            kept.push(token);
            if (text === '<end>') {
                this.counters.endpoints += 1;
                continue;
            }
            const status = token.translation_status || 'original';
            if (status === 'translation') this.counters.lastTranslationAt = now;
            if (token.is_final) {
                if (this.counters.finals[status] === undefined) this.counters.finals[status] = 0;
                this.counters.finals[status] += 1;
                if (status === 'original') this.counters.lastFinalOriginalAt = now;
                if (typeof token.language === 'string' && token.language) {
                    this.counters.langs[token.language] = (this.counters.langs[token.language] || 0) + 1;
                }
            }
        }
        if (hadFin) this.emit('fin');
        let outRaw = raw;
        let outFrame = frame;
        if (hadFin) {
            outFrame = { ...frame, tokens: kept };
            outRaw = JSON.stringify(outFrame);
        }
        return { upstream: this, frame: outFrame, raw: outRaw, tokens: kept, isAck, hadFin, isError: false };
    }

    sendAudio(buf) {
        if (!this.isOpen) return false;
        try {
            this.ws.send(buf, { binary: true });
        } catch (err) {
            this.log(`${this.tag} audio send failed: ${err.message}`);
            return false;
        }
        this.counters.audioBytes += buf.length;
        this.counters.audioFrames += 1;
        return true;
    }

    sendJson(obj) {
        if (!this.isOpen) return false;
        try {
            this.ws.send(JSON.stringify(obj));
            return true;
        } catch (err) {
            this.log(`${this.tag} send failed: ${err.message}`);
            return false;
        }
    }

    sendKeepalive() {
        if (!this.acked) return false;
        const ok = this.sendJson({ type: 'keepalive' });
        if (ok) this.counters.keepalives += 1;
        return ok;
    }

    sendFinalize() {
        return this.sendJson({ type: 'finalize' });
    }

    // Ends the stream the documented way: an empty TEXT frame. The server
    // answers with finished:true. (An empty binary frame is an empty audio
    // chunk and does not end the stream.)
    sendEnd() {
        if (!this.isOpen) return false;
        try {
            this.ws.send('');
            return true;
        } catch (err) {
            this.log(`${this.tag} end frame failed: ${err.message}`);
            return false;
        }
    }

    // Resolves when `event` fires or after `timeoutMs`, whichever first.
    waitFor(event, timeoutMs) {
        return new Promise((resolve) => {
            if (this.closed) { resolve(false); return; }
            let timer = null;
            const onEvent = () => { cleanup(); resolve(true); };
            const onClose = () => { cleanup(); resolve(false); };
            const cleanup = () => {
                if (timer) clearTimeout(timer);
                this.off(event, onEvent);
                this.off('close', onClose);
            };
            this.once(event, onEvent);
            this.once('close', onClose);
            timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
        });
    }

    close(code = 1000) {
        this.closeRequested = true;
        this.stopSummaryTimer();
        if (this.dialTimer) { clearTimeout(this.dialTimer); this.dialTimer = null; }
        if (!this.ws) { this.closed = true; return; }
        try {
            if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
            else if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CLOSING) this.ws.close(code);
        } catch (e) { /* ignore */ }
    }

    ping() {
        if (!this.isOpen) return;
        try { this.ws.ping(); } catch (e) { /* ignore */ }
    }

    startSummaryTimer() {
        const summaryMs = this.options.summaryMs || 60000;
        this.stopSummaryTimer();
        this.summaryTimer = setInterval(() => this.log(this.summaryLine()), summaryMs);
        if (typeof this.summaryTimer.unref === 'function') this.summaryTimer.unref();
    }

    stopSummaryTimer() {
        if (this.summaryTimer) { clearInterval(this.summaryTimer); this.summaryTimer = null; }
    }

    summaryLine() {
        const c = this.counters;
        const now = this.closeInfo ? this.closeInfo.at : this.now();
        const langs = Object.entries(c.langs).map(([k, v]) => `${k}:${v}`).join(',');
        const lastTrans = c.lastTranslationAt === null ? 'never' : `${fmtSeconds(now - c.lastTranslationAt)}s ago`;
        return `${this.tag} wall=${fmtSeconds(this.wallMs())}s audio=${fmtSeconds(this.audioMs())}s `
            + `finals orig=${c.finals.original} trans=${c.finals.translation} none=${c.finals.none} `
            + `langs={${langs}} lastTrans=${lastTrans} endpoints=${c.endpoints} bytes=${c.audioBytes} keepalives=${c.keepalives}`;
    }
}
