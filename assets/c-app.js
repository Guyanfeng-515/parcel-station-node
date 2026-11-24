/* ===========================================================
   社区快递驿站 · 实时监测平台  C 端居民端逻辑 (c-app.js)
   =========================================================== */
(function () {
  'use strict';

  /* 以 C 端（只读）身份连接服务端 */
  SIM.init('c');
  var S = SIM.S;
  var $ = function (id) { return document.getElementById(id); };
  var curTab = 'now';
  var lastChart = 0;
  var seenAlertIds = {};

  function pad2(n) { return ('0' + n).slice(-2); }
  function hms(ts) {
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function hm(ts) {
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function hoursAgo(ts) { return (S.t - ts) / 3600000; }

  /* 数字变化时跳动 */
  function bumpText(el, text) {
    if (!el) return;
    var changed = el.textContent !== text;
    el.textContent = text;
    if (changed) {
      el.classList.remove('bump');
      void el.offsetWidth;
      el.classList.add('bump');
    }
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
    }, 3800);
  }

  /* ---------- Tabs ---------- */
  document.querySelectorAll('#cTabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('#cTabs button').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      curTab = b.getAttribute('data-tab');
      document.querySelectorAll('.view').forEach(function (v) {
        v.classList.toggle('active', v.id === 'tab-' + curTab);
      });
      lastChart = 0;
      setTimeout(render, 20);
    });
  });

  /* ---------- 等待时间估算 ---------- */
  function waitMinutes() {
    var n = S.env.people;
    if (!SIM.isOpen()) return '—';
    if (n === 0) return '<1 分';
    // 每个取件人平均 40 秒，1 个窗口
    return Math.max(1, Math.round(n * 0.7)) + ' 分';
  }

  /* ---------- Hero ---------- */
  function renderHero() {
    var h = SIM.hourOf(S.t);
    var greet = h < 6 ? '夜深了 🌙' : h < 11 ? '早上好 ☀️' : h < 14 ? '中午好 🍚' : h < 18 ? '下午好 🌤' : '晚上好 🌆';
    $('greeting').textContent = greet + '，欢迎来取件';

    var open = SIM.isOpen();
    $('heroOpen').textContent = open ? '营业中' : '已打烊';
    $('heroDot').style.background = open ? '#fff' : 'rgba(255,255,255,.6)';

    var pending = S.stats.pending;
    var mine = S.parcels.filter(function (p) { return p.phone === SIM.MY_PHONE && p.status === 'pending'; }).length;
    bumpText($('heroParcels'), mine > 0 ? String(mine) : String(pending));
    bumpText($('heroPeople'), String(S.env.people));
    $('heroWait').textContent = waitMinutes();

    var sub;
    if (!S.online) sub = '设备暂时离线，数据可能不是最新的';
    else if (!open) sub = '驿站已打烊，明天 07:30 开门哦';
    else if (S.env.people === 0) sub = '现在店里没人，是取件的好时候 ✨';
    else if (S.env.people > 4) sub = '现在有 ' + S.env.people + ' 人在店里，稍等一下会舒服些';
    else sub = '店里有 ' + S.env.people + ' 人，随时可以来取件';
    $('heroSub').textContent = sub;
  }

  /* ---------- 环境卡 ---------- */
  function setCVal(el, text, cls) {
    if (!el) return;
    var changed = el.textContent !== text;
    el.textContent = text;
    if (changed) {
      el.classList.remove('bump');
      void el.offsetWidth;
      el.classList.add('bump');
    }
    if (cls !== undefined) el.className = 'm-val' + (cls ? ' ' + cls : '');
  }

  function renderEnv() {
    var e = S.env;
    var tShow = S.online ? e.tempDisp : e.temp;
    var hShow = S.online ? e.humDisp : e.hum;

    setCVal($('mTemp'), tShow.toFixed(1) + '℃');
    setCVal($('mHum'), Math.round(hShow) + '%');
    setCVal($('mPeople'), e.people + '人');

    var luxTxt, luxColor;
    if (e.lux > 800) { luxTxt = '自然光充足'; luxColor = 'var(--green)'; }
    else if (e.lux > 80) { luxTxt = '偏暗'; luxColor = 'var(--warn)'; }
    else if (S.dev.light.on) { luxTxt = '已开灯'; luxColor = 'var(--accent)'; }
    else { luxTxt = '光线较暗'; luxColor = 'var(--warn)'; }
    $('mLux').textContent = luxTxt;
    $('mLux').style.color = luxColor;

    var score = Math.max(0, 100 - e.comfort * 32);
    var tag = ['很舒适', '有点闷', '比较闷热'][e.comfort];
    var note = [
      '温湿度刚好，包裹和人都很舒服～',
      '温度或湿度略高，驿站已开启通风。',
      '现在比较闷热，驿站已加大通风力度，建议稍晚些再来。'
    ][e.comfort];
    $('comfortTag').textContent = tag;
    $('comfortTag').style.color = ['var(--green)', 'var(--warn)', 'var(--danger)'][e.comfort];
    $('comfortBar').style.width = score + '%';
    $('comfortBar').parentNode.className = 'bar' + (e.comfort === 2 ? ' bad' : (e.comfort === 1 ? ' warn' : ''));
    $('comfortNote').textContent = note;

    $('updatedAt').textContent = S.online ? hms(S.t) + ' 更新' : '离线数据';
  }

  /* ---------- 人流卡 ---------- */
  function renderCrowd() {
    var n = S.env.people;
    var label = SIM.crowdLabel();
    var tipMap = {
      '空闲': '店里没人，现在去取件完全不用排队～',
      '较少': '人不多，取件很轻松。',
      '一般': '有点人，但很快就能轮到。',
      '高峰': '正在高峰，建议 20 分钟后再来。'
    };
    var colorMap = { '空闲': 'var(--green)', '较少': 'var(--accent)', '一般': 'var(--warn)', '高峰': 'var(--danger)' };

    $('crowdText').textContent = label + '（' + n + ' 人）';
    $('crowdText').style.color = colorMap[label];
    $('crowdTip').textContent = tipMap[label];
    $('crowdRight').textContent = '预计等待 ' + waitMinutes();

    Chart.donut($('crowdDonut'), {
      size: 96, thickness: 10,
      data: [
        { label: '在店', value: n, color: colorMap[label] },
        { label: '余量', value: Math.max(0, 8 - n), color: 'var(--panel-3)' }
      ],
      center: { value: n + '', label: '在店人数' }
    });

    if (curTab === 'now') {
      var byHour = new Array(24).fill(0);
      S.hist.forEach(function (d) {
        var hh = new Date(d.t).getHours();
        if (d.people > byHour[hh]) byHour[hh] = d.people;
      });
      var nowH = new Date(S.t).getHours();
      var bars = [];
      for (var h = 7; h <= 21; h++) {
        bars.push({
          label: h % 3 === 0 ? h + '' : '',
          value: byHour[h],
          color: h === nowH ? 'var(--accent)' : 'var(--warn)',
          dim: byHour[h] === 0
        });
      }
      Chart.bars($('chartCrowd'), { height: 96, data: bars });
    }
  }

  /* ---------- 设备联动状态（C 端口语化） ---------- */
  function renderDev() {
    var rows = [
      {
        on: S.dev.fan.on, ico: '🌀', cls: 'live-fan',
        name: '通风排风扇',
        onTxt: '正在通风，空气在流动',
        offTxt: S.env.people === 0 ? '店里没人，已自动停下省电' : '空气还不错，暂时不用开'
      },
      {
        on: S.dev.ac.on, ico: '❄️', cls: 'live-cool',
        name: '空调',
        onTxt: '正在制冷降温',
        offTxt: S.env.people === 0 ? '店里没人，已自动关闭' : '温度舒适，不需要开'
      },
      {
        on: S.dev.light.on, ico: '💡', cls: 'live-glow',
        name: '照明灯',
        onTxt: '已开灯，取件看得清楚',
        offTxt: S.env.people === 0 ? '店里没人，灯已自动关'
              : (S.env.lux >= S.cfg.luxDark ? '自然光充足，不用开灯' : '灯已关闭')
      }
    ];
    $('devList').innerHTML = rows.map(function (r) {
      return '<div class="c-li">' +
        '<div class="ci' + (r.on ? ' ' + r.cls : '') + '" style="' +
          (r.on ? 'background:var(--accent-dim);color:#d9611a' : '') + '">' + r.ico + '</div>' +
        '<div class="cg"><b>' + r.name + '</b><span>' + (r.on ? r.onTxt : r.offTxt) + '</span></div>' +
        '<span class="badge ' + (r.on ? 'ok' : '') + '">' + (r.on ? '运行中' : '已停') + '</span>' +
      '</div>';
    }).join('');
  }

  /* ---------- 我的包裹 ---------- */
  function renderMine() {
    var mine = S.parcels.filter(function (p) { return p.phone === SIM.MY_PHONE; });
    var pending = mine.filter(function (p) { return p.status === 'pending'; });
    $('mineCount').textContent = pending.length + ' 件待取';

    if (!mine.length) {
      $('myParcels').innerHTML = '<div class="empty"><span class="em">📭</span>暂时没有你的包裹</div>';
    } else {
      $('myParcels').innerHTML = mine.map(function (p) {
        var hrs = hoursAgo(p.arrivedAt);
        var urgent = p.fresh && hrs > 6;
        var picked = p.status === 'picked';
        return '<div class="c-li" style="align-items:flex-start;padding:12px 0">' +
          '<div class="ci" style="' + (picked ? 'opacity:.45' : '') + '">📦</div>' +
          '<div class="cg">' +
            '<b style="' + (picked ? 'text-decoration:line-through;opacity:.5' : '') + '">' +
              p.courier + ' · ' + p.size + '</b>' +
            (picked
              ? '<span style="opacity:.6">已于 ' + hm(p.pickedAt || p.arrivedAt) + ' 取走 · 货架 ' + p.shelf + '</span>'
              : '<span>取件码 <b class="mono code-hi" style="color:var(--accent);font-size:13px">' + p.code + '</b>' +
                ' · 货架 ' + p.shelf + '</span>' +
                '<span>到件 ' + hm(p.arrivedAt) + '（已存放 ' + hrs.toFixed(1) + ' 小时）' +
                (p.fresh ? ' · <b style="color:var(--warn)">含生鲜/易变质</b>' : '') + '</span>') +
          '</div>' +
          (picked
            ? '<span class="badge">已取</span>'
            : (urgent ? '<span class="badge warn">尽快取</span>' : '<span class="badge ok">待取</span>')) +
        '</div>';
      }).join('');
    }

    // 保存环境
    var e = S.env;
    var risk = e.temp > S.cfg.tempAlarm ? 2 : (e.temp > S.cfg.tempSafe ? 1 : 0);
    var icons = ['✅', '🌡️', '🔥'];
    var titles = ['保存条件良好', '温度略高，已通风', '温度偏高，已通知老板'];
    var notes = [
      '当前 ' + e.temp.toFixed(1) + '℃，湿度 ' + Math.round(e.hum) + '%，包裹放在阴凉货架上，放心～',
      '当前 ' + e.temp.toFixed(1) + '℃ 略高于安全线，驿站已自动开启排风扇，建议尽快取走。',
      '当前 ' + e.temp.toFixed(1) + '℃ 已超报警线，老板已收到提醒正在处理，生鲜类请尽快取件。'
    ];
    $('safeIcon').textContent = icons[risk];
    $('safeTitle').textContent = titles[risk];
    $('safeTitle').style.color = ['var(--green)', 'var(--warn)', 'var(--danger)'][risk];
    $('safeNote').textContent = notes[risk];
    $('safeTemp').textContent = e.temp.toFixed(1) + ' ℃';
    var pct = Math.min(100, e.temp / 40 * 100);
    $('safeBar').style.width = pct + '%';
    $('safeBarWrap').className = 'bar' + (risk === 2 ? ' bad' : (risk === 1 ? ' warn' : ''));
  }

  /* ---------- C 端提醒 ---------- */
  function renderAlerts() {
    var open = SIM.isOpen();
    var list = [];

    // 1. 生鲜包裹催取
    S.parcels.forEach(function (p) {
      if (p.phone === SIM.MY_PHONE && p.status === 'pending' && p.fresh) {
        var hrs = hoursAgo(p.arrivedAt);
        if (hrs > 6) {
          list.push({
            ico: '🧊', lv: 'warn',
            t: '生鲜包裹建议尽快取走',
            d: '取件码 ' + p.code + ' 已存放 ' + hrs.toFixed(1) + ' 小时，超过 24 小时会影响品质。'
          });
        }
      }
    });

    // 2. 温度影响
    if (S.env.temp > S.cfg.tempSafe) {
      list.push({
        ico: '🌡️', lv: S.env.temp > S.cfg.tempAlarm ? 'bad' : 'warn',
        t: S.env.temp > S.cfg.tempAlarm ? '驿站温度偏高' : '驿站温度略高',
        d: '当前 ' + S.env.temp.toFixed(1) + '℃，易变质包裹存在风险，驿站已启动通风降温。'
      });
    }

    // 3. 人流
    if (S.env.people >= 5) {
      list.push({ ico: '👥', lv: 'warn', t: '驿站正在高峰', d: '店内 ' + S.env.people + ' 人，建议 20 分钟后再来取件。' });
    }

    // 4. 打烊
    if (!open) {
      list.push({ ico: '🌙', lv: '', t: '驿站已打烊', d: '营业时间 07:30 – 21:30，明天再来哦。' });
    }

    // 5. 离线
    if (!S.online) {
      list.push({ ico: '📡', lv: 'bad', t: '驿站设备离线', d: '数据暂时无法更新，驿站正常营业，可照常取件。' });
    }

    if (!list.length) {
      $('cAlerts').innerHTML = '<div class="empty"><span class="em">🌿</span>暂无提醒，一切正常～</div>';
      return;
    }
    $('cAlerts').innerHTML = list.map(function (a) {
      return '<div class="alert-item' + (a.lv ? ' lv-' + a.lv : '') + '" style="border-color:var(--line)">' +
        '<div class="alert-ico">' + a.ico + '</div>' +
        '<div class="alert-body"><b style="color:var(--txt)">' + a.t + '</b>' +
        '<p style="color:var(--txt-2)">' + a.d + '</p></div>' +
      '</div>';
    }).join('');
  }

  /* ---------- 营业徽标 ---------- */
  function renderOpen() {
    var open = SIM.isOpen();
    var b = $('openBadge');
    b.className = 'badge ' + (open ? 'ok' : '');
    b.textContent = open ? '营业中' : '已打烊';
  }

  /* ---------- 主渲染 ---------- */
  function render() {
    renderHero();
    renderEnv();
    renderCrowd();
    renderOpen();

    if (curTab === 'now') renderDev();
    if (curTab === 'mine') { renderMine(); renderAlerts(); }
  }

  /* 新报警时推送 toast */
  SIM.on('alarm', function (ev) {
    if (ev.level === 'high') {
      toast(ev.icon + ' ' + ev.title, 'bad');
    }
  });

  /* 真 B/C：由服务端推送驱动渲染（老板在 B 端的操作会立刻出现在这里） */
  SIM.on('state', function () {
    render();
  });

  SIM.on('status', function (st) {
    var el = $('heroSub');
    if (!st.connected && el) {
      el.textContent = st.reconnecting ? '正在连接驿站设备…' : '与驿站失去连接';
    }
  });

  // 首帧先渲染一次，避免白屏
  render();

  window.__C = { S: S, render: render };
})();
