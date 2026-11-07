// 专用画图工具：只负责在扫描图上叠加红笔批改痕迹
// 坐标全部使用 0-1000 归一化（x 按宽、y 按高），内部换算成像素后绘制
const sharp = require('sharp');

const RED = '#c81e1e';
const HAND_FONT = 'PingFang SC, Hiragino Sans GB, STHeiti, Songti SC';

/* 手写笔触引擎（起笔轻、行笔粗、收笔出锋 + 微抖） */
function rng(seed) {
  let s = ((seed * 1103515245 + 12345) >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function spline(pts, per = 10) {
  if (pts.length < 2) return pts.slice();
  const P = [pts[0], ...pts, pts[pts.length - 1]];
  const out = [];
  for (let i = 0; i < P.length - 3; i++) {
    const p0 = P[i], p1 = P[i + 1], p2 = P[i + 2], p3 = P[i + 3];
    for (let j = 0; j < per; j++) {
      const t = j / per, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function inkStroke(pts, { wStart, wMid, wEnd, jitter, seed, color = RED, per = 10 }) {
  const path = spline(pts, per);
  const n = path.length - 1;
  const phase = (seed % 11) * 0.7;
  const left = [], right = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = path[i];
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const wob = Math.sin(t * 8.2 + phase) * jitter * 0.75
      + Math.sin(t * 2.6 + phase * 1.9) * jitter
      + (rng(seed + i * 41)() - 0.5) * jitter * 0.45;
    const px = p[0] + nx * wob, py = p[1] + ny * wob;
    const half = t <= 0.5
      ? wStart + (wMid - wStart) * (t / 0.5)
      : wMid + (wEnd - wMid) * ((t - 0.5) / 0.5);
    const land = 0.45 + 0.55 * Math.min(1, t / 0.06);
    const lift = 0.5 + 0.5 * Math.min(1, (1 - t) / 0.05);
    const w = (half / 2) * land * lift * (1 + Math.sin(t * 9 + phase) * 0.08);
    left.push([px + nx * w, py + ny * w]);
    right.push([px - nx * w, py - ny * w]);
  }
  const f = a => `${a[0].toFixed(1)} ${a[1].toFixed(1)}`;
  let d = `M ${f(left[0])}`;
  for (let i = 1; i <= n; i++) d += ` L ${f(left[i])}`;
  for (let i = n; i >= 0; i--) d += ` L ${f(right[i])}`;
  d += ' Z';
  return `<path d="${d}" fill="${color}" opacity="0.95"/>`;
}

function tickMark(cx, cy, k, seed, color = RED) {
  const r = rng(seed * 977 + 31);
  const j = q => (r() - 0.5) * k * 0.09 + Math.sin(seed * 3.1 + q) * k * 0.03;
  const pts = [
    [cx - k * 1.00 + j(1), cy - k * 0.04 + j(2)],
    [cx - k * 0.64 + j(3), cy + k * 0.34 + j(4)],
    [cx - k * 0.20 + j(5), cy + k * 0.70 + j(6)],
    [cx + k * 0.10, cy + k * 0.86],
    [cx + k * 0.56 + j(7), cy + k * 0.28 + j(8)],
    [cx + k * 0.94 + j(9), cy - k * 0.38 - j(10)],
    [cx + k * 1.20 + j(11), cy - k * 1.04 + j(12)],
  ];
  const rot = (r() - 0.5) * 4;
  return `<g transform="rotate(${rot.toFixed(2)} ${cx.toFixed(1)} ${cy.toFixed(1)})">`
    + inkStroke(pts, {
      wStart: k * 0.14, wMid: k * 0.28, wEnd: k * 0.07,
      jitter: k * 0.055, seed, color, per: 10,
    })
    + `<ellipse cx="${pts[0][0].toFixed(1)}" cy="${pts[0][1].toFixed(1)}" rx="${(k * 0.06).toFixed(1)}" ry="${(k * 0.05).toFixed(1)}" fill="${color}" opacity="0.8"/>`
    + '</g>';
}

function crossMark(cx, cy, s, seed, color = RED) {
  const r = rng(seed * 613 + 17);
  const j = q => (r() - 0.5) * s * 0.08;
  const a = [
    [cx - s * 1.0 + j(1), cy - s * 1.02 + j(2)],
    [cx - s * 0.35 + j(3), cy - s * 0.12 + j(4)],
    [cx + s * 0.30 + j(5), cy + s * 0.45],
    [cx + s * 1.02 + j(6), cy + s * 1.10 + j(7)],
  ];
  const b = [
    [cx - s * 0.92 + j(8), cy + s * 1.02 + j(9)],
    [cx - s * 0.15 + j(10), cy + s * 0.08],
    [cx + s * 0.42 + j(11), cy - s * 0.40],
    [cx + s * 0.98 + j(12), cy - s * 1.02 + j(13)],
  ];
  const rot = (r() - 0.5) * 6;
  return `<g transform="rotate(${rot.toFixed(2)} ${cx.toFixed(1)} ${cy.toFixed(1)})">`
    + inkStroke(a, { wStart: s * 0.26, wMid: s * 0.36, wEnd: s * 0.14, jitter: s * 0.045, seed: seed + 3, color, per: 8 })
    + inkStroke(b, { wStart: s * 0.23, wMid: s * 0.31, wEnd: s * 0.10, jitter: s * 0.04, seed: seed + 8, color, per: 8 })
    + '</g>';
}

function halfMark(cx, cy, s, seed, color = RED) {
  const r = rng(seed * 331 + 7);
  const k = s * 0.9;
  const j = q => (r() - 0.5) * k * 0.06;
  const slash = [
    [cx - k * 0.95 + j(1), cy - k * 1.25 + j(2)],
    [cx + j(3), cy + j(4)],
    [cx + k * 0.95 + j(5), cy + k * 1.25 + j(6)],
  ];
  return tickMark(cx, cy, s * 0.85, seed, color)
    + inkStroke(slash, {
      wStart: k * 0.08, wMid: k * 0.15, wEnd: k * 0.05,
      jitter: k * 0.03, seed: seed + 11, color, per: 10,
    });
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 按像素宽折行（中文按字号，英文数字按 0.55 字号估算）
function wrapText(text, maxWidth, fs) {
  const out = [];
  let cur = '', w = 0;
  for (const ch of String(text)) {
    const cw = /[^\x00-\xff]/.test(ch) ? fs : fs * 0.55;
    if (w + cw > maxWidth && cur) { out.push(cur); cur = ''; w = 0; }
    cur += ch; w += cw;
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

class DrawTool {
  constructor(imagePath) {
    this.imagePath = imagePath;
    this.ops = [];
    this.guides = [];
  }

  setGuides(boxes) {
    this.guides = Array.isArray(boxes) ? boxes : [];
  }

  async init() {
    const m = await sharp(this.imagePath).metadata();
    this.W = m.width;
    this.H = m.height;
    return this;
  }

  reset() {
    this.ops = [];
  }

  px(nx, ny) {
    return [nx / 1000 * this.W, ny / 1000 * this.H];
  }

  // 归一化尺寸（按宽）→ 像素
  u(v) {
    return v / 1000 * this.W;
  }

  addOps(ops) {
    const added = [];
    const clamp = v => Math.max(0, Math.min(1000, typeof v === 'number' ? v : 0));
    for (const o of Array.isArray(ops) ? ops : []) {
      if (!o || typeof o !== 'object') continue;
      if (o.op === 'clear') { this.ops = []; added.push('clear'); continue; }
      for (const k of ['x', 'y', 'x1', 'y1', 'x2', 'y2']) {
        if (typeof o[k] === 'number') o[k] = clamp(o[k]);
      }
      // 若给了作答框 ans，就用框来定位：x=框右缘再右移 2%，y=框垂直中心
      // 模型对“这一行在哪”的判断通常比直接报一个点准得多
      if (Array.isArray(o.ans) && o.ans.length === 4) {
        const [ax1, ay1, ax2, ay2] = o.ans.map(clamp);
        if (['tick', 'cross', 'half', 'circle'].includes(o.op)) {
          o.x = Math.min(1000, ax2 + 20);
          o.y = Math.round((ay1 + ay2) / 2);
        }
      }

      // 同一题的同类标记只保留最新一条，避免自查时重复叠加
      if (o.no != null) {
        const sameKind = ['tick', 'cross', 'half'].includes(o.op);
        const idx = this.ops.findIndex(p => String(p.no) === String(o.no)
          && (sameKind ? ['tick', 'cross', 'half'].includes(p.op)
            : (p.op === 'text' && String(p.text) === String(o.text))));
        if (idx >= 0) this.ops.splice(idx, 1);
      }

      // 只报了题号、没给坐标：两种落笔策略
      // PLACE=margin（默认）落在右侧页边；PLACE=onanswer 直接压在作答旁/题上
      const gaveXY = typeof o.x === 'number';
      const onAnswer = process.env.PLACE === 'onanswer';
      const a = this.answerBox(o.no);
      if (a && (o.op === 'tick' || o.op === 'cross' || o.op === 'half') && typeof o.x !== 'number') {
        const [ax1, ay1, ax2, ay2] = a;
        const size = o.size || (o.op === 'cross' ? 14 : 20);
        if (onAnswer) {
          // 紧贴学生答案右侧；太靠右就改到左侧
          let mx = Math.min(950, ax2 + size * 1.25);
          if (mx > 900) mx = Math.max(30, ax1 - size * 0.8);
          o.x = mx;
          o.y = Math.max(size * 1.2, Math.min(985, (ay1 + ay2) / 2));
        } else {
          o.x = 900;
          o.y = Math.max(30, Math.min(980, (ay1 + ay2) / 2));
        }
      }
      if (a && o.op === 'text' && typeof o.x !== 'number') {
        const [ax1, ay1, ax2, ay2] = a;
        const fsN = o.size || 12;
        if (onAnswer) {
          o.x = Math.max(30, Math.min(700, ax2 + fsN * 1.2));
          o.y = Math.min(985, Math.max(ay1, ay2) + fsN * 1.4);
        } else {
          o.x = 748;
          o.y = Math.min(985, Math.max(ay1, ay2) + fsN * 1.5);
        }
      }

      // 模型自己给了坐标：约束在题框内，避免飘到空白处；自动落笔的不再回拉
      const g = this.guides.find(b => String(b.no) === String(o.no));
      if (gaveXY && g && Array.isArray(g.box)) {
        const [bx1, by1, bx2, by2] = g.box;
        if (typeof o.x === 'number') o.x = Math.max(bx1, Math.min(bx2, o.x));
        if (typeof o.y === 'number') o.y = Math.max(by1, Math.min(by2, o.y));
      }
      this.ops.push(o);
      added.push(o.op);
    }
    return added;
  }

  // 作答区：优先用模型单独标出的 ans，没有就用整题框
  answerBox(no) {
    if (no == null) return null;
    const g = this.guides.find(b => String(b.no) === String(no));
    if (!g) return null;
    if (Array.isArray(g.ans) && g.ans.length === 4) return g.ans.map(Number);
    return Array.isArray(g.box) ? g.box : null;
  }

  guidesSvg() {
    let s = '';
    for (const g of this.guides) {
      if (g && Array.isArray(g.box)) {
        const [x1, y1, x2, y2] = g.box;
        const [px1, py1] = this.px(x1, y1);
        const [px2, py2] = this.px(x2, y2);
        s += `<rect x="${px1}" y="${py1}" width="${Math.abs(px2 - px1)}" height="${Math.abs(py2 - py1)}" fill="none" stroke="#0a84ff" stroke-width="4" opacity="0.7"/>`;
      }
      if (g && Array.isArray(g.ans)) {
        const [x1, y1, x2, y2] = g.ans;
        const [px1, py1] = this.px(x1, y1);
        const [px2, py2] = this.px(x2, y2);
        s += `<rect x="${px1}" y="${py1}" width="${Math.abs(px2 - px1)}" height="${Math.abs(py2 - py1)}" fill="none" stroke="#ff9f0a" stroke-width="3" stroke-dasharray="10 8" opacity="0.75"/>`;
      }
      if (g && g.no != null) {
        const b = g.box || g.ans;
        if (Array.isArray(b)) {
          const [px1, py1] = this.px(b[0], b[1]);
          s += `<text x="${px1 + 8}" y="${py1 + 40}" font-size="38" fill="#0a84ff" opacity="0.9" font-family="PingFang SC">Q${g.no}</text>`;
        }
      }
    }
    return s;
  }

  svgBody(showGuides = false) {
    let body = showGuides ? this.guidesSvg() : '';
    let i = 0;
    for (const o of this.ops) {
      i += 1;
      const seed = ((o.x || 100) * 13 + (o.y || 50) * 7 + i * 97) % 100000;
      try {
        switch (o.op) {
          case 'tick': {
            const [x, y] = this.px(o.x, o.y);
            const k = this.u(o.size || 22);
            body += tickMark(x, y, k, seed);
            break;
          }
          case 'cross': {
            const [x, y] = this.px(o.x, o.y);
            const k = this.u(o.size || 14);
            body += crossMark(x, y, k, seed);
            break;
          }
          case 'half': {
            const [x, y] = this.px(o.x, o.y);
            const k = this.u(o.size || 22);
            body += halfMark(x, y, k, seed);
            break;
          }
          case 'text': {
            const [x, y] = this.px(o.x, o.y);
            const fs = this.u(o.size || 12);
            const lines = String(o.text || '').split('\n');
            let ty = y;
            const maxW = this.W - 40 - x;
            let tx = Math.max(20, Math.min(x, this.W - 60));
            for (const line of lines) {
              for (const ln of wrapText(line, maxW, fs)) {
                if (ty > this.H - 10) break;
                const tilt = Math.sin((o.x + i) * 0.02 + ty * 0.01) * 2;
                body += `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" font-size="${fs.toFixed(1)}" fill="${RED}" font-family="${HAND_FONT}" transform="rotate(${tilt.toFixed(2)} ${tx.toFixed(1)} ${ty.toFixed(1)})">${esc(ln)}</text>`;
                ty += fs * 1.45;
              }
            }
            break;
          }
          case 'circle': {
            const [x, y] = this.px(o.x, o.y);
            const r = this.u(o.r || 30);
            const seg = 18;
            const pts = [];
            for (let a = 0; a <= seg; a++) {
              const ang = -Math.PI * 1.05 + (Math.PI * 2.1) * a / seg;
              const rr = r * (1 + (a % 3) * 0.02);
              pts.push([x + Math.cos(ang) * rr, y + Math.sin(ang) * rr * 0.85]);
            }
            body += inkStroke(pts, {
              wStart: r * 0.05, wMid: r * 0.08, wEnd: r * 0.04,
              jitter: r * 0.02, seed, color: RED, per: 6,
            });
            break;
          }
          case 'underline':
          case 'line': {
            const [x1, y1] = this.px(o.x1, o.y1);
            const [x2, y2] = this.px(o.x2, o.y2);
            const w = Math.max(3, this.u(o.width || 2.2));
            body += inkStroke([[x1, y1], [(x1 + x2) / 2, (y1 + y2) / 2], [x2, y2]], {
              wStart: w, wMid: w * 1.1, wEnd: w * 0.6,
              jitter: w * 0.35, seed, color: o.color || RED, per: 8,
            });
            break;
          }
          default:
            break;
        }
      } catch (_) { /* 单条指令失败不影响整页 */ }
    }
    return body;
  }

  async render(outPath, { width, guides = false } = {}) {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${this.W}" height="${this.H}">${this.svgBody(guides)}</svg>`,
    );
    // 先把 SVG 单独栅格化并强行对齐到原图尺寸，避免 librsvg 取整后大 1 像素
    const overlay = await sharp(svg, { density: 96 })
      .resize(this.W, this.H, { fit: 'fill' })
      .png()
      .toBuffer();
    // composite 在 resize 之后才生效，所以先合成整图，再单独缩放
    const full = await sharp(this.imagePath)
      .composite([{ input: overlay, top: 0, left: 0 }])
      .jpeg({ quality: 92 })
      .toBuffer();
    let img = sharp(full);
    if (width) img = img.resize({ width });
    await img.jpeg({ quality: 88 }).toFile(outPath);
    return outPath;
  }

  // 供模型自查的预览：压到指定宽度，返回 data URL
  async preview(outPath, width = 1100, guides = false) {
    await this.render(outPath, { width, guides });
    const buf = await sharp(outPath).jpeg({ quality: 82 }).toBuffer();
    return 'data:image/jpeg;base64,' + buf.toString('base64');
  }
}

module.exports = { DrawTool, tickMark, crossMark, halfMark };
