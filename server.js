// 製作大亨 — 連線伺服器（Render「網頁服務」直接部署）
// 1. 提供遊戲網頁與所有檔案
// 2. 「/net」：製作大亨雙人連線（合作經營、對戰邀請、即時畫面）
// 3. 其他路徑：極速F1 內建的連線賽車房間
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wasm': 'application/wasm'
};
const BLOCK = new Set(['server.js', 'package.json', 'package-lock.json']);
const DEV = process.env.TYCOON_DEV === '1';
const gzCache = new Map();

const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url.endsWith('/')) url += 'index.html';
  const file = path.normalize(path.join(ROOT, url));
  if (!file.startsWith(ROOT + path.sep) || BLOCK.has(path.basename(file)) || (!DEV && file.includes(path.sep + 'node_modules' + path.sep)) || path.basename(file).startsWith('.')) {
    res.writeHead(404); return res.end('not found');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const type = TYPES[ext] || 'application/octet-stream';
    const text = /^(text|application\/(javascript|json))/.test(type) || ext === '.svg';
    const headers = { 'Content-Type': type, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400', 'Accept-Ranges': 'bytes' };
    // 文字檔：壓縮後傳送（第一次壓縮後放在記憶體）
    if (text && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      const key = file + ':' + st.mtimeMs;
      const send = buf => { res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': buf.length, Vary: 'Accept-Encoding' }); res.end(req.method === 'HEAD' ? undefined : buf); };
      if (gzCache.has(key)) return send(gzCache.get(key));
      return fs.readFile(file, (e, data) => {
        if (e) { res.writeHead(500); return res.end(); }
        zlib.gzip(data, { level: 6 }, (e2, gz) => { if (e2) { res.writeHead(200, headers); return res.end(data); } gzCache.set(key, gz); send(gz); });
      });
    }
    // 音樂等大檔：支援分段讀取（手機播放音樂需要）
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0, end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (m && !m[1] && m[2]) { start = Math.max(0, st.size - parseInt(m[2], 10)); end = st.size - 1; }
      if (start >= st.size || end >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }

/* ================= 製作大亨：雙人房間（房主＋一位朋友） ================= */
const tRooms = new Map();
function tLeave(ws) {
  const r = ws.troom; if (!r) return; ws.troom = null;
  if (r.host === ws) {
    send(r.guest, { t: 'hostLeft' }); if (r.guest) r.guest.troom = null;
    tRooms.delete(r.code);
  } else if (r.guest === ws) {
    r.guest = null; r.guestName = '';
    send(r.host, { t: 'peerLeft' });
  }
}
function tycoon(ws) {
  ws.on('message', raw => {
    const s = raw.toString();
    let m; try { m = JSON.parse(s); } catch { return; }
    const r = ws.troom;
    switch (m.t) {
      case 'create': {
        tLeave(ws);
        let code; do { code = String(1000 + Math.floor(Math.random() * 9000)); } while (tRooms.has(code) || fRooms.has(code));
        const room = { code, host: ws, guest: null, hostName: String(m.name || '老闆').slice(0, 10), guestName: '' };
        tRooms.set(code, room); ws.troom = room;
        send(ws, { t: 'created', code });
        break;
      }
      case 'join': {
        const room = tRooms.get(String(m.code || '').trim());
        if (!room) return send(ws, { t: 'err', msg: '找不到這個房間，請確認房號' });
        if (room.guest && room.guest !== ws && room.guest.readyState === 1) return send(ws, { t: 'err', msg: '這個房間已經有兩位玩家了' });
        tLeave(ws);
        room.guest = ws; room.guestName = String(m.name || '朋友').slice(0, 10); ws.troom = room;
        send(ws, { t: 'joined', code: room.code, host: room.hostName });
        send(room.host, { t: 'peer', name: room.guestName });
        break;
      }
      case 'leave': tLeave(ws); break;
      case 'ping': send(ws, { t: 'pong' }); break;
      default: // 其他訊息原封不動轉給房間裡的另一位
        if (!r) return;
        send(r.host === ws ? r.guest : r.host, s);
    }
  });
  ws.on('close', () => tLeave(ws));
}

/* ================= 極速F1：連線賽車房間（原遊戲內建） ================= */
const fRooms = new Map();
let nextId = 1;
function roomInfo(r, you) {
  return { t: 'room', code: r.code, host: r.host, you, level: r.level, state: r.state, players: r.players.map(p => ({ id: p.id, name: p.name, color: p.color })) };
}
function broadcastRoom(r) { r.players.forEach(p => send(p.ws, roomInfo(r, p.id))); }
function fJoin(ws, r, m) {
  const used = new Set(r.players.map(p => p.color));
  let color = Number.isInteger(m.color) && m.color >= 0 && m.color < 6 ? m.color : 0;
  if (used.has(color)) { for (let c = 0; c < 6; c++) if (!used.has(c)) { color = c; break; } }
  r.players.push({ id: ws.id, name: String(m.name || '車手').slice(0, 8), color, ws });
  ws.froom = r; broadcastRoom(r);
}
function fLeave(ws) {
  const r = ws.froom; if (!r) return; ws.froom = null;
  r.players = r.players.filter(p => p.id !== ws.id);
  if (!r.players.length) { fRooms.delete(r.code); return; }
  if (r.host === ws.id) r.host = r.players[0].id;
  r.players.forEach(p => send(p.ws, { t: 'gone', id: ws.id }));
  broadcastRoom(r);
}
function f1(ws) {
  ws.id = nextId++;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const r = ws.froom;
    switch (m.t) {
      case 'create': {
        fLeave(ws);
        let code; do { code = String(1000 + Math.floor(Math.random() * 9000)); } while (fRooms.has(code) || tRooms.has(code));
        const room = { code, host: ws.id, players: [], level: 0, state: 'lobby' };
        fRooms.set(code, room); fJoin(ws, room, m); break;
      }
      case 'join': {
        const room = fRooms.get(String(m.code));
        if (!room) return send(ws, { t: 'err', msg: '找不到這個房間' });
        if (room.players.length >= 6) return send(ws, { t: 'err', msg: '房間已滿（最多 6 人）' });
        if (room.state !== 'lobby') return send(ws, { t: 'err', msg: '比賽進行中，請等這場結束再加入' });
        fLeave(ws); fJoin(ws, room, m); break;
      }
      case 'level':
        if (r && r.host === ws.id && r.state === 'lobby') { r.level = Math.max(0, Math.min(9, m.level | 0)); broadcastRoom(r); }
        break;
      case 'start':
        if (r && r.host === ws.id && r.state === 'lobby') {
          r.state = 'race';
          const seed = 1 + Math.floor(Math.random() * 999999);
          const players = r.players.map(p => ({ id: p.id, name: p.name, color: p.color }));
          r.players.forEach(p => send(p.ws, { t: 'start', level: r.level, seed, host: r.host, players }));
        }
        break;
      case 'st':
        if (r) {
          const out = JSON.stringify({ t: 'st', id: ws.id, d: m.d, ai: r.host === ws.id ? m.ai : undefined });
          r.players.forEach(p => { if (p.id !== ws.id && p.ws.readyState === 1) p.ws.send(out); });
        }
        break;
      case 'back': if (r) { r.state = 'lobby'; broadcastRoom(r); } break;
      case 'leave': fLeave(ws); break;
    }
  });
  ws.on('close', () => fLeave(ws));
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
  if ((req.url || '').startsWith('/net')) tycoon(ws); else f1(ws);
});
// 保持連線（每 25 秒確認一次）
setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch {} });
}, 25000);

server.listen(PORT, () => console.log('製作大亨 伺服器啟動於連接埠 ' + PORT));
