import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { Relay, readRelayConfig, describeRelayConfig } from './relay.js';

config();

// Configuration from environment variables
const PORT = process.env.PORT || 8080;
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DEEPL_AUTH_KEY = process.env.DEEPL_AUTH_KEY;
// DeepL routes Free vs Pro by key suffix: Free keys end in ":fx" and use the
// api-free host; Pro keys have no suffix and use the api host. Auto-detect so a
// plan change only needs a new key, not a code edit.
const DEEPL_API_HOST = (DEEPL_AUTH_KEY && DEEPL_AUTH_KEY.endsWith(':fx'))
  ? 'https://api-free.deepl.com'
  : 'https://api.deepl.com';
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

// Soniox relay behavior (keepalive, stall watchdog, rotation, re-dial), all
// from SONIOX_* env vars with the defaults in docs/reliability-2026-10.md.
const RELAY_CONFIG = readRelayConfig(process.env);

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
            build: 'reliability-2026-10',
            timestamp: new Date().toISOString()
        }));
        return;
    }
    
    // Legacy /openai/token endpoint removed - raw API key exposure eliminated
    if (req.url === '/openai/token' && req.method === 'POST') {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'This endpoint has been removed. Use /api/openai/tts for TTS or /api/openai/chat for chat.' }));
        return;
    }
    
    // OpenAI Ephemeral Token endpoint - returns short-lived Realtime session token
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
                console.error('OpenAI ephemeral key error:', openaiResponse.status, errorData);
                
                res.writeHead(openaiResponse.status >= 400 && openaiResponse.status < 600 ? openaiResponse.status : 500, { 'Content-Type': 'application/json' });
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
    // Supports streaming for low-latency playback (PCM) and buffered for web (mp3/opus)
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
            const responseFormat = params.response_format || 'mp3';
            
            if (!text) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: text' }));
                return;
            }
            
            console.log(`OpenAI TTS request for user: ${user.id}, voice: ${voice}, format: ${responseFormat}, text length: ${text.length}`);
            
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
            
            const FORMAT_CONTENT_TYPES = {
                'mp3': 'audio/mpeg',
                'opus': 'audio/ogg',
                'aac': 'audio/aac',
                'flac': 'audio/flac',
                'wav': 'audio/wav',
                'pcm': 'audio/pcm',
            };
            const contentType = FORMAT_CONTENT_TYPES[responseFormat] || 'audio/mpeg';
            
            // For PCM/streaming formats, pipe directly for lowest latency
            if (responseFormat === 'pcm' && openaiResponse.body) {
                res.writeHead(200, { 
                    'Content-Type': contentType,
                    'Transfer-Encoding': 'chunked',
                });
                const reader = openaiResponse.body.getReader();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        res.write(Buffer.from(value));
                    }
                } catch (streamErr) {
                    console.error('OpenAI TTS stream error:', streamErr.message);
                } finally {
                    res.end();
                }
                console.log(`OpenAI TTS streamed for user: ${user.id}`);
                return;
            }
            
            // For compressed formats, buffer then send (content-length needed for web playback)
            const audioData = await openaiResponse.arrayBuffer();
            console.log(`OpenAI TTS success for user: ${user.id}, audio size: ${audioData.byteLength} bytes`);
            
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
    
    // OpenAI Chat Completions proxy - proxies requests to OpenAI so API key stays on server
    if (req.url === '/api/openai/chat' && req.method === 'POST') {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: No token provided' }));
                return;
            }
            
            const token = authHeader.substring(7);
            const { data: { user }, error } = await supabase.auth.getUser(token);
            
            if (error || !user) {
                console.log('OpenAI Chat: Auth failed:', error?.message || 'Invalid token');
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Invalid token' }));
                return;
            }
            
            let body = '';
            req.on('data', chunk => { body += chunk; });
            await new Promise(resolve => req.on('end', resolve));
            
            let params = {};
            try { params = JSON.parse(body || '{}'); } catch (e) {}
            
            console.log(`OpenAI Chat request for user: ${user.id}, model: ${params.model || 'gpt-4'}`);
            
            const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(params),
            });
            
            if (!openaiResponse.ok) {
                const errorText = await openaiResponse.text();
                console.error('OpenAI Chat error:', openaiResponse.status, errorText.substring(0, 200));
                res.writeHead(openaiResponse.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'OpenAI Chat failed' }));
                return;
            }
            
            // Stream SSE responses for streaming chat, buffer for non-streaming
            if (params.stream && openaiResponse.body) {
                res.writeHead(200, { 
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Transfer-Encoding': 'chunked',
                });
                const reader = openaiResponse.body.getReader();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        res.write(Buffer.from(value));
                    }
                } catch (streamErr) {
                    console.error('OpenAI Chat stream error:', streamErr.message);
                } finally {
                    res.end();
                }
                return;
            }
            
            const data = await openaiResponse.arrayBuffer();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(Buffer.from(data));
            return;
        } catch (err) {
            console.error('OpenAI Chat error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
            return;
        }
    }
    
    // OpenAI Transcription proxy - proxies Whisper STT requests so API key stays on server
    if (req.url === '/api/openai/transcriptions' && req.method === 'POST') {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: No token provided' }));
                return;
            }
            
            const token = authHeader.substring(7);
            const { data: { user }, error } = await supabase.auth.getUser(token);
            
            if (error || !user) {
                console.log('OpenAI Transcription: Auth failed:', error?.message || 'Invalid token');
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Invalid token' }));
                return;
            }
            
            // Forward the raw multipart body to OpenAI (preserve content-type with boundary)
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            await new Promise(resolve => req.on('end', resolve));
            const bodyBuffer = Buffer.concat(chunks);
            
            console.log(`OpenAI Transcription request for user: ${user.id}, body size: ${bodyBuffer.length}`);
            
            const openaiResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': req.headers['content-type'],
                },
                body: bodyBuffer,
            });
            
            if (!openaiResponse.ok) {
                const errorText = await openaiResponse.text();
                console.error('OpenAI Transcription error:', openaiResponse.status, errorText.substring(0, 200));
                res.writeHead(openaiResponse.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'OpenAI Transcription failed' }));
                return;
            }
            
            const data = await openaiResponse.arrayBuffer();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(Buffer.from(data));
            return;
        } catch (err) {
            console.error('OpenAI Transcription error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
            return;
        }
    }
    
    // DeepL Text Translation endpoint - translates text into one or more target languages
    if (req.url === '/api/deepl/translate' && req.method === 'POST') {
        try {
            if (!DEEPL_AUTH_KEY) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'DeepL translation not configured' }));
                return;
            }

            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: No token provided' }));
                return;
            }

            const token = authHeader.substring(7);
            const { data: { user }, error } = await supabase.auth.getUser(token);

            if (error || !user) {
                console.log('DeepL Translate: Auth failed:', error?.message || 'Invalid token');
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Invalid token' }));
                return;
            }

            let body = '';
            req.on('data', chunk => { body += chunk; });
            await new Promise(resolve => req.on('end', resolve));

            let params = {};
            try { params = JSON.parse(body || '{}'); } catch (e) {}

            const text = params.text;
            const targetLanguages = params.target_languages; // array of lang codes
            const sourceLanguage = params.source_language; // optional

            if (!text || !targetLanguages || !Array.isArray(targetLanguages) || targetLanguages.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required fields: text (string), target_languages (array)' }));
                return;
            }

            if (targetLanguages.length > 4) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Maximum 4 target languages per request' }));
                return;
            }

            console.log(`DeepL Translate for user: ${user.id}, targets: [${targetLanguages.join(',')}], text length: ${text.length}`);

            // DeepL language code mapping, DeepL requires specific codes
            const DEEPL_LANG_MAP = {
                'en': 'EN-US', 'pt': 'PT-BR', 'zh': 'ZH-HANS',
                'no': 'NB', // Norwegian Bokmål
            };
            // Languages DeepL Free doesn't support, skip silently
            const DEEPL_UNSUPPORTED = new Set(['hi', 'ar', 'th', 'vi', 'he', 'ms', 'tl', 'sw', 'ht']);

            const results = {};
            const promises = targetLanguages.map(async (targetLang) => {
                if (DEEPL_UNSUPPORTED.has(targetLang)) {
                    results[targetLang] = { error: 'Language not supported by DeepL' };
                    return;
                }
                try {
                    const deeplTarget = DEEPL_LANG_MAP[targetLang] || targetLang.toUpperCase();

                    const deeplResponse = await fetch(`${DEEPL_API_HOST}/v2/translate`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `DeepL-Auth-Key ${DEEPL_AUTH_KEY}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            text: [text],
                            target_lang: deeplTarget,
                            ...(sourceLanguage ? { source_lang: (DEEPL_LANG_MAP[sourceLanguage] || sourceLanguage.toUpperCase()).split('-')[0] } : {}),
                        }),
                    });

                    if (!deeplResponse.ok) {
                        const errorText = await deeplResponse.text();
                        console.error(`DeepL error for ${targetLang}:`, deeplResponse.status, errorText);
                        results[targetLang] = { error: `DeepL error: ${deeplResponse.status}` };
                        return;
                    }

                    const data = await deeplResponse.json();
                    results[targetLang] = {
                        text: data.translations?.[0]?.text || '',
                        detected_source: data.translations?.[0]?.detected_source_language?.toLowerCase(),
                    };
                } catch (langErr) {
                    console.error(`DeepL error for ${targetLang}:`, langErr.message);
                    results[targetLang] = { error: langErr.message };
                }
            });

            await Promise.all(promises);

            console.log(`DeepL Translate complete for user: ${user.id}, translated ${Object.keys(results).length} languages`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ translations: results }));
            return;
        } catch (err) {
            console.error('DeepL Translate error:', err.message);
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
console.log(`DeepL Auth Key: ${DEEPL_AUTH_KEY ? '✓ configured' : '✗ missing'} (${DEEPL_API_HOST})`);
console.log(`Soniox relay: ${describeRelayConfig(RELAY_CONFIG)}`);

wss.on('connection', async (clientWs, req) => {
    const connectionId = generateConnectionId();
    console.log(`[${connectionId}] New client connection from ${req.socket.remoteAddress}`);

    // Listeners first, before any await and before the early returns below.
    // A frame the receiver rejects (bad UTF-8, bad RSV bits, oversize) makes
    // ws emit 'error'; with no listener that is an uncaught exception that
    // ends the process and every live session with it. The relay adds its
    // own handlers later; these just log.
    clientWs.on('error', (err) => {
        console.log(`[${connectionId}] client socket error: ${err.message}`);
    });
    clientWs.on('close', (code) => {
        if (!connections.has(connectionId)) {
            console.log(`[${connectionId}] client closed before a relay was attached (code ${code})`);
        }
    });

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
    
    // The client may have left during the JWT round trip: no relay for a
    // socket that is already closing or closed.
    if (clientWs.readyState !== WebSocket.OPEN) {
        console.log(`[${connectionId}] client left during auth (readyState ${clientWs.readyState}), no relay created`);
        return;
    }

    // One relay per client: it owns the Soniox stream(s), the audio path,
    // keepalive, the stall watchdog, rotation and re-dial (see relay.js).
    const relay = new Relay({
        clientWs,
        connectionId,
        apiKey: SONIOX_API_KEY,
        config: RELAY_CONFIG,
        log: console.log,
        onClosed: () => connections.delete(connectionId),
    });
    connections.set(connectionId, relay);
    if (!relay.attach()) return;

    // Send immediate acknowledgment so client knows auth passed and server is ready
    console.log(`[${connectionId}] Auth complete, sending auth_success to client`);
    sendToClient(clientWs, {
        type: 'auth_success',
        message: 'Authenticated, ready for start message',
        connectionId: connectionId
    });
});

function cleanupConnection(connectionId) {
    const relay = connections.get(connectionId);
    if (!relay) return;
    console.log(`[${connectionId}] Cleaning up connection`);
    relay.destroy('server cleanup');
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
    console.log(`   DeepL Translate: POST http://localhost:${PORT}/api/deepl/translate`);
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

// Last line of defense, not a fix: on DigitalOcean a crash drops every live
// session and stays down until the health check restarts the container, so
// an escaped exception is logged and the process is kept alive.
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception (process kept alive):', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection (process kept alive):', reason && reason.stack ? reason.stack : reason);
});
