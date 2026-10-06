// Per-client relay session: the current upstream, a pending upstream during a
// switch, audio accounting and buffering, keepalive during silence, the stall
// watchdog, rotation before the 300 minute cap, re-dial on upstream loss, and
// the proxy_notice frames that tell clients what happened.
//
// Invariants the clients depend on:
//   * proxy_ready is sent exactly once per client connection (first ack).
//   * token frames reach the client unchanged except <fin> tokens are removed.
//   * audio is never sent to two upstreams at once; during a switch it goes to
//     the old stream until the commit point, then to a buffer, then to the new.
//   * two upstream sockets overlap only for the ack wait of a switch.

import { WebSocket } from 'ws';
import { Upstream, DEFAULT_SONIOX_WS_URL, bytesPerSecond } from './upstream.js';

const FLAG_OFF = /^(0|false|off|no)$/i;

function flag(value, dflt) {
    if (value === undefined || value === null || String(value).trim() === '') return dflt;
    return !FLAG_OFF.test(String(value).trim());
}

function num(value, dflt) {
    if (value === undefined || value === null || String(value).trim() === '') return dflt;
    const n = Number(value);
    return Number.isFinite(n) ? n : dflt;
}

function list(value, dflt) {
    if (value === undefined || value === null || String(value).trim() === '') return dflt;
    const parts = String(value).split(',').map((p) => Number(p.trim())).filter((n) => Number.isFinite(n) && n >= 0);
    return parts.length ? parts : dflt;
}

// Every behavior switch, read once at startup. Names and defaults are the
// contract in docs/reliability-2026-10.md.
export function readRelayConfig(env = process.env) {
    return {
        wsUrl: env.SONIOX_WS_URL || DEFAULT_SONIOX_WS_URL,
        langId: flag(env.SONIOX_LANG_ID, true),
        strictHints: flag(env.SONIOX_STRICT_HINTS, true),
        keepaliveMs: num(env.SONIOX_KEEPALIVE_MS, 10000),
        stallWatchdog: flag(env.SONIOX_STALL_WATCHDOG, true),
        stallSegments: num(env.SONIOX_STALL_SEGMENTS, 6),
        stallQuietMs: num(env.SONIOX_STALL_QUIET_MS, 20000),
        stallCountNone: flag(env.SONIOX_STALL_COUNT_NONE, true),
        segmentGapMs: num(env.SONIOX_SEGMENT_GAP_MS, 700),
        recycleMinIntervalMs: num(env.SONIOX_RECYCLE_MIN_INTERVAL_MS, 120000),
        recycleMax: num(env.SONIOX_RECYCLE_MAX, 3),
        recycleWindowMs: num(env.SONIOX_RECYCLE_WINDOW_MS, 600000),
        rotation: flag(env.SONIOX_ROTATION, true),
        rotateSoftMin: num(env.SONIOX_ROTATE_SOFT_MIN, 270),
        rotateHardMin: num(env.SONIOX_ROTATE_HARD_MIN, 290),
        rotateBackstopMin: num(env.SONIOX_ROTATE_BACKSTOP_MIN, 292),
        rotateQuietMs: num(env.SONIOX_ROTATE_QUIET_MS, 600),
        rotateRetryMs: num(env.SONIOX_ROTATE_RETRY_MS, 5000),
        rotateRetryMaxMs: num(env.SONIOX_ROTATE_RETRY_MAX_MS, 60000),
        minDialIntervalMs: num(env.SONIOX_MIN_DIAL_INTERVAL_MS, 1000),
        finalizeTailMs: num(env.SONIOX_FINALIZE_TAIL_MS, 1500),
        endGraceMs: num(env.SONIOX_END_GRACE_MS, 500),
        audioBufferMs: num(env.SONIOX_AUDIO_BUFFER_MS, 15000),
        redialDelaysMs: list(env.SONIOX_REDIAL_DELAYS_MS, [1000, 3000]),
        ackTimeoutMs: num(env.SONIOX_ACK_TIMEOUT_MS, 10000),
        overlapWarnMs: num(env.SONIOX_OVERLAP_WARN_MS, 3000),
        summaryMs: num(env.SONIOX_SUMMARY_MS, 60000),
        heartbeatMs: num(env.SONIOX_HEARTBEAT_MS, 20000),
        rotationTickMs: num(env.SONIOX_ROTATION_TICK_MS, 1000),
    };
}

export function describeRelayConfig(config) {
    const c = config;
    return `url=${c.wsUrl} langId=${c.langId} strictHints=${c.strictHints} keepaliveMs=${c.keepaliveMs} `
        + `stallWatchdog=${c.stallWatchdog} stallSegments=${c.stallSegments} stallQuietMs=${c.stallQuietMs} stallCountNone=${c.stallCountNone} `
        + `rotation=${c.rotation} soft=${c.rotateSoftMin}m hard=${c.rotateHardMin}m backstop=${c.rotateBackstopMin}m `
        + `rotateRetryMs=${c.rotateRetryMs}/${c.rotateRetryMaxMs} minDialIntervalMs=${c.minDialIntervalMs} `
        + `redialDelaysMs=${c.redialDelaysMs.join('/')} audioBufferMs=${c.audioBufferMs}`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Key-order independent JSON, so two start configs compare by content.
function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function sameConfig(a, b) {
    if (!a || !b) return false;
    return stableStringify(a) === stableStringify(b);
}

function looksLikeJsonBuffer(data) {
    if (!data || data.length === 0) return false;
    const first = data[0];
    return first === 0x7b || first === 0x5b; // '{' or '['
}

export class Relay {
    constructor({ clientWs, connectionId, apiKey, config, log = console.log, now = Date.now, onClosed = null }) {
        this.clientWs = clientWs;
        this.connectionId = connectionId;
        this.apiKey = apiKey;
        this.config = config || readRelayConfig();
        this.log = log;
        this.now = now;
        this.onClosed = onClosed;
        this.tag = `[${connectionId}]`;

        this.clientConfig = null;
        this.translationConfigured = false;
        this.current = null;
        this.pending = null;
        this.retiring = new Set();
        this.streamCount = 0;
        this.proxyReadySent = false;
        this.closed = false;
        this.recovering = false;

        this.buffering = false;
        this.buffer = { chunks: [], bytes: 0, capBytes: 0, droppedBytes: 0 };
        this.lastAudioAt = null;
        this.keepaliveTimer = null;
        this.pendingKeepaliveTimer = null;
        this.heartbeatTimer = null;

        // Repeated action:start frames: one re-dial per minDialIntervalMs,
        // always with the latest config; identical repeats are suppressed.
        this.restart = { timer: null, config: null };
        this.lastStartDialAt = 0;

        this.stall = this.freshStallState();
        this.recycleTimes = [];
        this.lastRecycleAt = null;
        this.unavailableSent = false;

        this.rotation = { phase: 'none', quietTimer: null, backstopTimer: null, tick: null, retryAfter: 0, minutes: 0, failures: 0, waitLogged: false };
        this.adoptNotice = null;
        this.stats = { audioFramesIn: 0, audioBytesIn: 0, droppedFrames: 0, suppressedStarts: 0 };
    }

    // ---- lifecycle -------------------------------------------------------

    // Returns false when the client socket is already gone: a client that
    // left during the JWT check must not leave a relay (and its heartbeat
    // interval) behind that nothing will ever destroy.
    attach() {
        if (this.clientWs.readyState !== WebSocket.OPEN) {
            this.log(`${this.tag} client socket not open at attach (readyState ${this.clientWs.readyState})`);
            this.destroy('client_gone');
            return false;
        }
        this.clientWs.on('message', (data, isBinary) => this.handleClientMessage(data, isBinary));
        this.clientWs.on('close', (code, reason) => {
            this.log(`${this.tag} client disconnected: ${code} ${reason ? reason.toString() : ''}`);
            this.destroy('client_closed');
        });
        this.clientWs.on('error', (err) => {
            this.log(`${this.tag} client socket error: ${err.message}`);
            this.destroy('client_error');
        });
        // Ping both legs so load balancers do not drop a quiet connection.
        this.heartbeatTimer = setInterval(() => {
            try { if (this.clientWs.readyState === WebSocket.OPEN) this.clientWs.ping(); } catch (e) { /* ignore */ }
            if (this.current) this.current.ping();
            if (this.pending) this.pending.ping();
        }, this.config.heartbeatMs);
        return true;
    }

    destroy(reason = 'destroyed') {
        if (this.closed) return;
        this.closed = true;
        this.log(`${this.tag} relay closing (${reason}); frames in=${this.stats.audioFramesIn} bytes in=${this.stats.audioBytesIn} dropped=${this.stats.droppedFrames} bufferDropped=${this.buffer.droppedBytes} suppressedStarts=${this.stats.suppressedStarts}`);
        this.stopStreamTimers();
        this.stopPendingKeepalive();
        if (this.restart.timer) { clearTimeout(this.restart.timer); this.restart.timer = null; }
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
        if (this.rotation.tick) { clearInterval(this.rotation.tick); this.rotation.tick = null; }
        for (const up of [this.current, this.pending, ...this.retiring]) {
            if (up) up.close();
        }
        this.current = null;
        this.pending = null;
        this.retiring.clear();
        this.buffer.chunks = [];
        this.buffer.bytes = 0;
        try {
            if (this.clientWs.readyState === WebSocket.OPEN || this.clientWs.readyState === WebSocket.CONNECTING) {
                this.clientWs.close();
            }
        } catch (e) { /* ignore */ }
        if (this.onClosed) this.onClosed(this);
    }

    // ---- client leg ------------------------------------------------------

    sendToClient(obj) {
        if (this.clientWs.readyState !== WebSocket.OPEN) return false;
        try { this.clientWs.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
    }

    sendRawToClient(raw) {
        if (this.clientWs.readyState !== WebSocket.OPEN) return false;
        try { this.clientWs.send(raw); return true; } catch (e) { return false; }
    }

    sendNotice(event, extra = {}) {
        this.log(`${this.tag} proxy_notice ${event}${Object.keys(extra).length ? ' ' + JSON.stringify(extra) : ''}`);
        return this.sendToClient({ type: 'proxy_notice', event, ...extra });
    }

    handleClientMessage(data, isBinary) {
        if (this.closed) return;
        if (isBinary) {
            // Some clients send control JSON as binary frames; audio is binary
            // too. Try JSON only when the first byte says so, and never drop
            // audio because a PCM sample happened to look like a brace.
            if (looksLikeJsonBuffer(data)) {
                let message = null;
                try { message = JSON.parse(data.toString()); } catch (e) { message = null; }
                if (message && typeof message === 'object') { this.handleControl(message); return; }
            }
            this.handleAudio(data);
            return;
        }
        const text = data.toString();
        let message;
        try {
            message = JSON.parse(text);
        } catch (err) {
            this.log(`${this.tag} ignoring non-JSON text frame (${text.length} chars)`);
            return;
        }
        if (!message || typeof message !== 'object') return;
        this.handleControl(message);
    }

    handleControl(message) {
        if (message.type === 'ping') {
            this.sendToClient({ type: 'pong', ref: message.ref || 0, timestamp: Date.now() });
            return;
        }
        if (message.action === 'start') {
            const configToUse = message.config || message;
            this.handleStart(configToUse);
            return;
        }
        if (message.type === 'finalize') {
            if (this.current && this.current.isOpen) {
                this.current.sendFinalize();
                this.log(`${this.tag} finalize forwarded to stream ${this.current.index}`);
            } else {
                this.log(`${this.tag} cannot finalize, no live upstream`);
            }
            return;
        }
        // Anything else goes to Soniox as before.
        if (this.current && this.current.isOpen) {
            this.current.sendJson(message);
        } else {
            this.log(`${this.tag} cannot forward ${message.type || message.action || 'message'}, no live upstream`);
        }
    }

    handleAudio(data) {
        this.stats.audioFramesIn += 1;
        this.stats.audioBytesIn += data.length;
        if (this.current && this.current.isOpen && !this.buffering) {
            if (this.current.sendAudio(data)) {
                this.lastAudioAt = this.now();
                this.armKeepalive();
                this.checkRotation();
                return;
            }
        }
        if (this.buffering) {
            this.pushBuffer(data);
            return;
        }
        // No upstream yet (before start/ack): dropped, as before.
        this.stats.droppedFrames += 1;
    }

    // ---- audio buffer (used only while no upstream can take audio) -------

    pushBuffer(data) {
        const b = this.buffer;
        b.chunks.push(data);
        b.bytes += data.length;
        while (b.bytes > b.capBytes && b.chunks.length > 1) {
            const dropped = b.chunks.shift();
            b.bytes -= dropped.length;
            b.droppedBytes += dropped.length;
        }
    }

    flushBuffer(up) {
        const b = this.buffer;
        if (!b.chunks.length) return 0;
        let sent = 0;
        for (const chunk of b.chunks) {
            if (up.sendAudio(chunk)) sent += chunk.length;
        }
        this.log(`${this.tag} flushed ${b.chunks.length} buffered audio frames (${sent} bytes) to stream ${up.index}`);
        b.chunks = [];
        b.bytes = 0;
        return sent;
    }

    // ---- start / upstream creation ---------------------------------------

    handleStart(config) {
        this.clientConfig = config;
        this.translationConfigured = !!(config.translation && config.translation.target_language);
        const bps = bytesPerSecond(config) || 32000;
        this.buffer.capBytes = Math.max(1, Math.round((this.config.audioBufferMs / 1000) * bps));
        this.log(`${this.tag} start: model=${config.model || '-'} hints=${JSON.stringify(config.language_hints || null)} `
            + `translation=${this.translationConfigured ? (config.translation.target_language) : 'off'} endpointing=${config.enable_endpoint_detection !== false}`);

        if (!this.current && !this.pending && !this.restart.timer) {
            this.lastStartDialAt = this.now();
            this.openFirstUpstream();
            return;
        }
        // A repeated start. Both clients send one start per socket, so a
        // repeat is a client stuck in a loop or a deliberate config change.
        // Identical to what is live, dialing, or already scheduled: nothing
        // to do. Different: one replacement dial, at most one per
        // minDialIntervalMs, carrying whatever config arrived last.
        const live = this.pending || this.current;
        const target = this.restart.config || (live ? live.clientConfig : null);
        if (sameConfig(target, config)) {
            this.stats.suppressedStarts += 1;
            if (this.stats.suppressedStarts === 1 || this.stats.suppressedStarts % 50 === 0) {
                this.log(`${this.tag} start suppressed: identical config (${this.stats.suppressedStarts} so far)`);
            }
            return;
        }
        this.scheduleRestart(config);
    }

    scheduleRestart(config) {
        this.restart.config = config;
        if (this.restart.timer) {
            this.log(`${this.tag} start coalesced into the scheduled restart`);
            return;
        }
        const wait = Math.max(0, this.lastStartDialAt + this.config.minDialIntervalMs - this.now());
        this.log(`${this.tag} start received again with a new config; replacing upstream in ${wait} ms`);
        this.restart.timer = setTimeout(() => {
            this.restart.timer = null;
            const latest = this.restart.config;
            this.restart.config = null;
            if (this.closed || !latest) return;
            this.clientConfig = latest;
            this.translationConfigured = !!(latest.translation && latest.translation.target_language);
            this.lastStartDialAt = this.now();
            this.replaceUpstream('restart');
        }, wait);
    }

    newUpstream() {
        this.streamCount += 1;
        const up = new Upstream({
            url: this.config.wsUrl,
            apiKey: this.apiKey,
            clientConfig: this.clientConfig,
            connectionId: this.connectionId,
            index: this.streamCount,
            options: {
                langId: this.config.langId,
                strictHints: this.config.strictHints,
                ackTimeoutMs: this.config.ackTimeoutMs,
                summaryMs: this.config.summaryMs,
            },
            log: this.log,
            now: this.now,
        });
        up.on('frame', (info) => this.handleUpstreamFrame(up, info));
        up.on('close', (info) => this.handleUpstreamClose(up, info));
        return up;
    }

    // Dials a new upstream as `pending`. Resolves true on ack (pending stays
    // set until adopted), false on failure (pending cleared). A newer dial or
    // destroy() supersedes an older one; the older socket is closed.
    async dialPending(reason) {
        const up = this.newUpstream();
        this.pending = up;
        this.log(`${this.tag} dialing stream ${up.index} (${reason})`);
        let ok = false;
        let error = null;
        try {
            await up.dial();
            ok = true;
        } catch (err) {
            error = err;
        }
        if (this.closed || this.pending !== up) {
            up.close();
            return { ok: false, up, error: error || new Error('superseded'), superseded: true };
        }
        if (!ok) {
            this.pending = null;
            this.log(`${this.tag} stream ${up.index} failed (${reason}): ${error.message}`);
            return { ok: false, up, error, superseded: false };
        }
        return { ok: true, up, error: null, superseded: false };
    }

    async openFirstUpstream() {
        const result = await this.dialPending('start');
        if (result.superseded) return;
        if (!result.ok) {
            this.failClient(result.error);
            return;
        }
        this.adopt(result.up, null);
    }

    // Takes a pending, acked upstream live: audio goes to it from now on.
    adopt(up, notice) {
        if (this.closed) { up.close(); return; }
        if (this.pending === up) this.pending = null;
        this.stopPendingKeepalive();
        this.current = up;
        this.buffering = false;
        this.stall = this.freshStallState();
        this.resetRotationForNewStream();
        this.flushBuffer(up);
        this.lastAudioAt = this.now();
        this.armKeepalive();
        this.startRotationTick();
        this.log(`${this.tag} stream ${up.index} is live`);

        if (!this.proxyReadySent) {
            this.proxyReadySent = true;
            this.log(`${this.tag} Soniox acknowledged config, sending proxy_ready to client`);
            this.sendToClient({ type: 'proxy_ready', connection_id: this.connectionId });
            if (up.firstAckRaw) this.sendRawToClient(up.firstAckRaw);
        }
        if (notice) this.sendNotice(notice.event, notice.extra || {});
    }

    // Retires the old current stream. If the pending stream has acked it is
    // adopted now; otherwise audio is buffered until it does.
    commit() {
        const old = this.current;
        this.current = null;
        this.stopStreamTimers();
        if (old) this.retire(old);
        if (this.pending && this.pending.acked) {
            this.adopt(this.pending, this.takeAdoptNotice());
        } else {
            this.buffering = true;
        }
    }

    takeAdoptNotice() {
        const n = this.adoptNotice;
        this.adoptNotice = null;
        return n;
    }

    // finalize -> forward the tail (up to finalizeTailMs or <fin>) -> empty
    // text frame -> wait for finished (up to endGraceMs) -> close.
    async retire(old) {
        this.retiring.add(old);
        try {
            if (old.isOpen) {
                old.sendFinalize();
                await old.waitFor('fin', this.config.finalizeTailMs);
            }
            if (old.isOpen) {
                old.sendEnd();
                await old.waitFor('finished', this.config.endGraceMs);
            }
        } finally {
            this.retiring.delete(old);
            old.close();
        }
    }

    failClient(err) {
        const code = (err && err.errorCode) || 1011;
        const message = (err && err.message) || 'Soniox upstream failed';
        this.log(`${this.tag} upstream failed for good: ${message}`);
        this.sendToClient({ type: 'error', code, message: `Soniox upstream failed: ${message}` });
        try { this.clientWs.close(1011, 'upstream failed'); } catch (e) { /* ignore */ }
        this.destroy('upstream_failed');
    }

    // ---- upstream events -------------------------------------------------

    handleUpstreamFrame(up, info) {
        if (this.closed) return;
        if (info.isAck) {
            // The first stream's ack frame reaches the client after proxy_ready,
            // as it always has. Later acks carry nothing the client needs.
            if (up.index === 1) up.firstAckRaw = info.raw;
            return;
        }
        if (up === this.current) {
            if (info.isError) {
                const type = info.frame && info.frame.error_type;
                // max_duration_reached is handled by the close that follows it.
                if (type !== 'max_duration_reached') this.sendRawToClient(info.raw);
                return;
            }
            this.sendRawToClient(info.raw);
            if (info.tokens.length) this.observeTokens(info.tokens);
            return;
        }
        if (this.retiring.has(up)) {
            if (!info.isError && info.tokens.length) this.sendRawToClient(info.raw);
            return;
        }
        // Frames from a pending stream before adoption: nothing to forward.
    }

    handleUpstreamClose(up, info) {
        if (this.closed) return;
        if (this.retiring.has(up)) { this.retiring.delete(up); return; }
        if (up === this.pending) {
            if (!up.acked) return; // the dial promise reports it
            // Acked but not yet adopted (rotation waiting for its trigger) and
            // gone again: forget it, and re-dial if nothing is live.
            this.pending = null;
            this.stopPendingKeepalive();
            this.log(`${this.tag} pending stream ${up.index} closed before adoption (code ${info.code})`);
            if (this.rotation.phase === 'predial') {
                this.scheduleRotationRetry(`pending stream ${up.index} closed`);
            }
            if (!this.current) {
                this.rotation.phase = 'none';
                this.recover(`pending_closed_${info.code}`, false);
            }
            return;
        }
        if (up !== this.current) return;

        this.current = null;
        this.stopStreamTimers();
        this.buffering = true;
        const maxDuration = !!(info.lastErrorFrame && info.lastErrorFrame.error_type === 'max_duration_reached');
        if (maxDuration) {
            this.log(`${this.tag} stream ${up.index} hit max_duration_reached (missed rotation), recycling immediately`);
        } else {
            this.log(`${this.tag} stream ${up.index} lost (code ${info.code}), re-dialing`);
        }
        if (this.pending) {
            if (this.rotation.phase === 'predial') {
                // The rotation's commit point has arrived the hard way: the
                // old stream is gone, so the replacement is the switch target.
                const minutes = Math.round(up.elapsedMinutes() * 100) / 100;
                this.rotation.minutes = minutes;
                this.rotation.phase = 'switching';
                this.adoptNotice = { event: 'stream_rotated', extra: { minutes } };
            }
            if (this.pending.acked) {
                // Already acked and waiting for a trigger that can no longer
                // come from the old stream: take it live now.
                this.log(`${this.tag} adopting acked pending stream ${this.pending.index} after stream ${up.index} was lost`);
                this.adopt(this.pending, this.takeAdoptNotice() || { event: 'stream_recycled' });
                return;
            }
            // Still dialing: its continuation adopts on ack (nothing is
            // current) and falls into recover() on failure.
            return;
        }
        this.recover(maxDuration ? 'max_duration_reached' : `upstream_closed_${info.code}`, maxDuration);
    }

    // Re-dial after the current stream died: immediately for a missed
    // rotation, then after the configured delays. Audio is buffered meanwhile.
    async recover(reason, immediate) {
        if (this.recovering || this.closed) return;
        this.recovering = true;
        const delays = immediate ? [0, ...this.config.redialDelaysMs] : [...this.config.redialDelaysMs];
        let lastError = null;
        try {
            for (let i = 0; i < delays.length; i += 1) {
                if (delays[i] > 0) await sleep(delays[i]);
                if (this.closed) return;
                if (this.current) return; // something else took over
                const result = await this.dialPending(`${reason} attempt ${i + 1}/${delays.length}`);
                if (result.superseded || this.closed) return;
                if (result.ok) {
                    this.adopt(result.up, { event: 'stream_recycled' });
                    return;
                }
                lastError = result.error;
                if (lastError && lastError.retryable === false) break;
            }
            this.failClient(lastError);
        } finally {
            this.recovering = false;
        }
    }

    // ---- switch flavors --------------------------------------------------

    // Stall recycle and second-start replacement: dial, wait for the ack, then
    // switch. The old stream keeps receiving audio until the ack.
    async replaceUpstream(kind) {
        if (this.closed) return false;
        if (this.pending) {
            if (kind !== 'restart') {
                this.log(`${this.tag} ${kind} skipped: a switch is already in progress`);
                return false;
            }
            // A new start carries a new config: the in-flight dial is stale.
            const stale = this.pending;
            this.pending = null;
            this.stopPendingKeepalive();
            this.rotation.phase = 'none';
            if (this.rotation.quietTimer) { clearTimeout(this.rotation.quietTimer); this.rotation.quietTimer = null; }
            stale.close();
        }
        const t0 = this.now();
        const result = await this.dialPending(kind);
        if (result.superseded || this.closed) return false;
        if (!result.ok) {
            if (!this.current) this.recover(`${kind} dial failed`, false);
            return false;
        }
        const overlap = this.now() - t0;
        if (overlap > this.config.overlapWarnMs) this.log(`${this.tag} ${kind}: ack wait overlapped ${overlap} ms`);
        this.adoptNotice = { event: 'stream_recycled' };
        this.commit();
        return true;
    }

    // ---- keepalive during audio silence ----------------------------------

    armKeepalive() {
        if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
        const ms = this.config.keepaliveMs;
        if (!(ms > 0)) return;
        this.keepaliveTimer = setTimeout(() => this.onKeepaliveTimer(), ms);
    }

    onKeepaliveTimer() {
        this.keepaliveTimer = null;
        if (this.closed || !this.current || !this.current.isOpen) return;
        const idle = this.now() - (this.lastAudioAt || 0);
        if (idle >= this.config.keepaliveMs - 1) {
            this.current.sendKeepalive();
        }
        this.armKeepalive();
    }

    // A pre-dialed rotation stream can sit acked and idle for many seconds of
    // continuous speech before its commit trigger. Soniox closes a stream
    // that gets neither audio nor keepalive for 20 s, so it is kept alive on
    // the same interval until it is adopted or dropped.
    armPendingKeepalive(up) {
        this.stopPendingKeepalive();
        const ms = this.config.keepaliveMs;
        if (!(ms > 0)) return;
        this.pendingKeepaliveTimer = setInterval(() => {
            if (this.closed || this.pending !== up || !up.isOpen) { this.stopPendingKeepalive(); return; }
            up.sendKeepalive();
        }, ms);
    }

    stopPendingKeepalive() {
        if (this.pendingKeepaliveTimer) { clearInterval(this.pendingKeepaliveTimer); this.pendingKeepaliveTimer = null; }
    }

    stopStreamTimers() {
        if (this.keepaliveTimer) { clearTimeout(this.keepaliveTimer); this.keepaliveTimer = null; }
        if (this.stall.gapTimer) { clearTimeout(this.stall.gapTimer); this.stall.gapTimer = null; }
        if (this.rotation.quietTimer) { clearTimeout(this.rotation.quietTimer); this.rotation.quietTimer = null; }
        if (this.rotation.backstopTimer) { clearTimeout(this.rotation.backstopTimer); this.rotation.backstopTimer = null; }
    }

    // ---- stall watchdog --------------------------------------------------

    freshStallState() {
        return { seg: null, lastClosed: null, streak: 0, gapTimer: null, startedAt: this.now() };
    }

    get watchdogActive() {
        return this.config.stallWatchdog && this.translationConfigured && !this.unavailableSent;
    }

    observeTokens(tokens) {
        const watch = this.watchdogActive;
        let sawToken = false;
        for (const token of tokens) {
            if (!token || typeof token !== 'object') continue;
            const text = token.text;
            if (text === '<end>') {
                this.onEndpoint();
                continue;
            }
            sawToken = true;
            if (!watch) continue;
            const status = token.translation_status || 'original';
            if (status === 'translation') {
                this.onTranslationToken();
            } else if (token.is_final && (status === 'original' || (status === 'none' && this.config.stallCountNone))) {
                // "none" is Soniox's tag for speech it judged outside the
                // configured pair: captions flow, no translation follows,
                // which is exactly the stall shape this watchdog exists for.
                this.onFinalOriginalToken();
            }
        }
        if (sawToken) {
            if (watch) this.armSegmentGap();
            this.armRotationQuiet();
        }
    }

    onFinalOriginalToken() {
        const s = this.stall;
        if (!s.seg) {
            this.evaluateClosedSegment();
            s.seg = { hadOriginal: true, hadTranslation: false };
        } else {
            s.seg.hadOriginal = true;
        }
    }

    onTranslationToken() {
        const s = this.stall;
        if (s.seg) s.seg.hadTranslation = true;
        else if (s.lastClosed) s.lastClosed.hadTranslation = true;
    }

    onEndpoint() {
        if (this.watchdogActive) this.closeSegment();
        if (this.rotation.phase === 'predial') this.commitRotation('endpoint');
    }

    armSegmentGap() {
        const s = this.stall;
        if (s.gapTimer) clearTimeout(s.gapTimer);
        s.gapTimer = setTimeout(() => {
            s.gapTimer = null;
            this.closeSegment();
        }, this.config.segmentGapMs);
    }

    closeSegment() {
        const s = this.stall;
        if (s.gapTimer) { clearTimeout(s.gapTimer); s.gapTimer = null; }
        if (!s.seg) return;
        s.lastClosed = s.seg;
        s.seg = null;
    }

    // A closed segment is judged when the next one begins, so a translation
    // that trails its <end> still counts for the segment it belongs to.
    evaluateClosedSegment() {
        const s = this.stall;
        const seg = s.lastClosed;
        if (!seg) return;
        s.lastClosed = null;
        if (!seg.hadOriginal) return;
        if (seg.hadTranslation) { s.streak = 0; return; }
        s.streak += 1;
        if (s.streak < this.config.stallSegments) return;
        const up = this.current;
        const lastTrans = up && up.counters.lastTranslationAt !== null ? up.counters.lastTranslationAt : s.startedAt;
        if (this.now() - lastTrans < this.config.stallQuietMs) return;
        s.streak = 0;
        this.declareStall();
    }

    declareStall() {
        const up = this.current;
        const now = this.now();
        this.log(`[stall] ${up ? up.summaryLine() : this.tag} segments=${this.config.stallSegments} recyclesInWindow=${this.recyclesInWindow(now)}`);
        if (this.recyclesInWindow(now) >= this.config.recycleMax) {
            if (!this.unavailableSent) {
                this.unavailableSent = true;
                this.sendNotice('translation_unavailable');
            }
            return;
        }
        if (this.lastRecycleAt !== null && now - this.lastRecycleAt < this.config.recycleMinIntervalMs) {
            this.log(`${this.tag} recycle suppressed: last recycle ${now - this.lastRecycleAt} ms ago`);
            return;
        }
        if (this.pending) {
            this.log(`${this.tag} recycle suppressed: a switch is in progress`);
            return;
        }
        this.lastRecycleAt = now;
        this.recycleTimes.push(now);
        this.sendNotice('translation_stalled');
        this.replaceUpstream('stall recycle');
    }

    recyclesInWindow(now) {
        const cutoff = now - this.config.recycleWindowMs;
        this.recycleTimes = this.recycleTimes.filter((t) => t >= cutoff);
        return this.recycleTimes.length;
    }

    // ---- rotation before the 300 minute cap ------------------------------

    resetRotationForNewStream() {
        if (this.rotation.quietTimer) { clearTimeout(this.rotation.quietTimer); this.rotation.quietTimer = null; }
        if (this.rotation.backstopTimer) { clearTimeout(this.rotation.backstopTimer); this.rotation.backstopTimer = null; }
        this.rotation.phase = 'none';
        this.rotation.retryAfter = 0;
        this.rotation.failures = 0;
        this.rotation.waitLogged = false;
        if (!this.config.rotation || !this.current) return;
        const up = this.current;
        const sinceOpen = this.now() - (up.openedAt || this.now());
        const backstopMs = Math.max(0, this.config.rotateBackstopMin * 60000 - sinceOpen);
        this.rotation.backstopTimer = setTimeout(() => {
            this.rotation.backstopTimer = null;
            if (this.current !== up || this.closed) return;
            this.log(`${this.tag} rotation backstop fired for stream ${up.index}`);
            if (this.rotation.phase === 'none') this.startRotation('backstop');
            if (this.rotation.phase === 'predial') this.commitRotation('backstop');
        }, backstopMs);
    }

    startRotationTick() {
        if (this.rotation.tick || !this.config.rotation) return;
        this.rotation.tick = setInterval(() => this.checkRotation(), this.config.rotationTickMs);
    }

    checkRotation() {
        if (!this.config.rotation || this.closed || !this.current) return;
        const minutes = this.current.elapsedMinutes();
        if (this.rotation.phase === 'predial') {
            if (minutes >= this.config.rotateHardMin) this.commitRotation('hard mark');
            return;
        }
        if (this.rotation.phase !== 'none' || this.pending) return;
        if (minutes >= this.config.rotateHardMin) {
            // The hard mark ignores the soft retry backoff: by now the stream
            // must go regardless of how the pre-dials went.
            this.startRotation('hard mark');
            if (this.rotation.phase === 'predial') this.commitRotation('hard mark');
        } else if (minutes >= this.config.rotateSoftMin && this.now() >= this.rotation.retryAfter) {
            this.startRotation('soft mark');
        }
    }

    // A failed soft pre-dial keeps the healthy old stream and tries again
    // with exponential backoff (5 s, 10 s, 20 s, ... capped) until the hard
    // mark takes over.
    scheduleRotationRetry(why) {
        this.rotation.phase = 'none';
        if (this.rotation.quietTimer) { clearTimeout(this.rotation.quietTimer); this.rotation.quietTimer = null; }
        this.rotation.failures += 1;
        const wait = Math.min(this.config.rotateRetryMs * (2 ** (this.rotation.failures - 1)), this.config.rotateRetryMaxMs);
        this.rotation.retryAfter = this.now() + wait;
        this.log(`${this.tag} rotation pre-dial failed (${why}); old stream kept, retry ${this.rotation.failures} in ${wait} ms`);
    }

    // Pre-dial the replacement; audio keeps flowing to the old stream until
    // the commit point (next endpoint, quiet window, hard mark, or backstop).
    startRotation(trigger) {
        if (this.rotation.phase !== 'none' || this.pending || !this.current) return;
        const old = this.current;
        this.rotation.phase = 'predial';
        this.rotation.startedAt = this.now();
        this.rotation.waitLogged = false;
        this.log(`${this.tag} rotation started (${trigger}) at ${old.elapsedMinutes().toFixed(2)} min on stream ${old.index}`);
        this.dialPending('rotation').then((result) => {
            if (result.superseded || this.closed) return;
            if (!result.ok) {
                if (this.rotation.phase === 'switching' || !this.current) {
                    // Already committed (or the old stream died): nothing is
                    // live, so fall into the re-dial ladder.
                    this.rotation.phase = 'none';
                    this.recover('rotation dial failed', false);
                } else {
                    // The old stream is still fine: keep it, back off, retry.
                    this.scheduleRotationRetry(result.error ? result.error.message : 'dial failed');
                }
                return;
            }
            const overlap = this.now() - this.rotation.startedAt;
            if (overlap > this.config.overlapWarnMs) this.log(`${this.tag} rotation: two upstreams overlapped ${overlap} ms`);
            if (this.rotation.phase === 'switching' || !this.current) {
                // Commit already happened; adopt now and flush the buffer.
                this.adopt(result.up, this.takeAdoptNotice() || { event: 'stream_rotated', extra: { minutes: this.rotation.minutes } });
                return;
            }
            // Acked and waiting for the commit trigger: the next endpoint, or
            // rotateQuietMs without tokens counted from this ack. Keep the
            // idle replacement alive meanwhile.
            this.armPendingKeepalive(result.up);
            this.armRotationQuiet();
        });
    }

    armRotationQuiet() {
        if (this.rotation.phase !== 'predial') return;
        if (this.rotation.quietTimer) clearTimeout(this.rotation.quietTimer);
        this.rotation.quietTimer = setTimeout(() => {
            this.rotation.quietTimer = null;
            if (this.rotation.phase === 'predial') this.commitRotation('quiet');
        }, this.config.rotateQuietMs);
    }

    commitRotation(trigger) {
        if (this.rotation.phase !== 'predial' || !this.current) return;
        const acked = !!(this.pending && this.pending.acked);
        const forced = trigger === 'hard mark' || trigger === 'backstop';
        if (!acked && !forced) {
            // An endpoint or quiet window never retires a healthy stream for a
            // replacement that has not acked (or was refused): keep waiting.
            if (!this.rotation.waitLogged) {
                this.rotation.waitLogged = true;
                this.log(`${this.tag} rotation commit (${trigger}) deferred: replacement not acked yet`);
            }
            return;
        }
        const old = this.current;
        const minutes = Math.round(old.elapsedMinutes() * 100) / 100;
        this.rotation.minutes = minutes;
        this.rotation.phase = 'switching';
        this.log(`${this.tag} rotation commit (${trigger}) at ${minutes} min on stream ${old.index}`);
        this.adoptNotice = { event: 'stream_rotated', extra: { minutes } };
        this.commit();
    }
}
