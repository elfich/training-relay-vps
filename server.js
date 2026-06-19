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

// ── Viewer HTML page ─────────────────────────────────────────────────────────
function viewerHtml(token, publicBaseUrl) {
    const wsUrl = publicBaseUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ORUS POS — Soporte Remoto</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#111; color:#eee; font-family:sans-serif; display:flex; flex-direction:column; height:100vh; }
  #header { padding:10px 16px; background:#1e1e1e; display:flex; align-items:center; gap:12px; flex-shrink:0; }
  #status { font-size:13px; padding:3px 10px; border-radius:12px; background:#444; }
  #status.connected { background:#2d6a2d; }
  #status.waiting { background:#6a5a00; }
  #status.error { background:#6a1e1e; }
  #screen-wrap { flex:1; display:flex; align-items:center; justify-content:center; overflow:hidden; }
  #screen { max-width:100%; max-height:100%; object-fit:contain; display:none; }
  #placeholder { text-align:center; color:#666; }
  #placeholder h2 { margin-bottom:8px; font-size:18px; }
</style>
</head>
<body>
<div id="header">
  <strong>ORUS POS · Soporte Remoto</strong>
  <span id="status">Conectando…</span>
</div>
<div id="screen-wrap">
  <img id="screen" alt="Pantalla remota">
  <div id="placeholder"><h2>⏳ Esperando conexión de la tablet…</h2><p>Token: ${token.slice(0,8)}…</p></div>
</div>
<script>
const token = ${JSON.stringify(token)};
const wsBase = ${JSON.stringify(wsUrl)};
const statusEl = document.getElementById('status');
const screenEl = document.getElementById('screen');
const placeholder = document.getElementById('placeholder');

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || '';
}

function connect() {
  const ws = new WebSocket(wsBase + '/relay/viewer?token=' + encodeURIComponent(token));
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => setStatus('Conectado — esperando tablet…', 'waiting');

  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      // Binary frame: JPEG
      const blob = new Blob([e.data], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      const old = screenEl.src;
      screenEl.src = url;
      screenEl.style.display = 'block';
      placeholder.style.display = 'none';
      setStatus('Activo ✓', 'connected');
      if (old && old.startsWith('blob:')) URL.revokeObjectURL(old);
    } else {
      // Text frame: control message
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'viewer_count') setStatus('Activo ✓ · ' + msg.count + ' viewer(s)', 'connected');
      } catch {}
    }
  };

  ws.onerror = () => setStatus('Error de conexión', 'error');

  ws.onclose = (e) => {
    setStatus('Desconectado — reconectando…', 'error');
    screenEl.style.display = 'none';
    placeholder.style.display = 'block';
    setTimeout(connect, 3000);
  };
}

connect();
</script>
</body>
</html>`;
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

    // Viewer HTML page — opened in browser by support agent
    if (req.method === 'GET' && url.pathname === '/relay/viewer') {
        const token = url.searchParams.get('token') || '';
        const html = viewerHtml(token, PUBLIC_BASE_URL);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
        return res.end(html);
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
