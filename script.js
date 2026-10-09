/* ==========================================================
   Real-time IoT Overview — interactions
   Dữ liệu lấy từ Supabase (telemetry_logs, devices). Biểu đồ, sparkline và
   chức năng xuất/xóa tháng cần chạy file dashboard_history.sql một lần.
   ========================================================== */
(() => {
  'use strict';
  const SUPABASE_URL = 'https://qdicuomcxiayoauricxo.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFkaWN1b21jeGlheW9hdXJpY3hvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0NTI3MDQsImV4cCI6MjEwNzAyODcwNH0.-zegaN7ftigClHdSJxsIOq4chTvtmlHhbiqFuTtAaKc';
  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (name, attrs = {}) => {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pad2 = (n) => String(n).padStart(2, '0');

  /* ---------- Toast ---------- */
  function toast(message, type = 'ok') {
    const box = $('#toasts');
    const t = document.createElement('div');
    t.className = 'toast' + (type === 'info' ? ' is-info' : '');
    t.textContent = message;
    box.appendChild(t);
    setTimeout(() => {
      t.classList.add('is-out');
      setTimeout(() => t.remove(), 300);
    }, 3200);
  }

  /* ---------- Math helpers ---------- */

  // Nội suy monotone cubic (Fritsch–Carlson): mượt, không vọt quá đỉnh.
  function monotone(xs, ys) {
    const n = xs.length;
    const d = [];
    const m = new Array(n);
    for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
      const a = m[i] / d[i];
      const b = m[i + 1] / d[i];
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        m[i] = t * a * d[i];
        m[i + 1] = t * b * d[i];
      }
    }
    return (x) => {
      x = clamp(x, xs[0], xs[n - 1]);
      let i = 0;
      while (i < n - 2 && x > xs[i + 1]) i++;
      const h = xs[i + 1] - xs[i];
      const t = (x - xs[i]) / h;
      const t2 = t * t;
      const t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] +
             (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    };
  }

  function mulberry32(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function tween(from, to, dur, onUpdate) {
    if (reduceMotion || dur <= 0) { onUpdate(to); return; }
    const t0 = performance.now();
    const step = (now) => {
      const p = clamp((now - t0) / dur, 0, 1);
      onUpdate(from + (to - from) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ==========================================================
     Cấu hình
     ========================================================== */
  const OFFLINE_AFTER_MS = 30000;   // quá 30 giây không có dòng dữ liệu mới = offline
  const KEYS = ['temp', 'hum', 'soil', 'light', 'co2'];
  const COL = { temp: 'temperature', hum: 'humidity', soil: 'soil_moisture', light: 'light_lux', co2: 'co2_ppm' };
  // Cảnh báo khi giá trị LỚN HƠN ngưỡng. Độ ẩm đất chưa có ngưỡng (đang là số thô, chưa hiệu chỉnh).
  const THRESHOLDS = {
    temp:  { max: 50,   unit: '°C',  label: 'Nhiệt độ' },
    hum:   { max: 50,   unit: '%',   label: 'Độ ẩm không khí' },
    light: { max: 2000, unit: 'lux', label: 'Ánh sáng' },
    co2:   { max: 800,  unit: 'ppm', label: 'CO₂' },
  };

  const state = {
    zones: new Map(),   // zone_id -> [{ id, name, zone_id }]
    zone: null,
    devices: [],
    latest: null,       // dòng telemetry_logs mới nhất của zone
    ref: null,          // dòng cách đây khoảng 1 giờ (để tính chênh lệch)
    fetchError: null,
  };
  let epoch = 0;        // tăng mỗi khi đổi zone để bỏ qua kết quả cũ
  const deviceIds = () => state.devices.map((d) => d.id);
  const hms = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

  /* ==========================================================
     KPI cards
     ========================================================== */
  const kpi = {
    temp:  { el: $('[data-kpi="temp"]'),  fmt: (v) => v.toFixed(1) },
    hum:   { el: $('[data-kpi="hum"]'),   fmt: (v) => String(Math.round(v)) },
    soil:  { el: $('[data-kpi="soil"]'),  fmt: (v) => String(Math.round(v)) },
    light: { el: $('[data-kpi="light"]'), fmt: (v) => Math.round(v).toLocaleString('en-US') },
    co2:   { el: $('[data-kpi="co2"]'),   fmt: (v) => String(Math.round(v)) },
  };
  for (const k of Object.values(kpi)) k.value = null;

  const GAUGE_C = 2 * Math.PI * 18.5;
  function setGauge(pct) {
    const p = pct == null ? 0 : clamp(pct, 0, 100);
    $('#gauge-value').setAttribute('stroke-dasharray', `${(GAUGE_C * p) / 100} ${GAUGE_C}`);
    $('#gauge-text').textContent = pct == null ? '--' : Math.round(pct);
  }

  // null (cảm biến không đo được / chưa có dữ liệu) hiển thị là "--"
  function setKpi(key, target, dur) {
    const k = kpi[key];
    if (target == null) {
      k.value = null;
      k.el.textContent = '--';
      if (key === 'hum') setGauge(null);
      return;
    }
    const from = k.value == null ? 0 : k.value;
    k.value = target;
    tween(from, target, dur, (v) => { k.el.textContent = k.fmt(v); });
    if (key === 'hum') setGauge(target);
  }

  function fmtVal(key, v, withUnit) {
    if (v == null) return '--';
    const s = kpi[key].fmt(v);
    if (!withUnit) return s;
    return s + ({ temp: '°C', hum: '%', soil: ' raw', light: ' lux', co2: ' ppm' })[key];
  }

  /* ---------- Sparkline (dữ liệu thật 60 phút gần nhất) ---------- */
  const sparkData = {};
  for (const key of ['temp', 'soil', 'light', 'co2']) sparkData[key] = null;   // null = chưa đủ dữ liệu, ẩn đường

  function sparkPath(values) {
    const xs = values.map((_, i) => (i / (values.length - 1)) * 74);
    const ys = values.map((v) => 2 + (1 - v) * 22);
    const f = monotone(xs, ys);
    let d = '';
    for (let x = 0; x <= 74; x += 1) d += (x ? 'L' : 'M') + x + ' ' + f(x).toFixed(2) + ' ';
    return d;
  }

  function renderSparks(animate) {
    $$('[data-spark]').forEach((p) => {
      const vals = sparkData[p.dataset.spark];
      if (!vals) { p.removeAttribute('d'); return; }
      p.setAttribute('d', sparkPath(vals));
      if (animate && !reduceMotion) {
        p.setAttribute('pathLength', '1');
        p.classList.add('draw');
      }
    });
  }

  /* ---------- Chênh lệch so với 1 giờ trước ---------- */
  function fmtDelta(key, d) {
    const abs = Math.abs(d);
    const num = (key === 'temp' || key === 'hum') ? abs.toFixed(1) : String(Math.round(abs));
    const sign = Number(num) === 0 ? '±' : (d > 0 ? '+' : '−');
    const unit = ({ temp: '°C', hum: '%', soil: '', light: ' lux', co2: ' ppm' })[key];
    const shown = key === 'light' ? Number(num).toLocaleString('en-US') : num;
    return `${sign}${shown}${unit}`;
  }

  function renderDeltas() {
    for (const key of KEYS) {
      const cur = state.latest ? state.latest[COL[key]] : null;
      const ref = state.ref ? state.ref[COL[key]] : null;
      const text = cur != null && ref != null ? fmtDelta(key, cur - ref) : '--';
      $(`[data-delta="${key}"]`).textContent = `${text} · so với 1 giờ trước`;
    }
    const ec = state.latest ? state.latest.ec : null;
    const ph = state.latest ? state.latest.ph : null;
    $('#kpi-detail').textContent = `EC ${ec != null ? ec.toFixed(1) + ' mS/cm' : '--'} · pH ${ph != null ? ph.toFixed(1) : '--'}`;
  }

  /* ==========================================================
     Trạng thái thiết bị + cảnh báo (tính trên trình duyệt)
     ========================================================== */
  function computeStatus(now = Date.now()) {
    if (state.fetchError) return { kind: 'error' };
    if (!state.devices.length) return { kind: 'nodevice' };
    const row = state.latest;
    if (!row) return { kind: 'nodata' };
    const ageMs = Math.max(0, now - Date.parse(row.timestamp));
    const online = ageMs <= OFFLINE_AFTER_MS;
    const sensorsOnline = online ? KEYS.filter((k) => row[COL[k]] != null).length : 0;
    return { kind: online ? 'online' : 'offline', row, ageMs, sensorsOnline };
  }

  function buildAlerts(st) {
    const names = state.devices.map((d) => d.name || d.id).join(', ');
    const list = [];
    if (st.kind === 'error') {
      list.push({ key: 'error', level: 'critical', msg: 'Không tải được dữ liệu từ Supabase: ' + state.fetchError, time: '' });
    } else if (st.kind === 'nodevice') {
      list.push({ key: 'nodevice', level: 'warn', msg: `Zone ${state.zone ?? '--'} chưa có thiết bị nào trong bảng devices.`, time: '' });
    } else if (st.kind === 'nodata') {
      list.push({ key: 'nodata', level: 'warn', msg: `Chưa có dữ liệu nào từ ${names}.`, time: '' });
    } else if (st.kind === 'offline') {
      const last = new Date(st.row.timestamp);
      list.push({ key: 'offline', level: 'critical', msg: `${names} OFFLINE: không có dữ liệu mới quá ${OFFLINE_AFTER_MS / 1000} giây (lần cuối ${hms(last)}).`, time: hms(last) });
    } else {
      const t = hms(new Date(st.row.timestamp));
      for (const [key, th] of Object.entries(THRESHOLDS)) {
        const v = st.row[COL[key]];
        if (v != null && v > th.max) {
          list.push({ key, level: 'warn', msg: `${th.label} vượt ngưỡng ${th.max} ${th.unit} (hiện tại: ${fmtVal(key, v)} ${th.unit}).`, time: t });
        }
      }
    }
    return list;
  }

  function renderAlerts(list) {
    const box = $('#alert-list');
    box.textContent = '';
    if (!list.length) {
      const e = document.createElement('p');
      e.className = 'alert-empty';
      e.textContent = 'Không có cảnh báo.';
      box.appendChild(e);
    }
    for (const a of list) {
      const item = document.createElement('article');
      item.className = 'alert-item' + (a.level === 'warn' ? ' alert-item--warn' : '');
      const head = document.createElement('div');
      head.className = 'alert-head';
      const badge = document.createElement('span');
      badge.className = 'badge ' + (a.level === 'warn' ? 'badge--amber' : 'badge--red');
      const dot = document.createElement('i');
      dot.className = 'dot';
      badge.append(dot, document.createTextNode(a.level === 'warn' ? 'WARNING' : 'CRITICAL'));
      const time = document.createElement('span');
      time.className = 'alert-time';
      time.textContent = a.time;
      head.append(badge, time);
      const msg = document.createElement('p');
      msg.className = 'alert-msg';
      msg.textContent = a.msg;
      item.append(head, msg);
      box.appendChild(item);
    }
    const cnt = $('#alert-count');
    const crit = list.some((a) => a.level === 'critical');
    cnt.className = 'badge ' + (!list.length ? 'badge--green' : crit ? 'badge--red' : 'badge--amber');
    $('span', cnt).textContent = `${list.length} OPEN`;
  }

  let lastAlertSig = '';
  function renderStatus() {
    const st = computeStatus();
    const names = state.devices.map((d) => d.name || d.id).join(', ') || '--';
    const n = st.kind === 'online' ? st.sensorsOnline : 0;
    const zoneTxt = state.zone != null ? `Zone ${state.zone}` : 'Chưa có zone';

    $('#page-desc').textContent = `${zoneTxt} · ${names} · ${n}/${KEYS.length} cảm biến đang truyền dữ liệu`;
    $('#edge-meta').textContent = `${zoneTxt} · ${n}/${KEYS.length} sensors online`;

    const ind = $('#edge-indicator');
    ind.classList.toggle('is-off', st.kind === 'offline' || st.kind === 'error');
    ind.classList.toggle('is-unknown', st.kind === 'nodata' || st.kind === 'nodevice');
    ind.setAttribute('aria-label', st.kind === 'online' ? 'Online' : st.kind === 'offline' ? 'Offline' : 'Không rõ');

    const db = $('#device-badge');
    const map = {
      online:   ['badge--green', `${names} · ONLINE`],
      offline:  ['badge--red',   `${names} · OFFLINE`],
      nodata:   ['badge--amber', 'CHƯA CÓ DỮ LIỆU'],
      nodevice: ['badge--amber', 'KHÔNG CÓ THIẾT BỊ'],
      error:    ['badge--red',   'LỖI KẾT NỐI DB'],
    }[st.kind];
    db.className = 'badge ' + map[0];
    $('#device-badge-text').textContent = map[1];

    // Huy hiệu trên từng thẻ KPI
    for (const key of KEYS) {
      const badge = $(`[data-badge="${key}"]`);
      const card = $(`[data-kpi-card="${key}"]`);
      const th = THRESHOLDS[key];
      const v = st.kind === 'online' ? st.row[COL[key]] : null;
      if (!th || v == null) {
        badge.hidden = true;
        card.classList.remove('is-alert');
        continue;
      }
      const over = v > th.max;
      badge.hidden = false;
      badge.className = 'badge ' + (over ? 'badge--amber' : 'badge--green');
      $('span', badge).textContent = over ? 'CẢNH BÁO' : 'BÌNH THƯỜNG';
      card.classList.toggle('is-alert', over);
    }

    // Thẻ cảm biến
    const row = state.latest;
    const on = st.kind === 'online';
    const t = row ? row.temperature : null;
    const h = row ? row.humidity : null;
    $('#sensor-th').textContent = `${fmtVal('temp', t, true)} / ${fmtVal('hum', h, true)}`;
    $('#sensor-soil').textContent = fmtVal('soil', row ? row.soil_moisture : null, true);
    $('#sensor-soil-id').textContent = `SM-${state.zone ?? '--'}`;
    $('#sensor-co2').textContent = fmtVal('co2', row ? row.co2_ppm : null, true);
    $('[data-sensor="th"]').classList.toggle('is-off', !(on && (t != null || h != null)));
    $('[data-sensor="soil"]').classList.toggle('is-off', !(on && row && row.soil_moisture != null));
    $('[data-sensor="co2"]').classList.toggle('is-off', !(on && row && row.co2_ppm != null));

    // Cảnh báo: chỉ vẽ lại khi nội dung đổi (tránh nháy mỗi giây)
    const alerts = buildAlerts(st);
    const sig = JSON.stringify(alerts.map((a) => [a.key, a.msg]));
    if (sig !== lastAlertSig) {
      lastAlertSig = sig;
      renderAlerts(alerts);
    }
  }

  function renderLatest() {
    const row = state.latest;
    for (const key of KEYS) setKpi(key, row ? row[COL[key]] : null, 600);
    $('#last-update').textContent = row ? 'LAST ' + hms(new Date(row.timestamp)) : 'LAST --:--:--';
    renderDeltas();
    renderStatus();
  }

  /* ==========================================================
     Biểu đồ lịch sử (dữ liệu thật từ hàm telemetry_buckets)
     ========================================================== */
  const RANGES = {
    live: { ms: 15 * 60e3,           bucket: '10 seconds',  bucketMs: 10e3,     title: '15 phút', labelSec: true },
    '1d': { ms: 24 * 3600e3,         bucket: '15 minutes',  bucketMs: 15 * 60e3, title: '24 giờ' },
    '1w': { ms: 7 * 24 * 3600e3,     bucket: '1 hour',      bucketMs: 3600e3,   title: '7 ngày', labelDate: true },
    '1m': { ms: 30 * 24 * 3600e3,    bucket: '6 hours',     bucketMs: 6 * 3600e3, title: '30 ngày', labelDate: true },
  };
  const REFRESH_MS = { live: 5000, '1d': 60000, '1w': 300000, '1m': 300000 };

  const fmtDate = (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  const fmtDay = (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
  const fmtHM = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

  const chart = { range: 'live', points: [], from: Date.now() - 900e3, to: Date.now(), err: null, seq: 0, lastLoad: 0 };
  const plot = $('#plot');
  const svg = $('#plot-svg');
  const tooltip = $('#tooltip');
  const GRID_Y = [44, 98, 152, 206, 260];
  const TOP = 44;
  const BOTTOM = 260;
  const geo = { w: 0, left: 44, right: 52 };
  let hoverX = null;     // null = ghim vào điểm dữ liệu mới nhất
  let guide, ptTemp, ptSoil;
  let tempSc = { lo: 0, hi: 1 };
  let soilSc = { lo: 0, hi: 1 };

  function niceScale(values) {
    const v = values.filter((x) => x != null && Number.isFinite(x));
    if (!v.length) return { lo: 0, hi: 1, empty: true };
    const lo = Math.min(...v);
    const hi = Math.max(...v);
    const pad = hi - lo < 1e-9 ? Math.max(1, Math.abs(hi) * 0.05) : (hi - lo) * 0.1;
    return { lo: lo - pad, hi: hi + pad, empty: false };
  }
  const yOf = (sc, v) => BOTTOM - ((v - sc.lo) / (sc.hi - sc.lo)) * (BOTTOM - TOP);
  const xOf = (t) => geo.left + ((t - chart.from) / (chart.to - chart.from)) * (geo.w - geo.left - geo.right);

  // Tách thành các đoạn liên tục; ngắt đường khi thiếu dữ liệu hoặc giá trị null
  function segments(key, gapMs) {
    const segs = [];
    let cur = [];
    let prevT = null;
    for (const p of chart.points) {
      const v = p[key];
      if (v == null) { if (cur.length) segs.push(cur); cur = []; prevT = null; continue; }
      if (prevT != null && p.t - prevT > gapMs && cur.length) { segs.push(cur); cur = []; }
      cur.push(p);
      prevT = p.t;
    }
    if (cur.length) segs.push(cur);
    return segs;
  }

  function drawChart(animate) {
    geo.w = plot.clientWidth;
    if (!geo.w) return;
    const cfg = RANGES[chart.range];
    const H = 292;
    svg.setAttribute('viewBox', `0 0 ${geo.w} ${H}`);
    svg.textContent = '';

    const defs = svgEl('defs');
    const grad = svgEl('linearGradient', { id: 'area-grad', x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.append(
      svgEl('stop', { offset: '0%', 'stop-color': '#06b6d4', 'stop-opacity': 0.28 }),
      svgEl('stop', { offset: '100%', 'stop-color': '#06b6d4', 'stop-opacity': 0 }),
    );
    defs.appendChild(grad);
    svg.appendChild(defs);

    tempSc = niceScale(chart.points.map((p) => p.temp));
    soilSc = niceScale(chart.points.map((p) => p.soil));

    GRID_Y.forEach((y, i) => {
      svg.appendChild(svgEl('line', { class: 'grid', x1: geo.left, x2: geo.w - geo.right, y1: y, y2: y }));
      const frac = i / (GRID_Y.length - 1);
      const tl = svgEl('text', { class: 'axis', x: 6, y: y + 3 });
      tl.textContent = tempSc.empty ? '' : (tempSc.hi - frac * (tempSc.hi - tempSc.lo)).toFixed(1);
      const sl = svgEl('text', { class: 'axis', x: geo.w - geo.right + 8, y: y + 3 });
      sl.textContent = soilSc.empty ? '' : String(Math.round(soilSc.hi - frac * (soilSc.hi - soilSc.lo)));
      svg.append(tl, sl);
    });

    const span = geo.w - geo.left - geo.right;
    for (let i = 0; i <= 6; i++) {
      const when = new Date(chart.from + (i / 6) * (chart.to - chart.from));
      const t = svgEl('text', { class: 'axis', x: geo.left + (i / 6) * span, y: 280, 'text-anchor': i === 0 ? 'start' : i === 6 ? 'end' : 'middle' });
      t.textContent = cfg.labelDate ? fmtDay(when) : (cfg.labelSec ? hms(when) : fmtHM(when));
      svg.appendChild(t);
    }

    const anim = animate && !reduceMotion;
    const gapMs = cfg.bucketMs * 2.5;
    const tempSegs = segments('temp', gapMs);
    const soilSegs = segments('soil', gapMs);
    const toPath = (seg, sc, key) => seg.map((p, i) => (i ? 'L' : 'M') + xOf(p.t).toFixed(1) + ' ' + yOf(sc, p[key]).toFixed(1)).join(' ');

    for (const seg of tempSegs) {
      if (seg.length < 2) continue;
      const area = svgEl('path', { d: `${toPath(seg, tempSc, 'temp')} L${xOf(seg[seg.length - 1].t).toFixed(1)} 262 L${xOf(seg[0].t).toFixed(1)} 262 Z`, fill: 'url(#area-grad)' });
      if (anim) area.classList.add('fade-in');
      svg.appendChild(area);
    }
    for (const [segs, sc, key, cls] of [[soilSegs, soilSc, 'soil', 'line--soil'], [tempSegs, tempSc, 'temp', 'line--temp']]) {
      for (const seg of segs) {
        if (seg.length < 2) {
          const c = svgEl('circle', { cx: xOf(seg[0].t), cy: yOf(sc, seg[0][key]), r: 2.5, fill: key === 'temp' ? '#06b6d4' : '#10b981' });
          svg.appendChild(c);
          continue;
        }
        const p = svgEl('path', { class: `line ${cls}`, d: toPath(seg, sc, key), pathLength: 1 });
        if (anim) p.classList.add('draw');
        svg.appendChild(p);
      }
    }

    const hasData = chart.points.some((p) => p.temp != null || p.soil != null);
    if (!hasData) {
      const msg = svgEl('text', { class: 'no-data', x: geo.w / 2, y: 150, 'text-anchor': 'middle' });
      msg.textContent = chart.err
        ? 'Không tải được lịch sử (đã chạy file dashboard_history.sql trên Supabase chưa?)'
        : 'Chưa có dữ liệu trong khoảng này';
      svg.appendChild(msg);
    }

    guide = svgEl('line', { class: 'guide', y1: 34, y2: 238 });
    ptSoil = svgEl('circle', { class: 'pt pt--soil', r: 5 });
    ptTemp = svgEl('circle', { class: 'pt pt--temp', r: 5 });
    svg.append(guide, ptSoil, ptTemp);
    moveCursor();
  }

  function pickPoint() {
    const pts = chart.points.filter((p) => p.temp != null || p.soil != null);
    if (!pts.length) return null;
    if (hoverX == null) return pts[pts.length - 1];
    let best = pts[0];
    let bd = Infinity;
    for (const p of pts) {
      const d = Math.abs(xOf(p.t) - hoverX);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  function moveCursor() {
    const p = pickPoint();
    const show = !!p;
    tooltip.style.display = show ? '' : 'none';
    guide.style.display = show ? '' : 'none';
    if (!p) { ptTemp.style.display = 'none'; ptSoil.style.display = 'none'; return; }
    const x = xOf(p.t);
    guide.setAttribute('x1', x); guide.setAttribute('x2', x);
    ptTemp.style.display = p.temp != null ? '' : 'none';
    ptSoil.style.display = p.soil != null ? '' : 'none';
    if (p.temp != null) { ptTemp.setAttribute('cx', x); ptTemp.setAttribute('cy', yOf(tempSc, p.temp)); }
    if (p.soil != null) { ptSoil.setAttribute('cx', x); ptSoil.setAttribute('cy', yOf(soilSc, p.soil)); }

    const when = new Date(p.t);
    $('#tt-ts').textContent = `${fmtDate(when)} · ${RANGES[chart.range].labelSec ? hms(when) : fmtHM(when)}`;
    $('#tt-temp').textContent = p.temp != null ? `${p.temp.toFixed(1)}°C` : '--';
    $('#tt-soil').textContent = p.soil != null ? `${Math.round(p.soil)} raw` : '--';

    const w = tooltip.offsetWidth || 166;
    tooltip.style.left = (x + 13 + w > geo.w ? x - 13 - w : x + 13) + 'px';
  }

  plot.addEventListener('pointermove', (e) => {
    hoverX = e.clientX - plot.getBoundingClientRect().left;
    if (guide) moveCursor();
  });
  plot.addEventListener('pointerleave', () => {
    hoverX = null;
    if (guide) moveCursor();
  });

  new ResizeObserver(() => { if (plot.clientWidth !== geo.w) drawChart(false); }).observe(plot);

  async function loadChart(animate) {
    const cfg = RANGES[chart.range];
    const ids = deviceIds();
    const seq = ++chart.seq;
    const myEpoch = epoch;
    const to = Date.now();
    const from = to - cfg.ms;
    if (!ids.length) {
      chart.points = []; chart.err = null; chart.from = from; chart.to = to;
      drawChart(animate);
      return;
    }
    const { data, error } = await supabase.rpc('telemetry_buckets', {
      p_device_ids: ids,
      p_from: new Date(from).toISOString(),
      p_to: new Date(to + 60000).toISOString(),
      p_bucket: cfg.bucket,
    });
    if (seq !== chart.seq || myEpoch !== epoch) return;
    chart.lastLoad = Date.now();
    chart.from = from;
    chart.to = to;
    if (error) {
      console.error('telemetry_buckets:', error);
      chart.err = error.message;
      chart.points = [];
    } else {
      chart.err = null;
      chart.points = (data || []).map((r) => ({ t: Date.parse(r.bucket), temp: r.temperature, soil: r.soil_moisture }));
    }
    drawChart(animate);
  }

  function updateChartTitles() {
    $('#chart-title').textContent = `Biến động môi trường · ${RANGES[chart.range].title}`;
    const names = state.devices.map((d) => d.name || d.id).join(', ') || '--';
    $('#chart-sub').textContent = `Zone ${state.zone ?? '--'} · ${names} · trục trái: nhiệt độ °C, trục phải: độ ẩm đất (raw)`;
  }

  // Bộ lọc thời gian
  $$('.time-filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.range === chart.range) return;
      chart.range = btn.dataset.range;
      $$('.time-filter').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      hoverX = null;
      updateChartTitles();
      loadChart(true);
    });
  });

  /* ==========================================================
     Navigation / quick actions (các trang này chưa có trong Figma)
     ========================================================== */
  $$('.nav-item[data-todo]').forEach((btn) => {
    btn.addEventListener('click', () => toast(`“${btn.dataset.todo}” chưa có trong thiết kế Figma này.`, 'info'));
  });
  $('#btn-twin').addEventListener('click', () => toast('“3D Spatial Twin” chưa có trong thiết kế Figma này.', 'info'));

  /* ==========================================================
     Irrigation dialog (form)
     ========================================================== */
  const dialog = $('#irrigation-dialog');
  const form = $('#irrigation-form');
  const fDuration = $('#f-duration');
  const fRange = $('#f-range');
  const fNote = $('#f-note');
  const durError = $('#duration-error');
  const irrigateBtn = $('#btn-irrigate');
  let irrigationTimer = null;

  function openDialog() {
    if (irrigateBtn.disabled) return;
    durError.textContent = '';
    fDuration.removeAttribute('aria-invalid');
    dialog.showModal();
    $('#f-zone').focus();
  }

  const closeDialog = () => dialog.close();

  irrigateBtn.addEventListener('click', openDialog);
  $('#dlg-close').addEventListener('click', closeDialog);
  $('#dlg-cancel').addEventListener('click', closeDialog);
  // Bấm ra ngoài hộp thoại để đóng
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeDialog(); });

  fRange.addEventListener('input', () => { fDuration.value = fRange.value; durError.textContent = ''; fDuration.removeAttribute('aria-invalid'); });
  fDuration.addEventListener('input', () => {
    const v = Number(fDuration.value);
    if (Number.isInteger(v) && v >= 1 && v <= 60) fRange.value = v;
  });
  fNote.addEventListener('input', () => { $('#note-count').textContent = fNote.value.length; });

  async function startIrrigation({ zone, zoneLabel, minutes, note }) {
    // 1. Gọi API lưu dữ liệu xuống Supabase
    const { error } = await supabase
      .from('irrigation_logs')
      .insert([{ 
        zone: zone, 
        duration_minutes: minutes, 
        note: note 
      }]);

    if (error) {
      toast('Lỗi kết nối DB: ' + error.message, 'error');
      return;
    }

    // 2. Chạy hiệu ứng UI như cũ nếu lưu thành công
    document.dispatchEvent(new CustomEvent('irrigation:start', { detail: { zone, minutes, note } }));
    toast(`Đã gửi lệnh tưới xuống DB · ${zoneLabel} · ${minutes} phút`);
    
    const label = $('span', irrigateBtn);
    irrigateBtn.disabled = true;
    let remaining = minutes * 60;
    
    const render = () => { label.textContent = `Đang tưới ${pad2(Math.floor(remaining / 60))}:${pad2(remaining % 60)}`; };
    render();
    
    irrigationTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(irrigationTimer);
        label.textContent = 'Kích hoạt tưới';
        irrigateBtn.disabled = false;
        toast(`Hoàn tất tưới · ${zoneLabel}`);
      } else {
        render();
      }
    }, 1000);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const minutes = Number(fDuration.value);
    if (fDuration.value.trim() === '' || !Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
      durError.textContent = 'Nhập số phút nguyên từ 1 đến 60.';
      fDuration.setAttribute('aria-invalid', 'true');
      fDuration.focus();
      return;
    }
    const zoneSelect = $('#f-zone');
    startIrrigation({
      zone: zoneSelect.value,
      zoneLabel: zoneSelect.selectedOptions[0].textContent,
      minutes,
      note: fNote.value.trim(),
    });
    form.reset();
    $('#note-count').textContent = '0';
    closeDialog();
  });

  /* ==========================================================
     Nạp dữ liệu từ Supabase
     ========================================================== */
  const zoneSelect = $('#zone-select');
  const LATEST_COLS = 'device_id, timestamp, temperature, humidity, soil_moisture, light_lux, co2_ppm, ec, ph';

  async function loadZones() {
    const { data, error } = await supabase.from('devices').select('id, name, zone_id').order('zone_id');
    state.zones = new Map();
    if (error) {
      console.error('devices:', error);
      state.fetchError = error.message;
    } else {
      state.fetchError = null;
      for (const d of data || []) {
        if (!state.zones.has(d.zone_id)) state.zones.set(d.zone_id, []);
        state.zones.get(d.zone_id).push(d);
      }
    }

    zoneSelect.textContent = '';
    if (!state.zones.size) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'Chưa có zone';
      zoneSelect.appendChild(o);
    }
    for (const zoneId of state.zones.keys()) {
      const o = document.createElement('option');
      o.value = zoneId;
      o.textContent = `Zone ${zoneId}`;
      zoneSelect.appendChild(o);
    }

    // Danh sách khu vực trong hộp thoại tưới cũng lấy từ các zone này
    const fz = $('#f-zone');
    fz.textContent = '';
    for (const zoneId of state.zones.keys()) {
      const o = document.createElement('option');
      o.value = zoneId;
      o.textContent = `Zone ${zoneId}`;
      fz.appendChild(o);
    }
    const all = document.createElement('option');
    all.value = 'LOT-A';
    all.textContent = 'Tomato Lot A (toàn bộ)';
    fz.appendChild(all);

    let saved = null;
    try { saved = localStorage.getItem('dash.zone'); } catch (e) { /* bỏ qua */ }
    const first = state.zones.has(saved) ? saved : (state.zones.keys().next().value ?? null);
    selectZone(first, true);
  }

  function selectZone(zoneId, reload) {
    epoch++;
    state.zone = zoneId;
    state.devices = zoneId != null ? (state.zones.get(zoneId) || []) : [];
    state.latest = null;
    state.ref = null;
    zoneSelect.value = zoneId ?? '';
    const fz = $('#f-zone');
    if (zoneId != null && [...fz.options].some((o) => o.value === zoneId)) fz.value = zoneId;
    try { if (zoneId != null) localStorage.setItem('dash.zone', zoneId); } catch (e) { /* bỏ qua */ }
    hoverX = null;
    updateChartTitles();
    renderLatest();
    if (reload !== false) refreshAll(true);
  }

  async function refreshLatest() {
    const ids = deviceIds();
    const myEpoch = epoch;
    if (!ids.length) { state.latest = null; renderLatest(); return; }
    const { data, error } = await supabase
      .from('telemetry_logs')
      .select(LATEST_COLS)
      .in('device_id', ids)
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (myEpoch !== epoch) return;
    if (error) {
      console.error('telemetry_logs:', error);
      state.fetchError = error.message;
    } else {
      state.fetchError = null;
      state.latest = data || null;
    }
    renderLatest();
  }

  async function refreshRef() {
    const ids = deviceIds();
    const myEpoch = epoch;
    if (!ids.length) { state.ref = null; renderDeltas(); return; }
    const now = Date.now();
    const { data, error } = await supabase
      .from('telemetry_logs')
      .select(LATEST_COLS)
      .in('device_id', ids)
      .lte('timestamp', new Date(now - 3600e3).toISOString())
      .gte('timestamp', new Date(now - 2 * 3600e3).toISOString())
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (myEpoch !== epoch) return;
    state.ref = error ? null : (data || null);
    renderDeltas();
  }

  async function refreshSparks() {
    const ids = deviceIds();
    const myEpoch = epoch;
    const to = Date.now();
    let rows = [];
    if (ids.length) {
      const { data, error } = await supabase.rpc('telemetry_buckets', {
        p_device_ids: ids,
        p_from: new Date(to - 3600e3).toISOString(),
        p_to: new Date(to + 60000).toISOString(),
        p_bucket: '6 minutes',
      });
      if (error) console.error('telemetry_buckets (sparkline):', error);
      else rows = data || [];
    }
    if (myEpoch !== epoch) return;
    const cols = { temp: 'temperature', soil: 'soil_moisture', light: 'light_lux', co2: 'co2_ppm' };
    for (const [key, col] of Object.entries(cols)) {
      const vals = rows.map((r) => r[col]).filter((v) => v != null);
      if (vals.length < 2) { sparkData[key] = null; continue; }
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      sparkData[key] = vals.map((v) => (hi - lo < 1e-9 ? 0.5 : clamp((v - lo) / (hi - lo), 0.05, 0.95)));
    }
    renderSparks(false);
  }

  function refreshAll(animate) {
    refreshLatest();
    refreshRef();
    refreshSparks();
    loadChart(animate);
  }

  zoneSelect.addEventListener('change', () => selectZone(zoneSelect.value || null, true));

  /* ==========================================================
     Xuất file txt + xóa dữ liệu một tháng đã kết thúc
     ========================================================== */
  const expDialog = $('#export-dialog');
  const expMonth = $('#exp-month');
  const expStatus = $('#exp-status');
  const expProgress = $('#exp-progress');
  const expConfirmField = $('#exp-confirm-field');
  const expConfirm = $('#exp-confirm');
  const expDownload = $('#exp-download');
  const expDelete = $('#exp-delete');
  const exp = { months: [], busy: false, verifiedMonth: null };
  const EXPORT_COLS = ['id', 'timestamp', 'device_id', 'temperature', 'humidity', 'soil_moisture', 'light_lux', 'co2_ppm', 'ec', 'ph'];

  function setExpStatus(text, cls) {
    expStatus.textContent = text;
    expStatus.className = 'exp-status' + (cls ? ' ' + cls : '');
  }
  const selMonth = () => exp.months.find((m) => m.month_start === expMonth.value) || null;

  function syncExpButtons() {
    const m = selMonth();
    const verified = !!m && exp.verifiedMonth === m.month_start;
    expDownload.disabled = exp.busy || !m;
    expConfirmField.hidden = !(verified && m.is_finished);
    expDelete.disabled = exp.busy || !(verified && m.is_finished && expConfirm.value.trim() === m.month_start.slice(0, 7));
  }

  async function loadMonths() {
    expMonth.textContent = '';
    setExpStatus('Đang tải danh sách tháng…');
    const { data, error } = await supabase.rpc('telemetry_months');
    if (error) {
      console.error('telemetry_months:', error);
      exp.months = [];
      setExpStatus('Không tải được danh sách tháng. Đã chạy file dashboard_history.sql trên Supabase chưa?\n' + error.message, 'is-error');
      syncExpButtons();
      return;
    }
    exp.months = (data || []).map((r) => ({ month_start: r.month_start, row_count: Number(r.row_count), is_finished: !!r.is_finished }));
    if (!exp.months.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'Chưa có dữ liệu';
      expMonth.appendChild(o);
      setExpStatus('Chưa có dữ liệu nào trong telemetry_logs.');
    }
    for (const m of exp.months) {
      const o = document.createElement('option');
      o.value = m.month_start;
      o.textContent = `${m.month_start.slice(0, 7)} · ${m.row_count.toLocaleString('en-US')} dòng${m.is_finished ? '' : ' (tháng hiện tại, chưa thể xóa)'}`;
      expMonth.appendChild(o);
    }
    if (exp.months.length) setExpStatus('Chọn tháng rồi bấm “Tải file txt”.');
    syncExpButtons();
  }

  function rowToLine(r) {
    return EXPORT_COLS.map((c) => (r[c] == null ? 'NULL' : String(r[c]))).join('\t');
  }

  // Mốc đầu tháng theo giờ Việt Nam (UTC+7), khớp với hàm SQL
  function monthRange(ym) {
    const [y, m] = ym.split('-').map(Number);
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    return {
      start: new Date(`${y}-${pad2(m)}-01T00:00:00+07:00`),
      end: new Date(`${ny}-${pad2(nm)}-01T00:00:00+07:00`),
    };
  }

  async function downloadMonth() {
    const m = selMonth();
    if (!m || exp.busy) return;
    const ym = m.month_start.slice(0, 7);
    const { start, end } = monthRange(ym);
    exp.busy = true;
    exp.verifiedMonth = null;
    expConfirm.value = '';
    expProgress.hidden = false;
    expProgress.value = 0;
    syncExpButtons();
    try {
      const lines = [EXPORT_COLS.join('\t')];
      let last = start.toISOString();
      let seen = new Set();
      let count = 0;
      for (;;) {
        const { data, error } = await supabase
          .from('telemetry_logs')
          .select(EXPORT_COLS.join(', '))
          .gte('timestamp', last)
          .lt('timestamp', end.toISOString())
          .order('timestamp', { ascending: true })
          .limit(1000);
        if (error) throw error;
        const fresh = (data || []).filter((r) => !(r.timestamp === last && seen.has(r.id)));
        if (!fresh.length) break;
        for (const r of fresh) lines.push(rowToLine(r));
        count += fresh.length;
        const newLast = data[data.length - 1].timestamp;
        const ids = data.filter((r) => r.timestamp === newLast).map((r) => r.id);
        seen = newLast === last ? new Set([...seen, ...ids]) : new Set(ids);
        last = newLast;
        expProgress.value = Math.min(100, (count / Math.max(1, m.row_count)) * 100);
        setExpStatus(`Đang tải… ${count.toLocaleString('en-US')} / ${m.row_count.toLocaleString('en-US')} dòng`);
      }

      const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `telemetry_${ym}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);

      if (count === m.row_count) {
        exp.verifiedMonth = m.month_start;
        setExpStatus(m.is_finished
          ? `Đã tải ${count.toLocaleString('en-US')} dòng, khớp với database.\nHãy mở file telemetry_${ym}.txt kiểm tra lại. Khi chắc chắn đã lưu file, gõ ${ym} vào ô bên dưới để bật nút xóa.`
          : `Đã tải ${count.toLocaleString('en-US')} dòng. Tháng này chưa kết thúc nên chưa thể xóa.`, 'is-ok');
      } else {
        setExpStatus(`Số dòng tải về (${count.toLocaleString('en-US')}) KHÔNG khớp số dòng trong database (${m.row_count.toLocaleString('en-US')}). Không cho phép xóa. Hãy thử tải lại.`, 'is-error');
      }
    } catch (err) {
      console.error(err);
      setExpStatus('Lỗi khi tải dữ liệu: ' + (err.message || err), 'is-error');
    } finally {
      exp.busy = false;
      expProgress.hidden = true;
      syncExpButtons();
    }
  }

  async function deleteMonth() {
    const m = selMonth();
    if (!m || exp.busy || exp.verifiedMonth !== m.month_start || !m.is_finished) return;
    exp.busy = true;
    syncExpButtons();
    setExpStatus('Đang xóa dữ liệu tháng ' + m.month_start.slice(0, 7) + '…');
    const { data, error } = await supabase.rpc('delete_telemetry_month', { p_month: m.month_start });
    exp.busy = false;
    if (error) {
      console.error('delete_telemetry_month:', error);
      setExpStatus('Xóa thất bại: ' + error.message, 'is-error');
      syncExpButtons();
      return;
    }
    const n = Number(data);
    toast(`Đã xóa ${n.toLocaleString('en-US')} dòng của tháng ${m.month_start.slice(0, 7)}`);
    exp.verifiedMonth = null;
    expConfirm.value = '';
    await loadMonths();
    setExpStatus(`Đã xóa ${n.toLocaleString('en-US')} dòng (kỳ vọng ${m.row_count.toLocaleString('en-US')}). Dung lượng ổ đĩa có thể chưa giảm ngay vì Postgres thu hồi chỗ trống sau khi vacuum.`, n === m.row_count ? 'is-ok' : 'is-error');
  }

  $('#btn-export').addEventListener('click', () => {
    exp.verifiedMonth = null;
    expConfirm.value = '';
    expProgress.hidden = true;
    expDialog.showModal();
    loadMonths();
  });
  const closeExport = () => { if (!exp.busy) expDialog.close(); };
  $('#exp-close').addEventListener('click', closeExport);
  $('#exp-cancel').addEventListener('click', closeExport);
  expDialog.addEventListener('click', (e) => { if (e.target === expDialog) closeExport(); });
  expDialog.addEventListener('cancel', (e) => { if (exp.busy) e.preventDefault(); });
  expMonth.addEventListener('change', () => {
    exp.verifiedMonth = null;
    expConfirm.value = '';
    const m = selMonth();
    setExpStatus(m ? 'Chọn tháng rồi bấm “Tải file txt”.' : '');
    syncExpButtons();
  });
  expConfirm.addEventListener('input', syncExpButtons);
  expDownload.addEventListener('click', downloadMonth);
  expDelete.addEventListener('click', deleteMonth);

  /* ==========================================================
     Boot
     ========================================================== */
  async function boot() {
    $('#policy-text').textContent =
      'Ngưỡng cảnh báo: nhiệt độ > 50°C · độ ẩm không khí > 50% · ánh sáng > 2000 lux · CO₂ > 800 ppm · ' +
      'độ ẩm đất: chưa đặt ngưỡng (đang là số thô). Offline nếu không có dữ liệu mới quá 30 giây.';
    setGauge(null);
    renderSparks(true);
    updateChartTitles();
    renderStatus();
    drawChart(false);

    await loadZones();

    setInterval(() => { if (!document.hidden) refreshLatest(); }, 5000);
    setInterval(() => { if (!document.hidden) { refreshRef(); refreshSparks(); } }, 60000);
    setInterval(() => {
      if (!document.hidden && Date.now() - chart.lastLoad >= REFRESH_MS[chart.range]) loadChart(false);
    }, 5000);
    setInterval(renderStatus, 1000);   // cập nhật online/offline mỗi giây, không cần gọi lại DB
  }

  boot();
})();
