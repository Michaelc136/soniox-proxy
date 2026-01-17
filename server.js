import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config();

// Configuration from environment variables
const PORT = process.env.PORT || 8080;
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Validate required environment variables
if (!SONIOX_API_KEY) {
    console.error('ERROR: SONIOX_API_KEY environment variable is required');
    process.exit(1);
}

if (!DEEPGRAM_API_KEY) {
    console.error('ERROR: DEEPGRAM_API_KEY environment variable is required');
    process.exit(1);
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
    
    // Deepgram TTS token endpoint - returns API key for authenticated users
    if (req.url === '/deepgram/token' && req.method === 'POST') {
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
                console.log('Deepgram token request: Auth failed:', error?.message || 'Invalid token');
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Unauthorized: Invalid token' }));
                return;
            }
            
            console.log(`Deepgram token issued for user: ${user.id}`);
            
            // Return the Deepgram API key
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                api_key: DEEPGRAM_API_KEY,
                expires_in: 3600 // 1 hour (client should request new token before expiry)
            }));
            return;
        } catch (err) {
            console.error('Deepgram token error:', err.message);
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
console.log(`Deepgram API Key: ${DEEPGRAM_API_KEY ? '✓ configured' : '✗ missing'}`);

wss.on('connection', async (clientWs, req) => {
    const connectionId = generateConnectionId();
    console.log(`[${connectionId}] New client connection from ${req.socket.remoteAddress}`);
    
    // Parse token from query string
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    
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
        
        console.log(`[${connectionId}] User authenticated: ${user.id} (${user.email})`);
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
        connectToSoniox(connectionId, message.config || message);
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
    console.log(`[${connectionId}] Config:`, JSON.stringify(config).substring(0, 300));
    
    // Connect to Soniox with API key in header
    const sonioxWs = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket', {
        headers: {
            'Authorization': `Bearer ${SONIOX_API_KEY}`
        }
    });
    
    sonioxWs.on('open', () => {
        console.log(`[${connectionId}] Connected to Soniox`);
        conn.sonioxWs = sonioxWs;
        
        // Remove 'action' field before sending to Soniox
        const sonioxConfig = { ...config };
        delete sonioxConfig.action;
        
        // Send config to Soniox
        sonioxWs.send(JSON.stringify(sonioxConfig));
        console.log(`[${connectionId}] Sent config to Soniox:`, JSON.stringify(sonioxConfig).substring(0, 200));
        
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
    console.log(`   Deepgram token: POST http://localhost:${PORT}/deepgram/token`);
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
