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

// Hub Basic Auth — protects the session list from public access.
// Only /api/training/requests and GET / require auth.
// POST /api/training/request (tablet) and /relay/viewer?token=X (client) remain open.
const HUB_USER     = process.env.HUB_USER     || 'orus';
const HUB_PASSWORD = process.env.HUB_PASSWORD || 'orus2026';

function requireHubAuth(req, res) {
    const auth = req.headers['authorization'] || '';
    if (!auth.startsWith('Basic ')) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ORUS Hub"', 'Content-Type': 'text/plain' });
        res.end('Acceso no autorizado');
        return false;
    }
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const colonIdx = decoded.indexOf(':');
    const user = colonIdx >= 0 ? decoded.slice(0, colonIdx) : decoded;
    const pass = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : '';
    if (user !== HUB_USER || pass !== HUB_PASSWORD) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Credenciales incorrectas');
        return false;
    }
    return true;
}

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

// ── Hub HTML page — fixed URL for support agents ─────────────────────────────
function hubHtml(publicBaseUrl) {
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ORUS POS · Soporte Remoto</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#111; color:#eee; font-family:sans-serif; padding:24px; }
  h1 { font-size:20px; margin-bottom:4px; }
  .sub { color:#888; font-size:13px; margin-bottom:24px; }
  #list { display:flex; flex-direction:column; gap:12px; }
  .card { background:#1e1e1e; border-radius:10px; padding:16px 20px; display:flex; align-items:center; justify-content:space-between; gap:16px; }
  .info h2 { font-size:16px; margin-bottom:4px; }
  .info .meta { font-size:12px; color:#888; }
  .badge { font-size:11px; padding:2px 8px; border-radius:10px; font-weight:bold; }
  .badge.PENDING { background:#6a5a00; color:#ffe; }
  .badge.CONNECTED { background:#2d6a2d; color:#efe; }
  .btn { background:#1976D2; color:#fff; border:none; border-radius:8px; padding:10px 20px; font-size:14px; font-weight:bold; cursor:pointer; white-space:nowrap; }
  .btn:hover { background:#1565C0; }
  #empty { color:#555; text-align:center; margin-top:48px; font-size:16px; }
  .refresh { font-size:12px; color:#555; text-align:right; margin-bottom:12px; }
</style>
</head>
<body>
<h1>ORUS POS · Soporte Remoto</h1>
<p class="sub">Sesiones de formación activas</p>
<div class="refresh" id="refresh-info">Actualizando…</div>
<div id="list"></div>
<div id="empty" style="display:none">No hay sesiones activas en este momento.<br>La tablet aparecerá aquí cuando active el modo formación.</div>
<script>
const base = ${JSON.stringify(publicBaseUrl)};

function timeAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm';
  return Math.floor(s/3600) + 'h';
}

async function load() {
  try {
    const r = await fetch(base + '/api/training/requests');
    const sessions = await r.json();
    const list = document.getElementById('list');
    const empty = document.getElementById('empty');
    list.innerHTML = '';
    if (!sessions.length) { empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    for (const s of sessions) {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = \`
        <div class="info">
          <h2>\${s.businessName || s.terminalId}</h2>
          <div class="meta">Terminal: \${s.terminalId} · Hace \${timeAgo(s.createdAt)} · <span class="badge \${s.status}">\${s.status}</span></div>
        </div>
        <button class="btn" onclick="window.open('\${s.viewerUrl}','_blank')">Conectar →</button>
      \`;
      list.appendChild(card);
    }
    document.getElementById('refresh-info').textContent = 'Actualizado: ' + new Date().toLocaleTimeString();
  } catch(e) {
    document.getElementById('refresh-info').textContent = 'Error al cargar: ' + e.message;
  }
}

load();
setInterval(load, 5000);
</script>
</body>
</html>`;
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
  #screen-wrap { flex:1; display:flex; align-items:center; justify-content:center; overflow:hidden; position:relative; }
  #screen { max-width:100%; max-height:100%; object-fit:contain; display:none; cursor:crosshair; touch-action:none; }
  #placeholder { text-align:center; color:#666; }
  #placeholder h2 { margin-bottom:8px; font-size:18px; }
  #codec-info { font-size:11px; color:#555; margin-left:auto; }
</style>
</head>
<body>
<div id="header">
  <strong>ORUS POS · Soporte Remoto</strong>
  <span id="status">Conectando…</span>
  <span id="codec-info"></span>
</div>
<div id="screen-wrap">
  <canvas id="screen" style="display:none"></canvas>
  <div id="placeholder"><h2>⏳ Esperando conexión de la tablet…</h2><p>Token: ${token.slice(0,8)}…</p></div>
</div>
<script>
const token = ${JSON.stringify(token)};
const wsBase = ${JSON.stringify(wsUrl)};
const statusEl = document.getElementById('status');
const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const placeholder = document.getElementById('placeholder');
const codecInfo = document.getElementById('codec-info');

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || '';
}

// ── WebCodecs H.264 decoder ──────────────────────────────────────────────────
let decoder = null;
let ws = null;

function initDecoder() {
  if (decoder) { try { decoder.close(); } catch(_){} }
  decoder = new VideoDecoder({
    output(frame) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
      ctx.drawImage(frame, 0, 0);
      frame.close();
      canvas.style.display = 'block';
      placeholder.style.display = 'none';
      setStatus('Activo ✓', 'connected');
    },
    error(e) {
      codecInfo.textContent = 'decoder error: ' + e.message;
      // reiniciar decoder en el próximo keyframe
      try { decoder.close(); } catch(_){}
      decoder = null;
    }
  });
  decoder.configure({ codec: 'avc1.42E01F', optimizeForLatency: true });
  codecInfo.textContent = 'H.264 WebCodecs';
}

function decodeFrame(data, isKeyframe) {
  if (!decoder || decoder.state === 'closed') {
    if (!isKeyframe) return; // esperar keyframe para reiniciar
    initDecoder();
  }
  if (decoder.decodeQueueSize > 10) return; // evitar acumulación
  try {
    const chunk = new EncodedVideoChunk({
      type: isKeyframe ? 'key' : 'delta',
      timestamp: performance.now() * 1000,
      data: data
    });
    decoder.decode(chunk);
  } catch(e) {
    codecInfo.textContent = 'decode err: ' + e.message;
    try { decoder.close(); } catch(_){}
    decoder = null;
  }
}

// ── Touch events → relay ─────────────────────────────────────────────────────
function sendTouch(action, clientX, clientY) {
  if (!ws || ws.readyState !== 1) return;
  const rect = canvas.getBoundingClientRect();
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  ws.send(JSON.stringify({ type: 'touch', action, x, y }));
}

canvas.addEventListener('pointerdown', e => { e.preventDefault(); sendTouch('down', e.clientX, e.clientY); });
canvas.addEventListener('pointermove', e => { if (e.buttons) { e.preventDefault(); sendTouch('move', e.clientX, e.clientY); } });
canvas.addEventListener('pointerup',   e => { e.preventDefault(); sendTouch('up',   e.clientX, e.clientY); });

// ── WebSocket ────────────────────────────────────────────────────────────────
function connect() {
  ws = new WebSocket(wsBase + '/relay/viewer?token=' + encodeURIComponent(token));
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => setStatus('Conectado — esperando tablet…', 'waiting');

  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      if (e.data.byteLength < 2) return;
      const view = new Uint8Array(e.data);
      const isKeyframe = view[0] === 1;
      const nalData = e.data.slice(1);

      if (typeof VideoDecoder !== 'undefined') {
        decodeFrame(nalData, isKeyframe);
      } else {
        codecInfo.textContent = 'WebCodecs no soportado en este navegador';
        setStatus('Error: necesita Chrome/Edge/Safari', 'error');
      }
    } else {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'viewer_count') setStatus('Activo ✓ · ' + msg.count + ' viewer(s)', 'connected');
      } catch {}
    }
  };

  ws.onerror = () => setStatus('Error de conexión', 'error');
  ws.onclose = () => {
    setStatus('Desconectado — reconectando…', 'error');
    canvas.style.display = 'none';
    placeholder.style.display = 'block';
    if (decoder) { try { decoder.close(); } catch(_){} decoder = null; }
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
        if (!requireHubAuth(req, res)) return;
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

    // Hub page — support agent opens this fixed URL to see pending sessions
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/hub')) {
        if (!requireHubAuth(req, res)) return;
        const html = hubHtml(PUBLIC_BASE_URL);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
        return res.end(html);
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
