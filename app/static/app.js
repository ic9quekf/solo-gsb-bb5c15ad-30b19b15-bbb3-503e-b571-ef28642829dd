'use strict';
/* =========================================================================
 * 平面照片标尺校准 —— 前端逻辑
 *
 * 核心原理：
 *   用户标记的 4 个图像角点与已知矩形的 4 个世界坐标角点
 *   （0,0）（W,0）（W,H）（0,H）构成透视对应，用 DLT（直接线性变换）
 *   求解 3×3 单应矩阵 H（图像像素 -> 实际米制平面）。
 *   多边形顶点经 H 映射后，用鞋带公式求面积、逐边求和得周长。
 *
 * 所有交互（缩放/平移/拖顶点）都显式区分「屏幕坐标」与「图像坐标」，
 * 视图变化不会改变测量所依赖的图像坐标。
 * ========================================================================= */

// ---------------- DOM ----------------
const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const wrap = $('canvas-wrap');
const fileInput = $('file-input');
const refW = $('ref-w');
const refH = $('ref-h');
const calibStatus = $('calib-status');
const clearCornersBtn = $('clear-corners-btn');
const newPolyBtn = $('new-poly-btn');
const redrawPolyBtn = $('redraw-poly-btn');
const deletePolyBtn = $('delete-poly-btn');
const polyName = $('poly-name');
const regionList = $('region-list');
const regionEmpty = $('region-empty');
const exportBtn = $('export-btn');
const resetViewBtn = $('reset-view-btn');
const overlay = $('drop-overlay');
const toastEl = $('toast');
const zoomHud = $('zoom-hud');
const zoomLevel = $('zoom-level');

const POLY_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7',
  '#ec4899', '#14b8a6', '#eab308', '#f97316', '#06b6d4', '#84cc16'];

// ---------------- 全局状态 ----------------
const state = {
  image: null,
  imageInfo: null,                 // {url, filename, width, height}
  view: { scale: 1, offX: 0, offY: 0 },
  fitScale: 1,
  corners: [],                     // [{x,y}] 图像坐标，共 4 个
  polygons: [],                    // [{id,name,color,points,closed,error,metrics}]
  activeId: null,                  // 当前绘制/选中的多边形
  calib: { ok: false, H: null, reason: '尚未标记角点（0/4）' },
  hover: null,                     // 鼠标位置（图像坐标）
  pointers: new Map(),
  gesture: null,                   // 当前指针手势
  polySeq: 0,
};

const HANDLE_PX = 9;               // 顶点拾取半径（屏幕像素）
const TAP_SLOP = 5;                // 点击与拖动的位移阈值
const DEDUP_PX = 6;                // 连续点击去重半径（屏幕像素）

// ---------------- 通用工具 ----------------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const finitePt = (p) => Number.isFinite(p.x) && Number.isFinite(p.y);

function toast(msg, kind = '') {
  toastEl.textContent = msg;
  toastEl.className = 'toast' + (kind ? ' ' + kind : '');
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.hidden = true; }, 3200);
}

function activePolygon() {
  return state.polygons.find((p) => p.id === state.activeId) || null;
}

// =========================================================================
// 几何：3x3 单应矩阵（DLT + Jacobi 特征分解求齐次零空间）
// =========================================================================

/* 对 9x9 实对称矩阵做 Jacobi 特征分解，返回 {values, vectors}（vectors 的列为特征向量）。 */
function jacobiEigen(matrix) {
  const n = 9;
  const a = matrix.map((r) => r.slice());
  const v = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-26) break;

    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p][q];
        if (Math.abs(apq) < 1e-18) continue;
        const theta = 0.5 * Math.atan2(2 * apq, a[q][q] - a[p][p]);
        const c = Math.cos(theta), s = Math.sin(theta);
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: Array.from({ length: n }, (_, i) => a[i][i]), vectors: v };
}

/* DLT：由 4 对对应点求 src -> dst 的单应矩阵，返回扁平 9 维向量或 null（退化时）。 */
function homographyDLT(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];
    A.push([0, 0, 0, -x, -y, -1, Y * x, Y * y, Y]);
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y, -X]);
  }
  // M = AᵀA，其最小特征值对应的特征向量即 A h = 0 的解。
  const M = Array.from({ length: 9 }, () => new Array(9).fill(0));
  for (let i = 0; i < 9; i++) {
    for (let j = 0; j < 9; j++) {
      let s = 0;
      for (let k = 0; k < 8; k++) s += A[k][i] * A[k][j];
      M[i][j] = s;
    }
  }
  const { values, vectors } = jacobiEigen(M);
  let idx = 0;
  for (let i = 1; i < 9; i++) if (Math.abs(values[i]) < Math.abs(values[idx])) idx = i;
  const h = vectors.map((row) => row[idx]);
  if (h.some((v) => !Number.isFinite(v))) return null;
  // 归一化，便于数值阈值判断。
  const norm = Math.hypot(...h);
  if (norm < 1e-15) return null;
  return h.map((v) => v / norm);
}

function applyH(H, p) {
  const w = H[2][0] * p.x + H[2][1] * p.y + H[2][2];
  return {
    x: (H[0][0] * p.x + H[0][1] * p.y + H[0][2]) / w,
    y: (H[1][0] * p.x + H[1][1] * p.y + H[1][2]) / w,
    w,
  };
}

/* 线段是否相交（含端点接触与共线重叠），用于多边形自交检测。 */
function segmentsIntersect(a, b, c, d) {
  const eps = 1e-9;
  const cross = (p, q, r) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const onSeg = (p, q, r) =>
    Math.min(p.x, q.x) - eps <= r.x && r.x <= Math.max(p.x, q.x) + eps &&
    Math.min(p.y, q.y) - eps <= r.y && r.y <= Math.max(p.y, q.y) + eps;

  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);

  if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
      ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) return true;

  if (Math.abs(d1) <= eps && onSeg(c, d, a)) return true;
  if (Math.abs(d2) <= eps && onSeg(c, d, b)) return true;
  if (Math.abs(d3) <= eps && onSeg(a, b, c)) return true;
  if (Math.abs(d4) <= eps && onSeg(a, b, d)) return true;
  return false;
}

function polygonSelfIntersects(pts) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i) continue;
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (adjacent) continue;
      const c = pts[j], d = pts[(j + 1) % n];
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

const shoelace2 = (pts) => {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a.x * b.y - a.y * b.x;
  }
  return s / 2;
};

// =========================================================================
// 校准与测量
// =========================================================================

function convexOrdered(pts) {
  // 依次连接是否构成凸四边形（各边叉积同号）；任意连续三点近似共线视为退化。
  let sign = 0;
  const n = pts.length;
  let maxEdge = 0;
  for (let i = 0; i < n; i++) maxEdge = Math.max(maxEdge, dist(pts[i], pts[(i + 1) % n]));
  const eps = 1e-8 * maxEdge * maxEdge;

  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) < eps) return false; // 三点（近似）共线，无法标定
    const s = Math.sign(cr);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

function recomputeCalibration() {
  const W = parseFloat(refW.value);
  const H = parseFloat(refH.value);
  const cs = state.corners;

  const fail = (reason) => { state.calib = { ok: false, H: null, reason }; };

  if (!(W > 0) || !(H > 0)) { fail('标定矩形的实际宽、高必须为正数'); return; }
  if (cs.length < 4) { fail(`尚未标记角点（${cs.length}/4）`); return; }

  for (let i = 0; i < 4; i++)
    for (let j = i + 1; j < 4; j++)
      if (dist(cs[i], cs[j]) < 1e-6) { fail('存在重合角点，请将四个角放在不同位置'); return; }

  if (!convexOrdered(cs)) {
    fail('角点未构成非退化凸四边形（可能顺序错误、交叉或三点共线）：请严格按 左上 → 右上 → 右下 → 左下 的顺序标记');
    return;
  }

  const world = [
    { x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H },
  ];
  const h = homographyDLT(cs, world);
  if (!h) { fail('四点配置退化，透视变换矩阵无法求解'); return; }
  const Hm = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], h[8]]];

  // 正算校验：映射结果必须与矩形世界点吻合，且分母不接近 0，
  // 否则说明该单应矩阵不可逆 / 四点共线等退化情形。
  const scale = Math.max(W, H);
  for (let i = 0; i < 4; i++) {
    const mp = applyH(Hm, cs[i]);
    if (!Number.isFinite(mp.x) || !Number.isFinite(mp.y) || Math.abs(mp.w) < 1e-9) {
      fail('单应矩阵不可逆（透视分母为 0），请重新标记四角');
      return;
    }
    const err = Math.hypot(mp.x - world[i].x, mp.y - world[i].y) / scale;
    if (err > 1e-5) {
      fail('四点无法求出有效的透视校准（矩阵不可逆或角点近似共线），请重新标记');
      return;
    }
  }
  state.calib = { ok: true, H: Hm, reason: '' };
}

function measurePolygon(poly) {
  poly.error = '';
  poly.metrics = null;
  if (!poly.closed) return;
  if (!state.calib.ok) { poly.error = '等待透视校准完成'; return; }
  if (poly.points.length < 3) { poly.error = '顶点数不足 3 个'; return; }

  // 图像坐标重合顶点检查。
  for (let i = 0; i < poly.points.length; i++)
    for (let j = i + 1; j < poly.points.length; j++)
      if (dist(poly.points[i], poly.points[j]) < 1e-6) {
        poly.error = '存在重合顶点，无法计算面积';
        return;
      }

  const Hm = state.calib.H;
  const worldPts = [];
  for (const p of poly.points) {
    const mp = applyH(Hm, p);
    if (!Number.isFinite(mp.x) || !Number.isFinite(mp.y) || Math.abs(mp.w) < 1e-9) {
      poly.error = '多边形跨越透视消失线附近，投影分母为 0，无法计算';
      return;
    }
    worldPts.push({ x: mp.x, y: mp.y });
  }

  // 透视双射保持相交关系，在世界坐标下检测自交。
  if (polygonSelfIntersects(worldPts)) {
    poly.error = '多边形自交：请拖动顶点消除边的交叉后再测量';
    return;
  }

  const area = Math.abs(shoelace2(worldPts));
  let perimeter = 0;
  for (let i = 0; i < worldPts.length; i++) {
    perimeter += dist(worldPts[i], worldPts[(i + 1) % worldPts.length]);
  }
  poly.metrics = { areaM2: area, perimeterM: perimeter, worldPts };
}

function recomputeAll() {
  recomputeCalibration();
  for (const poly of state.polygons) measurePolygon(poly);
  render();
  renderSidebar();
  renderCalibStatus();
  updateButtons();
}

// =========================================================================
// 坐标变换：屏幕(CSS 像素) <-> 图像(像素)
// screen = image * scale + offset
// =========================================================================

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const cw = wrap.clientWidth, ch = wrap.clientHeight;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

function screenToImage(sx, sy) {
  const r = canvas.getBoundingClientRect();
  const x = sx - r.left, y = sy - r.top;
  const v = state.view;
  return { x: (x - v.offX) / v.scale, y: (y - v.offY) / v.scale, sx: x, sy: y };
}

function imageToScreen(p) {
  const v = state.view;
  return { x: p.x * v.scale + v.offX, y: p.y * v.scale + v.offY };
}

function fitImage() {
  const info = state.imageInfo;
  const cw = wrap.clientWidth, ch = wrap.clientHeight;
  const pad = 48;
  const s = Math.min((cw - pad * 2) / info.width, (ch - pad * 2) / info.height);
  state.fitScale = s;
  state.view.scale = s;
  state.view.offX = (cw - info.width * s) / 2;
  state.view.offY = (ch - info.height * s) / 2;
}

function zoomAt(sx, sy, factor) {
  const v = state.view;
  const newScale = clamp(v.scale * factor, state.fitScale * 0.1, state.fitScale * 60);
  const real = newScale / v.scale;
  v.offX = sx - (sx - v.offX) * real;
  v.offY = sy - (sy - v.offY) * real;
  v.scale = newScale;
  render();
  updateZoomHud();
}

function updateZoomHud() {
  zoomLevel.textContent = Math.round((state.view.scale / state.fitScale) * 100) + '%';
}

// =========================================================================
// 渲染
// =========================================================================

function drawLabel(text, x, y, color, scale) {
  const fs = 12 / scale;
  ctx.font = `600 ${fs}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const w = ctx.measureText(text).width + fs;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - fs * 0.8, w, fs * 1.6, fs * 0.35);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.5 / scale;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x, y + fs * 0.05);
}

function render() {
  const cw = wrap.clientWidth, ch = wrap.clientHeight;
  ctx.clearRect(0, 0, cw, ch);
  if (!state.image) return;

  const v = state.view, s = v.scale;
  ctx.save();
  ctx.translate(v.offX, v.offY);
  ctx.scale(s, s);

  // 照片。
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(state.image, 0, 0, state.imageInfo.width, state.imageInfo.height);

  // 标定四边形。
  const cs = state.corners;
  if (cs.length > 0) {
    ctx.beginPath();
    cs.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (cs.length === 4) ctx.closePath();
    ctx.strokeStyle = state.calib.ok ? 'rgba(34,197,94,0.95)' : 'rgba(245,158,11,0.95)';
    ctx.lineWidth = 2 / s;
    ctx.stroke();
    cs.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, HANDLE_PX / 2 / s, 0, Math.PI * 2);
      ctx.fillStyle = state.calib.ok ? '#22c55e' : '#f59e0b';
      ctx.fill();
      ctx.lineWidth = 1.5 / s;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      drawLabel(String(i + 1), p.x, p.y - 16 / s, '#d97706', s);
    });
  }

  // 各测量多边形。
  for (const poly of state.polygons) {
    const active = poly.id === state.activeId;
    const bad = !!poly.error;
    const col = bad ? '#ef4444' : poly.color;
    const pts = poly.points;

    if (poly.closed && pts.length >= 3) {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = bad ? 'rgba(239,68,68,0.10)' : col + '26';
      ctx.fill();
    }

    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (poly.closed) ctx.closePath();
    ctx.strokeStyle = col;
    ctx.lineWidth = (active ? 2.5 : 1.8) / s;
    ctx.stroke();

    // 活动多边形的橡皮筋。
    if (active && !poly.closed && pts.length > 0 && state.hover) {
      ctx.beginPath();
      ctx.moveTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      ctx.lineTo(state.hover.x, state.hover.y);
      ctx.strokeStyle = col + '99';
      ctx.lineWidth = 1.2 / s;
      ctx.setLineDash([6 / s, 5 / s]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (pts.length >= 3) {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        ctx.lineTo(state.hover.x, state.hover.y);
        ctx.strokeStyle = col + '55';
        ctx.stroke();
      }
    }

    pts.forEach((p, i) => {
      const isFirst = i === 0;
      ctx.beginPath();
      const r = (isFirst && active ? HANDLE_PX * 0.75 : HANDLE_PX * 0.5) / s;
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isFirst ? col : '#fff';
      ctx.fill();
      ctx.lineWidth = 1.6 / s;
      ctx.strokeStyle = col;
      ctx.stroke();
      if (isFirst && active && !poly.closed && pts.length >= 3) {
        drawLabel('✓', p.x, p.y - 18 / s, '#16a34a', s);
      }
    });

    // 面积/周长标签（取顶点平均位置）。
    if (poly.closed && pts.length >= 3) {
      const c = pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
      c.x /= pts.length; c.y /= pts.length;
      if (poly.metrics) {
        drawLabel(`${fmtArea(poly.metrics.areaM2)}  ·  ${fmtLength(poly.metrics.perimeterM)}`,
          c.x, c.y, col, s);
      } else if (poly.error) {
        drawLabel('✕ ' + poly.error, c.x, c.y, '#dc2626', s);
      }
    }
  }

  ctx.restore();
}

// ---------------- 侧栏 ----------------
function fmtArea(m2) {
  if (m2 >= 1) return m2.toFixed(3) + ' m²';
  if (m2 >= 1e-4) return (m2 * 1e4).toFixed(2) + ' cm²';
  return (m2 * 1e6).toFixed(2) + ' mm²';
}
function fmtLength(m) {
  if (m >= 1) return m.toFixed(3) + ' m';
  if (m >= 0.01) return (m * 100).toFixed(2) + ' cm';
  return (m * 1000).toFixed(2) + ' mm';
}

function renderCalibStatus() {
  const c = state.calib;
  if (c.ok) {
    calibStatus.textContent = `校准成功：1 像素 ≈ 可变比例（透视已校正），可绘制测量区域`;
    calibStatus.className = 'status ok';
  } else {
    calibStatus.textContent = '⛔ ' + c.reason;
    calibStatus.className = 'status err';
  }
}

function renderSidebar() {
  regionList.innerHTML = '';
  regionEmpty.style.display = state.polygons.length ? 'none' : 'block';

  for (const poly of state.polygons) {
    const li = document.createElement('li');
    li.className = 'region-item' +
      (poly.id === state.activeId ? ' selected' : '') +
      (poly.error ? ' invalid' : '');
    li.dataset.id = poly.id;

    const head = document.createElement('div');
    head.className = 'rhead';
    const name = document.createElement('div');
    name.className = 'rname';
    name.innerHTML = `<span class="swatch" style="background:${poly.color}"></span>`;
    name.append(document.createTextNode(poly.name));
    const rm = document.createElement('button');
    rm.className = 'rremove';
    rm.title = '删除区域';
    rm.textContent = '✕';
    rm.addEventListener('click', (e) => { e.stopPropagation(); removePolygon(poly.id); });
    head.append(name, rm);

    const metrics = document.createElement('div');
    metrics.className = poly.error ? 'rerr' : 'rmetrics';
    if (!poly.closed) {
      metrics.textContent = `绘制中（${poly.points.length} 个顶点，至少 3 个后双击闭合）`;
    } if (poly.error) {
      metrics.textContent = '⛔ ' + poly.error;
    } else if (poly.metrics) {
      metrics.innerHTML =
        `面积：<strong>${fmtArea(poly.metrics.areaM2)}</strong><br>` +
        `周长：<strong>${fmtLength(poly.metrics.perimeterM)}</strong><br>` +
        `顶点：${poly.points.length} 个`;
    }
    li.append(head, metrics);
    li.addEventListener('click', () => selectPolygon(poly.id));
    regionList.append(li);
  }
}

function updateButtons() {
  const hasImg = !!state.image;
  const c = state.calib.ok;
  clearCornersBtn.disabled = state.corners.length === 0;
  newPolyBtn.disabled = !c;
  const poly = activePolygon();
  redrawPolyBtn.disabled = !poly;
  deletePolyBtn.disabled = !poly;
  exportBtn.disabled = !hasImg;
  resetViewBtn.disabled = !hasImg;
}

// =========================================================================
// 指针交互（拾取 / 拖动 / 平移 / 缩放）
// =========================================================================

function hitCorner(pt) {
  for (let i = state.corners.length - 1; i >= 0; i--)
    if (dist(pt, imageToScreen(state.corners[i])) <= HANDLE_PX) return i;
  return -1;
}

function hitVertex(pt) {
  // 优先活动多边形的首顶点（用于闭合），再按从后往前的多边形顺序拾取。
  const active = activePolygon();
  if (active && !active.closed && active.points.length >= 3) {
    if (dist(pt, imageToScreen(active.points[0])) <= HANDLE_PX + 2)
      return { polyId: active.id, index: 0, close: true };
  }
  for (let pi = state.polygons.length - 1; pi >= 0; pi--) {
    const poly = state.polygons[pi];
    for (let i = poly.points.length - 1; i >= 0; i--) {
      if (dist(pt, imageToScreen(poly.points[i])) <= HANDLE_PX)
        return { polyId: poly.id, index: i };
    }
  }
  return null;
}

canvas.addEventListener('pointerdown', (e) => {
  if (!state.image) return;
  canvas.setPointerCapture(e.pointerId);
  state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  // 双指手势：捏合缩放 + 平移。
  if (state.pointers.size === 2) {
    const [p0, p1] = [...state.pointers.values()];
    state.gesture = {
      mode: 'pinch',
      startDist: Math.hypot(p1.x - p0.x, p1.y - p0.y),
      startScale: state.view.scale,
      startMidImg: screenToImage((p0.x + p1.x) / 2, (p0.y + p1.y) / 2),
      startMidScreen: { x: (p0.x + p1.x) / 2 - canvas.getBoundingClientRect().left,
                        y: (p0.y + p1.y) / 2 - canvas.getBoundingClientRect().top },
    };
    return;
  }

  const img = screenToImage(e.clientX, e.clientY);
  // 拾取测试统一使用相对画布的 CSS 像素坐标（与 imageToScreen 一致）。
  const local = { x: img.sx, y: img.sy };

  // 1) 标定角点优先（始终可拖动调整）。
  const ci = hitCorner(local);
  if (ci >= 0) {
    state.gesture = { mode: 'corner', index: ci };
    return;
  }

  // 2) 多边形顶点。
  const vh = hitVertex(local);
  if (vh) {
    if (vh.close) {
      state.gesture = { mode: 'tap', pos: img }; // 松手时闭合
    } else {
      selectPolygon(vh.polyId);
      state.gesture = { mode: 'vertex', ...vh, moved: false };
    }
    return;
  }

  // 3) 空白处：中键/空格直接平移；左键先记录，移动超过阈值才算平移，否则视为点击。
  const panNow = e.button === 1 || e.button === 2 || state.spaceDown;
  state.gesture = {
    mode: panNow ? 'pan' : 'pending',
    startScreen: { x: img.sx, y: img.sy },
    startOff: { ...state.view },
    pos: img,
    moved: false,
  };
  if (panNow) wrap.classList.add('space');
  e.preventDefault();
});

canvas.addEventListener('pointermove', (e) => {
  if (state.pointers.has(e.pointerId))
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  const img = screenToImage(e.clientX, e.clientY);
  state.hover = state.image ? img : null;

  const g = state.gesture;

  if (g && g.mode === 'pinch' && state.pointers.size >= 2) {
    const [p0, p1] = [...state.pointers.values()];
    const d = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const ns = clamp(g.startScale * (d / g.startDist),
      state.fitScale * 0.1, state.fitScale * 60);
    const rect = canvas.getBoundingClientRect();
    const mx = (p0.x + p1.x) / 2 - rect.left;
    const my = (p0.y + p1.y) / 2 - rect.top;
    state.view.scale = ns;
    state.view.offX = mx - g.startMidImg.x * ns;
    state.view.offY = my - g.startMidImg.y * ns;
    render();
    updateZoomHud();
    return;
  }

  if (!g) {
    updateHoverCursor(e);
    render();
    return;
  }

  if (g.mode === 'corner') {
    state.corners[g.index] = clampImage(img);
    recomputeAll();
    return;
  }

  if (g.mode === 'vertex') {
    const poly = state.polygons.find((p) => p.id === g.polyId);
    if (poly) {
      poly.points[g.index] = clampImage(img);
      recomputeAll();
    }
    return;
  }

  if (g.mode === 'pending' || g.mode === 'pan') {
    const dx = img.sx - g.startScreen.x;
    const dy = img.sy - g.startScreen.y;
    if (g.mode === 'pending' && Math.hypot(dx, dy) > TAP_SLOP) {
      g.mode = 'pan';
      wrap.classList.add('space');
    }
    if (g.mode === 'pan') {
      state.view.offX = g.startOff.offX + dx;
      state.view.offY = g.startOff.offY + dy;
      g.moved = true;
      render();
      return;
    }
  }
  render();
});

canvas.addEventListener('pointerup', (e) => {
  const g = state.gesture;
  state.pointers.delete(e.pointerId);
  if (state.pointers.size < 2 && g && g.mode === 'pinch') {
    state.gesture = null;
    wrap.classList.remove('space');
    return;
  }
  if (!g) return;
  state.gesture = null;
  wrap.classList.remove('space');

  if (g.mode === 'tap') { handleCanvasTap(g.pos); return; }
  if (g.mode === 'pending') handleCanvasTap(g.pos);
});

canvas.addEventListener('pointercancel', () => {
  state.gesture = null;
  state.pointers.clear();
  wrap.classList.remove('space');
});

canvas.addEventListener('pointerleave', () => { state.hover = null; render(); });

function updateHoverCursor(e) {
  if (state.spaceDown) { wrap.style.cursor = 'grab'; return; }
  const img = screenToImage(e.clientX, e.clientY);
  const local = { x: img.sx, y: img.sy };
  if (hitCorner(local) >= 0 || hitVertex(local)) wrap.style.cursor = 'pointer';
  else wrap.style.cursor = 'crosshair';
}

function clampImage(p) {
  return {
    x: clamp(p.x, 0, state.imageInfo.width),
    y: clamp(p.y, 0, state.imageInfo.height),
  };
}

function handleCanvasTap(img) {
  if (!state.image || !finitePt(img)) return;
  const p = clampImage(img);

  // 阶段一：标记 4 个标定角点。
  if (state.corners.length < 4) {
    // 与上一个角点去重。
    const last = state.corners[state.corners.length - 1];
    if (last && dist(last, p) < DEDUP_PX / state.view.scale) return;
    state.corners.push(p);
    recomputeAll();
    if (state.corners.length === 4 && state.calib.ok)
      toast('四个角已标记且校准成功，可以绘制测量区域', 'ok');
    return;
  }

  // 阶段二：多边形。
  const poly = activePolygon();
  if (!poly || poly.closed) return;

  // 点击首顶点闭合（≥3 点）。
  if (poly.points.length >= 3 && dist(p, poly.points[0]) <= (HANDLE_PX + 2) / state.view.scale) {
    poly.closed = true;
    recomputeAll();
    if (poly.error) toast('区域已闭合：' + poly.error, 'err');
    else toast(`区域「${poly.name}」：${fmtArea(poly.metrics.areaM2)} / ${fmtLength(poly.metrics.perimeterM)}`, 'ok');
    return;
  }

  const lastV = poly.points[poly.points.length - 1];
  if (lastV && dist(lastV, p) < DEDUP_PX / state.view.scale) return; // 双击去重
  poly.points.push(p);
  recomputeAll();
}

// 双击闭合（第二次点击已被去重逻辑忽略）。
canvas.addEventListener('dblclick', (e) => {
  e.preventDefault();
  const poly = activePolygon();
  if (poly && !poly.closed && poly.points.length >= 3) {
    poly.closed = true;
    recomputeAll();
    if (poly.error) toast('区域已闭合：' + poly.error, 'err');
    else toast(`区域「${poly.name}」：${fmtArea(poly.metrics.areaM2)} / ${fmtLength(poly.metrics.perimeterM)}`, 'ok');
  }
});

// 滚轮：以光标为锚点缩放。
wrap.addEventListener('wheel', (e) => {
  if (!state.image) return;
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const factor = Math.exp(-e.deltaY * 0.0015);
  zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if (e.code === 'Space') { state.spaceDown = true; wrap.style.cursor = 'grab'; e.preventDefault(); }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const p = activePolygon();
    if (p) { e.preventDefault(); removePolygon(p.id); }
  }
  if (e.key === 'Escape') {
    const p = activePolygon();
    if (p && !p.closed) removePolygon(p.id);
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { state.spaceDown = false; wrap.style.cursor = ''; }
});

// 屏蔽画布上的右键菜单，避免平移时打断。
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// =========================================================================
// 多边形增删 / 选择
// =========================================================================

function newPolygon() {
  if (!state.calib.ok) { toast('请先完成四点透视校准', 'err'); return; }
  state.polySeq += 1;
  const color = POLY_COLORS[(state.polySeq - 1) % POLY_COLORS.length];
  const name = polyName.value.trim() || `区域 ${state.polySeq}`;
  const poly = {
    id: 'poly-' + state.polySeq + '-' + Date.now().toString(36),
    name, color, points: [], closed: false, error: '', metrics: null,
  };
  state.polygons.push(poly);
  state.activeId = poly.id;
  recomputeAll();
}

// 重画：清空选中区域的全部顶点重新描边（保留名称与颜色）。
redrawPolyBtn.addEventListener('click', () => {
  const existing = activePolygon();
  if (!existing) return;
  existing.points = [];
  existing.closed = false;
  existing.error = '';
  existing.metrics = null;
  recomputeAll();
  toast(`已清空「${existing.name}」，重新绘制顶点`);
});

function selectPolygon(id) {
  state.activeId = id;
  const p = activePolygon();
  if (p) polyName.value = p.name;
  renderSidebar();
  updateButtons();
  render();
}

function removePolygon(id) {
  state.polygons = state.polygons.filter((p) => p.id !== id);
  if (state.activeId === id) state.activeId = null;
  recomputeAll();
}

newPolyBtn.addEventListener('click', newPolygon);
deletePolyBtn.addEventListener('click', () => {
  const p = activePolygon();
  if (p) removePolygon(p.id);
});
polyName.addEventListener('input', () => {
  const p = activePolygon();
  if (p) { p.name = polyName.value.trim() || p.name; renderSidebar(); }
});
clearCornersBtn.addEventListener('click', () => {
  state.corners = [];
  recomputeAll();
  toast('已清除标定角点，测量已暂停');
});
refW.addEventListener('input', recomputeAll);
refH.addEventListener('input', recomputeAll);

// 视图复位。
resetViewBtn.addEventListener('click', () => { fitImage(); render(); updateZoomHud(); });
$('zoom-in-btn').addEventListener('click', () =>
  zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, 1.25));
$('zoom-out-btn').addEventListener('click', () =>
  zoomAt(wrap.clientWidth / 2, wrap.clientHeight / 2, 0.8));

// =========================================================================
// 图片上传（按钮 + 拖放）
// =========================================================================

async function uploadFile(file) {
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  toast('正在上传并解析照片…');
  try {
    const resp = await fetch('/api/upload', { method: 'POST', body: fd });
    if (!resp.ok) {
      const detail = await resp.json().catch(() => ({}));
      throw new Error(detail.detail || `上传失败（HTTP ${resp.status}）`);
    }
    const info = await resp.json();
    await loadImage(info);
  } catch (err) {
    toast(err.message || String(err), 'err');
  }
}

function loadImage(info) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      state.image = img;
      state.imageInfo = info;
      state.corners = [];
      state.polygons = [];
      state.activeId = null;
      state.polySeq = 0;
      overlay.classList.add('hidden');
      zoomHud.hidden = false;
      fitImage();
      updateZoomHud();
      recomputeAll();
      toast(`已载入 ${info.filename}（${info.width}×${info.height}px），请标记标定矩形四角`, 'ok');
      resolve();
    };
    img.onerror = () => reject(new Error('照片加载失败'));
    img.src = info.url;
  });
}

fileInput.addEventListener('change', () => {
  uploadFile(fileInput.files[0]);
  fileInput.value = '';
});

['dragenter', 'dragover'].forEach((ev) =>
  wrap.addEventListener(ev, (e) => {
    e.preventDefault();
    wrap.classList.add('dragover');
  }));
['dragleave', 'drop'].forEach((ev) =>
  wrap.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'dragleave' && wrap.contains(e.relatedTarget)) return;
    wrap.classList.remove('dragover');
  }));
wrap.addEventListener('drop', (e) => {
  e.preventDefault();
  wrap.classList.remove('dragover');
  uploadFile(e.dataTransfer.files[0]);
});

// =========================================================================
// 导出测量 JSON
// =========================================================================

exportBtn.addEventListener('click', () => {
  if (!state.imageInfo) { toast('请先打开照片', 'err'); return; }

  const W = parseFloat(refW.value), H = parseFloat(refH.value);
  const payload = {
    app: 'photo-planar-ruler',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    image: {
      filename: state.imageInfo.filename,
      widthPx: state.imageInfo.width,
      heightPx: state.imageInfo.height,
      url: state.imageInfo.url,
    },
    calibration: {
      referenceRectangle: { widthM: W, heightM: H },
      cornerOrder: 'top-left -> top-right -> bottom-right -> bottom-left',
      cornersImagePx: state.corners.map((c) => ({ x: +c.x.toFixed(3), y: +c.y.toFixed(3) })),
      valid: state.calib.ok,
      error: state.calib.ok ? null : state.calib.reason,
      homographyImageToWorld: state.calib.H,
    },
    regions: state.polygons.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      closed: p.closed,
      vertexCount: p.points.length,
      verticesImagePx: p.points.map((q) => ({ x: +q.x.toFixed(3), y: +q.y.toFixed(3) })),
      verticesWorldM: p.metrics
        ? p.metrics.worldPts.map((q) => ({ x: +q.x.toFixed(6), y: +q.y.toFixed(6) }))
        : null,
      areaM2: p.metrics ? +p.metrics.areaM2.toFixed(6) : null,
      perimeterM: p.metrics ? +p.metrics.perimeterM.toFixed(6) : null,
      error: p.error || null,
    })),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const base = (state.imageInfo.filename || 'photo').replace(/\.[^.]+$/, '');
  a.download = `measurements-${base}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('测量 JSON 已导出', 'ok');
});

// ---------------- 初始化 ----------------
new ResizeObserver(resizeCanvas).observe(wrap);
resizeCanvas();
updateButtons();
