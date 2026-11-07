// 本地 OCR 切题：PaddleOCR(ONNX) 识别整页文字行，再用「行首题号」切题
// 旧版 tesseract 只认数字列，容易漏题/误判，保留为加载失败时的兜底
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');
const sharp = require('sharp');

const OCR_ENTRY = path.join(
  __dirname, '..', 'node_modules', '@gutenye', 'ocr-node', 'build', 'index.js'
);

let paddlePromise = null;
async function getPaddle() {
  if (!paddlePromise) {
    paddlePromise = (async () => {
      const mod = await import(pathToFileURL(OCR_ENTRY).href);
      return mod.default.create();
    })();
  }
  return paddlePromise;
}

// 题号行：行首 1~2 位数字 + 顿号/点号；后面不能紧跟数字（避免把「1.5 米」当成第 1 题）
const QNUM_RE = /^\s*(\d{1,2})\s*[.．、]\s*(?!\d)/;

// 检测模型按原图尺寸跑（内部只补到 32 的倍数），300dpi 整页会申请超大中间张量，
// 在 Electron 主进程里直接 SIGTRAP 闪退；先把长边缩到 1600 再识别
const MAX_SIDE = 1600;

/** 找竖向分栏的空白中缝：返回 [left, right] 像素，找不到返回 null */
async function findGutter(imagePath, meta) {
  const W = 500;
  const { data, info } = await sharp(imagePath)
    .resize({ width: W })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sw = info.width, sh = info.height;
  const y0 = Math.round(sh * 0.06), y1 = Math.round(sh * 0.94);
  const ink = new Array(sw).fill(0);
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < sw; x++) if (data[y * sw + x] < 190) ink[x]++;
  }
  // 一段连续的低墨迹列，宽度至少 1.2% 页宽，且位于页面中间区域
  const thr = Math.max(2, (y1 - y0) * 0.02);
  const runs = [];
  let st = -1;
  for (let x = Math.round(sw * 0.2); x <= Math.round(sw * 0.8); x++) {
    if (ink[x] < thr) { if (st < 0) st = x; }
    else if (st >= 0) { if (x - st >= Math.max(4, sw * 0.012)) runs.push([st, x]); st = -1; }
  }
  if (st >= 0 && Math.round(sw * 0.8) - st >= Math.max(4, sw * 0.012)) runs.push([st, Math.round(sw * 0.8)]);
  if (!runs.length) return null;
  // 取最靠近页面中线的一段
  runs.sort((a, b) => Math.abs((a[0] + a[1]) / 2 - sw / 2) - Math.abs((b[0] + b[1]) / 2 - sw / 2));
  const [a, b] = runs[0];
  return [Math.round(a * meta.width / sw), Math.round(b * meta.width / sw)];
}

/** 对指定区域做 OCR，坐标映射回整页 */
async function detectRegion(imagePath, region, metaW, metaH, offX, col, tmpFiles) {
  const cw = region.width, ch = region.height;
  const maxSide = Math.max(cw, ch);
  const scale = maxSide > MAX_SIDE ? MAX_SIDE / maxSide : 1;
  const outW = Math.round(cw * scale), outH = Math.round(ch * scale);
  const tmp = path.join(os.tmpdir(), `eg_ocr_${process.pid}_${Date.now()}_${col}.jpg`);
  tmpFiles.push(tmp);
  await sharp(imagePath)
    .extract({ left: region.left, top: region.top, width: cw, height: ch })
    .resize({ width: outW, height: outH, fit: 'fill' })
    .jpeg({ quality: 90 }).toFile(tmp);

  const ocr = await getPaddle();
  const r = await ocr.detect(tmp);
  const sx = cw / r.resizedImageWidth;
  const sy = ch / r.resizedImageHeight;
  const lines = [];
  for (const t of r.texts || []) {
    if (!t.box || !t.box.length) continue;
    const xs = t.box.map(p => p[0]);
    const ys = t.box.map(p => p[1]);
    lines.push({
      text: t.text || '',
      conf: typeof t.mean === 'number' ? t.mean : ((t.score ?? 1)),
      x0: Math.min(...xs) * sx + offX,
      x1: Math.max(...xs) * sx + offX,
      y0: Math.min(...ys) * sy,
      y1: Math.max(...ys) * sy,
      col,
    });
  }
  return lines;
}

/** 用 PaddleOCR 取整页文字行，坐标还原到原图；有两栏时按中缝分两次识别 */
async function paddleLines(imagePath) {
  const meta = await sharp(imagePath).metadata();
  const gutter = await findGutter(imagePath, meta).catch(() => null);
  const tmpFiles = [];
  try {
    let lines = [];
    if (gutter) {
      const [g0, g1] = gutter;
      lines = lines.concat(
        await detectRegion(imagePath, { left: 0, top: 0, width: g0, height: meta.height }, meta.width, meta.height, 0, 0, tmpFiles),
        await detectRegion(imagePath, { left: g1, top: 0, width: meta.width - g1, height: meta.height }, meta.width, meta.height, g1, 1, tmpFiles),
      );
      lines.sort((a, b) => (a.col - b.col) || (a.y0 - b.y0));
    } else {
      lines = await detectRegion(imagePath, { left: 0, top: 0, width: meta.width, height: meta.height }, meta.width, meta.height, 0, 0, tmpFiles);
      lines.sort((a, b) => a.y0 - b.y0);
    }
    return { width: meta.width, height: meta.height, lines, columns: gutter ? 2 : 1 };
  } finally {
    for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch (_) {} }
  }
}

/** 从文字行里挑题号行：行首数字 + 左对齐聚类（支持左右分栏） */
function pickNumbers(lines, page) {
  const cands = [];
  for (const l of lines) {
    const m = l.text.match(QNUM_RE);
    if (!m) continue;
    const no = parseInt(m[1], 10);
    if (!no || no > 200) continue;
    const h = l.y1 - l.y0;
    if (h < 12 || h > page.height * 0.08) continue;
    if (l.text.replace(QNUM_RE, '').trim().length < 2) continue;
    cands.push({ no, x: l.x0, y: l.y0, h, conf: l.conf });
  }
  if (!cands.length) return [];

  // 按题号左边界聚类：一栏一个簇，分栏卷会得到多个簇
  const tol = Math.max(24, page.width * 0.035);
  const sorted = [...cands].sort((a, b) => a.x - b.x);
  const clusters = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const cur = clusters[clusters.length - 1];
    if (sorted[i].x - cur[cur.length - 1].x <= tol) cur.push(sorted[i]);
    else clusters.push([sorted[i]]);
  }
  // 过滤掉只有一两个的杂散数字；整页只有一个簇时保留
  const keep = clusters.filter(c => c.length >= 2).length
    ? clusters.filter(c => c.length >= 2)
    : clusters;

  const picked = [];
  keep.forEach((cluster, ci) => {
    // 同一行去重
    const rows = [...cluster].sort((a, b) => a.y - b.y);
    const dedup = [];
    for (const c of rows) {
      const last = dedup[dedup.length - 1];
      if (last && Math.abs(c.y - last.y) < Math.min(c.h, last.h) * 0.6) continue;
      dedup.push(c);
    }
    // 本栏内用最长递增子序列剔除混进题干的数字
    const n = dedup.length;
    const dp = new Array(n).fill(1);
    const prev = new Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < i; j++) {
        if (dedup[i].no > dedup[j].no && dp[j] + 1 > dp[i]) { dp[i] = dp[j] + 1; prev[i] = j; }
      }
    }
    let end = 0;
    for (let i = 1; i < n; i++) if (dp[i] > dp[end]) end = i;
    const seq = [];
    for (let i = end; i >= 0; i = prev[i]) seq.push(dedup[i]);
    seq.reverse();

    // 本栏内题号纠偏（OCR 可能把 11 读成 1）
    let anchor = 0, runLen = 1;
    for (let i = 0; i < seq.length; i++) {
      let j = i;
      while (j + 1 < seq.length && seq[j + 1].no === seq[j].no + 1) j++;
      if (j - i + 1 > runLen) { runLen = j - i + 1; anchor = i; }
    }
    if (runLen >= 3) {
      const baseNo = seq[anchor].no;
      seq.forEach((p, i) => { p.no = baseNo + (i - anchor); });
    }
    for (const p of seq) { p.col = ci; picked.push(p); }
  });

  return picked;
}

/** 漏检补齐（只在同一栏内插值），再按栏切成题块 */
function buildBlocks(picked, page) {
  if (!picked.length) return [];

  // 按栏分组
  const groups = [];
  for (const p of picked) {
    const ci = p.col ?? 0;
    (groups[ci] = groups[ci] || []).push(p);
  }

  // 栏边界：取相邻两栏题号 x 的中点，避免把另一栏的文字切进来
  const ranges = groups.map((g, ci) => {
    const xs = g.map(p => p.x);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const prev = groups[ci - 1] ? Math.max(...groups[ci - 1].map(p => p.x)) : null;
    const next = groups[ci + 1] ? Math.min(...groups[ci + 1].map(p => p.x)) : null;
    const left = prev == null ? 0 : Math.round((prev + minX) / 2);
    const right = next == null ? page.width : Math.round((maxX + next) / 2);
    return { left, right };
  });

  const blocks = [];
  groups.forEach((g, ci) => {
    const filled = [];
    for (let i = 0; i < g.length; i++) {
      filled.push(g[i]);
      const nx = g[i + 1];
      if (!nx) continue;
      const gap = nx.no - g[i].no;
      for (let k = 1; k < gap; k++) {
        filled.push({
          no: g[i].no + k,
          x: g[i].x,
          y: g[i].y + (nx.y - g[i].y) * (k / gap),
          h: g[i].h,
          conf: 0,
          synthetic: true,
        });
      }
    }

    for (let i = 0; i < filled.length; i++) {
      const top = Math.max(0, filled[i].y - Math.round(filled[i].h * 0.5));
      // 宁可多切不可少切：下边界延伸到同栏下一题题号行往下一点
      const bottom = i === filled.length - 1
        ? page.height - 2
        : filled[i + 1].y + Math.round(filled[i + 1].h * 1.2);
      blocks.push({
        no: filled[i].no,
        type: 'answer',
        y0: Math.max(0, Math.round(top)),
        y1: Math.min(page.height, Math.round(bottom)),
        x0: ranges[ci].left,
        x1: ranges[ci].right,
        numX: Math.round(filled[i].x),
        numY: Math.round(filled[i].y + filled[i].h / 2),
        synthetic: !!filled[i].synthetic,
        col: ci,
      });
    }
  });
  return blocks;
}

/* ---------------- tesseract 兜底 ---------------- */
let workerPromise = null;
async function tessLines(imagePath) {
  const { createWorker } = require('tesseract.js');
  if (!workerPromise) {
    workerPromise = (async () => {
      const w = await createWorker('eng', 1, {
        langPath: path.join(__dirname, '..'),
        gzip: false,
        cacheMethod: 'none',
        logger: () => {},
      });
      await w.setParameters({
        tessedit_pageseg_mode: '11',
        tessedit_char_whitelist: '0123456789.．、 ',
      });
      return w;
    })();
  }
  const meta = await sharp(imagePath).metadata();
  const bandW = Math.round(meta.width * 0.42);
  const buf = await sharp(imagePath)
    .extract({ left: 0, top: 0, width: bandW, height: meta.height })
    .resize({ width: 1100, withoutEnlargement: true })
    .greyscale().png().toBuffer();
  const bandMeta = await sharp(buf).metadata();
  const ratio = meta.height / bandMeta.height;
  const { data } = await workerPromise.recognize(buf, {}, { blocks: true });
  const out = [];
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        out.push({
          text: l.text.trim(),
          conf: 1,
          x0: l.bbox.x0, x1: l.bbox.x1,
          y0: l.bbox.y0 * ratio, y1: l.bbox.y1 * ratio,
        });
      }
    }
  }
  return { width: meta.width, height: meta.height, lines: out };
}

async function split(imagePath, onProgress = () => {}, prePage = null) {
  onProgress('PaddleOCR 识别全文…');
  let page = prePage;
  if (!page || !Array.isArray(page.lines)) {
    try {
      page = await paddleLines(imagePath);
    } catch (e) {
      console.warn('[ocr] PaddleOCR 加载失败，改用 tesseract：', e.message);
      onProgress('PaddleOCR 不可用，改用 tesseract…');
      page = await tessLines(imagePath);
    }
    if (prePage) page = { ...page, width: prePage.width, height: prePage.height };
  }

  const picked = pickNumbers(page.lines, page);
  if (picked.length < 2) {
    throw new Error(`OCR 只找到 ${picked.length} 个题号，请检查图像方向或清晰度`);
  }
  const blocks = buildBlocks(picked, page);
  if (blocks.length < 2) throw new Error('没有切出足够的题目');
  onProgress(`找到 ${blocks.length} 道题：${blocks.map(b => b.no).join(', ')}`);
  return { width: page.width, height: page.height, blocks, lines: page.lines || [] };
}

function countQuestionNumbers(page) {
  try { return pickNumbers(page.lines || [], page).length; } catch (_) { return 0; }
}

module.exports = { split, paddleLines, countQuestionNumbers };
