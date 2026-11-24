/* ===========================================================
   社区快递驿站 · 实时监测平台  B 端管理台逻辑 (b-app.js)
   =========================================================== */
(function () {
  'use strict';

  /* 以 B 端（可控制）身份连接服务端 */
  SIM.init('b');
  var S = SIM.S;
  var $ = function (id) { return document.getElementById(id); };
  var curView = 'dash';
  var alarmFilter = 'all';
  var cmdLog = [];
  var chartCache = {};
  var lastChartDraw = 0;

  /* =========================================================
     工具
     ========================================================= */
  function pad2(n) { return ('0' + n).slice(-2); }
  function hms(ts) {
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function hm(ts) {
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function ago(ts) {
    var s = Math.floor((S.t - ts) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }
  function dur(ms) {
    var m = Math.round(ms / 60000);
    if (m < 1) return '<1 分钟';
    if (m < 60) return m + ' 分钟';
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
  }

  var toastBox = $('toasts');
  function toast(msg, kind) {
    var d = document.createElement('div');
    d.className = 'toast' + (kind ? ' ' + kind : '');
    d.textContent = msg;
    toastBox.appendChild(d);
    setTimeout(function () {
      d.style.transition = 'opacity .3s, transform .3s';
      d.style.opacity = '0';
      d.style.transform = 'translateX(16px)';
      setTimeout(function () { d.remove(); }, 320);
    }, 3600);
  }

  /* =========================================================
     导航
     ========================================================= */
  var navEls = Array.prototype.slice.call(document.querySelectorAll('.nav-item'));
  navEls.forEach(function (el) {
    el.addEventListener('click', function () {
      navEls.forEach(function (n) { n.classList.remove('active'); });
      el.classList.add('active');
      switchView(el.getAttribute('data-view'));
    });
  });

  function switchView(v) {
    curView = v;
    document.querySelectorAll('.view').forEach(function (s) {
      s.classList.toggle('active', s.id === 'view-' + v);
    });
    navEls.forEach(function (n) {
      n.classList.toggle('active', n.getAttribute('data-view') === v);
    });
    if (location.hash.slice(1) !== v) {
      try { history.replaceState(null, '', '#' + v); } catch (e) { location.hash = v; }
    }
    // 切视图时强制重绘图表
    chartCache = {};
    setTimeout(render, 30);
  }

  // 支持 #dash / #control / #history / #alarms / #energy / #device 直达
  (function initFromHash() {
    var v = (location.hash || '').replace('#', '');
    if (v && document.getElementById('view-' + v)) switchView(v);
  })();

  document.querySelectorAll('[data-goto]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      switchView(a.getAttribute('data-goto'));
    });
  });

  /* =========================================================
     倍速 / 断网
     ========================================================= */
  var speedSeg = $('speedSeg');
  speedSeg.querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () {
      speedSeg.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      SIM.setSpeed(+b.getAttribute('data-speed'));
      toast('仿真倍速已切换为 ' + b.getAttribute('data-speed') + '×');
    });
  });
  // 恢复上次倍速
  setTimeout(syncSpeedSeg, 0);

  function toggleOffline() {
    if (S.online) {
      SIM.setOnline(false);
      toast('已模拟断网：设备失联', 'bad');
    } else {
      SIM.setOnline(true);
      toast('连接已恢复', '');
    }
  }
  $('btnOffline').addEventListener('click', toggleOffline);
  $('btnReconnect').addEventListener('click', function () {
    SIM.setOnline(true);
    toast('连接已恢复', '');
  });
  var btnOffline2 = $('btnOffline2');
  if (btnOffline2) btnOffline2.addEventListener('click', toggleOffline);

  /* =========================================================
     一键演示
     ========================================================= */
  var btnDemo = $('btnDemo');
  var demoBanner = $('demoBanner');

  btnDemo.addEventListener('click', function () {
    if (SIM.demoState.running) { SIM.stopDemo(); return; }
    SIM.startDemo();
  });
  $('btnDemoStop').addEventListener('click', function () { SIM.stopDemo(); });

  SIM.on('demo', function (ev) {
    if (ev.type === 'start') {
      demoBanner.style.display = 'flex';
      $('demoStepLabel').textContent = ev.label;
      $('demoBar').style.width = '0%';
      $('demoCount').textContent = '0/' + (ev.total || 7);
      btnDemo.textContent = '■ 停止演示';
      btnDemo.classList.add('danger');
      // 切到总览页看联动
      switchView('dash');
      syncSpeedSeg();
      toast('🎬 开始演示：约 30 秒走完整条链路', '');
    } else if (ev.type === 'step') {
      $('demoStepLabel').textContent = ev.label;
      $('demoBar').style.width = (ev.index / ev.total * 100) + '%';
      $('demoCount').textContent = ev.index + '/' + ev.total;
      toast(ev.label, '');
    } else if (ev.type === 'end') {
      demoBanner.style.display = 'none';
      btnDemo.textContent = '▶ 一键演示';
      btnDemo.classList.remove('danger');
      syncSpeedSeg();
      toast(ev.label, '');
    }
  });

  function syncSpeedSeg() {
    speedSeg.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('on', +b.getAttribute('data-speed') === S.speed);
    });
  }

  /* =========================================================
     KPI 渲染（带动效：数字变化时跳动 + 变色）
     ========================================================= */
  var prev = { temp: null, hum: null, lux: null, people: null };

  function setNum(el, text, cls) {
    if (!el) return;
    var changed = el.textContent !== text;
    el.textContent = text;
    if (changed) {
      el.classList.remove('bump');
      // 强制重排以重启动画
      void el.offsetWidth;
      el.classList.add('bump');
    }
    el.classList.remove('hot', 'warm');
    if (cls) el.classList.add(cls);
  }

  function deltaHTML(cur, old, unit, invert) {
    if (old == null) return '<span class="kpi-delta">—</span>';
    var d = cur - old;
    if (Math.abs(d) < 0.05) return '<span class="kpi-delta">持平</span>';
    var up = d > 0;
    var cls = invert ? (up ? 'down' : 'up') : (up ? 'up' : 'down');
    return '<span class="kpi-delta ' + cls + '">' + (up ? '▲' : '▼') +
           Math.abs(d).toFixed(1) + unit + '</span>';
  }

  function renderKPI() {
    var e = S.env, c = S.cfg;

    var tShow = S.online ? e.tempDisp : e.temp;
    var hShow = S.online ? e.humDisp : e.hum;
    var lShow = S.online ? e.luxDisp : e.lux;

    setNum($('kTemp'), tShow.toFixed(1),
      e.temp > c.tempAlarm ? 'hot' : (e.temp > c.tempSafe ? 'warm' : ''));
    setNum($('kHum'), Math.round(hShow) + '', e.hum > c.humAlarm ? 'warm' : '');
    setNum($('kLux'), Math.round(lShow) + '');
    setNum($('kPeople'), e.people + '');

    $('safeLine').textContent = c.tempSafe;

    // 温度徽标
    var tb = $('tempBadge');
    if (e.temp > c.tempAlarm) { tb.className = 'badge bad'; tb.textContent = '⚠ 超报警线'; }
    else if (e.temp > c.tempSafe) { tb.className = 'badge warn'; tb.textContent = '超安全线'; }
    else if (e.temp > c.tempSafe - 2) { tb.className = 'badge info'; tb.textContent = '接近安全线'; }
    else { tb.className = 'badge ok'; tb.textContent = '正常'; }

    var hb = $('humBadge');
    if (e.hum > c.humAlarm) { hb.className = 'badge warn'; hb.textContent = '偏湿'; }
    else if (e.hum > c.humAlarm - 8) { hb.className = 'badge info'; hb.textContent = '略高'; }
    else { hb.className = 'badge ok'; hb.textContent = '正常'; }

    var lb = $('luxBadge');
    if (e.lux > 800) { lb.className = 'badge ok'; lb.textContent = '充足'; }
    else if (e.lux > c.luxDark) { lb.className = 'badge info'; lb.textContent = '偏暗'; }
    else { lb.className = 'badge warn'; lb.textContent = '需照明'; }

    var pb = $('peopleBadge');
    pb.className = 'badge ' + (e.people === 0 ? 'info' : (e.people > 4 ? 'warn' : 'ok'));
    pb.textContent = SIM.crowdLabel();

    $('peakPeople').textContent = S.stats.peakPeople;
    $('lightState').textContent = S.dev.light.on ? 'ON' : 'OFF';

    // 舒适度
    var labels = ['舒适', '略闷', '闷热'];
    var tips = [
      '温湿度处于适宜区间，包裹保存条件良好。',
      '温度或湿度略高，建议开启排风扇通风。',
      '闷热明显，包裹受热受潮风险上升，已联动通风。'
    ];
    var colors = ['var(--accent)', 'var(--warn)', 'var(--danger)'];
    $('comfortText').textContent = labels[e.comfort];
    $('comfortText').style.color = colors[e.comfort];
    $('comfortTip').textContent = tips[e.comfort];
    var cb = $('comfortBadge');
    cb.className = 'badge ' + (e.comfort === 0 ? 'ok' : (e.comfort === 1 ? 'warn' : 'bad'));
    cb.textContent = labels[e.comfort];

    Chart.donut($('donutComfort'), {
      size: 108, thickness: 11,
      data: [
        { label: '舒适', value: e.comfort === 0 ? 1 : 0, color: 'var(--accent)' },
        { label: '略闷', value: e.comfort === 1 ? 1 : 0, color: 'var(--warn)' },
        { label: '闷热', value: e.comfort === 2 ? 1 : 0, color: 'var(--danger)' }
      ],
      center: { value: Math.round((100 - e.comfort * 30)) + '', label: '舒适度分' }
    });

    $('tempPeak').textContent = S.stats.maxTemp.toFixed(1) + ' ℃';
    $('tempLow').textContent = (S.stats.minTemp === 99 ? '--' : S.stats.minTemp.toFixed(1) + ' ℃');
    $('flowPeak').textContent = S.stats.peakPeople + ' 人';

    prev = { temp: e.temp, hum: e.hum, lux: e.lux, people: e.people };
  }

  /* =========================================================
     实时数据流条
     ========================================================= */
  var lastSeq = 0;
  function renderStream() {
    var u = S.uplink;
    if (u.seq !== lastSeq) {
      $('seqVal').textContent = u.seq;
      $('rssiVal').textContent = S.online ? u.rssi : '--';
      $('latVal').textContent = S.online ? u.latency : '--';
      $('byteVal').textContent = S.online ? u.bytes : '--';
      $('rateVal').textContent = S.online ? (S.speed >= 60 ? '1.0' : S.speed.toFixed(1)) : '0.0';
      lastSeq = u.seq;
      var bar = $('streamBar');
      if (bar) {
        bar.classList.remove('tick');
        void bar.offsetWidth;
        bar.classList.add('tick');
      }
    }
    document.body.classList.toggle('offline', !S.online);
  }

  /* =========================================================
     设备状态卡
     ========================================================= */
  function renderDevices() {
    var map = {
      fan: { state: 'fanState', reason: 'fanReason', ctrl: 'fanState' },
      ac: { state: 'acState', reason: 'acReason', ctrl: 'acState' },
      light: { state: 'lightState2', reason: 'lightReason', ctrl: 'lightState2' }
    };
    ['fan', 'ac', 'light'].forEach(function (k) {
      var d = S.dev[k];
      var row = document.querySelector('.ctrl[data-dev="' + k + '"]');
      if (row) row.classList.toggle('on', d.on);
      var st = $(map[k].state);
      if (st) st.textContent = d.on ? 'ON' : 'OFF';
      var rs = $(map[k].reason);
      if (rs) {
        var why = reasonFor(k);
        rs.textContent = why;
      }
    });

    var dRow = document.querySelector('.ctrl[data-dev="door"]');
    var ds = $('doorState');
    if (ds) ds.textContent = S.env.doorOpen ? '开' : '关';
    var dr = $('doorReason');
    if (dr) dr.textContent = S.env.doorOpen
      ? (S.env.people === 0 ? '无人时段门仍开着，注意包裹安全' : '有顾客进出中')
      : '门磁闭合';

    var anyManual = ['fan', 'ac', 'light'].some(function (k) { return S.dev[k].mode === 'manual'; });
    var mb = $('modeBadge');
    mb.className = 'badge ' + (anyManual ? 'warn' : 'info');
    mb.textContent = anyManual ? '部分手动' : '全自动';
  }

  function reasonFor(k) {
    var d = S.dev[k], e = S.env, c = S.cfg;
    if (d.mode === 'manual') {
      return d.on ? '手动开启中（已退出自动联动）' : '手动关闭中（已退出自动联动）';
    }
    if (k === 'fan') {
      if (d.on) return '温度 ' + e.temp.toFixed(1) + '℃ 超安全线且店内有 ' + e.people + ' 人 → 自动开启';
      if (e.people === 0) return '店内无人 → 自动关闭，节能';
      return '温度未超 ' + c.tempSafe + '℃，无需通风';
    }
    if (k === 'ac') {
      if (d.on) return '温度 ' + e.temp.toFixed(1) + '℃ 超 ' + c.tempAC + '℃ 且有人 → 自动开启';
      if (e.people === 0) return '店内无人 → 自动关闭，节能';
      return '温度未超 ' + c.tempAC + '℃，无需制冷';
    }
    if (k === 'light') {
      if (d.on) return '光照 ' + Math.round(e.lux) + ' lx 不足且有人 → 自动开灯';
      if (e.people === 0) return '店内无人 → 自动关灯';
      if (e.lux >= c.luxDark) return '自然光充足（' + Math.round(e.lux) + ' lx），无需开灯';
      return '光线不足（' + Math.round(e.lux) + ' lx），等待自动开灯';
    }
    return '';
  }

  /* =========================================================
     图表
     ========================================================= */
  function rtSeries() {
    var src = S.rt.length >= 2 ? S.rt : S.hist.slice(-60);
    return {
      temp: src.map(function (d) { return { t: d.t, v: d.temp }; }),
      hum: src.map(function (d) { return { t: d.t, v: d.hum }; })
    };
  }

  function drawRT() {
    var s = rtSeries();
    Chart.line($('chartRT'), {
      height: 210,
      series: [
        { name: '温度', color: '#ff8a5b', data: s.temp, fill: true, width: 2 },
        { name: '湿度', color: '#5eb3ff', data: s.hum, fill: false, width: 1.6, dash: '4 3', axis: 'right' }
      ],
      yMin: 18, yMax: 42,
      y2Min: 30, y2Max: 90, y2Unit: '%',
      bands: [
        { from: 30, to: 42, color: '#ffb454', label: '安全线以上 30℃+' },
        { from: 35, to: 42, color: '#ff6b6b', label: '报警线 35℃' }
      ],
      xTicks: 4, yTicks: 4
    });
  }

  function drawToday() {
    Chart.line($('chartToday'), {
      height: 178,
      series: [
        { name: '温度', color: '#ff8a5b', data: S.hist.map(function (d) { return { t: d.t, v: d.temp }; }), fill: true },
        { name: '湿度', color: '#5eb3ff', data: S.hist.map(function (d) { return { t: d.t, v: d.hum }; }), width: 1.4, dash: '4 3', axis: 'right' }
      ],
      yMin: 18, yMax: 42, y2Min: 30, y2Max: 90, y2Unit: '%',
      xTicks: 5, yTicks: 4,
      bands: [{ from: 35, to: 42, color: '#ff6b6b', label: '35℃ 报警线' }]
    });
  }

  function drawHist() {
    Chart.line($('chartHistTemp'), {
      height: 240,
      series: [{ name: '温度', color: '#ff8a5b', data: S.hist.map(function (d) { return { t: d.t, v: d.temp }; }), fill: true }],
      yMin: 18, yMax: 42, xTicks: 6, yTicks: 5,
      bands: [
        { from: 30, to: 33, color: '#ffb454', label: '安全线 30℃' },
        { from: 33, to: 35, color: '#ff9f43', label: '' },
        { from: 35, to: 42, color: '#ff6b6b', label: '报警线 35℃' }
      ]
    });
    Chart.line($('chartHistHum'), {
      height: 200,
      series: [{ name: '湿度', color: '#5eb3ff', data: S.hist.map(function (d) { return { t: d.t, v: d.hum }; }), fill: true }],
      yMin: 30, yMax: 90, xTicks: 5, yTicks: 4, yUnit: '%',
      bands: [{ from: 75, to: 90, color: '#ffb454', label: '受潮线 75%' }]
    });

    // 人流柱状
    var byHour = new Array(24).fill(0);
    S.hist.forEach(function (d) {
      var h = new Date(d.t).getHours();
      if (d.people > byHour[h]) byHour[h] = d.people;
    });
    var bars = [];
    for (var h = 0; h < 24; h++) {
      bars.push({ label: h % 4 === 0 ? h + '' : '', value: byHour[h], dim: byHour[h] === 0 });
    }
    Chart.bars($('chartFlow'), { height: 160, data: bars, color: '#3ddc97' });

    renderOverheat();
  }

  function renderOverheat() {
    // 找连续超温片段
    var segs = [];
    var cur = null;
    S.hist.forEach(function (d) {
      if (d.temp > S.cfg.tempSafe) {
        if (!cur) cur = { from: d.t, to: d.t, max: d.temp };
        else { cur.to = d.t; if (d.temp > cur.max) cur.max = d.temp; }
      } else if (cur) { segs.push(cur); cur = null; }
    });
    if (cur) segs.push(cur);

    // 合并间隔 < 10 分钟的片段，并丢弃不足 3 分钟的抖动
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
    merged = merged.filter(function (s) { return s.to - s.from >= 3 * 60 * 1000; });

    var box = $('overheatTable');
    if (!merged.length) {
      box.innerHTML = '<div class="empty"><span class="em">✓</span>今日尚无超过 ' + S.cfg.tempSafe + '℃ 的持续时段（≥3 分钟），包裹保存条件良好</div>';
      return;
    }
    var html = '<table class="tb"><thead><tr><th>时段</th><th>持续</th><th>峰值温度</th><th>风险</th></tr></thead><tbody>';
    merged.slice(-12).reverse().forEach(function (s) {
      var lvl = s.max > S.cfg.tempAlarm ? '<span class="badge bad">高</span>' : '<span class="badge warn">中</span>';
      html += '<tr><td class="num">' + hm(s.from) + ' – ' + hm(s.to) + '</td>' +
              '<td class="num">' + dur(s.to - s.from) + '</td>' +
              '<td class="num" style="color:var(--warn)">' + s.max.toFixed(1) + ' ℃</td>' +
              '<td>' + lvl + '</td></tr>';
    });
    html += '</tbody></table>';
    box.innerHTML = html;
  }

  /* =========================================================
     事件 / 报警
     ========================================================= */
  function levelName(l) { return l === 'high' ? '高危' : (l === 'mid' ? '中危' : '低危'); }

  function eventHTML(ev, compact) {
    var active = !ev.resolvedAt;
    return '<div class="alert-item lv-' + ev.level + '">' +
      '<div class="alert-ico">' + ev.icon + '</div>' +
      '<div class="alert-body">' +
        '<b>' + ev.title +
          (active ? ' <span class="badge bad" style="margin-left:4px">进行中</span>'
                  : ' <span class="badge ok" style="margin-left:4px">已恢复</span>') +
          (!ev.acked && active ? ' <span class="badge warn" style="margin-left:4px">未读</span>' : '') +
        '</b>' +
        '<p>' + ev.msg + '</p>' +
      '</div>' +
      '<div class="alert-time">' + hm(ev.ts) + '</div>' +
      (compact ? '' : '<button class="btn sm ghost" data-ack="' + ev.id + '">已读</button>') +
    '</div>';
  }

  function renderRecent() {
    var list = S.events.slice(0, 4);
    var box = $('recentEvents');
    if (!list.length) {
      box.innerHTML = '<div class="empty"><span class="em">🌿</span>暂无异常事件，驿站运行平稳</div>';
      return;
    }
    box.innerHTML = list.map(function (e) { return eventHTML(e, true); }).join('');
  }

  function renderAlarms() {
    var active = SIM.activeAlarmList();
    var unacked = SIM.unackedCount();
    $('aUnacked').textContent = unacked;
    $('aActive').textContent = active.length;
    $('aTotal').textContent = S.events.length;

    var resolved = S.events.filter(function (e) { return e.resolvedAt; });
    if (resolved.length) {
      var sum = resolved.reduce(function (a, e) { return a + (e.resolvedAt - e.ts); }, 0);
      $('aRecover').textContent = Math.max(1, Math.round(sum / resolved.length / 60000));
    } else {
      $('aRecover').textContent = '--';
    }

    var dot = $('navDot');
    dot.textContent = unacked;
    dot.classList.toggle('show', unacked > 0);

    var list = S.events.filter(function (e) {
      if (alarmFilter === 'active') return !e.resolvedAt;
      if (alarmFilter === 'high') return e.level === 'high';
      return true;
    });

    var box = $('alarmList');
    if (!list.length) {
      box.innerHTML = '<div class="empty"><span class="em">🔔</span>当前筛选条件下没有报警记录</div>';
      return;
    }
    box.innerHTML = list.slice(0, 40).map(function (e) { return eventHTML(e, false); }).join('');
    box.querySelectorAll('[data-ack]').forEach(function (b) {
      b.addEventListener('click', function () {
        SIM.ackEvent(b.getAttribute('data-ack'));
        toast('已标记为已读');
        render();
      });
    });
  }

  $('alarmFilter').querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () {
      $('alarmFilter').querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      alarmFilter = b.getAttribute('data-f');
      renderAlarms();
    });
  });
  $('btnAckAll').addEventListener('click', function () {
    SIM.ackAll();
    toast('已全部标记为已读');
    render();
  });

  /* =========================================================
     远程控制页
     ========================================================= */
  var DEV_META = {
    fan: { ico: '🌀', name: '排风扇', desc: '通风除湿，降低体感温度' },
    ac: { ico: '❄️', name: '空调', desc: '1.5 匹，制冷降温' },
    light: { ico: '💡', name: '照明', desc: '45W LED 顶灯' }
  };

  function renderCtrlList() {
    var box = $('ctrlList');
    var html = '';
    ['fan', 'ac', 'light'].forEach(function (k) {
      var d = S.dev[k], m = DEV_META[k];
      html += '<div class="ctrl' + (d.on ? ' on' : '') + '">' +
        '<div class="ctrl-ico">' + m.ico + '</div>' +
        '<div class="ctrl-txt"><b>' + m.name + '</b><span>' + reasonFor(k) + '</span></div>' +
        '<span class="ctrl-state">' + (d.on ? 'ON' : 'OFF') + '</span>' +
        '<div class="seg" data-mode="' + k + '">' +
          '<button data-m="auto" class="' + (d.mode === 'auto' ? 'on' : '') + '">自动</button>' +
          '<button data-m="manual" class="' + (d.mode === 'manual' ? 'on' : '') + '">手动</button>' +
        '</div>' +
        '<div class="sw' + (d.on ? ' on' : '') + '" data-sw="' + k + '"></div>' +
      '</div>';
    });
    box.innerHTML = html;

    box.querySelectorAll('[data-sw]').forEach(function (sw) {
      sw.addEventListener('click', function () {
        var k = sw.getAttribute('data-sw');
        var target = !S.dev[k].on;
        sendCmd(k, target);
      });
    });
    box.querySelectorAll('[data-mode]').forEach(function (seg) {
      seg.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () {
          var k = seg.getAttribute('data-mode');
          SIM.setDeviceMode(k, b.getAttribute('data-m'));
          toast(DEV_META[k].name + '已切换为' + (b.getAttribute('data-m') === 'auto' ? '自动联动' : '手动控制'));
          render();
        });
      });
    });
  }

  function sendCmd(k, on) {
    var name = DEV_META[k].name;
    cmdLog.unshift({
      t: Date.now(),
      text: (on ? '开启' : '关闭') + name,
      state: 'pending'
    });
    renderCmdLog();
    var entry = cmdLog[0];
    setTimeout(function () {
      SIM.setDevice(k, on);
      entry.state = 'ok';
      entry.ackAt = Date.now();
      renderCmdLog();
      render();
      toast(name + '已' + (on ? '开启' : '关闭') + '（继电器已动作）');
    }, 420);
  }

  function renderCmdLog() {
    var box = $('cmdLog');
    if (!cmdLog.length) {
      box.innerHTML = '<div class="empty"><span class="em">⌘</span>暂无控制指令<br><span class="sr">操作左侧开关后会在此显示下发记录</span></div>';
      return;
    }
    var html = '<table class="tb"><thead><tr><th>时间</th><th>指令</th><th>状态</th></tr></thead><tbody>';
    cmdLog.slice(0, 12).forEach(function (c) {
      html += '<tr><td class="num">' + hms(c.t) + '</td><td>' + c.text + '</td><td>' +
        (c.state === 'ok'
          ? '<span class="badge ok">已确认</span>'
          : '<span class="badge info">下发中…</span>') +
        '</td></tr>';
    });
    html += '</tbody></table>';
    box.innerHTML = html;
  }

  $('btnAllOff').addEventListener('click', function () {
    SIM.allOff();
    cmdLog.unshift({ t: Date.now(), text: '一键全关（风扇 / 空调 / 照明）', state: 'ok' });
    renderCmdLog();
    toast('已一键关闭全部设备', 'warn');
    render();
  });
  $('btnAllAuto').addEventListener('click', function () {
    SIM.setAllAuto();
    cmdLog.unshift({ t: Date.now(), text: '全部恢复自动联动', state: 'ok' });
    renderCmdLog();
    toast('全部设备已恢复自动联动');
    render();
  });

  /* 阈值表单 */
  function renderCfg() {
    var c = S.cfg;
    var fields = [
      { k: 'tempSafe', label: '包裹安全温度线', unit: '℃', min: 24, max: 34, step: 0.5 },
      { k: 'tempAC', label: '自动开空调阈值', unit: '℃', min: 28, max: 38, step: 0.5 },
      { k: 'tempAlarm', label: '高温报警阈值', unit: '℃', min: 30, max: 42, step: 0.5 },
      { k: 'humAlarm', label: '湿度报警阈值', unit: '%', min: 60, max: 90, step: 1 },
      { k: 'luxDark', label: '判定光线不足', unit: 'lx', min: 20, max: 300, step: 10 }
    ];
    var html = '';
    fields.forEach(function (f) {
      html += '<div class="row" style="padding:7px 0;border-bottom:1px dashed var(--line-soft)">' +
        '<span style="flex:1;font-size:12.5px">' + f.label + '</span>' +
        '<input type="range" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" value="' + c[f.k] + '" data-cfg="' + f.k + '" style="width:130px">' +
        '<span class="mono" style="width:58px;text-align:right;color:var(--accent)" id="cfgv-' + f.k + '">' + c[f.k] + f.unit + '</span>' +
      '</div>';
    });
    html += '<div class="row mt12" style="gap:16px">' +
      '<label class="row" style="gap:6px;font-size:12.5px"><span class="sw' + (c.autoFan ? ' on' : '') + '" data-tog="autoFan"></span>通风联动</label>' +
      '<label class="row" style="gap:6px;font-size:12.5px"><span class="sw' + (c.autoAC ? ' on' : '') + '" data-tog="autoAC"></span>空调联动</label>' +
      '<label class="row" style="gap:6px;font-size:12.5px"><span class="sw' + (c.autoLight ? ' on' : '') + '" data-tog="autoLight"></span>照明联动</label>' +
    '</div>';
    $('cfgForm').innerHTML = html;

    $('cfgForm').querySelectorAll('[data-cfg]').forEach(function (r) {
      r.addEventListener('input', function () {
        var k = r.getAttribute('data-cfg');
        var v = +r.value;
        var unit = r.parentNode.querySelector('#cfgv-' + k);
        var f = fields.filter(function (x) { return x.k === k; })[0];
        if (unit) unit.textContent = v + f.unit;
        var patch = {}; patch[k] = v;
        SIM.setCfg(patch);
      });
    });
    $('cfgForm').querySelectorAll('[data-tog]').forEach(function (sw) {
      sw.addEventListener('click', function () {
        var k = sw.getAttribute('data-tog');
        var patch = {}; patch[k] = !S.cfg[k];
        SIM.setCfg(patch);
        sw.classList.toggle('on', S.cfg[k]);
        toast('联动开关已' + (S.cfg[k] ? '开启' : '关闭'));
      });
    });
  }

  /* 故障模拟 */
  $('btnHotDay').addEventListener('click', function () {
    SIM.setCfg({ hotDay: !S.cfg.hotDay });
    toast(S.cfg.hotDay ? '已切换为极端高温日（室外 +3℃）' : '已恢复正常天气', S.cfg.hotDay ? 'warn' : '');
    render();
  });
  $('btnDoor').addEventListener('click', function () {
    SIM.setDoorForce(!S.doorForce);
    toast(S.doorForce ? '已模拟门磁长开' : '门磁已复位', S.doorForce ? 'warn' : '');
    render();
  });
  $('btnPause').addEventListener('click', function () {
    SIM.setRunning(!S.running);
    $('btnPause').textContent = S.running ? '⏸ 暂停仿真' : '▶ 继续仿真';
    toast(S.running ? '仿真已继续' : '仿真已暂停');
  });

  /* =========================================================
     节能核算
     ========================================================= */
  function renderEnergy() {
    var en = S.energy;
    var rate = SIM.todaySavingRate() * 100;
    $('eSaved').textContent = en.savedKwh.toFixed(2);
    $('eMoney').textContent = en.savedMoney.toFixed(2);
    $('eRate').textContent = rate.toFixed(0);
    var pb = SIM.paybackDays();
    $('ePayback').textContent = pb == null ? '--' : pb;

    $('eBase').innerHTML = en.baseKwh.toFixed(2) + ' <span style="font-size:12px">度</span>';
    $('eUsed').innerHTML = en.usedKwh.toFixed(2) + ' <span style="font-size:12px">度</span>';
    var pct = en.baseKwh > 0 ? (en.usedKwh / en.baseKwh * 100) : 0;
    $('eBarUsed').style.width = Math.min(100, pct) + '%';
    $('eBarLabel').textContent = '本方案耗电占传统做法的 ' + pct.toFixed(0) + '%';

    // 能耗曲线（每小时累计节省）
    var byHour = new Array(24).fill(0);
    // 简化：用当前累计节省按小时比例分布展示
    var pts = [];
    for (var h = 0; h <= new Date(S.t).getHours(); h++) {
      var frac = (h + 1) / 24;
      pts.push({ t: new Date(S.t).setHours(h, 0, 0, 0), v: +(en.baseKwh * frac).toFixed(2) });
    }
    var pts2 = pts.map(function (p) { return { t: p.t, v: +(p.v * (1 - rate / 100)).toFixed(2) }; });
    Chart.line($('chartEnergy'), {
      height: 170,
      series: [
        { name: '传统', color: 'var(--muted)', data: pts, width: 1.6, dash: '4 3' },
        { name: '本方案', color: 'var(--accent)', data: pts2, fill: true, width: 2 }
      ],
      yMin: 0, xTicks: 4, yTicks: 4, yUnit: ' 度',
      emptyText: '今日暂无能耗数据'
    });

    // 耗电构成：照明 + 排风扇计入节能核算，空调为舒适性设备单列
    var total = en.usedKwh || 0.001;
    var acTotal = en.acKwh || 0;
    var wLight = SIM.KW.light * 14, wFan = SIM.KW.fan * 6; // 典型日运行小时权重
    var sumW = wLight + wFan;
    var parts = [
      { label: '照明', value: total * wLight / sumW, color: '#ffd66e', kw: SIM.KW.light },
      { label: '排风扇', value: total * wFan / sumW, color: '#3ddc97', kw: SIM.KW.fan },
      { label: '空调', value: acTotal, color: '#5eb3ff', kw: SIM.KW.ac }
    ];
    var grand = total + acTotal;
    Chart.donut($('donutEnergy'), {
      size: 124, thickness: 12,
      data: parts,
      center: { value: grand.toFixed(1), label: '度 / 今日' }
    });
    $('energyLegend').innerHTML = parts.map(function (p) {
      var pctv = grand > 0 ? (p.value / grand * 100) : 0;
      return '<div class="row between sr" style="margin-bottom:7px">' +
        '<span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + p.color + ';margin-right:6px"></i>' +
        p.label + '（' + Math.round(p.kw * 1000) + 'W）</span>' +
        '<span class="mono">' + p.value.toFixed(2) + ' 度 · ' + pctv.toFixed(0) + '%</span></div>';
    }).join('') +
    '<div class="sr mt8" style="color:var(--muted);line-height:1.7">节能核算口径 = 照明 + 排风扇（可自动开关的回路）；空调属舒适性设备，仅在有人且超 32℃ 时开启，单列统计不计入节省。</div>';

    $('eMoney2').textContent = en.savedMoney.toFixed(2) + ' 元';
    var monthly = SIM.dailySavingEstimate() * 30;
    $('eMonthly').textContent = monthly.toFixed(2) + ' 元';
    $('ePayback2').textContent = pb == null ? '--' : pb + ' 天';
    var paid = Math.min(100, (en.savedMoney / SIM.BUILD_COST) * 100);
    $('ePayBar').style.width = paid + '%';
    $('ePayTip').textContent = paid >= 100
      ? '✅ 改造成本 ' + SIM.BUILD_COST + ' 元已通过节省的电费收回'
      : '已回收 ' + paid.toFixed(1) + '%（' + en.savedMoney.toFixed(2) + ' / ' + SIM.BUILD_COST + ' 元）';
  }

  /* =========================================================
     设备与点位
     ========================================================= */
  function renderFloorplan() {
    var box = $('floorplan');
    if (box.dataset.done) return;
    box.dataset.done = '1';
    var e = S.env;

    box.innerHTML =
    '<svg viewBox="0 0 460 300" style="width:100%;height:auto">' +
      '<defs>' +
        '<pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">' +
          '<path d="M20 0 L0 0 0 20" fill="none" stroke="rgba(255,255,255,.045)" stroke-width="1"/>' +
        '</pattern>' +
      '</defs>' +
      '<rect x="0" y="0" width="460" height="300" fill="url(#grid)"/>' +
      /* 墙体 */
      '<rect x="26" y="26" width="408" height="248" fill="none" stroke="#3a5c4e" stroke-width="3" rx="4"/>' +
      /* 货架区 */
      '<rect x="44" y="46" width="150" height="96" fill="rgba(61,220,151,.07)" stroke="rgba(61,220,151,.28)" stroke-dasharray="4 3"/>' +
      '<text x="52" y="62" fill="#7d948c" font-size="10">包裹货架区 A–D 排</text>' +
      '<rect x="44" y="160" width="150" height="96" fill="rgba(61,220,151,.05)" stroke="rgba(61,220,151,.2)" stroke-dasharray="4 3"/>' +
      '<text x="52" y="176" fill="#7d948c" font-size="10">取件等候区</text>' +
      /* 收银台 */
      '<rect x="286" y="52" width="120" height="44" fill="rgba(94,179,255,.1)" stroke="rgba(94,179,255,.35)" rx="3"/>' +
      '<text x="294" y="70" fill="#9ec8e8" font-size="10">收银台 / 电脑</text>' +
      '<text x="294" y="85" fill="#7d948c" font-size="9">ESP32 主控 · 扫码枪 · WiFi</text>' +
      /* 排风扇 / 空调 */
      '<rect x="286" y="212" width="58" height="34" fill="rgba(255,180,84,.1)" stroke="rgba(255,180,84,.35)" rx="3"/>' +
      '<text x="292" y="233" fill="#d9a95f" font-size="9">排风扇</text>' +
      '<rect x="352" y="212" width="58" height="34" fill="rgba(94,179,255,.1)" stroke="rgba(94,179,255,.35)" rx="3"/>' +
      '<text x="366" y="233" fill="#9ec8e8" font-size="9">空调</text>' +
      /* 大门 */
      '<rect x="180" y="264" width="80" height="10" fill="#3ddc97" opacity=".55"/>' +
      '<text x="196" y="290" fill="#7d948c" font-size="10">大门（入口）</text>' +
      /* 传感器点位 */
      '<g>' +
        '<circle cx="238" cy="130" r="13" fill="rgba(255,138,91,.16)" stroke="#ff8a5b" stroke-width="1.6"/>' +
        '<text x="238" y="135" text-anchor="middle" fill="#ff8a5b" font-size="12">T</text>' +
        '<text x="256" y="126" fill="#c9a08e" font-size="9">DHT11</text>' +
        '<text x="256" y="139" fill="#8f7a6c" font-size="8.5">中部墙面 1.5m</text>' +
      '</g>' +
      '<g>' +
        '<circle cx="200" cy="46" r="13" fill="rgba(255,214,110,.16)" stroke="#ffd66e" stroke-width="1.6"/>' +
        '<text x="200" y="51" text-anchor="middle" fill="#ffd66e" font-size="12">L</text>' +
        '<text x="218" y="44" fill="#c9b98e" font-size="9">光敏 · 靠窗朝外</text>' +
      '</g>' +
      '<g>' +
        '<circle cx="120" cy="200" r="14" fill="rgba(61,220,151,.16)" stroke="#3ddc97" stroke-width="1.6"/>' +
        '<text x="120" y="205" text-anchor="middle" fill="#3ddc97" font-size="12">P</text>' +
        '<text x="140" y="204" fill="#8fc4ad" font-size="9">PIR 天花板中央</text>' +
      '</g>' +
      /* 动态：有人指示 */
      '<g id="fpPeople">' +
        '<circle cx="120" cy="230" r="5" fill="#3ddc97" opacity=".85"/>' +
        '<circle cx="150" cy="240" r="4" fill="#3ddc97" opacity=".7"/>' +
        '<circle cx="96" cy="246" r="4" fill="#3ddc97" opacity=".6"/>' +
      '</g>' +
      /* 动态：通风/制冷标识 */
      '<g id="fpFan" opacity="0">' +
        '<circle cx="315" cy="229" r="24" fill="none" stroke="#3ddc97" stroke-width="1.2" stroke-dasharray="3 4"/>' +
      '</g>' +
    '</svg>';
  }

  function updateFloorplan() {
    var g = document.getElementById('fpPeople');
    if (!g) return;
    var n = S.env.people;
    var dots = g.querySelectorAll('circle');
    for (var i = 0; i < dots.length; i++) {
      dots[i].style.display = i < Math.min(n, 3) ? '' : 'none';
    }
    var fan = document.getElementById('fpFan');
    if (fan) fan.setAttribute('opacity', S.dev.fan.on ? '1' : '0');
  }

  function renderNetChain() {
    var box = $('netChain');
    if (box.dataset.done) return;
    box.dataset.done = '1';
    var nodes = [
      { ico: '🌡️', name: '传感器', sub: 'DHT11 / 光敏 / PIR' },
      { ico: '🧠', name: 'ESP32', sub: '采集 + 逻辑判断' },
      { ico: '📶', name: 'WiFi 路由', sub: '复用驿站原有' },
      { ico: '☁️', name: '云端', sub: '存储 + 推送' },
      { ico: '📱', name: '手机端', sub: 'B 管理 / C 查询' }
    ];
    box.innerHTML = nodes.map(function (n, i) {
      return '<div class="row" style="padding:8px 0">' +
        '<div class="ctrl-ico" style="font-size:15px">' + n.ico + '</div>' +
        '<div style="flex:1"><b style="font-size:12.5px">' + n.name + '</b>' +
        '<div class="sr">' + n.sub + '</div></div>' +
        (i < nodes.length - 1 ? '<span style="color:var(--muted)">↓</span>' : '<span class="badge ok">实时</span>') +
      '</div>';
    }).join('');
  }

  function renderLogicCards() {
    var box = $('logicCards');
    if (box.dataset.done) return;
    box.dataset.done = '1';
    var cards = [
      {
        t: '🌡️ 温度 / 通风联动',
        rows: [
          ['温度 ≤ 30℃', '排风扇、空调保持关闭，节能', 'ok'],
          ['温度 > 30℃ 且有人', '自动开启排风扇通风', 'warn'],
          ['温度 > 32℃ 且有人', '自动开启空调降温', 'bad'],
          ['店内无人', '立即关闭风扇 / 空调', 'ok']
        ]
      },
      {
        t: '💡 照明联动',
        rows: [
          ['光照充足（>80 lx）', '不开灯，利用自然光', 'ok'],
          ['光线不足且有人', '自动开灯，保障取件安全', 'warn'],
          ['店内无人', '自动关灯，杜绝长明灯', 'ok'],
          ['打烊后仍有设备开启', '推送提醒，避免无谓电费', 'info']
        ]
      }
    ];
    box.innerHTML = cards.map(function (c) {
      return '<div class="card" style="background:var(--panel-2)">' +
        '<div class="card-h" style="margin-bottom:10px"><h2>' + c.t + '</h2></div>' +
        c.rows.map(function (r) {
          return '<div class="row between" style="padding:7px 0;border-bottom:1px dashed var(--line-soft);font-size:12.5px">' +
            '<span class="mono" style="color:var(--txt-2)">' + r[0] + '</span>' +
            '<span class="badge ' + r[2] + '">' + r[1] + '</span></div>';
        }).join('') +
      '</div>';
    }).join('');
  }

  /* =========================================================
     全局状态条
     ========================================================= */
  function renderStatus() {
    $('clock').textContent = hms(S.t);
    var online = S.online;
    $('offlineBanner').style.display = online ? 'none' : 'flex';
    $('topPulse').className = 'pulse' + (online ? '' : ' off');
    $('sidePulse').className = 'pulse' + (online ? '' : ' off');
    $('topConn').textContent = online ? '设备在线' : '设备离线';
    $('sideConn').textContent = online ? 'WiFi 在线' : '已断网';
    $('btnOffline').textContent = online ? '模拟断网' : '恢复连接';

    document.querySelectorAll('[data-live-badge]').forEach(function (b) {
      b.className = 'badge ' + (online ? 'ok' : 'bad');
      b.textContent = online ? '在线' : '离线';
    });
  }

  /* =========================================================
     主渲染
     ========================================================= */
  function render() {
    renderStatus();
    renderKPI();
    renderStream();
    renderDevices();
    renderRecent();
    renderAlarms();
    updateFloorplan();

    var now = Date.now();
    var throttle = now - lastChartDraw > 700;

    if (curView === 'dash' && throttle) {
      drawRT(); drawToday();
      lastChartDraw = now;
    }
    if (curView === 'history' && throttle) {
      drawHist();
      lastChartDraw = now;
    }
    if (curView === 'control') {
      renderCtrlList();
      renderCmdLog();
    }
    if (curView === 'energy' && throttle) {
      renderEnergy();
      lastChartDraw = now;
    }
    if (curView === 'device') {
      renderFloorplan();
      renderNetChain();
      renderLogicCards();
    }
  }

  /* =========================================================
     事件订阅（真 B/C：由服务端推送驱动渲染）
     ========================================================= */
  SIM.on('alarm', function (ev) {
    toast(ev.icon + ' ' + ev.title + '：' + ev.msg.slice(0, 26) + '…',
      ev.level === 'high' ? 'bad' : 'warn');
  });

  /* 收到服务端状态即渲染 */
  SIM.on('state', function () {
    render();
  });

  /* 连接状态变化 */
  SIM.on('status', function (st) {
    updateConn(st);
  });

  SIM.on('hello', function (msg) {
    if (msg.hardwareMode) {
      $('demoHint').textContent = '⚡ 真实硬件模式';
    }
  });

  function updateConn(st) {
    var online = st.connected;
    var badge = $('connBadge');
    if (badge) {
      badge.className = 'chip ' + (online ? '' : 'bad');
      badge.innerHTML = '<span class="pulse' + (online ? '' : ' off') + '"></span>' +
        (online ? '实时连接' : (st.reconnecting ? '重连中…' : '已断开'));
    }
  }

  // 视图首次进入时初始化表单
  var initedCfg = false;
  function ensureInit() {
    if (initedCfg) return;
    initedCfg = true;
    renderCfg();
    renderCtrlList();
    renderCmdLog();
  }
  setTimeout(ensureInit, 0);

  // 首帧先用本地空状态渲染一次，避免白屏；随后由服务端 state 驱动
  render();

  // 窗口尺寸变化时重绘
  var rzT = 0;
  window.addEventListener('resize', function () {
    clearTimeout(rzT);
    rzT = setTimeout(function () { chartCache = {}; render(); }, 220);
  });

  // 暴露给调试
  window.__B = {
    S: S,
    render: render,
    switchView: switchView,
    startDemo: function () { SIM.startDemo(); },
    stopDemo: function () { SIM.stopDemo(); }
  };
})();
