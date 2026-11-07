// 卷面预处理：自动纠正 180° 倒置 + 裁掉四周空白
const sharp = require('sharp');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { paddleLines, countQuestionNumbers } = require('./ocr');

// 统计 OCR 里“像正常文字”的行数与字符量，用来判断页面是否倒置
function textStat(page) {
  let good = 0, chars = 0;
  for (const l of page.lines || []) {
    const t = String(l.text || '').replace(/\s+/g, '');
    const n = (t.match(/[\p{L}\p{N}]/gu) || []).length;
    if (n >= 2 && (l.conf ?? 0) >= 0.55) {
      good += 1;
      chars += n * (l.conf || 0);
    }
  }
  return { good, chars };
}

async function rotateBy(imagePath, deg) {
  const out = path.join(os.tmpdir(), `eg_rot_${deg}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`);
  await sharp(imagePath).rotate(deg).jpeg({ quality: 94, chromaSubsampling: '4:4:4' }).toFile(out);
  return out;
}

// 0/90/180/270 各扫一遍太慢，先看 0° 是否已经明显正常，再先试最常见的 180°，最后才试 90°/270°
function pageScore(p) {
  const n = countQuestionNumbers(p);
  const s = textStat(p);
  return { n, good: s.good, chars: s.chars, score: n * 100 + Math.min(80, s.chars) };
}

async function orient(imagePath) {
  let p0;
  try {
    p0 = await paddleLines(imagePath);
  } catch (_) {
    return { imagePath, page: null, rotation: 0 };
  }
  const s0 = pageScore(p0);
  // 题号够多、有效文字也够多，基本可确定方向正确，省掉后续 OCR
  if (s0.n >= 3 && s0.chars >= 40) return { imagePath, page: p0, rotation: 0 };

  const tried = [];
  const attempt = async deg => {
    let rotPath = null;
    try {
      rotPath = await rotateBy(imagePath, deg);
      const p = await paddleLines(rotPath);
      tried.push({ deg, path: rotPath, page: p, ...pageScore(p) });
    } catch (_) {
      if (rotPath) { try { fs.unlinkSync(rotPath); } catch (_) {} }
    }
  };

  const needMore = () => {
    const best = tried.reduce((a, b) => (b.score > a.score ? b : a), s0);
    return best.n < 2 || best.chars < 8;
  };

  await attempt(180);
  // 180° 已经能明显读出文字就不必再试横向旋转
  if (needMore()) await attempt(90);
  if (needMore()) await attempt(270);

  const best = tried.reduce((a, b) => (b.score > a.score ? b : a), { deg: 0, path: null, page: p0, ...s0 });
  for (const t of tried) {
    if (t.path !== best.path) { try { fs.unlinkSync(t.path); } catch (_) {} }
  }
  if (best.deg === 0) {
    if (best.path) { try { fs.unlinkSync(best.path); } catch (_) {} }
    return { imagePath, page: p0, rotation: 0 };
  }
  return { imagePath: best.path, page: best.page, rotation: best.deg };
}

// 检测内容包围盒，裁掉四周大片空白；优先用 OCR 文字行定位，避免被纸张/扫描边界干扰
async function trim(imagePath, ocrPage = null) {
  const meta = await sharp(imagePath).metadata();
  const W = meta.width, H = meta.height;

  let box = null;
  if (ocrPage && ocrPage.lines && ocrPage.lines.length >= 5) {
    const lines = ocrPage.lines;
    const x0 = Math.min(...lines.map(l => l.x0));
    const x1 = Math.max(...lines.map(l => l.x1));
    const y0 = Math.min(...lines.map(l => l.y0));
    const y1 = Math.max(...lines.map(l => l.y1));
    const padX = Math.max(24, Math.round(W * 0.03));
    const padTop = Math.max(30, Math.round(H * 0.025));
    const padBottom = Math.max(60, Math.round(H * 0.1));
    box = {
      left: Math.max(0, Math.round(x0 - padX)),
      right: Math.min(W, Math.round(x1 + padX)),
      top: Math.max(0, Math.round(y0 - padTop)),
      bottom: Math.min(H, Math.round(y1 + padBottom)),
    };
  }
  if (!box) box = darkBox(W, H, imagePath);
  if (!box) return { imagePath, page: null, cropped: false };

  const bw = box.right - box.left, bh = box.bottom - box.top;
  // 边界几乎等于整页，或检测到的内容小得离谱，就不裁
  if (bw > W * 0.97 && bh > H * 0.97) return { imagePath, page: null, cropped: false };
  if (bw < W * 0.2 || bh < H * 0.2) return { imagePath, page: null, cropped: false };

  const out = path.join(os.tmpdir(), `eg_trim_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`);
  await sharp(imagePath)
    .extract({ left: box.left, top: box.top, width: bw, height: bh })
    .jpeg({ quality: 94, chromaSubsampling: '4:4:4' })
    .toFile(out);
  return {
    imagePath: out, page: null, cropped: true,
    box: { left: box.left, top: box.top, width: bw, height: bh },
  };
}

// 没有 OCR 文字时，退回按暗像素分布找内容区（同时排除噪声与纸张边线）
async function darkBox(W, H, imagePath) {
  const { data, info } = await sharp(imagePath)
    .greyscale()
    .resize({ width: 800, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sw = info.width, sh = info.height;
  const DARK = 190;
  const rowDark = new Array(sh).fill(0);
  const colDark = new Array(sw).fill(0);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (data[y * sw + x] < DARK) { rowDark[y] += 1; colDark[x] += 1; }
    }
  }
  let top = -1, bottom = -1, left = -1, right = -1;
  const rowOK = y => rowDark[y] >= 5 && rowDark[y] <= sw * 0.5;
  const colOK = x => colDark[x] >= 4 && colDark[x] <= sh * 0.55;
  for (let y = 0; y < sh; y++) if (rowOK(y)) { if (top < 0) top = y; bottom = y; }
  for (let x = 0; x < sw; x++) if (colOK(x)) { if (left < 0) left = x; right = x; }
  if (top < 0 || left < 0) return null;

  const sx = W / sw, sy = H / sh;
  const pad = Math.max(12, Math.round(Math.min(W, H) * 0.012));
  return {
    left: Math.max(0, Math.round(left * sx) - pad),
    top: Math.max(0, Math.round(top * sy) - pad),
    right: Math.min(W, Math.round((right + 1) * sx) + pad),
    bottom: Math.min(H, Math.round((bottom + 1) * sy) + pad),
  };
}

// 裁切只是平移，不需要重跑 OCR：把文字坐标整体挪一下即可
function shiftPage(page, box) {
  if (!page) return null;
  const lines = (page.lines || [])
    .map(l => ({ ...l, x0: l.x0 - box.left, x1: l.x1 - box.left, y0: l.y0 - box.top, y1: l.y1 - box.top }))
    .filter(l => l.y1 > 0 && l.y0 < box.height && l.x1 > 0 && l.x0 < box.width);
  return { width: box.width, height: box.height, lines };
}

// 对外：返回摆正、裁好空白的图，以及沿用的 OCR 结果（坐标已同步平移）
async function prepareImage(imagePath, onStage = () => {}) {
  onStage({ stage: 'split', label: '判断卷面方向' });
  const o = await orient(imagePath);
  onStage({ stage: 'split', label: '裁掉空白边' });
  const t = await trim(o.imagePath, o.page);
  let page = o.page;
  if (t.cropped) page = shiftPage(page, t.box);
  if (o.rotation !== 0 && o.imagePath !== t.imagePath) {
    try { fs.unlinkSync(o.imagePath); } catch (_) {}
  }
  return {
    imagePath: t.imagePath,
    page,
    rotation: o.rotation,
    cropped: t.cropped,
  };
}

module.exports = { prepareImage };
