import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config();

// Configuration from environment variables
const PORT = process.env.PORT || 8080;
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Validate required environment variables
if (!SONIOX_API_KEY) {
    console.error('ERROR: SONIOX_API_KEY environment variable is required');
    process.exit(1);
}

if (!OPENAI_API_KEY) {
    console.error('ERROR: OPENAI_API_KEY environment variable is required');
    process.exit(1);
}

if (!DEEPGRAM_API_KEY) {
    console.error('WARNING: DEEPGRAM_API_KEY not configured - Deepgram TTS will not be available');
}

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_ANON_KEY environment variables are required');
    process.exit(1);
}

// Initialize Supabase client for JWT verification
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Create HTTP server
const server = createServer(async (req, res) => {
    // CORS headers for all requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    // Health check endpoint
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'healthy', 
            service: 'soniox-proxy',
            timestamp: new Date().toISOString()
        }));
        return;
    }
    
    // DEPRECATED: OpenAI TTS token endpoint - returns raw API key (INSECURE)
    // Use /api/openai/ephemeral-token instead - scheduled for removal 2026-04-01
    if (req.url === '/openai/token' && req.method === 'POST') {
        console.warn(`[DEPRECATED] /openai/token endpoint called - clients should migrate to /api/openai/ephemeral-token`);
        try {
            // Get authorization header
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: No token provided' }));
                return;
            }
            
            const token = authHeader.substring(7);
            
            // Verify JWT with Supabase
            const { data: { user }, error } = await supabase.auth.getUser(token);
            
            if (error || !user) {
                console.log('OpenAI token request: Auth failed:', error?.message || 'Invalid token');
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Invalid token' }));
                return;
            }
            
            console.log(`[DEPRECATED] OpenAI token issued for user: ${user.id} - migrate to /api/openai/ephemeral-token`);
            
            // Return the OpenAI API key (DEPRECATED - exposes raw key)
            res.writeHead(200, { 
                'Content-Type': 'application/json',
                'X-Deprecated': 'This endpoint is deprecated. Use /api/openai/ephemeral-token instead.'
            });
            res.end(JSON.stringify({ 
                api_key: OPENAI_API_KEY,
                expires_in: 3600,
                deprecated: true,
                migration_notice: 'Use /api/openai/ephemeral-token for better security'
            }));
            return;
        } catch (err) {
            console.error('OpenAI token error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
            return;
        }
    }
    
    // OpenAI Ephemeral Token endpoint - MORE SECURE: returns short-lived token, real key never leaves server
    if (req.url === '/api/openai/ephemeral-token' && req.method === 'POST') {
        try {
            // Get authorization header
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: No token provided' }));
                return;
            }
            
            const token = authHeader.substring(7);
            
            // Verify JWT with Supabase
            const { data: { user }, error } = await supabase.auth.getUser(token);
            
            if (error || !user) {
                console.log('OpenAI ephemeral token: Auth failed:', error?.message || 'Invalid token');
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Invalid token' }));
                return;
            }
            
            // Parse request body for voice/model preferences
            let body = '';
            req.on('data', chunk => { body += chunk; });
            await new Promise(resolve => req.on('end', resolve));
            
            let params = {};
            try { params = JSON.parse(body || '{}'); } catch (e) {}
            
            const requestedVoice = params.voice || 'nova';
            const model = params.model || 'gpt-4o-realtime-preview-2024-12-17';
            
            // The Realtime Sessions API supports a different voice set than /v1/audio/speech.
            // Map standard TTS voices to their Realtime equivalents so both clients work.
            const REALTIME_VOICE_MAP = {
                'nova': 'coral',
                'shimmer': 'shimmer',
                'alloy': 'alloy',
                'echo': 'echo',
                'fable': 'sage',
                'onyx': 'ash',
            };
            const VALID_REALTIME_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
            const voice = VALID_REALTIME_VOICES.includes(requestedVoice) 
                ? requestedVoice 
                : (REALTIME_VOICE_MAP[requestedVoice] || 'coral');
            
            console.log(`OpenAI ephemeral token request for user: ${user.id}, voice: ${requestedVoice} -> ${voice}`);
            
            // Request ephemeral key from OpenAI Realtime API
            const openaiResponse = await fetch('https://api.openai.com/v1/realtime/sessions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: model,
                    voice: voice,
                    modalities: ['text', 'audio'],
                }),
            });
            
            if (!openaiResponse.ok) {
                const errorData = await openaiResponse.json().catch(() => ({}));
                console.error('OpenAI ephemeral key error:', errorData);
                
                // If ephemeral endpoint doesn't exist, fall back to API key (less secure)
                if (openaiResponse.status === 404) {
                    console.log('Ephemeral endpoint not available, falling back to API key');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        ephemeralKey: OPENAI_API_KEY,
                        model: model,
                        voice: voice,
                        fallback: true
                    }));
                    return;
                }
                
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to create OpenAI session' }));
                return;
            }
            
            const sessionData = await openaiResponse.json();
            console.log(`OpenAI ephemeral token issued for user: ${user.id}`);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ephemeralKey: sessionData.client_secret?.value || sessionData.api_key,
                model: model,
                voice: voice,
                expiresAt: sessionData.client_secret?.expires_at,
            }));
            return;
        } catch (err) {
            console.error('OpenAI ephemeral token error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
            return;
        }
    }
    
    // Soniox token endpoint for web clients (returns proxy URL, not API key)
    if (req.url === '/api/soniox/token' && req.method === 'POST') {
        try {
            // Get authorization header
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: No token provided' }));
                return;
            }
            
            const token = authHeader.substring(7);
            
            // Verify JWT with Supabase
            const { data: { user }, error } = await supabase.auth.getUser(token);
            
            if (error || !user) {
                console.log('Soniox token: Auth failed:', error?.message || 'Invalid token');
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Invalid token' }));
                return;
            }
            
            console.log(`Soniox proxy access granted for user: ${user.id}`);
            
            // Return the proxy WebSocket URL (client connects to proxy, not directly to Soniox)
            // This way the API key NEVER leaves the server
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                useProxy: true,
                proxyUrl: 'wss://selah-proxy-ffrw7.ondigitalocean.app',
                // Client should append ?token=THEIR_JWT to the URL
                message: 'Connect to proxyUrl with your JWT token as query param'
            }));
            return;
        } catch (err) {
            console.error('Soniox token error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
            return;
        }
    }
    
    // OpenAI TTS endpoint - converts text to speech using OpenAI's audio/speech API
    // Returns audio data directly (mp3 format)
    if (req.url === '/api/openai/tts' && req.method === 'POST') {
        try {
            // Get authorization header
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: No token provided' }));
                return;
            }
            
            const token = authHeader.substring(7);
            
            // Verify JWT with Supabase
            const { data: { user }, error } = await supabase.auth.getUser(token);
            
            if (error || !user) {
                console.log('OpenAI TTS: Auth failed:', error?.message || 'Invalid token');
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Invalid token' }));
                return;
            }
            
            // Parse request body
            let body = '';
            req.on('data', chunk => { body += chunk; });
            await new Promise(resolve => req.on('end', resolve));
            
            let params = {};
            try { params = JSON.parse(body || '{}'); } catch (e) {}
            
            const text = params.text || params.input;
            const voice = params.voice || 'nova';
            const model = params.model || 'tts-1';
            const speed = params.speed || 1.0;
            
            if (!text) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: text' }));
                return;
            }
            
            console.log(`OpenAI TTS request for user: ${user.id}, voice: ${voice}, text length: ${text.length}`);
            
            // Call OpenAI's TTS API
            const openaiResponse = await fetch('https://api.openai.com/v1/audio/speech', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: model,
                    input: text,
                    voice: voice,
                    speed: speed,
                    response_format: 'mp3',
                }),
            });
            
            if (!openaiResponse.ok) {
                const errorText = await openaiResponse.text();
                console.error('OpenAI TTS error:', openaiResponse.status, errorText);
                res.writeHead(openaiResponse.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'OpenAI TTS failed: ' + errorText }));
                return;
            }
            
            // Stream the audio response back to client
            const audioData = await openaiResponse.arrayBuffer();
            console.log(`OpenAI TTS success for user: ${user.id}, audio size: ${audioData.byteLength} bytes`);
            
            res.writeHead(200, { 
                'Content-Type': 'audio/mpeg',
                'Content-Length': audioData.byteLength,
            });
            res.end(Buffer.from(audioData));
            return;
        } catch (err) {
            console.error('OpenAI TTS error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
            return;
        }
    }
    
    // Deepgram TTS endpoint - converts text to speech using Deepgram's Aura voices
    // More cost-effective and faster than OpenAI for real-time streaming
    if (req.url === '/api/deepgram/tts' && req.method === 'POST') {
        try {
            if (!DEEPGRAM_API_KEY) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Deepgram TTS not configured' }));
                return;
            }
            
            // Get authorization header
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: No token provided' }));
                return;
            }
            
            const token = authHeader.substring(7);
            
            // Verify JWT with Supabase
            const { data: { user }, error } = await supabase.auth.getUser(token);
            
            if (error || !user) {
                console.log('Deepgram TTS: Auth failed:', error?.message || 'Invalid token');
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Invalid token' }));
                return;
            }
            
            // Parse request body
            let body = '';
            req.on('data', chunk => { body += chunk; });
            await new Promise(resolve => req.on('end', resolve));
            
            let params = {};
            try { params = JSON.parse(body || '{}'); } catch (e) {}
            
            const text = params.text || params.input;
            // Deepgram Aura voices: aura-asteria-en, aura-luna-en, aura-stella-en, aura-athena-en, aura-hera-en, aura-orion-en, aura-arcas-en, aura-perseus-en, aura-angus-en, aura-orpheus-en, aura-helios-en, aura-zeus-en
            const model = params.model || 'aura-asteria-en';
            const encoding = params.encoding || 'mp3';
            
            if (!text) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: text' }));
                return;
            }
            
            console.log(`Deepgram TTS request for user: ${user.id}, model: ${model}, text length: ${text.length}`);
            
            // Call Deepgram's TTS API
            // API: https://api.deepgram.com/v1/speak?model={model}&encoding={encoding}
            const deepgramUrl = `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&encoding=${encoding}`;
            
            const deepgramResponse = await fetch(deepgramUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Token ${DEEPGRAM_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ text }),
            });
            
            if (!deepgramResponse.ok) {
                const errorText = await deepgramResponse.text();
                console.error('Deepgram TTS error:', deepgramResponse.status, errorText);
                res.writeHead(deepgramResponse.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Deepgram TTS failed: ' + errorText }));
                return;
            }
            
            // Stream the audio response back to client
            const audioData = await deepgramResponse.arrayBuffer();
            console.log(`Deepgram TTS success for user: ${user.id}, audio size: ${audioData.byteLength} bytes`);
            
            // Content type based on encoding
            const contentType = encoding === 'mp3' ? 'audio/mpeg' : 
                               encoding === 'wav' ? 'audio/wav' :
                               encoding === 'opus' ? 'audio/opus' :
                               encoding === 'flac' ? 'audio/flac' : 'audio/mpeg';
            
            res.writeHead(200, { 
                'Content-Type': contentType,
                'Content-Length': audioData.byteLength,
            });
            res.end(Buffer.from(audioData));
            return;
        } catch (err) {
            console.error('Deepgram TTS error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
            return;
        }
    }
    
    // OpenAI TTS endpoint - converts text to speech using OpenAI's voices
    if (req.url === '/api/openai/tts' && req.method === 'POST') {
        try {
            if (!OPENAI_API_KEY) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'OpenAI TTS not configured' }));
                return;
            }
            
            // Get authorization header
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: No token provided' }));
                return;
            }
            
            const token = authHeader.substring(7);
            
            // Verify JWT with Supabase
            const { data: { user }, error } = await supabase.auth.getUser(token);
            
            if (error || !user) {
                console.log('OpenAI TTS: Auth failed:', error?.message || 'Invalid token');
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Invalid token' }));
                return;
            }
            
            // Parse request body
            let body = '';
            req.on('data', chunk => { body += chunk; });
            await new Promise(resolve => req.on('end', resolve));
            
            let params = {};
            try { params = JSON.parse(body || '{}'); } catch (e) {}
            
            const text = params.text || params.input;
            // OpenAI voices: alloy, echo, fable, onyx, nova, shimmer
            const voice = params.voice || 'nova';
            const model = params.model || 'tts-1';
            const responseFormat = params.response_format || 'mp3';
            // Speed: 0.25 to 4.0, default 1.1 for slightly faster playback
            const speed = Math.min(4.0, Math.max(0.25, parseFloat(params.speed) || 1.1));
            
            if (!text) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: text' }));
                return;
            }
            
            console.log(`OpenAI TTS request for user: ${user.id}, voice: ${voice}, model: ${model}, speed: ${speed}, text length: ${text.length}`);
            
            // Call OpenAI's TTS API
            const openaiResponse = await fetch('https://api.openai.com/v1/audio/speech', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: model,
                    input: text,
                    voice: voice,
                    speed: speed,
                    response_format: responseFormat,
                }),
            });
            
            if (!openaiResponse.ok) {
                const errorText = await openaiResponse.text();
                console.error('OpenAI TTS error:', openaiResponse.status, errorText);
                res.writeHead(openaiResponse.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'OpenAI TTS failed: ' + errorText }));
                return;
            }
            
            // Stream the audio response back to client
            const audioData = await openaiResponse.arrayBuffer();
            console.log(`OpenAI TTS success for user: ${user.id}, audio size: ${audioData.byteLength} bytes`);
            
            // Content type based on format
            const contentType = responseFormat === 'mp3' ? 'audio/mpeg' : 
                               responseFormat === 'opus' ? 'audio/opus' :
                               responseFormat === 'aac' ? 'audio/aac' :
                               responseFormat === 'flac' ? 'audio/flac' : 'audio/mpeg';
            
            res.writeHead(200, { 
                'Content-Type': contentType,
                'Content-Length': audioData.byteLength,
            });
            res.end(Buffer.from(audioData));
            return;
        } catch (err) {
            console.error('OpenAI TTS error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
            return;
        }
    }
    
    res.writeHead(404);
    res.end('Not Found');
});

// Create WebSocket server
const wss = new WebSocketServer({ server });

// Track active connections
const connections = new Map();

console.log('Selah Translation Proxy Server starting...');
console.log(`Port: ${PORT}`);
console.log(`Supabase URL: ${SUPABASE_URL}`);
console.log(`Soniox API Key: ${SONIOX_API_KEY ? '✓ configured' : '✗ missing'}`);
console.log(`OpenAI API Key: ${OPENAI_API_KEY ? '✓ configured' : '✗ missing'}`);
console.log(`Deepgram API Key: ${DEEPGRAM_API_KEY ? '✓ configured' : '✗ missing'}`);

wss.on('connection', async (clientWs, req) => {
    const connectionId = generateConnectionId();
    console.log(`[${connectionId}] New client connection from ${req.socket.remoteAddress}`);
    
    // Parse auth token from query string (standard for WebSocket auth over wss://).
    // The connection is TLS-encrypted end-to-end so the token is not exposed in transit.
    // Sec-WebSocket-Protocol headers are stripped by DigitalOcean/Cloudflare reverse proxies.
    let token = null;
    const url = new URL(req.url, `http://${req.headers.host}`);
    token = url.searchParams.get('token');
    
    // Fallback: try Sec-WebSocket-Protocol header (for direct connections without reverse proxy)
    if (!token) {
        const protocols = req.headers['sec-websocket-protocol'];
        if (protocols) {
            const protocolParts = protocols.split(',').map(p => p.trim());
            const bearerProtocol = protocolParts.find(p => p.startsWith('Bearer.'));
            if (bearerProtocol) {
                token = bearerProtocol.replace('Bearer.', '');
            }
        }
    }
    
    if (!token) {
        console.log(`[${connectionId}] No token provided, closing connection`);
        sendError(clientWs, 'Unauthorized: No token provided', 401);
        clientWs.close(1008, 'Unauthorized');
        return;
    }
    
    // Verify JWT with Supabase
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        
        if (error || !user) {
            console.log(`[${connectionId}] Auth failed: ${error?.message || 'Invalid token'}`);
            sendError(clientWs, 'Unauthorized: Invalid token', 401);
            clientWs.close(1008, 'Unauthorized');
            return;
        }
        
        // Log authentication success without exposing full email (redact for privacy)
        const emailHint = user.email ? user.email.substring(0, 3) + '***' : 'unknown';
        console.log(`[${connectionId}] User authenticated: ${user.id} (${emailHint})`);
    } catch (err) {
        console.error(`[${connectionId}] Auth error:`, err.message);
        sendError(clientWs, 'Authentication error', 500);
        clientWs.close(1011, 'Auth error');
        return;
    }
    
    // Store connection info
    const connectionInfo = {
        clientWs,
        sonioxWs: null,
        connectionId,
        isReady: false
    };
    connections.set(connectionId, connectionInfo);
    
    // Send immediate acknowledgment so client knows auth passed and server is ready
    console.log(`[${connectionId}] Auth complete, sending auth_success to client`);
    sendToClient(clientWs, {
        type: 'auth_success',
        message: 'Authenticated, ready for start message',
        connectionId: connectionId
    });
    
    // Handle messages from client
    clientWs.on('message', (data, isBinary) => {
        console.log(`[${connectionId}] Received message: isBinary=${isBinary}, type=${typeof data}, length=${data?.length || 0}`);
        handleClientMessage(connectionId, data, isBinary);
    });
    
    // Handle client disconnect
    clientWs.on('close', (code, reason) => {
        console.log(`[${connectionId}] Client disconnected: ${code} ${reason?.toString() || ''}`);
        cleanupConnection(connectionId);
    });
    
    clientWs.on('error', (err) => {
        console.error(`[${connectionId}] Client WebSocket error:`, err.message);
        cleanupConnection(connectionId);
    });
});

function handleClientMessage(connectionId, data, isBinary) {
    const conn = connections.get(connectionId);
    if (!conn) {
        console.log(`[${connectionId}] No connection found for message`);
        return;
    }
    
    // Convert data to string for inspection
    const dataStr = data.toString();
    
    // Check if it looks like JSON (starts with { or [)
    const looksLikeJson = dataStr.startsWith('{') || dataStr.startsWith('[');
    
    // If binary audio data (not JSON), forward to Soniox
    if (isBinary && !looksLikeJson) {
        if (conn.sonioxWs && conn.sonioxWs.readyState === WebSocket.OPEN) {
            conn.sonioxWs.send(data);
            // Don't log every audio packet to reduce noise
        } else {
            // Silently drop audio if Soniox not connected yet
        }
        return;
    }
    
    // Parse JSON message
    let message;
    try {
        message = JSON.parse(dataStr);
        console.log(`[${connectionId}] Parsed JSON message:`, JSON.stringify(message).substring(0, 200));
    } catch (err) {
        console.log(`[${connectionId}] Failed to parse JSON: ${err.message}`);
        console.log(`[${connectionId}] Raw data (first 200 chars):`, dataStr.substring(0, 200));
        return;
    }
    
    // Handle ping/keepalive
    if (message.type === 'ping') {
        console.log(`[${connectionId}] Received ping, sending pong`);
        sendToClient(conn.clientWs, {
            type: 'pong',
            ref: message.ref || 0,
            timestamp: Date.now()
        });
        return;
    }
    
    // Handle start action - connect to Soniox
    if (message.action === 'start') {
        console.log(`[${connectionId}] ✅ Received START action - connecting to Soniox...`);
        const configToUse = message.config || message;
        const translation = configToUse.translation || {};
        console.log(`[${connectionId}] Config structure:`, JSON.stringify({
            hasTranslation: !!configToUse.translation,
            translation: translation,
            targetLang: translation.target_language,
            sourceLang: translation.source_language
        }));
        connectToSoniox(connectionId, configToUse);
        return;
    }
    
    // Handle finalize message - flush pending tokens before language switch
    if (message.type === 'finalize') {
        console.log(`[${connectionId}] 📝 Received FINALIZE - flushing pending tokens...`);
        if (conn.sonioxWs && conn.sonioxWs.readyState === WebSocket.OPEN) {
            // Forward finalize message to Soniox
            conn.sonioxWs.send(JSON.stringify(message));
            console.log(`[${connectionId}] Finalize message forwarded to Soniox`);
        } else {
            console.log(`[${connectionId}] Cannot finalize - Soniox not connected`);
        }
        return;
    }
    
    // Forward other messages to Soniox
    console.log(`[${connectionId}] Forwarding message to Soniox:`, JSON.stringify(message).substring(0, 100));
    if (conn.sonioxWs && conn.sonioxWs.readyState === WebSocket.OPEN) {
        conn.sonioxWs.send(JSON.stringify(message));
    } else {
        console.log(`[${connectionId}] Cannot forward - Soniox not connected (state: ${conn.sonioxWs?.readyState})`);
    }
}

function connectToSoniox(connectionId, config) {
    const conn = connections.get(connectionId);
    if (!conn) {
        console.log(`[${connectionId}] connectToSoniox: No connection found!`);
        return;
    }
    
    // Close existing Soniox connection if any
    if (conn.sonioxWs) {
        console.log(`[${connectionId}] Closing existing Soniox connection`);
        conn.sonioxWs.close();
        conn.sonioxWs = null;
    }
    
    console.log(`[${connectionId}] 🔗 Connecting to Soniox WebSocket...`);
    console.log(`[${connectionId}] Client config:`, JSON.stringify(config).substring(0, 300));
    
    // Connect to Soniox (no auth header - API key goes in config JSON per docs)
    const sonioxWs = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket');
    
    sonioxWs.on('open', () => {
        console.log(`[${connectionId}] Connected to Soniox`);
        conn.sonioxWs = sonioxWs;
        
        // Build Soniox config - API key must be in the JSON config per Soniox docs
        const sonioxConfig = {
            api_key: SONIOX_API_KEY,
            model: config.model || 'stt-rt-preview',
            audio_format: config.audio_format || 'pcm_s16le',
            sample_rate: config.sample_rate || 16000,
            num_channels: config.num_channels || 1,
            include_nonfinal: config.include_nonfinal !== false,
            language_hints: config.language_hints || ['en'],
            // Enable endpoint detection to finalize tokens on speech pauses (reduces hanging)
            enable_endpoint_detection: config.enable_endpoint_detection !== false,
            // Reduce max non-final duration for faster translation output (default is ~4000-6000ms)
            max_non_final_tokens_duration_ms: config.max_non_final_tokens_duration_ms || 4000
        };
        
        // Add translation config if present
        if (config.translation) {
            const targetLang = config.translation.target_language;
            const sourceLang = config.translation.source_language;
            
            if (!targetLang) {
                console.error(`[${connectionId}] ⚠️ Translation config missing target_language!`, JSON.stringify(config.translation));
                console.error(`[${connectionId}] Full config received:`, JSON.stringify(config).substring(0, 500));
            } else {
                console.log(`[${connectionId}] ✅ Translation config - source: ${sourceLang || 'auto'}, target: ${targetLang}`);
                
                sonioxConfig.translation = {
                    type: config.translation.type || 'one_way',
                    target_language: targetLang
                };
                // Add source_language if provided (required for translation to work)
                if (sourceLang) {
                    sonioxConfig.translation.source_language = sourceLang;
                }
                
                console.log(`[${connectionId}] Final Soniox translation config:`, JSON.stringify(sonioxConfig.translation));
            }
        } else {
            console.log(`[${connectionId}] ⚠️ No translation config provided in config object`);
            console.log(`[${connectionId}] Config keys:`, Object.keys(config));
        }
        
        // Send config to Soniox
        sonioxWs.send(JSON.stringify(sonioxConfig));
        console.log(`[${connectionId}] Sent config to Soniox:`, JSON.stringify(sonioxConfig).substring(0, 300));
        
        // Don't send proxy_ready yet - wait for Soniox to acknowledge
        // We'll send it after receiving the first message from Soniox
    });
    
    sonioxWs.on('message', (data) => {
        const dataStr = data.toString();
        console.log(`[${connectionId}] Soniox message:`, dataStr.substring(0, 300));
        
        // If this is the first message (status/ack), send proxy_ready
        if (!conn.isReady) {
            conn.isReady = true;
            console.log(`[${connectionId}] Soniox acknowledged config, sending proxy_ready to client`);
            sendToClient(conn.clientWs, {
                type: 'proxy_ready',
                connection_id: connectionId
            });
        }
        
        // Forward Soniox response to client
        if (conn.clientWs && conn.clientWs.readyState === WebSocket.OPEN) {
            conn.clientWs.send(dataStr);
        }
    });
    
    sonioxWs.on('close', (code, reason) => {
        const reasonStr = reason ? reason.toString() : 'No reason provided';
        console.log(`[${connectionId}] Soniox connection closed: code=${code}, reason="${reasonStr}"`);
        
        // Log if this happened before Soniox acknowledged config
        if (!conn.isReady) {
            console.error(`[${connectionId}] ⚠️ Soniox closed BEFORE acknowledging config - likely invalid API key or config`);
        }
        
        conn.sonioxWs = null;
        conn.isReady = false;
        
        // Notify client
        if (conn.clientWs && conn.clientWs.readyState === WebSocket.OPEN) {
            sendToClient(conn.clientWs, {
                type: 'error',
                message: `Soniox connection closed: ${reasonStr || 'Unknown reason'}`,
                code: code
            });
        }
    });
    
    sonioxWs.on('error', (err) => {
        console.error(`[${connectionId}] Soniox error:`, err.message);
        conn.sonioxWs = null;
        conn.isReady = false;
        
        // Notify client
        if (conn.clientWs && conn.clientWs.readyState === WebSocket.OPEN) {
            sendToClient(conn.clientWs, {
                type: 'error',
                message: 'Soniox connection error: ' + err.message
            });
        }
    });
    
    // Timeout for Soniox connection
    setTimeout(() => {
        if (sonioxWs.readyState !== WebSocket.OPEN) {
            console.log(`[${connectionId}] Soniox connection timeout`);
            sonioxWs.close();
            sendToClient(conn.clientWs, {
                type: 'error',
                message: 'Soniox connection timeout'
            });
        }
    }, 10000);
}

function cleanupConnection(connectionId) {
    const conn = connections.get(connectionId);
    if (!conn) return;
    
    console.log(`[${connectionId}] Cleaning up connection`);
    
    // Close Soniox connection
    if (conn.sonioxWs) {
        conn.sonioxWs.close();
    }
    
    // Close client connection
    if (conn.clientWs && conn.clientWs.readyState !== WebSocket.CLOSED) {
        conn.clientWs.close();
    }
    
    connections.delete(connectionId);
}

function sendToClient(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function sendError(ws, message, code) {
    sendToClient(ws, { type: 'error', message, code });
}

function generateConnectionId() {
    return Math.random().toString(36).substring(2, 15);
}

// Start the server
server.listen(PORT, () => {
    console.log(`✅ Selah Translation Proxy running on port ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   OpenAI TTS: POST http://localhost:${PORT}/api/openai/tts`);
    console.log(`   Deepgram TTS: POST http://localhost:${PORT}/api/deepgram/tts`);
    console.log(`   Soniox WebSocket: ws://localhost:${PORT}?token=YOUR_JWT_TOKEN`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    
    // Close all connections
    for (const [id, conn] of connections) {
        cleanupConnection(id);
    }
    
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
