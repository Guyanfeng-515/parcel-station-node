/* ===========================================================
   社区快递驿站 · 实时监测平台  仿真内核（服务端版）
   -----------------------------------------------------------
   严格对应 PPT 方案：
     感知层  DHT11 温湿度 / 光敏电阻 / 人体红外 PIR (+ 门磁)
     网络层  WiFi 上行 + 指令下行
     应用层  温度-通风联动、照明联动、两类预警（高温 / 失联）

   ⚠ 与 assets/sim.js 的区别：
     本文件运行在 Node 服务端，是整个系统的【唯一状态源】。
     浏览器端不再各自仿真，而是通过 WebSocket 订阅这里的状态。
     数据落盘到 data/state.json，服务重启后继续。
   =========================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

  /* ---------- 常量 ---------- */
  var COST_PER_KWH = 0.62;      // 电价 元/度（居民商业合表估算）
  var KW_LIGHT = 0.18;          // 照明 180W（40㎡ 驿站 4 支灯管）
  var KW_FAN   = 0.06;          // 排风扇 60W
  var KW_AC    = 1.20;          // 空调 1.5 匹 1200W（舒适性设备，不计入节能核算）
  var BUILD_COST = 66;          // 单店改造成本（PPT 成本核算表）
  var HIST_STEP = 60 * 1000;    // 今日曲线 1 分钟一个点
  var RT_LEN = 180;             // 实时曲线保留 180 个点

  /* ---------- 确定性伪随机（同一分钟内稳定，避免数字乱跳） ---------- */
  function hash01(a, b, c) {
    var x = Math.sin(a * 127.1 + b * 311.7 + (c || 0) * 74.7) * 43758.5453;
    return x - Math.floor(x);
  }

  /* ---------- 默认配置 ---------- */
  function defaultCfg() {
    return {
      tempSafe: 30,     // 包裹安全温度线（PPT 核心创新点）
      tempAC: 32,       // 自动开空调阈值
      tempAlarm: 35,    // 高温报警阈值（PPT 预警条件）
      humAlarm: 75,     // 湿度过高报警
      luxDark: 80,      // 判定"光线不足"的照度
      hotDay: false,    // 模拟极端高温日
      autoFan: true,
      autoAC: true,
      autoLight: true
    };
  }

  /* ---------- 设备 ---------- */
  function defaultDev() {
    return {
      fan:   { on: false, mode: 'auto' },
      ac:    { on: false, mode: 'auto' },
      light: { on: false, mode: 'auto' }
    };
  }

  /* ---------- 状态 ---------- */
  var S = {
    ready: false,
    t: Date.now(),          // 驿站（仿真）时间
    speed: 60,              // 倍速：默认 60×（1 真实秒 = 1 仿真分钟，肉眼可见变化）
    frames: 0,              // 帧计数（驱动传感器噪声与上行序号）
    dayStart: 0,            // 本仿真日的 00:00
    running: true,
    online: true,           // 网络在线
    dayKey: '',
    cfg: defaultCfg(),
    dev: defaultDev(),
    env: { temp: 28, hum: 58, lux: 0, people: 0, doorOpen: false, comfort: 2,
           tempDisp: 28, humDisp: 58, luxDisp: 0 },
    uplink: { seq: 0, rssi: -52, latency: 26, bytes: 140 },
    doorForce: false,       // 门磁强制打开（模拟忘记关门）
    demoForce: { heat: 0, people: 0, targetTemp: 0 },  // 演示强制环境
    hardwareMode: false,    // 已接入真实硬件
    hardwareSeenAt: 0,      // 最近一次硬件上报时间
    hardwareStaleMs: 30000, // 超过此时长没上报，视为硬件掉线
    hist: [],               // 今日 1 分钟曲线
    rt: [],                 // 实时曲线（1 秒 1 点）
    events: [],
    activeAlarms: {},       // key -> eventId
    energy: { savedKwh: 0, savedMoney: 0, usedKwh: 0, baseKwh: 0, acKwh: 0 },
    stats: { arrive: 0, picked: 0, pending: 0, peakPeople: 0, maxTemp: 0, minTemp: 99 },
    parcels: [],
    subs: {}
  };

  /* =========================================================
     物理/环境模型
     ========================================================= */
  function hourOf(t) {
    var d = new Date(t);
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  }

  // 室外温度：03:00 最低 22℃，15:00 最高 34℃
  function outdoorTemp(h) {
    var base = 28 + 6 * Math.sin((h - 9) * Math.PI / 12);
    if (S.cfg.hotDay) base += 3.2;
    // 演示强制升温：不受时段影响，保证能跨过阈值
    if (S.demoForce.heat > 0) base = Math.max(base, S.demoForce.heat);
    return base;
  }

  // 营业曲线：08:00-21:00 营业，午高峰 11:30-13:00，晚高峰 17:00-19:30
  function occupancyTarget(h, seed) {
    // 演示强制客流：保证"有人"这一联动条件成立
    if (S.demoForce.people > 0) return S.demoForce.people;
    if (h < 7.6 || h > 21.4) return 0;
    var g1 = Math.exp(-Math.pow((h - 12.2) / 0.9, 2));
    var g2 = Math.exp(-Math.pow((h - 18.2) / 1.25, 2));
    var open = 1.2 + 3.4 * g1 + 4.2 * g2;
    var r = hash01(Math.floor(h * 60), seed, 7);
    return Math.max(0, Math.round(open * (0.55 + 0.9 * r)));
  }

  function indoorBaseTemp(h) {
    var out = outdoorTemp(h);
    // 40 ㎡ 单层砖混 + 门窗，室内随室外变化但被削弱
    return 26 + (out - 26) * 0.72;
  }

  /* 单步推进（dtMin = 推进的分钟数） */
  function stepEnv(dtMin) {
    var h = hourOf(S.t);
    var e = S.env;
    var seed = Math.floor(S.t / 60000);

    /* =====================================================
       硬件模式：读数来自真实传感器，绝不覆盖
       -----------------------------------------------------
       此时只做两件事：
         1. 应用层联动（按真实温度/人数决定继电器）
         2. 能耗核算
       环境数值保持 ESP32 上报的值不变。
       ===================================================== */
    if (S.hardwareMode) {
      var fresh = (Date.now() - S.hardwareSeenAt) < S.hardwareStaleMs;

      if (!fresh) {
        // 硬件掉线：设备失联，停止联动以免误动作
        S.hardwareOffline = true;
      } else {
        S.hardwareOffline = false;
        autoControl(h);
      }

      // 能耗仍按继电器实际状态累计
      var dtHh = dtMin / 60;
      var usedH = (S.dev.light.on ? KW_LIGHT : 0) + (S.dev.fan.on ? KW_FAN : 0);
      var baseH = baselineLoad(h);
      S.energy.usedKwh += usedH * dtHh;
      S.energy.baseKwh += baseH * dtHh;
      S.energy.acKwh += (S.dev.ac.on ? KW_AC : 0) * dtHh;
      S.energy.savedKwh += Math.max(0, (baseH - usedH) * dtHh);
      S.energy.savedMoney = S.energy.savedKwh * COST_PER_KWH;

      // 显示值直接用真实读数（真实传感器本身就有波动，不需要再加噪声）
      e.tempDisp = e.temp;
      e.humDisp = e.hum;
      e.luxDisp = e.lux;

      if (e.temp > S.stats.maxTemp) S.stats.maxTemp = e.temp;
      if (e.temp < S.stats.minTemp) S.stats.minTemp = e.temp;
      if (e.people > S.stats.peakPeople) S.stats.peakPeople = e.people;

      return;
    }

    /* ---------- 以下为仿真模式 ---------- */

    /* --- 人员：PIR 计数 --- */
    var target = occupancyTarget(h, seed);
    if (S.demoForce.people > 0) {
      // 演示强制客流：直接到位，不等平滑爬升
      e.people = S.demoForce.people;
    } else if (target > e.people) {
      e.people = Math.min(target, e.people + Math.ceil(dtMin * 2));
    } else if (target < e.people) {
      e.people = Math.max(target, e.people - Math.ceil(dtMin * 2));
    }
    if (e.people > S.stats.peakPeople) S.stats.peakPeople = e.people;

    /* --- 门磁 --- */
    e.doorOpen = S.doorForce || (e.people > 0 && hash01(seed, 3, 9) > 0.45);

    /* --- 自动联动（应用层核心逻辑） --- */
    autoControl(h);

    /* --- 温度（真值平滑演化，单目标逼近，避免震荡） --- */
    var tgt;
    if (S.demoForce.targetTemp > 0) {
      // 演示模式：直接给目标温度，不再叠加室外/空调拉扯
      tgt = S.demoForce.targetTemp;
    } else {
      tgt = indoorBaseTemp(h) + e.people * 0.06 + (S.dev.light.on ? 0.18 : 0);
      if (S.dev.fan.on) tgt -= 0.95;
      if (S.dev.ac.on) tgt = Math.min(tgt, 26);
    }
    var k = Math.min(1, (S.dev.ac.on ? 0.30 : 0.13) * dtMin);
    e.temp += (tgt - e.temp) * k;

    /* --- 湿度 --- */
    var htgt = 54 + e.people * 1.1 - (S.dev.fan.on ? 9 : 0) - (S.dev.ac.on ? 11 : 0);
    if (S.cfg.hotDay) htgt -= 4;
    e.hum += (htgt - e.hum) * Math.min(1, 0.09 * dtMin);

    /* --- 光照（光敏电阻） --- */
    var day = Math.max(0, Math.sin((h - 6) / 12 * Math.PI));
    var lux = day * 9000 + (S.dev.light.on ? 340 : 0);
    if (S.dev.light.on && day > 0.2) lux = day * 9000 + 340;
    e.lux = Math.max(0, lux * (0.92 + 0.16 * hash01(seed, 31, 2)));

    /* --- 传感器噪声：每帧变化，肉眼可见"在动"
       DHT11 实测精度 ±0.5℃ / ±2%，这里取可见且合理的抖动 --- */
    var f = S.frames;
    e.tempDisp = e.temp + (hash01(f, 101, 1) - 0.5) * 0.36;
    e.humDisp  = e.hum  + (hash01(f, 211, 2) - 0.5) * 1.8;
    e.luxDisp  = Math.max(0, e.lux * (0.93 + 0.14 * hash01(f, 307, 3)));

    /* --- 舒适度：0 舒适 / 1 略闷 / 2 闷热 --- */
    e.comfort = e.temp > 32 || e.hum > 74 ? 2 : (e.temp > 30 || e.hum > 68 ? 1 : 0);

    /* --- 能耗核算（照明 + 排风扇；空调另计） --- */
    var dtH = dtMin / 60;
    var used = (S.dev.light.on ? KW_LIGHT : 0) + (S.dev.fan.on ? KW_FAN : 0);
    var base = baselineLoad(h);
    S.energy.usedKwh += used * dtH;
    S.energy.baseKwh += base * dtH;
    S.energy.acKwh += (S.dev.ac.on ? KW_AC : 0) * dtH;
    var saved = Math.max(0, (base - used) * dtH);
    S.energy.savedKwh += saved;
    S.energy.savedMoney = S.energy.savedKwh * COST_PER_KWH;

    /* --- 统计 --- */
    if (e.temp > S.stats.maxTemp) S.stats.maxTemp = e.temp;
    if (e.temp < S.stats.minTemp) S.stats.minTemp = e.temp;
  }

  /* 传统做法基线：灯从早亮到晚、排风扇整个营业时段常开
     （与 PPT 一致：省下的电费 = 自动关灯 + 自动关风扇；
       空调属舒适性设备，单独统计，不计入节能核算） */
  function baselineLoad(h) {
    var kw = 0;
    if (h >= 6 && h < 23) kw += KW_LIGHT;
    if (h >= 8 && h < 21) kw += KW_FAN;
    return kw;
  }

  /* =========================================================
     应用层 · 自动控制逻辑
     ========================================================= */
  function autoControl(h) {
    var e = S.env, c = S.cfg, d = S.dev;

    // 温度 / 通风联动：温度超安全线且有人 → 开排风扇；更高 → 开空调；无人 → 停（节能）
    if (d.fan.mode === 'auto' && c.autoFan) {
      d.fan.on = e.people > 0 && e.temp > c.tempSafe;
    }
    if (d.ac.mode === 'auto' && c.autoAC) {
      d.ac.on = e.people > 0 && e.temp > c.tempAC;
    }
    // 照明联动：光线不足且有人 → 开灯；无人 → 关灯
    if (d.light.mode === 'auto' && c.autoLight) {
      d.light.on = e.people > 0 && e.lux < c.luxDark;
    }
  }

  /* =========================================================
     报警引擎
     ========================================================= */
  var ALARM_DEFS = {
    temp_warn:  { level: 'mid',  icon: '🌡️', title: '温度接近安全线',   msg: '室内温度超过 {tempSafe}℃，包裹存在受热风险，已自动开启排风扇。' },
    temp_alarm: { level: 'high', icon: '🔥', title: '高温报警',         msg: '室内温度已达 {v}℃，超过 {tempAlarm}℃ 报警线，生鲜、巧克力等货品有变质风险，请立即处理。' },
    hum_high:   { level: 'mid',  icon: '💧', title: '湿度过高',         msg: '室内湿度 {v}%，纸箱受潮易变形，建议开启排风除湿。' },
    offline:    { level: 'high', icon: '📡', title: '设备离线',         msg: '驿站监测设备已失联，可能是停电或断网，请及时到店检查，避免"以为在监控、其实已失联"。' },
    door_open:  { level: 'mid',  icon: '🚪', title: '疑似忘记关门',     msg: '无人时段门磁仍处于开启状态已超过 5 分钟，存在包裹丢失风险。' },
    night_waste:{ level: 'low',  icon: '💡', title: '夜间设备未关',     msg: '打烊后仍有设备处于开启状态，正在产生无谓电费。' }
  };

  var doorOpenSince = 0;

  function raise(key, extra) {
    if (S.activeAlarms[key]) return;
    var def = ALARM_DEFS[key];
    var msg = def.msg
      .replace('{tempSafe}', S.cfg.tempSafe)
      .replace('{tempAlarm}', S.cfg.tempAlarm)
      .replace('{v}', extra && extra.v != null ? extra.v : '');
    var ev = {
      id: 'ev' + S.t + '_' + key,
      key: key,
      level: def.level,
      icon: def.icon,
      title: def.title,
      msg: msg,
      ts: S.t,
      resolvedAt: 0,
      acked: false
    };
    S.events.unshift(ev);
    if (S.events.length > 120) S.events.length = 120;
    S.activeAlarms[key] = ev.id;
    emit('alarm', ev);
  }

  function clear(key) {
    var id = S.activeAlarms[key];
    if (!id) return;
    for (var i = 0; i < S.events.length; i++) {
      if (S.events[i].id === id) { S.events[i].resolvedAt = S.t; break; }
    }
    delete S.activeAlarms[key];
    emit('resolve', { key: key });
  }

  function checkAlarms() {
    var e = S.env, c = S.cfg, h = hourOf(S.t);

    if (!S.online) {
      raise('offline');
      return; // 离线时不再产生其它实时报警
    }
    clear('offline');

    if (e.temp > c.tempAlarm) raise('temp_alarm', { v: e.temp.toFixed(1) });
    else clear('temp_alarm');

    if (e.temp > c.tempSafe) raise('temp_warn');
    else clear('temp_warn');

    if (e.hum > c.humAlarm) raise('hum_high', { v: e.hum.toFixed(0) });
    else clear('hum_high');

    if (e.doorOpen && e.people === 0) {
      if (!doorOpenSince) doorOpenSince = S.t;
      if (S.t - doorOpenSince > 5 * 60 * 1000) raise('door_open');
    } else {
      doorOpenSince = 0;
      clear('door_open');
    }

    var closed = (h >= 21.5 || h < 7.5);
    var anyOn = S.dev.fan.on || S.dev.ac.on || S.dev.light.on;
    if (closed && e.people === 0 && anyOn) raise('night_waste');
    else clear('night_waste');
  }

  /* =========================================================
     包裹数据
     ========================================================= */
  var COURIERS = ['顺丰速运', '中通快递', '圆通速递', '韵达快递', '京东物流', '极兔速递'];
  var SIZES = ['小件', '中件', '大件'];
  var MY_PHONE = '8823';

  function seedParcels() {
    var list = [];
    var now = Date.now();
    var codes = ['6-2-108', '3-1-042', '7-4-215', '2-3-077', '5-1-330', '8-2-119', '4-3-056', '1-2-201'];
    for (var i = 0; i < 8; i++) {
      var arrived = now - Math.floor(hash01(i, 5, 2) * 26 + 1) * 3600 * 1000;
      list.push({
        id: 'p' + i,
        code: codes[i],
        courier: COURIERS[Math.floor(hash01(i, 9, 1) * COURIERS.length)],
        shelf: 'ABCD'[Math.floor(hash01(i, 13, 4) * 4)] + '-' + (1 + Math.floor(hash01(i, 17, 6) * 4)) + '排',
        size: SIZES[Math.floor(hash01(i, 21, 8) * 3)],
        arrivedAt: arrived,
        status: i < 3 ? 'picked' : 'pending',
        phone: i % 2 === 0 ? MY_PHONE : '510' + i,
        fresh: i === 4 || i === 6      // 含生鲜/巧克力类
      });
    }
    S.parcels = list;
    S.stats.pending = list.filter(function (p) { return p.status === 'pending'; }).length;
    S.stats.picked = list.filter(function (p) { return p.status === 'picked'; }).length;
    S.stats.arrive = list.length;
  }

  /* =========================================================
     今日历史预灌（00:00 → 现在，1 分钟一个点）
     ========================================================= */
  function seedHistory() {
    S.hist = [];
    S.energy = { savedKwh: 0, savedMoney: 0, usedKwh: 0, baseKwh: 0, acKwh: 0 };
    S.stats.maxTemp = 0; S.stats.minTemp = 99; S.stats.peakPeople = 0;

    var now = new Date(S.t);
    var start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var savedT = S.t;
    var e = { temp: 26, hum: 58, lux: 0, people: 0, doorOpen: false, comfort: 2,
              tempDisp: 26, humDisp: 58, luxDisp: 0 };
    S.env = e;

    var cur = start;
    var guard = 0;
    while (cur < savedT && guard++ < 2000) {
      S.t = cur;
      // 历史预灌阶段不让报警刷屏
      stepEnvNoAlarm(1);
      S.hist.push({
        t: cur,
        temp: +e.temp.toFixed(2),
        hum: +e.hum.toFixed(1),
        lux: Math.round(e.lux),
        people: e.people
      });
      cur += HIST_STEP;
    }
    S.t = savedT;
    S.rt = [];
    S.activeAlarms = {};
    doorOpenSince = 0;
    seedEventsFromHistory();
  }

  /* 从今日历史曲线里回溯出报警记录（已恢复的历史事件） */
  function seedEventsFromHistory() {
    S.events = [];
    var segs = [], cur = null;
    S.hist.forEach(function (d) {
      if (d.temp > S.cfg.tempSafe) {
        if (!cur) cur = { from: d.t, to: d.t, max: d.temp };
        else { cur.to = d.t; if (d.temp > cur.max) cur.max = d.temp; }
      } else if (cur) { segs.push(cur); cur = null; }
    });
    if (cur) segs.push(cur);

    // 合并间隔小于 10 分钟的片段，避免阈值抖动造成刷屏
    var merged = [];
    segs.forEach(function (s) {
      var last = merged[merged.length - 1];
      if (last && s.from - last.to < 10 * 60 * 1000) {
        last.to = s.to;
        if (s.max > last.max) last.max = s.max;
      } else {
        merged.push({ from: s.from, to: s.to, max: s.max });
      }
    });

    merged.forEach(function (s) {
      // 只保留持续 3 分钟以上的片段
      if (s.to - s.from < 3 * 60 * 1000) return;
      var isHigh = s.max > S.cfg.tempAlarm;
      var def = ALARM_DEFS[isHigh ? 'temp_alarm' : 'temp_warn'];
      S.events.push({
        id: 'hist' + s.from,
        key: isHigh ? 'temp_alarm' : 'temp_warn',
        level: def.level,
        icon: def.icon,
        title: def.title,
        msg: def.msg.replace('{tempSafe}', S.cfg.tempSafe)
                    .replace('{tempAlarm}', S.cfg.tempAlarm)
                    .replace('{v}', s.max.toFixed(1)),
        ts: s.from,
        resolvedAt: s.to + 60000,
        acked: true,
        hist: true
      });
    });

    S.events.sort(function (a, b) { return b.ts - a.ts; });
    if (S.events.length > 120) S.events.length = 120;
  }

  function stepEnvNoAlarm(dtMin) {
    var h = hourOf(S.t);
    var e = S.env;
    var seed = Math.floor(S.t / 60000);
    var target = occupancyTarget(h, seed);
    e.people = S.demoForce.people > 0 ? S.demoForce.people : target;
    if (e.people > S.stats.peakPeople) S.stats.peakPeople = e.people;
    e.doorOpen = e.people > 0 && hash01(seed, 3, 9) > 0.45;
    autoControl(h);

    var tgt = indoorBaseTemp(h) + e.people * 0.06 + (S.dev.light.on ? 0.18 : 0);
    if (S.dev.fan.on) tgt -= 0.95;
    if (S.dev.ac.on) tgt = 26;
    e.temp += (tgt - e.temp) * Math.min(1, (S.dev.ac.on ? 0.22 : 0.075) * dtMin);
    e.temp += (hash01(seed, 11, 5) - 0.5) * 0.05;

    var htgt = 54 + e.people * 1.1 - (S.dev.fan.on ? 9 : 0) - (S.dev.ac.on ? 11 : 0);
    if (S.cfg.hotDay) htgt -= 4;
    e.hum += (htgt - e.hum) * Math.min(1, 0.09 * dtMin);

    var day = Math.max(0, Math.sin((h - 6) / 12 * Math.PI));
    e.lux = Math.max(0, day * 9000 + (S.dev.light.on ? 340 : 0));
    e.comfort = e.temp > 32 || e.hum > 74 ? 2 : (e.temp > 30 || e.hum > 68 ? 1 : 0);

    var dtH = dtMin / 60;
    var used = (S.dev.light.on ? KW_LIGHT : 0) + (S.dev.fan.on ? KW_FAN : 0);
    var base = baselineLoad(h);
    S.energy.usedKwh += used * dtH;
    S.energy.baseKwh += base * dtH;
    S.energy.acKwh += (S.dev.ac.on ? KW_AC : 0) * dtH;
    S.energy.savedKwh += Math.max(0, (base - used) * dtH);
    S.energy.savedMoney = S.energy.savedKwh * COST_PER_KWH;

    if (e.temp > S.stats.maxTemp) S.stats.maxTemp = e.temp;
    if (e.temp < S.stats.minTemp) S.stats.minTemp = e.temp;
  }

  /* =========================================================
     主循环
     ========================================================= */
  var lastTick = 0;
  var lastMinute = 0;

  function tick() {
    if (!S.running) return;
    var now = Date.now();
    if (!lastTick) lastTick = now;
    var wall = Math.min(3, (now - lastTick) / 1000); // 防止切标签页后跳跃
    lastTick = now;

    var advSec = wall * S.speed;
    S.t += advSec * 1000;
    S.frames++;

    // 跨天：重置今日曲线与统计（长跑演示时保持数据正确）
    var dk = new Date(S.t).toDateString();
    if (dk !== S.dayKey) {
      S.dayKey = dk;
      S.hist = [];
      S.events = [];
      S.activeAlarms = {};
      S.energy = { savedKwh: 0, savedMoney: 0, usedKwh: 0, baseKwh: 0, acKwh: 0 };
      S.stats = { arrive: 0, picked: 0, pending: 0, peakPeople: 0, maxTemp: 0, minTemp: 99 };
      doorOpenSince = 0;
    }

    if (S.online) {
      var dtMin = advSec / 60;
      stepEnv(dtMin);
      checkAlarms();

      // 实时曲线：每秒一个点（用带噪声的显示值，曲线有细微起伏）
      S.rt.push({
        t: S.t,
        temp: +S.env.tempDisp.toFixed(2),
        hum: +S.env.humDisp.toFixed(1),
        lux: Math.round(S.env.luxDisp),
        people: S.env.people
      });
      while (S.rt.length > RT_LEN) S.rt.shift();

      // 上行数据包（模拟 ESP32 每秒推一帧到云端）
      S.uplink = {
        seq: S.uplink.seq + 1,
        rssi: -46 - Math.round(hash01(S.frames, 401, 5) * 16),
        latency: 18 + Math.round(hash01(S.frames, 409, 6) * 34),
        bytes: 128 + Math.round(hash01(S.frames, 417, 7) * 48)
      };

      // 今日曲线：跨分钟才追加
      var m = Math.floor(S.t / HIST_STEP);
      if (m !== lastMinute) {
        lastMinute = m;
        S.hist.push({
          t: m * HIST_STEP,
          temp: +S.env.temp.toFixed(2),
          hum: +S.env.hum.toFixed(1),
          lux: Math.round(S.env.lux),
          people: S.env.people
        });
        if (S.hist.length > 1500) S.hist.shift();
      }
    }

    emit('tick', S);
  }

  /* =========================================================
     事件总线
     ========================================================= */
  function on(ev, fn) {
    (S.subs[ev] = S.subs[ev] || []).push(fn);
    return function () { off(ev, fn); };
  }
  function off(ev, fn) {
    var a = S.subs[ev];
    if (!a) return;
    var i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  function emit(ev, payload) {
    var a = S.subs[ev];
    if (a) for (var i = 0; i < a.length; i++) { try { a[i](payload, S); } catch (e) {} }
    var all = S.subs['*'];
    if (all) for (var j = 0; j < all.length; j++) { try { all[j]({ type: ev, payload: payload }, S); } catch (e) {} }
  }

  /* =========================================================
     对外操作
     ========================================================= */
  function setDevice(name, onOff) {
    var d = S.dev[name];
    if (!d) return;
    d.mode = 'manual';
    d.on = !!onOff;
    persist();
    emit('device', { name: name, on: d.on });
    emit('tick', S);
  }

  function setDeviceMode(name, mode) {
    var d = S.dev[name];
    if (!d) return;
    d.mode = mode;
    if (mode === 'auto') autoControl(hourOf(S.t));
    persist();
    emit('tick', S);
  }

  function allOff() {
    ['fan', 'ac', 'light'].forEach(function (k) { S.dev[k].mode = 'manual'; S.dev[k].on = false; });
    persist();
    emit('device', { name: 'all', on: false });
    emit('tick', S);
  }

  function setAllAuto() {
    ['fan', 'ac', 'light'].forEach(function (k) { S.dev[k].mode = 'auto'; });
    autoControl(hourOf(S.t));
    persist();
    emit('tick', S);
  }

  function setOnline(v) {
    var was = S.online;
    S.online = !!v;
    if (!S.online) {
      emit('offline', true);
      checkAlarms();          // 立即触发 offline 报警，不等下一帧
    } else {
      clear('offline');
      lastTick = 0;
      emit('offline', false);
      checkAlarms();
    }
    persist();
    if (was !== S.online) emit('tick', S);
  }

  function setCfg(patch) {
    Object.keys(patch).forEach(function (k) { S.cfg[k] = patch[k]; });
    if (S.cfg.autoFan && S.dev.fan.mode === 'auto') { /* 阈值立即生效 */ }
    autoControl(hourOf(S.t));
    persist();
    emit('tick', S);
  }

  function setSpeed(v) { S.speed = v; persist(); emit('tick', S); }
  function setRunning(v) { S.running = !!v; lastTick = 0; emit('tick', S); }
  function setDoorForce(v) { S.doorForce = !!v; emit('tick', S); }

  /* =========================================================
     演示剧本：一键把整条链路走一遍
     顾客进店 → 温度超线 → 自动开风扇 → 再超线 → 开空调
     → 顾客离店 → 自动全关 → 模拟断网报警 → 恢复
     ========================================================= */
  var demo = { running: false, step: 0, timer: null, total: 7 };

  var DEMO_STEPS = [
    {
      at: 0, label: '① 顾客进店，驿站开始有人活动',
      run: function () {
        S.demoForce.people = 3;         // 强制 3 人在店
        S.demoForce.targetTemp = 28.5;
        S.cfg.hotDay = false;
        S.doorForce = false;
        S.online = true;
        ['fan', 'ac', 'light'].forEach(function (k) { S.dev[k].mode = 'auto'; });
        clear('offline');
      }
    },
    {
      at: 4500, label: '② 天气转热，室内温度快速爬升',
      run: function () { S.demoForce.targetTemp = 29.6; }
    },
    {
      at: 10500, label: '③ 温度超过 30℃ 安全线 → 排风扇自动开启',
      run: function () { S.demoForce.targetTemp = 31.4; }
    },
    {
      at: 16500, label: '④ 温度继续超过 32℃ → 空调自动开启',
      run: function () { S.demoForce.targetTemp = 34.2; }
    },
    {
      at: 23000, label: '⑤ 模拟驿站断网，设备失联报警',
      run: function () { S.online = false; checkAlarms(); }
    },
    {
      at: 29000, label: '⑥ 网络恢复，报警自动消除',
      run: function () { S.online = true; clear('offline'); checkAlarms(); }
    },
    {
      at: 34000, label: '⑦ 顾客离店 → 自动关灯关风扇，节能',
      run: function () {
        S.demoForce.people = 0;         // 无人 → 自动关灯关风扇
        S.demoForce.targetTemp = 27;
        S.cfg.hotDay = false;
        S.online = true;
        checkAlarms();
      }
    }
  ];

  function startDemo() {
    if (demo.running) return;
    demo.running = true;
    demo.step = 0;
    var savedSpeed = S.speed;
    S.speed = 240;                 // 演示时大幅提速，20 秒内走完
    emit('demo', { type: 'start', label: '演示开始，仿真提速至 240×', total: demo.total });

    function next() {
      if (!demo.running) return;
      if (demo.step >= DEMO_STEPS.length) {
        S.speed = savedSpeed;
        demo.running = false;
        emit('demo', { type: 'end', label: '演示结束' });
        return;
      }
      var s = DEMO_STEPS[demo.step];
      try { s.run(); } catch (e) {}
      emit('demo', {
        type: 'step',
        index: demo.step + 1,
        total: DEMO_STEPS.length,
        label: s.label
      });
      demo.step++;
      var cur = DEMO_STEPS[demo.step];
      var delay = cur ? (cur.at - s.at) : 0;
      demo.timer = setTimeout(next, Math.max(600, delay));
    }
    next();
  }

  function stopDemo() {
    if (!demo.running) return;
    demo.running = false;
    if (demo.timer) clearTimeout(demo.timer);
    S.demoForce.heat = 0;
    S.demoForce.people = 0;
    S.demoForce.targetTemp = 0;
    S.speed = 60;
    emit('demo', { type: 'end', label: '演示已中止' });
  }

  function ackEvent(id) {
    for (var i = 0; i < S.events.length; i++) {
      if (S.events[i].id === id) { S.events[i].acked = true; break; }
    }
    persist();
    emit('tick', S);
  }
  function ackAll() {
    S.events.forEach(function (e) { e.acked = true; });
    persist();
    emit('tick', S);
  }

  function pickParcel(id) {
    for (var i = 0; i < S.parcels.length; i++) {
      if (S.parcels[i].id === id && S.parcels[i].status === 'pending') {
        S.parcels[i].status = 'picked';
        S.parcels[i].pickedAt = S.t;
        S.stats.pending = S.parcels.filter(function (p) { return p.status === 'pending'; }).length;
        S.stats.picked++;
        emit('tick', S);
        return true;
      }
    }
    return false;
  }

  /* =========================================================
     持久化（跨 B/C 页面共享手动状态）
     ========================================================= */
  /* 关键操作后立即落盘（服务端版本，替代原浏览器 localStorage） */
  function persist() {
    saveNow();
  }

  /* =========================================================
     持久化（落盘到 data/state.json）
     ---------------------------------------------------------
     服务重启后设备状态、阈值、今日曲线、报警记录、包裹都还在。
     每 20 秒自动存一次，关键操作立即存。
     ========================================================= */
  /* Render/云平台：免费版无持久磁盘，写失败时静默降级为纯内存模式 */
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const STATE_FILE = path.join(DATA_DIR, 'state.json');
  let diskOk = true;   // 首次写失败后置 false，后续不再尝试
  let saveTimer = null;

  function ensureDir() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (e) {}
  }

  function buildPersistable() {
    return {
      version: 2,
      savedAt: Date.now(),
      dayKey: S.dayKey,
      t: S.t,
      speed: S.speed,
      running: S.running,
      online: S.online,
      doorForce: S.doorForce,
      cfg: S.cfg,
      dev: S.dev,
      env: S.env,
      energy: S.energy,
      stats: S.stats,
      parcels: S.parcels,
      events: S.events.slice(0, 60),
      activeAlarms: S.activeAlarms,
      hist: S.hist.slice(-600)   // 只存最近 10 小时，避免文件过大
    };
  }

  function saveNow() {
    if (!diskOk) return false;   // 已确认不可写，跳过（云平台无持久盘）
    ensureDir();
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(buildPersistable()), 'utf8');
      return true;
    } catch (e) {
      diskOk = false;
      console.warn('[sim] 状态落盘不可用（云平台常见，已降级为纯内存运行）:', e.message);
      return false;
    }
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      saveNow();
    }, 20000);
    if (saveTimer.unref) saveTimer.unref();
  }

  function loadFromDisk() {
    try {
      if (!fs.existsSync(STATE_FILE)) return false;
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const o = JSON.parse(raw);

      // 跨天则丢弃今日曲线（保留设备与配置）
      const sameDay = o.dayKey === new Date().toDateString();

      if (o.cfg) Object.keys(o.cfg).forEach(function (k) { if (k in S.cfg) S.cfg[k] = o.cfg[k]; });
      if (o.dev) Object.keys(o.dev).forEach(function (k) { if (S.dev[k]) S.dev[k] = o.dev[k]; });
      if (o.speed) S.speed = o.speed;
      if (typeof o.online === 'boolean') S.online = o.online;
      if (typeof o.doorForce === 'boolean') S.doorForce = o.doorForce;

      if (sameDay) {
        if (o.energy) S.energy = o.energy;
        if (o.stats) S.stats = o.stats;
        if (Array.isArray(o.parcels) && o.parcels.length) S.parcels = o.parcels;
        if (Array.isArray(o.events)) S.events = o.events;
        if (o.activeAlarms) S.activeAlarms = o.activeAlarms;
        if (Array.isArray(o.hist) && o.hist.length) S.hist = o.hist;
        if (o.env && typeof o.env.temp === 'number') {
          Object.keys(o.env).forEach(function (k) { if (k in S.env) S.env[k] = o.env[k]; });
        }
      }
      console.log('[sim] 已从磁盘恢复状态（同日=' + sameDay + '，设备=' +
        ['fan', 'ac', 'light'].map(function (k) { return k + ':' + (S.dev[k].on ? 'ON' : 'off'); }).join(' ') + '）');
      return true;
    } catch (e) {
      console.error('[sim] 状态恢复失败（将从默认值开始）:', e.message);
      return false;
    }
  }

  /* =========================================================
     快照：发给前端的完整状态（唯一数据出口）
     ========================================================= */
  function snapshot() {
    var e = S.env;
    return {
      type: 'state',
      serverTime: Date.now(),
      t: S.t,
      speed: S.speed,
      running: S.running,
      online: S.online,
      frames: S.frames,
      uplink: S.uplink,
      cfg: S.cfg,
      dev: S.dev,
      env: {
        temp: +e.temp.toFixed(2),
        hum: +e.hum.toFixed(1),
        lux: Math.round(e.lux),
        tempDisp: +(e.tempDisp != null ? e.tempDisp : e.temp).toFixed(2),
        humDisp: +(e.humDisp != null ? e.humDisp : e.hum).toFixed(1),
        luxDisp: Math.round(e.luxDisp != null ? e.luxDisp : e.lux),
        people: e.people,
        doorOpen: !!e.doorOpen,
        comfort: e.comfort
      },
      energy: S.energy,
      stats: S.stats,
      parcels: S.parcels,
      events: S.events.slice(0, 40),
      activeAlarms: S.activeAlarms,
      rt: S.rt.slice(-90),
      hist: S.hist.slice(-320),
      demo: { running: demo.running, step: demo.step, total: demo.total },
      hardware: {
        mode: !!S.hardwareMode,
        offline: !!S.hardwareOffline,
        lastSeenAt: S.hardwareSeenAt || 0
      },
      derived: {
        isOpen: isOpen(),
        crowd: crowdLabel(),
        comfortText: comfortLabel(),
        savingRate: todaySavingRate(),
        paybackDays: paybackDays(),
        dailySaving: dailySavingEstimate(),
        unacked: unackedCount()
      }
    };
  }

  /* =========================================================
     初始化
     ========================================================= */
  function init() {
    if (S.ready) return S;
    S.t = Date.now();
    S.dayKey = new Date().toDateString();

    // 先建默认数据，再用磁盘状态覆盖
    seedParcels();
    seedHistory();
    loadFromDisk();

    lastMinute = Math.floor(S.t / HIST_STEP);
    S.ready = true;
    checkAlarms();
    setInterval(tick, 1000);

    // 定时落盘
    setInterval(function () { scheduleSave(); }, 20000).unref();

    emit('tick', S);
    return S;
  }

  /* =========================================================
     派生数据（给 UI 用）
     ========================================================= */
  function comfortLabel() {
    return ['舒适', '略闷', '闷热'][S.env.comfort] || '—';
  }
  function crowdLabel() {
    var n = S.env.people;
    if (n === 0) return '空闲';
    if (n <= 2) return '较少';
    if (n <= 4) return '一般';
    return '高峰';
  }
  function isOpen() {
    var h = hourOf(S.t);
    return h >= 7.5 && h < 21.5;
  }
  function todaySavingRate() {
    if (S.energy.baseKwh <= 0.001) return 0;
    return Math.max(0, 1 - S.energy.usedKwh / S.energy.baseKwh);
  }
  /* 今日已省电费按已过时段折算成整日估算 */
  function dailySavingEstimate() {
    var h = Math.max(1, hourOf(S.t));
    return S.energy.savedMoney / h * 24;
  }
  function paybackDays() {
    var daily = dailySavingEstimate();
    if (daily < 0.01) return null;
    return Math.max(1, Math.round(BUILD_COST / daily));
  }
  function activeAlarmList() {
    var out = [];
    Object.keys(S.activeAlarms).forEach(function (k) {
      var id = S.activeAlarms[k];
      for (var i = 0; i < S.events.length; i++) if (S.events[i].id === id) out.push(S.events[i]);
    });
    return out;
  }
  function unackedCount() {
    return S.events.filter(function (e) { return !e.acked; }).length;
  }

  const SIM = {
    S: S,
    init: init,
    on: on, off: off,
    setDevice: setDevice,
    setDeviceMode: setDeviceMode,
    allOff: allOff,
    setAllAuto: setAllAuto,
    setOnline: setOnline,
    setCfg: setCfg,
    setSpeed: setSpeed,
    setRunning: setRunning,
    setDoorForce: setDoorForce,
    startDemo: startDemo,
    stopDemo: stopDemo,
    demoState: demo,
    ackEvent: ackEvent,
    ackAll: ackAll,
    pickParcel: pickParcel,
    comfortLabel: comfortLabel,
    crowdLabel: crowdLabel,
    isOpen: isOpen,
    todaySavingRate: todaySavingRate,
    paybackDays: paybackDays,
    dailySavingEstimate: dailySavingEstimate,
    activeAlarmList: activeAlarmList,
    unackedCount: unackedCount,
    hourOf: hourOf,
    COST_PER_KWH: COST_PER_KWH,
    KW: { light: KW_LIGHT, fan: KW_FAN, ac: KW_AC },
    BUILD_COST: BUILD_COST,
    MY_PHONE: MY_PHONE,

    /* ---------- 服务端新增：快照与持久化 ---------- */
    snapshot: snapshot,
    saveNow: saveNow,
    loadFromDisk: loadFromDisk,
    checkAlarmsNow: checkAlarms,
    /* 立即按当前环境跑一次联动（硬件上报后调用，让继电器立刻到位） */
    applyControlNow: function () { autoControl(hourOf(S.t)); }
  };

  module.exports = SIM;
