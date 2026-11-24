/* ===========================================================
   社区快递驿站 · 实时监测平台  轻量 SVG 图表库 (chart.js)
   不依赖任何第三方库；每秒重绘，随容器宽度自适应。
   =========================================================== */
(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var uid = 0;

  function el(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    if (attrs) for (var k in attrs) {
      if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    return n;
  }

  function css(el, prop) {
    return getComputedStyle(el).getPropertyValue(prop).trim();
  }

  function niceTicks(min, max, count) {
    var span = max - min;
    if (span <= 0) span = 1;
    var raw = span / count;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step;
    if (norm <= 1) step = 1; else if (norm <= 2) step = 2;
    else if (norm <= 2.5) step = 2.5; else if (norm <= 5) step = 5; else step = 10;
    step *= mag;
    var out = [];
    var start = Math.ceil(min / step) * step;
    for (var v = start; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }

  function fmtNum(v) {
    if (Math.abs(v) >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k';
    if (Number.isInteger(v)) return String(v);
    return String(+v.toFixed(1));
  }

  function hhmm(ts) {
    var d = new Date(ts);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  /* ---------------------------------------------------------
     折线 / 面积图
     cfg = {
       height, series:[{name,color,data:[{t,v}],fill,dash,width}],
       yMin, yMax, yUnit, bands:[{from,to,color,label}],
       xTicks: 4, yTicks: 4, showArea, emptyText
     }
     --------------------------------------------------------- */
  function line(container, cfg) {
    if (!container) return;

    // 容器还没完成布局（宽度为 0）时不画，等下次状态推送重绘
    var cw = container.clientWidth || (container.parentNode && container.parentNode.clientWidth) || 0;
    if (cw < 20) {
      container.dataset.pending = '1';
      return;
    }
    container.dataset.pending = '';

    var hasRight = (cfg.series || []).some(function (s) { return s.axis === 'right'; });
    var W = Math.max(240, cw);
    var H = cfg.height || 180;
    var padL = cfg.padL != null ? cfg.padL : 34;
    var padR = hasRight ? 36 : 8, padT = 10, padB = 20;
    var innerW = W - padL - padR;
    var innerH = H - padT - padB;

    container.innerHTML = '';
    var svg = el('svg', {
      width: W, height: H,
      viewBox: '0 0 ' + W + ' ' + H,
      preserveAspectRatio: 'none'
    });

    var gridColor = css(container, '--chart-grid') || 'rgba(255,255,255,.06)';
    var mutedColor = css(container, '--muted') || '#888';
    var txtColor = css(container, '--txt-2') || '#aaa';

    // 数据范围（左轴系列）
    var all = [];
    (cfg.series || []).forEach(function (s) {
      if (s.axis === 'right') return;
      (s.data || []).forEach(function (d) { all.push(d); });
    });

    if (!all.length) {
      var t = el('text', {
        x: W / 2, y: H / 2, 'text-anchor': 'middle',
        fill: mutedColor, 'font-size': 12
      });
      t.textContent = cfg.emptyText || '暂无数据';
      svg.appendChild(t);
      container.appendChild(svg);
      return;
    }

    var xMin = Infinity, xMax = -Infinity;
    (cfg.series || []).forEach(function (s) {
      (s.data || []).forEach(function (d) { if (d.t < xMin) xMin = d.t; if (d.t > xMax) xMax = d.t; });
    });
    if (xMax === xMin) { xMax = xMin + 60000; }

    var yMin = cfg.yMin, yMax = cfg.yMax;
    if (yMin == null || yMax == null) {
      var vMin = Infinity, vMax = -Infinity;
      all.forEach(function (d) { if (d.v < vMin) vMin = d.v; if (d.v > vMax) vMax = d.v; });
      if (cfg.bands) cfg.bands.forEach(function (b) {
        if (b.to > vMax) vMax = b.to;
      });
      var pad = (vMax - vMin) * 0.18 || 1;
      if (yMin == null) yMin = Math.floor(vMin - pad);
      if (yMax == null) yMax = Math.ceil(vMax + pad);
    }
    if (yMax - yMin < 1e-6) yMax = yMin + 1;

    // 右轴范围
    var rMin = cfg.y2Min, rMax = cfg.y2Max;
    if (hasRight && (rMin == null || rMax == null)) {
      var rv = [];
      (cfg.series || []).forEach(function (s) {
        if (s.axis !== 'right') return;
        (s.data || []).forEach(function (d) { rv.push(d.v); });
      });
      var rlo = Math.min.apply(null, rv), rhi = Math.max.apply(null, rv);
      var rp = (rhi - rlo) * 0.2 || 1;
      if (rMin == null) rMin = Math.floor(rlo - rp);
      if (rMax == null) rMax = Math.ceil(rhi + rp);
    }
    if (rMax - rMin < 1e-6) rMax = rMin + 1;

    function X(t) { return padL + (t - xMin) / (xMax - xMin) * innerW; }
    function Y(v) { return padT + innerH - (v - yMin) / (yMax - yMin) * innerH; }
    function Y2(v) { return padT + innerH - (v - rMin) / (rMax - rMin) * innerH; }

    var g = el('g');
    svg.appendChild(g);

    // 阈值带：极淡填充 + 阈值处虚线，避免遮挡曲线
    (cfg.bands || []).forEach(function (b) {
      var yTop = Y(Math.min(b.to, yMax));
      var yBot = Y(Math.max(b.from, yMin));
      if (yBot - yTop <= 0) return;
      g.appendChild(el('rect', {
        x: padL, y: yTop, width: innerW, height: yBot - yTop,
        fill: b.color, opacity: 0.07
      }));
      // 阈值虚线（带的下边界就是阈值本身）
      var yLine = Y(b.from);
      if (yLine >= padT && yLine <= padT + innerH) {
        g.appendChild(el('line', {
          x1: padL, y1: yLine, x2: W - padR, y2: yLine,
          stroke: b.color, 'stroke-width': 1,
          'stroke-dasharray': '5 4', opacity: 0.55
        }));
      }
      if (b.label) {
        var lb = el('text', {
          x: padL + 6, y: Math.max(padT + 10, yLine - 5),
          fill: b.color, 'font-size': 9.5, opacity: 0.9
        });
        lb.textContent = b.label;
        g.appendChild(lb);
      }
    });

    // 横向网格 + y 轴标签
    var yt = niceTicks(yMin, yMax, cfg.yTicks || 4);
    yt.forEach(function (v) {
      var y = Y(v);
      if (y < padT - 1 || y > padT + innerH + 1) return;
      g.appendChild(el('line', {
        x1: padL, y1: y, x2: W - padR, y2: y,
        stroke: gridColor, 'stroke-width': 1
      }));
      var tx = el('text', {
        x: padL - 7, y: y + 3.5, 'text-anchor': 'end',
        fill: mutedColor, 'font-size': 10
      });
      tx.textContent = fmtNum(v) + (cfg.yUnit || '');
      g.appendChild(tx);
    });

    // 右轴刻度
    if (hasRight) {
      var rt2 = niceTicks(rMin, rMax, cfg.yTicks || 4);
      rt2.forEach(function (v) {
        var y = Y2(v);
        if (y < padT - 1 || y > padT + innerH + 1) return;
        var tx = el('text', {
          x: W - padR + 7, y: y + 3.5, 'text-anchor': 'start',
          fill: mutedColor, 'font-size': 10
        });
        tx.textContent = fmtNum(v) + (cfg.y2Unit || '');
        g.appendChild(tx);
      });
    }

    // x 轴时间标签
    var xtN = cfg.xTicks || 4;
    for (var i = 0; i <= xtN; i++) {
      var tv = xMin + (xMax - xMin) * (i / xtN);
      var x = X(tv);
      var t2 = el('text', {
        x: x, y: H - 5,
        'text-anchor': i === 0 ? 'start' : (i === xtN ? 'end' : 'middle'),
        fill: mutedColor, 'font-size': 10
      });
      t2.textContent = hhmm(tv);
      g.appendChild(t2);
    }

    // 系列
    (cfg.series || []).forEach(function (s, si) {
      var data = (s.data || []).slice();
      if (data.length < 2) return;
      var gradId = 'grad' + (++uid);
      var useY = s.axis === 'right' ? Y2 : Y;

      if (s.fill) {
        var defs = el('defs');
        var lg = el('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 });
        lg.appendChild(el('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': 0.34 }));
        lg.appendChild(el('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': 0.01 }));
        defs.appendChild(lg);
        svg.insertBefore(defs, g);
      }

      var d = '';
      for (var k = 0; k < data.length; k++) {
        d += (k === 0 ? 'M' : 'L') + X(data[k].t).toFixed(1) + ' ' + useY(data[k].v).toFixed(1);
      }

      if (s.fill) {
        var area = d +
          'L' + X(data[data.length - 1].t).toFixed(1) + ' ' + (padT + innerH) +
          'L' + X(data[0].t).toFixed(1) + ' ' + (padT + innerH) + 'Z';
        g.appendChild(el('path', { d: area, fill: 'url(#' + gradId + ')', stroke: 'none' }));
      }

      g.appendChild(el('path', {
        d: d, fill: 'none',
        stroke: s.color,
        'stroke-width': s.width || 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
        'stroke-dasharray': s.dash || null,
        opacity: s.opacity != null ? s.opacity : 1
      }));

      // 末端圆点
      var last = data[data.length - 1];
      g.appendChild(el('circle', {
        cx: X(last.t), cy: useY(last.v), r: 3,
        fill: s.color, stroke: css(container, '--panel') || '#111', 'stroke-width': 1.5
      }));
    });

    container.appendChild(svg);
  }

  /* ---------------------------------------------------------
     环形图
     cfg = { size, thickness, data:[{label,value,color}], center:{value,label} }
     --------------------------------------------------------- */
  function donut(container, cfg) {
    if (!container) return;
    var size = cfg.size || 132;
    var th = cfg.thickness || 13;
    var r = (size - th) / 2;
    var cx = size / 2, cy = size / 2;
    var C = 2 * Math.PI * r;

    container.innerHTML = '';
    var svg = el('svg', { width: size, height: size, viewBox: '0 0 ' + size + ' ' + size });

    var total = cfg.data.reduce(function (a, b) { return a + Math.max(0, b.value); }, 0);
    var panel = css(container, '--panel-3') || '#222';

    svg.appendChild(el('circle', {
      cx: cx, cy: cy, r: r, fill: 'none',
      stroke: panel, 'stroke-width': th
    }));

    var acc = 0;
    cfg.data.forEach(function (s) {
      var frac = total > 0 ? Math.max(0, s.value) / total : 0;
      if (frac <= 0) return;
      var dash = C * frac;
      var gap = C - dash;
      svg.appendChild(el('circle', {
        cx: cx, cy: cy, r: r, fill: 'none',
        stroke: s.color, 'stroke-width': th,
        'stroke-dasharray': dash + ' ' + gap,
        'stroke-dashoffset': -acc,
        transform: 'rotate(-90 ' + cx + ' ' + cy + ')',
        'stroke-linecap': 'butt'
      }));
      acc += dash;
    });

    if (cfg.center) {
      var v = el('text', {
        x: cx, y: cy + 2, 'text-anchor': 'middle',
        fill: css(container, '--txt') || '#fff',
        'font-size': cfg.centerSize || 19, 'font-weight': 650,
        'font-family': 'ui-monospace, Consolas, monospace'
      });
      v.textContent = cfg.center.value;
      svg.appendChild(v);
      if (cfg.center.label) {
        var l = el('text', {
          x: cx, y: cy + 19, 'text-anchor': 'middle',
          fill: css(container, '--muted') || '#888', 'font-size': 10
        });
        l.textContent = cfg.center.label;
        svg.appendChild(l);
      }
    }
    container.appendChild(svg);
  }

  /* ---------------------------------------------------------
     柱状图（按小时的人员分布）
     cfg = { height, data:[{label,value}], color }
     --------------------------------------------------------- */
  function bars(container, cfg) {
    if (!container) return;
    var W = Math.max(240, container.clientWidth || 600);
    var H = cfg.height || 110;
    var padB = 16, padT = 8;
    var innerH = H - padB - padT;
    var n = cfg.data.length || 1;
    var gap = 2;
    var bw = Math.max(2, (W - gap * (n - 1)) / n);

    container.innerHTML = '';
    var svg = el('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H });
    var max = 1;
    cfg.data.forEach(function (d) { if (d.value > max) max = d.value; });

    cfg.data.forEach(function (d, i) {
      var h = Math.max(1, d.value / max * innerH);
      var x = i * (bw + gap);
      svg.appendChild(el('rect', {
        x: x, y: padT + innerH - h, width: bw, height: h,
        rx: Math.min(2, bw / 3),
        fill: d.color || cfg.color,
        opacity: d.dim ? 0.3 : 0.9
      }));
      if (d.label != null) {
        var t = el('text', {
          x: x + bw / 2, y: H - 4, 'text-anchor': 'middle',
          fill: css(container, '--muted') || '#888', 'font-size': 9
        });
        t.textContent = d.label;
        svg.appendChild(t);
      }
    });
    container.appendChild(svg);
  }

  global.Chart = { line: line, donut: donut, bars: bars, hhmm: hhmm };
})(window);
