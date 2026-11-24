/* ===========================================================
   社区快递驿站 · 实时监测平台  主服务
   -----------------------------------------------------------
   真 B/C 架构：
     后端 = 唯一状态源（sim-core.js）
     B 端浏览器 ──┐
                  ├── WebSocket ──> 本服务 ──> 状态 / 指令
     C 端浏览器 ──┘
     ESP32 硬件 ── HTTP POST /api/ingest（可选，接真设备）

   零外部依赖，离线可部署。
   启动：node server/server.js
   =========================================================== */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { WSServer } = require('./ws.js');
const SIM = require('./sim-core.js');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 8765);
const HOST = process.env.HOST || '0.0.0.0';

/* ---------- 设备令牌（真实 ESP32 上报用） ---------- */
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || 'station-demo-token';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

/* ===========================================================
   启动内核
   =========================================================== */
const S = SIM.init();
console.log('[boot] 仿真内核已启动，倍速 ' + S.speed + '×');

/* ===========================================================
   HTTP 服务
   =========================================================== */
const server = http.createServer((req, res) => {
  let pathname;
  try {
    // 用 WHATWG URL 解析，避免 url.parse 的弃用与安全隐患
    const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    pathname = decodeURIComponent(u.pathname);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  /* ---------- CORS（方便局域网内其它设备访问） ---------- */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Device-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  /* ---------- 健康检查 ---------- */
  if (pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      clients: wss ? wss.count() : 0,
      online: S.online,
      simTime: new Date(S.t).toISOString(),
      speed: S.speed,
      frames: S.frames,
      version: 2
    });
  }

  /* ---------- 完整状态（供调试 / 轮询兜底） ---------- */
  if (pathname === '/api/state') {
    return json(res, 200, SIM.snapshot());
  }

  /* ---------- ESP32 硬件上行 ---------- */
  if (pathname === '/api/ingest') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
    return handleIngest(req, res);
  }

  /* ---------- 控制指令（HTTP 兜底，主通道是 WebSocket） ---------- */
  if (pathname === '/api/command' && req.method === 'POST') {
    return readBody(req, (body) => {
      let cmd;
      try { cmd = JSON.parse(body); } catch (e) { return json(res, 400, { ok: false, error: 'bad json' }); }
      const r = applyCommand(cmd, 'http');
      return json(res, 200, r);
    });
  }

  /* ---------- 静态文件 ---------- */
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end('Method Not Allowed'); return;
  }

  let filePath = path.join(ROOT, pathname === '/' ? '/index.html' : pathname);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // 找不到就回退到入口页（单页应用式兜底）
      if (!path.extname(filePath)) {
        fs.readFile(path.join(ROOT, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404); res.end('Not Found'); return; }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(d2);
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + pathname);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req, cb) {
  let chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 256 * 1024) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
}

/* ===========================================================
   ESP32 硬件上行
   真实设备把 DHT11 / 光敏 / PIR 的读数 POST 过来，
   内核切换为"硬件模式"，不再用仿真环境模型覆盖这些值。
   =========================================================== */
function handleIngest(req, res) {
  const token = req.headers['x-device-token'];
  if (token !== DEVICE_TOKEN) {
    return json(res, 401, { ok: false, error: 'invalid device token' });
  }
  readBody(req, (body) => {
    let d;
    try { d = JSON.parse(body); } catch (e) { return json(res, 400, { ok: false, error: 'bad json' }); }

    const r = ingestReading(d);
    json(res, 200, r);
  });
}

function ingestReading(d) {
  const env = S.env;
  const now = Date.now();

  // 切到硬件模式（内核会据此跳过仿真，不再覆盖真实读数）
  if (!S.hardwareMode) {
    S.hardwareMode = true;
    console.log('[ingest] 检测到真实硬件上行，已切换为硬件模式（仿真停止覆盖读数）');
  }
  S.hardwareSeenAt = now;

  if (typeof d.temp === 'number' && isFinite(d.temp)) env.temp = d.temp;
  if (typeof d.hum === 'number' && isFinite(d.hum)) env.hum = d.hum;
  if (typeof d.lux === 'number' && isFinite(d.lux)) env.lux = d.lux;
  if (typeof d.people === 'number' && isFinite(d.people)) env.people = Math.max(0, Math.round(d.people));
  if (typeof d.door === 'boolean') env.doorOpen = d.door;

  env.tempDisp = env.temp;
  env.humDisp = env.hum;
  env.luxDisp = env.lux;
  env.comfort = env.temp > 32 || env.hum > 74 ? 2 : (env.temp > 30 || env.hum > 68 ? 1 : 0);

  // 立即按真实读数跑一次联动与报警，让继电器当场到位（不等下一帧）
  SIM.applyControlNow && SIM.applyControlNow();
  SIM.checkAlarmsNow && SIM.checkAlarmsNow();
  broadcastNow();

  return {
    ok: true,
    receivedAt: now,
    hardwareMode: true,
    echo: { temp: env.temp, hum: env.hum, lux: env.lux, people: env.people },
    relays: { fan: S.dev.fan.on, ac: S.dev.ac.on, light: S.dev.light.on }
  };
}

/* ===========================================================
   WebSocket
   =========================================================== */
const wss = new WSServer(server, { path: '/ws' });

wss.on('connect', (conn) => {
  console.log('[ws] 连接 ' + conn.id + ' from ' + conn.remote);

  // 稍等一拍再推首帧：浏览器端的 onmessage 有时晚于握手完成挂载，
  // 立刻发送会导致首帧丢失（表现为页面一直空白）。
  setTimeout(() => {
    if (conn.closed) return;
    conn.send(SIM.snapshot());
    conn.send({
      type: 'hello',
      id: conn.id,
      serverTime: Date.now(),
      roles: ['b', 'c'],
      hardwareMode: !!S.hardwareMode
    });
  }, 60);
});

wss.on('disconnect', (conn) => {
  console.log('[ws] 断开 ' + conn.id + '（角色 ' + conn.role + '）');
});

wss.on('message', (conn, msg) => {
  if (!msg || typeof msg.type !== 'string') return;

  /* 角色声明：b=老板端（可控制） c=顾客端（只读） */
  if (msg.type === 'hello') {
    conn.role = (msg.role === 'b' || msg.role === 'c') ? msg.role : 'c';
    conn.send({ type: 'hello-ack', role: conn.role, id: conn.id });
    console.log('[ws] ' + conn.id + ' 声明角色: ' + conn.role);
    return;
  }

  /* 控制指令：只有 B 端可以发 */
  if (msg.type === 'command') {
    if (conn.role !== 'b') {
      conn.send({ type: 'error', code: 'forbidden', message: 'C 端为只读，不能下发控制指令' });
      return;
    }
    const r = applyCommand(msg.payload || {}, 'ws:' + conn.id);
    conn.send({ type: 'command-ack', id: msg.id, result: r });
    return;
  }

  if (msg.type === 'ping') {
    conn.send({ type: 'pong', t: msg.t, serverTime: Date.now() });
    return;
  }

  /* 客户端主动索要当前状态（首帧兜底，避免抢发丢帧） */
  if (msg.type === 'sync') {
    conn.send(SIM.snapshot());
    return;
  }
});

/* ===========================================================
   指令分发
   =========================================================== */
function applyCommand(payload, from) {
  const cmd = payload.action || payload.cmd;
  const t0 = Date.now();
  let result = { ok: true, action: cmd };

  try {
    switch (cmd) {
      case 'device':
        SIM.setDevice(payload.name, !!payload.on);
        result.state = { name: payload.name, on: !!payload.on };
        break;

      case 'deviceMode':
        SIM.setDeviceMode(payload.name, payload.mode);
        result.state = { name: payload.name, mode: payload.mode };
        break;

      case 'allOff':
        SIM.allOff();
        break;

      case 'allAuto':
        SIM.setAllAuto();
        break;

      case 'online':
        SIM.setOnline(!!payload.online);
        result.state = { online: S.online };
        break;

      case 'cfg':
        SIM.setCfg(payload.patch || {});
        result.state = S.cfg;
        break;

      case 'speed':
        SIM.setSpeed(Number(payload.speed) || 60);
        break;

      case 'running':
        SIM.setRunning(!!payload.running);
        break;

      case 'doorForce':
        SIM.setDoorForce(!!payload.force);
        break;

      case 'ackEvent':
        SIM.ackEvent(payload.id);
        break;

      case 'ackAll':
        SIM.ackAll();
        break;

      case 'pickParcel':
        result.ok = SIM.pickParcel(payload.id);
        break;

      case 'demoStart':
        SIM.startDemo();
        break;

      case 'demoStop':
        SIM.stopDemo();
        break;

      default:
        result = { ok: false, error: 'unknown action: ' + cmd };
    }
  } catch (e) {
    result = { ok: false, error: e.message };
  }

  result.tookMs = Date.now() - t0;
  result.from = from;

  if (result.ok) {
    console.log('[cmd] ' + cmd + ' from ' + from + ' (' + result.tookMs + 'ms)');
    broadcastNow();   // 指令生效后立即广播，B/C 同时看到
  }
  return result;
}

/* ===========================================================
   状态广播
   =========================================================== */
let lastBroadcast = 0;
let broadcastTimer = null;

function broadcastNow() {
  const snap = SIM.snapshot();
  const n = wss.broadcast(snap);
  lastBroadcast = Date.now();
  return n;
}

/* 每秒推一次状态；有变化时合并到 1 帧内，避免刷屏 */
function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setImmediate(() => {
    broadcastTimer = null;
    broadcastNow();
  });
}

/* 内核 tick 驱动广播 */
SIM.on('tick', () => scheduleBroadcast());

/* 报警与演示事件即时推送（不等下一帧） */
SIM.on('alarm', (ev) => {
  wss.broadcast({ type: 'event', kind: 'alarm', event: ev });
  console.log('[alarm] ' + ev.title + ' - ' + ev.level);
});
SIM.on('resolve', (ev) => {
  wss.broadcast({ type: 'event', kind: 'resolve', key: ev.key });
});
SIM.on('demo', (ev) => {
  wss.broadcast({ type: 'demo', demo: ev });
  console.log('[demo] ' + ev.label);
});
SIM.on('device', (ev) => {
  wss.broadcast({ type: 'device', device: ev });
});

/* ===========================================================
   启动
   =========================================================== */
server.listen(PORT, HOST, () => {
  const nets = require('os').networkInterfaces();
  const lanIps = [];
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((ni) => {
      if (ni.family === 'IPv4' && !ni.internal) lanIps.push(ni.address);
    });
  });

  console.log('');
  console.log('  ╔════════════════════════════════════════════════════╗');
  console.log('  ║   社区快递驿站 · 实时监测平台（真 B/C 架构）        ║');
  console.log('  ╚════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  入口页    http://127.0.0.1:' + PORT + '/');
  console.log('  B 端      http://127.0.0.1:' + PORT + '/b.html');
  console.log('  C 端      http://127.0.0.1:' + PORT + '/c.html');
  if (lanIps.length) {
    console.log('');
    console.log('  局域网（手机可访问，同一 WiFi）：');
    lanIps.forEach((ip) => {
      console.log('    http://' + ip + ':' + PORT + '/');
    });
  }
  console.log('');
  console.log('  WebSocket  ws://127.0.0.1:' + PORT + '/ws');
  console.log('  健康检查   http://127.0.0.1:' + PORT + '/api/health');
  console.log('  状态快照   http://127.0.0.1:' + PORT + '/api/state');
  console.log('  硬件上行   POST /api/ingest  (X-Device-Token: ' + DEVICE_TOKEN + ')');
  console.log('');
});

/* ===========================================================
   优雅退出：落盘后关闭
   =========================================================== */
function shutdown(sig) {
  console.log('\n[shutdown] 收到 ' + sig + '，正在保存状态…');
  try { SIM.saveNow(); } catch (e) {}
  try { wss.close(); } catch (e) {}
  try { server.close(); } catch (e) {}
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
