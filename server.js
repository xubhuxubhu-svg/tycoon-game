// 億萬大亨 — 連線伺服器（Render「網頁服務」直接部署）
// 1. 提供遊戲網頁與所有檔案
// 2. 「/net」：億萬大亨雙人連線（合作經營、對戰邀請、即時畫面）
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

/* ================= 億萬大亨：多人合作大廳 ================= */
const LOBBY = new Set();
let lobbyT = null;
function lobbyList() {
  const teams = [];
  for (const r of tRooms.values()) {
    const on = [...r.mem.values()].filter(x => x.ws && x.ws.readyState === 1);
    const host = [...r.mem.values()].find(x => x.slot === 0);
    if (!host || !on.length) continue;
    teams.push({ code: r.code, series: r.series || 'farm', cap: r.cap, n: r.mem.size, on: on.length, hostName: host.name, hostLu: host.lu || '', hostOn: !!(host.ws && host.ws.readyState === 1), mem: [...r.mem.values()].sort((a, b) => a.slot - b.slot).map(x => ({ name: x.name, on: !!(x.ws && x.ws.readyState === 1), lu: x.lu || '' })) });
  }
  const inTeam = new Map();
  for (const t of teams) for (const x of t.mem) if (x.lu) inTeam.set(x.lu, t.code);
  const seen = new Set(), players = [];
  for (const w of LOBBY) { if (w.readyState !== 1 || !w.lobby || seen.has(w.lobby.lu)) continue; seen.add(w.lobby.lu); players.push({ lu: w.lobby.lu, name: w.lobby.name, where: w.lobby.where, team: inTeam.get(w.lobby.lu) || '' }); }
  return { t: 'llist', players, teams };
}
function lobbyDirty() { if (lobbyT) return; lobbyT = setTimeout(() => { lobbyT = null; const s = JSON.stringify(lobbyList()); for (const w of LOBBY) if (w.readyState === 1) w.send(s); }, 600); }
function lobbyTo(lu, obj) { let n = 0; if (!lu) return 0; const s = JSON.stringify(obj); for (const w of LOBBY) if (w.readyState === 1 && w.lobby && w.lobby.lu === lu) { w.send(s); n++; } return n; }
setInterval(lobbyDirty, 5000);

/* ================= 億萬大亨：合作房間（雙人 2 位／多人 4 位，斷線可用房號回來） ================= */
// 房間成員用玩家代號記住；有人登出時保留位置 30 分鐘，用同一個房號就能回來繼續玩。
const tRooms = new Map();
function tMembers(r) { return [...r.mem.values()].map(m => ({ uid: m.uid, name: m.name, slot: m.slot, on: !!(m.ws && m.ws.readyState === 1) })); }
function tBroadcast(r, obj, except) { const s = JSON.stringify(obj); for (const m of r.mem.values()) if (m.ws && m.ws !== except && m.ws.readyState === 1) m.ws.send(s); }
function tCheckEmpty(r) {
  clearTimeout(r.kill);
  if ([...r.mem.values()].some(m => m.ws && m.ws.readyState === 1)) return;
  r.kill = setTimeout(() => tRooms.delete(r.code), 30 * 60 * 1000);
}
function tLeave(ws) {
  const r = ws.troom; if (!r) return; ws.troom = null;
  const m = r.mem.get(ws.tuid); if (!m || m.ws !== ws) return;
  m.ws = null;
  tBroadcast(r, { t: 'gone', uid: m.uid, name: m.name, slot: m.slot, host: m.slot === 0 });
  tCheckEmpty(r);
}
function tycoon(ws) {
  ws.on('message', raw => {
    const s = raw.toString();
    let m; try { m = JSON.parse(s); } catch { return; }
    const r = ws.troom;
    switch (m.t) {
      case 'create': {
        tLeave(ws);
        const uid = String(m.uid || ('u' + Math.random().toString(36).slice(2))).slice(0, 40);
        // 固定房號：房主每次都用同一個號碼；房間還在而且是自己的，就直接回到房間
        const want = /^\d{4}$/.test(String(m.code || '')) ? String(m.code) : '';
        const old = want && tRooms.get(want);
        if (old) {
          const h = [...old.mem.values()].find(x => x.slot === 0);
          if (h && h.uid === uid) {
            old.cap = Math.max(m.cap === 4 ? 4 : 2, old.mem.size);
            h.ws = ws; h.name = String(m.name || h.name).slice(0, 10); if (m.lu) h.lu = String(m.lu).slice(0, 40); if (m.series) old.series = String(m.series).slice(0, 8); ws.troom = old; ws.tuid = uid; clearTimeout(old.kill);
            send(ws, { t: 'joined', code: old.code, cap: old.cap, uid, slot: 0, role: 'host', hostName: h.name, members: tMembers(old), fixed: true });
            tBroadcast(old, { t: 'peer', uid, name: h.name, slot: 0 }, ws);
            break;
          }
        }
        let code = want && !tRooms.has(want) && !fRooms.has(want) ? want : '';
        while (!code || tRooms.has(code) || fRooms.has(code)) code = String(1000 + Math.floor(Math.random() * 9000));
        const room = { code, cap: m.cap === 4 ? 4 : 2, mem: new Map(), kill: null, series: String(m.series || 'farm').slice(0, 8) };
        room.mem.set(uid, { uid, name: String(m.name || '老闆').slice(0, 10), slot: 0, ws, lu: String(m.lu || '').slice(0, 40) });
        tRooms.set(code, room); ws.troom = room; ws.tuid = uid;
        send(ws, { t: 'created', code, cap: room.cap, uid, slot: 0, members: tMembers(room) });
        break;
      }
      case 'join': {
        const room = tRooms.get(String(m.code || '').trim());
        if (!room) return send(ws, { t: 'err', msg: '找不到這個房間，請確認房號（房間沒人超過 30 分鐘會自動關閉）' });
        let uid = String(m.uid || ('u' + Math.random().toString(36).slice(2))).slice(0, 40);
        let mem = room.mem.get(uid);
        if (mem && mem.ws && mem.ws !== ws && mem.ws.readyState === 1) { uid = uid + '#' + Math.random().toString(36).slice(2, 6); mem = null; } // 同一個瀏覽器開兩個分頁
        if (!mem) {
          if (room.mem.size >= room.cap) return send(ws, { t: 'err', msg: `這個房間已經滿了（最多 ${room.cap} 位）` });
          const used = new Set([...room.mem.values()].map(x => x.slot));
          let slot = 1; while (used.has(slot)) slot++;
          mem = { uid, name: '', slot, ws: null }; room.mem.set(uid, mem);
        }
        tLeave(ws);
        mem.ws = ws; mem.name = String(m.name || '朋友').slice(0, 10); if (m.lu) mem.lu = String(m.lu).slice(0, 40); ws.troom = room; ws.tuid = uid; clearTimeout(room.kill);
        const host = [...room.mem.values()].find(x => x.slot === 0);
        send(ws, { t: 'joined', code: room.code, cap: room.cap, uid, slot: mem.slot, role: mem.slot === 0 ? 'host' : 'guest', hostName: host ? host.name : '', members: tMembers(room) });
        tBroadcast(room, { t: 'peer', uid, name: mem.name, slot: mem.slot }, ws);
        break;
      }
      case 'leave': tLeave(ws); break;
      case 'ping': send(ws, { t: 'pong' }); break;
      // ===== 多人合作大廳：誰在線上、有哪些隊伍、邀請、請求加入 =====
      case 'lhello': { ws.lobby = { lu: String(m.lu || '').slice(0, 40), name: String(m.name || '玩家').slice(0, 10), where: String(m.where || 'home').slice(0, 8) }; LOBBY.add(ws); lobbyDirty(); send(ws, lobbyList()); break; }
      case 'lstat': { if (ws.lobby) { if (m.name) ws.lobby.name = String(m.name).slice(0, 10); if (m.where) ws.lobby.where = String(m.where).slice(0, 8); lobbyDirty(); } break; }
      case 'llist': send(ws, lobbyList()); break;
      case 'linvite': { if (!ws.lobby) return; lobbyTo(m.to, { t: 'linvite', from: ws.lobby.lu, fromName: ws.lobby.name, code: String(m.code || ''), series: String(m.series || '') }); break; }
      case 'lreq': { if (!ws.lobby) return; const room = tRooms.get(String(m.code || '')); if (!room) return send(ws, { t: 'lans', ok: false, why: '這個隊伍已經解散了' });
        if (room.mem.size >= room.cap && ![...room.mem.values()].some(x => x.lu === ws.lobby.lu)) return send(ws, { t: 'lans', ok: false, why: `這個隊伍已經滿了（最多 ${room.cap} 位）` });
        const host = [...room.mem.values()].find(x => x.slot === 0);
        if (!host || !lobbyTo(host.lu, { t: 'lreq', from: ws.lobby.lu, fromName: ws.lobby.name, code: room.code, series: room.series })) return send(ws, { t: 'lans', ok: false, why: '房主現在不在大廳，請稍後再試' });
        for (const x of room.mem.values()) if (x.slot !== 0 && x.lu) lobbyTo(x.lu, { t: 'lnote', msg: `「${ws.lobby.name}」申請加入隊伍，等房主決定` });
        break; }
      case 'lans': { if (!ws.lobby) return; const room = tRooms.get(String(m.code || '')); lobbyTo(m.to, { t: 'lans', ok: !!m.ok, code: String(m.code || ''), series: room ? room.series : String(m.series || ''), hostName: ws.lobby.name, why: m.ok ? '' : '房主沒有同意' }); break; }
      default: { // 其他訊息轉給房間裡的其他人（_to 指定一人、_x 排除一人）
        if (!r) return;
        const me = r.mem.get(ws.tuid); if (!me) return;
        m._f = me.uid; m._s = me.slot;
        const out = JSON.stringify(m);
        for (const x of r.mem.values()) {
          if (!x.ws || x.ws === ws || x.ws.readyState !== 1) continue;
          if (m._to && x.uid !== m._to) continue;
          if (m._x && x.uid === m._x) continue;
          x.ws.send(out);
        }
      }
    }
  });
  ws.on('close', () => { tLeave(ws); if (LOBBY.delete(ws)) lobbyDirty(); });
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

server.listen(PORT, () => console.log('億萬大亨 伺服器啟動於連接埠 ' + PORT));
