import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config();

// Configuration from environment variables
const PORT = process.env.PORT || 8080;
const SONIOX_API_KEY = process.env.SONIOX_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Validate required environment variables
if (!SONIOX_API_KEY) {
    console.error('ERROR: SONIOX_API_KEY environment variable is required');
    process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_ANON_KEY environment variables are required');
    process.exit(1);
}

// Initialize Supabase client for JWT verification
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Create HTTP server
const server = createServer((req, res) => {
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
    
    res.writeHead(404);
    res.end('Not Found');
});

// Create WebSocket server
const wss = new WebSocketServer({ server });

// Track active connections
const connections = new Map();

console.log('Soniox Proxy Server starting...');
console.log(`Port: ${PORT}`);
console.log(`Supabase URL: ${SUPABASE_URL}`);

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
    
    // Handle messages from client
    clientWs.on('message', (data, isBinary) => {
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
    
    // If binary data, forward to Soniox
    if (isBinary || Buffer.isBuffer(data)) {
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
        message = JSON.parse(data.toString());
    } catch {
        console.log(`[${connectionId}] Invalid JSON message:`, data.toString().substring(0, 100));
        return;
    }
    
    // Handle ping/keepalive
    if (message.type === 'ping') {
        sendToClient(conn.clientWs, {
            type: 'pong',
            ref: message.ref || 0,
            timestamp: Date.now()
        });
        return;
    }
    
    // Handle start action - connect to Soniox
    if (message.action === 'start') {
        console.log(`[${connectionId}] Starting Soniox session...`);
        connectToSoniox(connectionId, message.config || message);
        return;
    }
    
    // Forward other messages to Soniox
    if (conn.sonioxWs && conn.sonioxWs.readyState === WebSocket.OPEN) {
        conn.sonioxWs.send(JSON.stringify(message));
    }
}

function connectToSoniox(connectionId, config) {
    const conn = connections.get(connectionId);
    if (!conn) return;
    
    // Close existing Soniox connection if any
    if (conn.sonioxWs) {
        conn.sonioxWs.close();
        conn.sonioxWs = null;
    }
    
    console.log(`[${connectionId}] Connecting to Soniox...`);
    
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
        
        // Notify client that proxy is ready
        conn.isReady = true;
        sendToClient(conn.clientWs, {
            type: 'proxy_ready',
            connection_id: connectionId
        });
    });
    
    sonioxWs.on('message', (data) => {
        // Forward Soniox response to client
        if (conn.clientWs && conn.clientWs.readyState === WebSocket.OPEN) {
            conn.clientWs.send(data.toString());
        }
    });
    
    sonioxWs.on('close', (code, reason) => {
        console.log(`[${connectionId}] Soniox connection closed: ${code} ${reason?.toString() || ''}`);
        conn.sonioxWs = null;
        conn.isReady = false;
        
        // Notify client
        if (conn.clientWs && conn.clientWs.readyState === WebSocket.OPEN) {
            sendToClient(conn.clientWs, {
                type: 'error',
                message: 'Soniox connection closed',
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
    console.log(`✅ Soniox Proxy Server running on port ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   WebSocket: ws://localhost:${PORT}?token=YOUR_JWT_TOKEN`);
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
