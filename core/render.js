// 用 SVG 叠加批改痕迹，再合成回原图（sharp / librsvg）
const sharp = require('sharp');

/* —— 手写笔触引擎 ——
   真人下笔：起笔轻、行笔粗、收笔出锋；线条本身还会微抖。
   这里用 Catmull-Rom 样条串出平滑曲线，再叠加低频抖动与粗细变化，
   让每一笔都是连贯的一笔，而不是几段硬邦邦的直线。 */

function rng(seed) {
  let s = ((seed * 1103515245 + 12345) >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Catmull-Rom 插值，端点复制，保证经过每个控制点
function spline(pts, per = 12) {
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

// 一笔：平滑曲线 + 垂直方向轻微抖动 + 起收笔粗细变化
function inkStroke(pts, { wStart = 7, wMid = 13, wEnd = 4, jitter = 2.2, seed = 0, color = '#c02722', per = 12 } = {}) {
  const path = spline(pts, per);
  const n = path.length - 1;
  const phase = (seed % 11) * 0.7;
  const left = [], right = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = path[i];
    // 前后切向 → 法线
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    // 两段不同频率的抖动 + 一点随机，模拟手腕微颤
    const wob = Math.sin(t * 8.2 + phase) * jitter * 0.75
      + Math.sin(t * 2.6 + phase * 1.9) * jitter
      + (rng(seed + i * 41)() - 0.5) * jitter * 0.45;
    const px = p[0] + nx * wob, py = p[1] + ny * wob;
    // 粗细：起笔 → 行笔最粗 → 收笔出锋
    const half = t <= 0.5
      ? wStart + (wMid - wStart) * (t / 0.5)
      : wMid + (wEnd - wMid) * ((t - 0.5) / 0.5);
    const land = 0.45 + 0.55 * Math.min(1, t / 0.06); // 落笔处略窄
    const lift = 0.5 + 0.5 * Math.min(1, (1 - t) / 0.05); // 出锋
    const w = (half / 2) * land * lift * (1 + Math.sin(t * 9 + phase) * 0.08);
    left.push([px + nx * w, py + ny * w]);
    right.push([px - nx * w, py - ny * w]);
  }
  const f = a => `${a[0].toFixed(1)} ${a[1].toFixed(1)}`;
  let d = `M ${f(left[0])}`;
  for (let i = 1; i <= n; i++) d += ` L ${f(left[i])}`;
  for (let i = n; i >= 0; i--) d += ` L ${f(right[i])}`;
  d += ' Z';
  return `<path d="${d}" fill="${color}" opacity="0.94"/>`;
}

// 手写对勾：一笔连贯下来再挑上去，收笔顺势冲出，略有弧度
function tickMark(cx, cy, s = 46, seed = 0, { color = '#c02722', scale = 1 } = {}) {
  const r = rng(seed * 977 + 31);
  const j = k => (r() - 0.5) * s * 0.09 + Math.sin(seed * 3.1 + k) * s * 0.03;
  const k = s * scale;
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
  return `<g transform="rotate(${rot.toFixed(2)} ${cx} ${cy})">`
    + inkStroke(pts, { wStart: k * 0.14, wMid: k * 0.28, wEnd: k * 0.07, jitter: k * 0.055, seed, color, per: 10 })
    + `<ellipse cx="${pts[0][0].toFixed(1)}" cy="${pts[0][1].toFixed(1)}" rx="${(k * 0.06).toFixed(1)}" ry="${(k * 0.05).toFixed(1)}" fill="${color}" opacity="0.8"/>`
    + '</g>';
}

// 手写叉：第一笔快、第二笔稍短，交叉点略微错开，收笔有冲力
function crossMark(cx, cy, s = 33, seed = 0, { color = '#c02722' } = {}) {
  const r = rng(seed * 613 + 17);
  const j = k => (r() - 0.5) * s * 0.08;
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
  return `<g transform="rotate(${rot.toFixed(2)} ${cx} ${cy})">`
    + inkStroke(a, { wStart: s * 0.26, wMid: s * 0.36, wEnd: s * 0.14, jitter: s * 0.045, seed: seed + 3, color, per: 8 })
    + inkStroke(b, { wStart: s * 0.23, wMid: s * 0.31, wEnd: s * 0.10, jitter: s * 0.04, seed: seed + 8, color, per: 8 })
    + '</g>';
}

// 半对：先一个对勾，再接一笔斜线划过去（不写「半」字）
function halfMark(cx, cy, s = 46, seed = 0, { color = '#c02722' } = {}) {
  const r = rng(seed * 331 + 7);
  const k = s * 0.9;
  const j = q => (r() - 0.5) * k * 0.06;
  const slash = [
    [cx - k * 0.95 + j(1), cy - k * 1.25 + j(2)],
    [cx + j(3), cy + j(4)],
    [cx + k * 0.95 + j(5), cy + k * 1.25 + j(6)],
  ];
  return tickMark(cx, cy, s, seed, { color })
    + inkStroke(slash, {
      wStart: k * 0.08, wMid: k * 0.15, wEnd: k * 0.05,
      jitter: k * 0.03, seed: seed + 11, color, per: 10,
    });
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const HAND_FONT = 'Hannotate SC, Xingkai SC, Kaiti SC, STKaiti';

async function render(imagePath, page, marks, outPath, opts = {}) {
  const W = page.width, H = page.height;
  const showTicks = opts.ticks !== false;
  const showComments = opts.comments !== false;
  let body = '';
  const FS = 34;

  // 调试：切题框 + 题号锚点
  for (const b of (opts.boxes || [])) {
    body += `<rect x="${b.x0 + 4}" y="${b.y0}" width="${W - 8}" height="${Math.max(2, b.y1 - b.y0)}" fill="none" stroke="#0a84ff" stroke-width="5"/>`;
    body += `<text x="18" y="${b.y0 + 52}" font-size="44" fill="#0a84ff" font-family="PingFang SC">Q${b.no}</text>`;
    if (b.numY != null) {
      body += `<line x1="${b.numX - 70}" y1="${b.numY + 20}" x2="${b.numX + 90}" y2="${b.numY + 20}" stroke="#ff9f0a" stroke-width="6"/>`;
      body += `<circle cx="${b.numX - 58}" cy="${b.numY + 12}" r="12" fill="#ff3b30"/>`;
    }
  }

  for (const m of marks) {
    if (!showTicks && !m.text) continue;
    const mx = Math.max(30, Math.min(W - 30, m.x));
    const my = Math.max(36, Math.min(H - 40, m.point ? m.y : m.y + m.h / 2));
    const seed = (m.x % 97) * 13 + (m.y % 89) * 7 + (m.no || 0);

    if (showTicks) {
      if (m.verdict === 'correct') {
        body += tickMark(mx, my, 46, seed);
      } else if (m.verdict === 'wrong') {
        body += crossMark(mx, my, 33, seed);
      } else if (m.verdict === 'partial') {
        body += halfMark(mx, my, 42, seed);
      } else {
        body += `<text x="${mx}" y="${my + 16}" font-size="46" fill="#1a3cb0" font-family="${HAND_FONT}">?</text>`;
      }
    }

    if (opts.coords) {
      body += `<line x1="${mx - 40}" y1="${my}" x2="${mx + 40}" y2="${my}" stroke="#00c2ff" stroke-width="2"/>`;
      body += `<line x1="${mx}" y1="${my - 40}" x2="${mx}" y2="${my + 40}" stroke="#00c2ff" stroke-width="2"/>`;
      body += `<text x="${mx + 12}" y="${my - 14}" font-size="26" fill="#0090cc" font-family="Menlo, monospace">${Math.round(m.x)},${Math.round(m.y)}</text>`;
    }
    if (!m.text || !showComments) continue;

    const startX = m.textX ?? Math.min(mx + 48, W - 400);
    const maxChars = Math.max(8, Math.floor((W - 30 - startX) / (FS * 0.95)));
    const lines = [];
    let rest = m.text;
    while (rest.length && lines.length < 3) {
      lines.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    let ty = Math.min(H - 20, m.textY ?? my + 34);
    for (const line of lines) {
      const tw = [...line].reduce((a, ch) => a + (/[^\x00-\xff]/.test(ch) ? FS : FS * 0.55), 0);
      let tx = startX;
      if (tx + tw > W - 20) tx = Math.max(20, W - 20 - tw);
      if (ty > H - 10) break;
      const tilt = Math.sin(m.x * 0.02 + ty * 0.01) * 1.8;
      body += `<text x="${tx}" y="${ty}" font-size="${FS + 4}" fill="#c81e1e" font-family="${HAND_FONT}" transform="rotate(${tilt} ${tx} ${ty})">${esc(line)}</text>`;
      ty += FS + 12;
    }
  }

  // 整页/作文模式：在页面下方留白处输出评语块
  if (opts.summary) {
    const s = opts.summary;
    const x = 70;
    let y = Math.round(H * 0.70);
    const scoreText = s.score != null ? `${s.score}${s.fullScore ? ' / ' + s.fullScore : ''}` : '-';
    const head = `AI 评阅　得分 ${scoreText}`;
    body += `<rect x="${x - 16}" y="${y - 44}" width="${W - (x - 16) * 2}" height="${H * 0.27}" rx="12" fill="#ffffff" opacity="0.9" stroke="#1a3cb0" stroke-width="3"/>`;
    body += `<text x="${x}" y="${y}" font-size="34" fill="#1a3cb0" font-family="PingFang SC" font-weight="600">${esc(head)}</text>`;
    y += 46;
    const dims = s.dims && typeof s.dims === 'object' ? Object.entries(s.dims) : [];
    if (dims.length) {
      const txt = dims.map(([k, v]) => `${k} ${v}`).join('　');
      body += `<text x="${x}" y="${y}" font-size="28" fill="#2b4a8f" font-family="PingFang SC">${esc(txt)}</text>`;
      y += 38;
    }
    const maxChars = Math.floor((W - x * 2) / (FS * 0.95));
    const text = String(s.comment || '');
    for (let i = 0; i < text.length && y < H * 0.70 + H * 0.24; i += maxChars) {
      body += `<text x="${x}" y="${y}" font-size="${FS}" fill="#1a3cb0" font-family="PingFang SC">${esc(text.slice(i, i + maxChars))}</text>`;
      y += FS + 10;
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${body}</svg>`;
  const img = sharp(imagePath).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  if (/\.jpe?g$/i.test(outPath)) {
    await img.jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toFile(outPath);
  } else {
    await img.png().toFile(outPath);
  }
  return outPath;
}

module.exports = { render };

