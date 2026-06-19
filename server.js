// Training Relay Server — Node.js WebSocket relay
// Proxies frames between POS tablet (screen share source) and viewer (support agent)
// REST:
//   POST /api/training/request   — tablet registers a session, gets back viewerUrl
//   GET  /api/training/requests  — list pending/active sessions
// WebSocket:
//   ws://.../relay/tablet?token=X&sessionId=Y&terminalId=Z&businessName=W
//   ws://.../relay/viewer?token=X

'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.TRAINING_RELAY_PORT || '8766', 10);
const PUBLIC_BASE_URL = (process.env.TRAINING_RELAY_PUBLIC_URL || 'https://soporte.ademweb.eu').replace(/\/$/, '');
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// sessions: Map<token, SessionEntry>
const sessions = new Map();

function cleanupExpired() {
    const now = Date.now();
    for (const [token, s] of sessions) {
        if (s.expiresAt < now) sessions.delete(token);
    }
}

function getOrCreate(token, fields) {
    if (!sessions.has(token)) {
        sessions.set(token, {
            token,
            sessionId: token,
            terminalId: 'unknown',
            businessName: 'unknown',
            status: 'PENDING',
            createdAt: Date.now(),
            expiresAt: Date.now() + SESSION_TTL_MS,
            tablet: null,
            viewers: [],
        });
    }
    if (fields) Object.assign(sessions.get(token), fields);
    return sessions.get(token);
}

function sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

// ── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/api/training/request') {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
            try {
                const { token, sessionId, terminalId, businessName } = JSON.parse(body || '{}');
                if (!token) return sendJson(res, 400, { ok: false, error: 'missing token' });
                const s = getOrCreate(token, {
                    sessionId: sessionId || token,
                    terminalId: terminalId || 'unknown',
                    businessName: businessName || terminalId || 'unknown',
                    status: 'PENDING',
                    createdAt: Date.now(),
                    expiresAt: Date.now() + SESSION_TTL_MS,
                });
                const viewerUrl = `${PUBLIC_BASE_URL}/relay/viewer?token=${encodeURIComponent(token)}`;
                console.log(`[request] ${s.businessName} token=${token.slice(0, 8)}… viewer=${viewerUrl}`);
                return sendJson(res, 200, { ok: true, viewerUrl, expiresAt: s.expiresAt });
            } catch {
                return sendJson(res, 400, { ok: false, error: 'invalid json' });
            }
        });
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/training/requests') {
        cleanupExpired();
        const list = [...sessions.values()]
            .filter(s => s.status === 'PENDING' || s.status === 'CONNECTED')
            .sort((a, b) => b.createdAt - a.createdAt)
            .map(s => ({
                token: s.token,
                sessionId: s.sessionId,
                terminalId: s.terminalId,
                businessName: s.businessName,
                status: s.status,
                createdAt: s.createdAt,
                expiresAt: s.expiresAt,
                viewerUrl: `${PUBLIC_BASE_URL}/relay/viewer?token=${encodeURIComponent(s.token)}`,
            }));
        return sendJson(res, 200, list);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
});

// ── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/relay/tablet' || url.pathname === '/relay/viewer') {
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    } else {
        socket.destroy();
    }
});

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const role = url.pathname === '/relay/tablet' ? 'tablet' : 'viewer';
    const token = url.searchParams.get('token');
    if (!token) { ws.close(1008, 'missing token'); return; }

    if (role === 'tablet') {
        const s = getOrCreate(token, {
            sessionId: url.searchParams.get('sessionId') || token,
            terminalId: url.searchParams.get('terminalId') || 'unknown',
            businessName: url.searchParams.get('businessName') || url.searchParams.get('terminalId') || 'Tablet',
        });
        s.tablet?.close(1001, 'replaced');
        s.tablet = ws;
        s.status = s.viewers.length > 0 ? 'CONNECTED' : 'PENDING';
        console.log(`[tablet+] ${s.businessName} token=${token.slice(0, 8)}…`);

        ws.on('message', (data, isBinary) => {
            for (const v of s.viewers) if (v.readyState === 1) v.send(data, { binary: isBinary });
        });
        ws.on('close', () => {
            if (s.tablet === ws) { s.tablet = null; s.status = 'PENDING'; }
            console.log(`[tablet-] token=${token.slice(0, 8)}…`);
        });
    } else {
        const s = sessions.get(token);
        if (!s) { ws.close(1008, 'session not found'); return; }
        s.viewers.push(ws);
        s.status = s.tablet ? 'CONNECTED' : 'PENDING';
        console.log(`[viewer+] token=${token.slice(0, 8)}… total=${s.viewers.length}`);

        ws.on('message', (data, isBinary) => {
            if (s.tablet?.readyState === 1) s.tablet.send(data, { binary: isBinary });
        });
        ws.on('close', () => {
            s.viewers = s.viewers.filter(v => v !== ws);
            if (!s.tablet && s.viewers.length === 0) sessions.delete(token);
            console.log(`[viewer-] token=${token.slice(0, 8)}… total=${s.viewers.length}`);
        });
    }
});

server.listen(PORT, '127.0.0.1', () =>
    console.log(`TrainingRelayServer listening on 127.0.0.1:${PORT}  publicBaseUrl=${PUBLIC_BASE_URL}`)
);
