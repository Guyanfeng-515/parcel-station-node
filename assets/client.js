/* ===========================================================
   社区快递驿站 · 实时监测平台  前端连接层 (client.js)
   -----------------------------------------------------------
   真 B/C 架构的前端半边：
     · 通过 WebSocket 订阅服务端唯一状态
     · 断线自动重连（指数退避）
     · 暴露 client.send() 下发指令（仅 B 端有效）
     · 兼容层：把服务端状态映射成旧 UI 期望的 SIM.S 形状，
       这样 b-app.js / c-app.js 的渲染代码几乎不用改。

   数据流： 服务端 ──state──> client.state ──> 各页面渲染
   控制流： 页面 ──send()──> 服务端 ──command-ack──> 页面
   =========================================================== */
(function (global) {
  'use strict';

  var WS_URL = (function () {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  })();

  var C = {
    role: 'c',            // 'b' | 'c'
    connected: false,
    state: null,          // 服务端最新快照
    lastRecvAt: 0,
    rtt: null,
    reconnectDelay: 800,
    id: null,
    hardwareMode: false
  };

  var ws = null;
  var handlers = {};      // 事件订阅
  var cmdSeq = 0;
  var pendingCmds = {};   // id -> callback
  var manuallyClosed = false;

  /* ---------- 事件总线 ---------- */
  function on(ev, fn) {
    (handlers[ev] = handlers[ev] || []).push(fn);
    return function () { off(ev, fn); };
  }
  function off(ev, fn) {
    var a = handlers[ev];
    if (!a) return;
    var i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  function emit(ev, payload) {
    (handlers[ev] || []).forEach(function (fn) {
      try { fn(payload, C); } catch (e) { console.error(e); }
    });
  }

  /* ---------- 连接 ---------- */
  function connect(role) {
    if (role) C.role = role;
    manuallyClosed = false;

    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      C.connected = true;
      C.reconnectDelay = 800;
      emit('status', { connected: true });
      send({ type: 'hello', role: C.role });
      // 主动索要首帧：不依赖服务端抢发，避免浏览器 onmessage 尚未就绪时丢帧
      send({ type: 'sync' });
      setTimeout(function () { if (C.connected) send({ type: 'sync' }); }, 400);
      // 延迟探测时延
      setTimeout(pingOnce, 500);
    };

    ws.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      C.lastRecvAt = Date.now();

      if (msg.type === 'state') {
        C.state = msg;
        emit('state', msg);
        return;
      }
      if (msg.type === 'hello') {
        C.id = msg.id;
        C.hardwareMode = !!msg.hardwareMode;
        emit('hello', msg);
        return;
      }
      if (msg.type === 'hello-ack') {
        C.role = msg.role;
        emit('role', msg);
        return;
      }
      if (msg.type === 'command-ack') {
        var cb = pendingCmds[msg.id];
        if (cb) { delete pendingCmds[msg.id]; cb(msg.result); }
        emit('ack', msg);
        return;
      }
      if (msg.type === 'event') {
        emit('event', msg);
        return;
      }
      if (msg.type === 'demo') {
        emit('demo', msg.demo);
        return;
      }
      if (msg.type === 'device') {
        emit('device', msg.device);
        return;
      }
      if (msg.type === 'error') {
        emit('error', msg);
        return;
      }
      if (msg.type === 'pong') {
        if (msg.t) C.rtt = Date.now() - msg.t;
        emit('pong', msg);
        return;
      }
    };

    ws.onclose = function () {
      C.connected = false;
      emit('status', { connected: false });
      if (!manuallyClosed) scheduleReconnect();
    };

    ws.onerror = function () {
      try { ws.close(); } catch (e) {}
    };
  }

  function scheduleReconnect() {
    emit('status', { connected: false, reconnecting: true });
    setTimeout(function () {
      if (!manuallyClosed) connect();
    }, C.reconnectDelay);
    C.reconnectDelay = Math.min(8000, C.reconnectDelay * 1.7);
  }

  function pingOnce() {
    send({ type: 'ping', t: Date.now() });
  }

  /* ---------- 发送 ---------- */
  function send(obj) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; }
    catch (e) { return false; }
  }

  /* 下发控制指令（仅 B 端有效；C 端会被服务端拒绝） */
  function command(payload, cb) {
    var id = 'c' + (++cmdSeq) + '-' + Date.now();
    if (cb) pendingCmds[id] = cb;
    var okSent = send({ type: 'command', id: id, payload: payload });
    if (!okSent) {
      delete pendingCmds[id];
      if (cb) cb({ ok: false, error: '未连接到服务器' });
    }
    return okSent;
  }

  /* ---------- 心跳与时延 ---------- */
  setInterval(function () {
    if (C.connected) pingOnce();
  }, 10000);

  /* 超过 8 秒没收到状态，认为连接异常 */
  setInterval(function () {
    if (C.connected && C.lastRecvAt && Date.now() - C.lastRecvAt > 8000) {
      try { ws.close(); } catch (e) {}
    }
  }, 4000);

  /* ===========================================================
     兼容层：把服务端快照映射成旧 UI 期望的 SIM.S 形状
     -----------------------------------------------------------
     这样 b-app.js / c-app.js 里所有读取 S.env.temp、S.dev.fan.on
     这类代码无需改动，真正做到"只换数据源，不换界面"。
     =========================================================== */
  var mirror = {
    ready: false,
    t: Date.now(),
    speed: 60,
    running: true,
    online: true,
    frames: 0,
    uplink: { seq: 0, rssi: -52, latency: 26, bytes: 140 },
    cfg: {},
    dev: {
      fan: { on: false, mode: 'auto' },
      ac: { on: false, mode: 'auto' },
      light: { on: false, mode: 'auto' }
    },
    env: { temp: 26, hum: 55, lux: 0, people: 0, doorOpen: false, comfort: 0,
           tempDisp: 26, humDisp: 55, luxDisp: 0 },
    hist: [],
    rt: [],
    events: [],
    activeAlarms: {},
    energy: { savedKwh: 0, savedMoney: 0, usedKwh: 0, baseKwh: 0, acKwh: 0 },
    stats: { arrive: 0, picked: 0, pending: 0, peakPeople: 0, maxTemp: 0, minTemp: 99 },
    parcels: [],
    doorForce: false,
    demoForce: { people: 0, targetTemp: 0, heat: 0 }
  };

  function applyState(s) {
    mirror.ready = true;
    mirror.t = s.t;
    mirror.speed = s.speed;
    mirror.running = s.running;
    mirror.online = s.online;
    mirror.frames = s.frames;
    mirror.uplink = s.uplink || mirror.uplink;
    mirror.cfg = s.cfg || mirror.cfg;
    mirror.dev = s.dev || mirror.dev;
    mirror.env = s.env || mirror.env;
    mirror.hist = s.hist || [];
    mirror.rt = s.rt || [];
    mirror.events = s.events || [];
    mirror.activeAlarms = s.activeAlarms || {};
    mirror.energy = s.energy || mirror.energy;
    mirror.stats = s.stats || mirror.stats;
    mirror.parcels = s.parcels || [];
    mirror.derived = s.derived || {};
    mirror.demo = s.demo || { running: false, step: 0, total: 7 };
  }

  on('state', applyState);

  /* ===========================================================
     对外接口：伪装成原来的 SIM，让 UI 代码零改动
     =========================================================== */
  var SIM = {
    S: mirror,

    /* UI 调 init() 时建立连接 */
    init: function (role) {
      connect(role || C.role);
      return mirror;
    },

    on: on,
    off: off,

    /* ---- 控制类：全部转成 WebSocket 指令 ---- */
    setDevice: function (name, onOff) {
      command({ action: 'device', name: name, on: !!onOff });
    },
    setDeviceMode: function (name, mode) {
      command({ action: 'deviceMode', name: name, mode: mode });
    },
    allOff: function () { command({ action: 'allOff' }); },
    setAllAuto: function () { command({ action: 'allAuto' }); },
    setOnline: function (v) { command({ action: 'online', online: !!v }); },
    setCfg: function (patch) { command({ action: 'cfg', patch: patch }); },
    setSpeed: function (v) { command({ action: 'speed', speed: v }); },
    setRunning: function (v) { command({ action: 'running', running: !!v }); },
    setDoorForce: function (v) { command({ action: 'doorForce', force: !!v }); },
    ackEvent: function (id) { command({ action: 'ackEvent', id: id }); },
    ackAll: function () { command({ action: 'ackAll' }); },
    pickParcel: function (id) { command({ action: 'pickParcel', id: id }); },
    startDemo: function () { command({ action: 'demoStart' }); },
    stopDemo: function () { command({ action: 'demoStop' }); },

    /* ---- 派生数据：优先用服务端算好的，保证 B/C 一致 ---- */
    comfortLabel: function () {
      return (mirror.derived && mirror.derived.comfortText) ||
             ['舒适', '略闷', '闷热'][mirror.env.comfort] || '—';
    },
    crowdLabel: function () {
      return (mirror.derived && mirror.derived.crowd) || (function () {
        var n = mirror.env.people;
        return n === 0 ? '空闲' : n <= 2 ? '较少' : n <= 4 ? '一般' : '高峰';
      })();
    },
    isOpen: function () {
      if (mirror.derived && typeof mirror.derived.isOpen === 'boolean') return mirror.derived.isOpen;
      var d = new Date(mirror.t);
      var h = d.getHours() + d.getMinutes() / 60;
      return h >= 7.5 && h < 21.5;
    },
    todaySavingRate: function () {
      return (mirror.derived && mirror.derived.savingRate) || 0;
    },
    paybackDays: function () {
      return (mirror.derived && mirror.derived.paybackDays != null)
        ? mirror.derived.paybackDays : null;
    },
    dailySavingEstimate: function () {
      return (mirror.derived && mirror.derived.dailySaving) || 0;
    },
    activeAlarmList: function () {
      var out = [];
      Object.keys(mirror.activeAlarms || {}).forEach(function (k) {
        var id = mirror.activeAlarms[k];
        for (var i = 0; i < mirror.events.length; i++) {
          if (mirror.events[i].id === id) out.push(mirror.events[i]);
        }
      });
      return out;
    },
    unackedCount: function () {
      if (mirror.derived && typeof mirror.derived.unacked === 'number') return mirror.derived.unacked;
      return mirror.events.filter(function (e) { return !e.acked; }).length;
    },
    hourOf: function (t) {
      var d = new Date(t == null ? mirror.t : t);
      return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
    },

    COST_PER_KWH: 0.62,
    KW: { light: 0.18, fan: 0.06, ac: 1.2 },
    BUILD_COST: 66,
    MY_PHONE: '8823',

    /* ---- 连接状态（页面用来显示"已连接/重连中"） ---- */
    client: C,
    connect: connect,
    command: command,
    isConnected: function () { return C.connected; }
  };

  global.SIM = SIM;
})(window);
