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

/** 用 PaddleOCR 取整页文字行，坐标还原到原图 */
async function paddleLines(imagePath) {
  const meta = await sharp(imagePath).metadata();
  let detectPath = imagePath;
  let tmpFile = null;
  const maxSide = Math.max(meta.width, meta.height);
  if (maxSide > MAX_SIDE) {
    const scale = MAX_SIDE / maxSide;
    const w = Math.round(meta.width * scale);
    const h = Math.round(meta.height * scale);
    tmpFile = path.join(os.tmpdir(), `eg_ocr_${process.pid}_${Date.now()}.jpg`);
    await sharp(imagePath).resize({ width: w, height: h, fit: 'fill' })
      .jpeg({ quality: 90 }).toFile(tmpFile);
    detectPath = tmpFile;
  }

  try {
    const ocr = await getPaddle();
    const r = await ocr.detect(detectPath);
    const sx = meta.width / r.resizedImageWidth;
    const sy = meta.height / r.resizedImageHeight;
    const lines = [];
    for (const t of r.texts || []) {
      if (!t.box || !t.box.length) continue;
      const xs = t.box.map(p => p[0]);
      const ys = t.box.map(p => p[1]);
      lines.push({
        text: t.text || '',
        conf: typeof t.mean === 'number' ? t.mean : ((t.score ?? 1)),
        x0: Math.min(...xs) * sx,
        x1: Math.max(...xs) * sx,
        y0: Math.min(...ys) * sy,
        y1: Math.max(...ys) * sy,
      });
    }
    lines.sort((a, b) => a.y0 - b.y0);
    return { width: meta.width, height: meta.height, lines };
  } finally {
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (_) {} }
  }
}

/** 从文字行里挑题号行：行首数字 + 左对齐聚类 + 严格递增 */
function pickNumbers(lines, page) {
  const cands = [];
  for (const l of lines) {
    const m = l.text.match(QNUM_RE);
    if (!m) continue;
    const no = parseInt(m[1], 10);
    if (!no || no > 60) continue;
    const h = l.y1 - l.y0;
    if (h < 12 || h > page.height * 0.08) continue;
    if (l.text.replace(QNUM_RE, '').trim().length < 2) continue;
    cands.push({ no, x: l.x0, y: l.y0, h, conf: l.conf });
  }
  if (!cands.length) return [];

  // 题号都在页面的同一条左边界上；按 x0 做聚类，取成员最多的那一列
  const sorted = [...cands].sort((a, b) => a.x - b.x);
  const tol = page.width * 0.035;
  let best = [], cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].x - cur[cur.length - 1].x <= tol) cur.push(sorted[i]);
    else { if (cur.length > best.length) best = cur; cur = [sorted[i]]; }
  }
  if (cur.length > best.length) best = cur;

  // 同一行去重（题号可能被拆成两个框）
  best.sort((a, b) => a.y - b.y);
  const dedup = [];
  for (const c of best) {
    const last = dedup[dedup.length - 1];
    if (last && Math.abs(c.y - last.y) < Math.min(c.h, last.h) * 0.6) continue;
    dedup.push(c);
  }

  // 最长递增子序列：题干里的数字即使混进来，也接不上真正的题号链
  const n = dedup.length;
  const dp = new Array(n).fill(1);
  const prev = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (dedup[i].no > dedup[j].no && dp[j] + 1 > dp[i]) {
        dp[i] = dp[j] + 1;
        prev[i] = j;
      }
    }
  }
  let end = 0;
  for (let i = 1; i < n; i++) if (dp[i] > dp[end]) end = i;
  const picked = [];
  for (let i = end; i >= 0; i = prev[i]) picked.push(dedup[i]);
  picked.reverse();
  return picked;
}

/** 题号纠偏 + 漏检补齐，再把相邻题号之间切成题块 */
function buildBlocks(picked, page) {
  if (!picked.length) return [];
  // 取最长的连续编号段作为锚点，向前后推出整页题号（OCR 可能把 11 读成 1）
  let anchor = 0, runLen = 1;
  for (let i = 0; i < picked.length; i++) {
    let j = i;
    while (j + 1 < picked.length && picked[j + 1].no === picked[j].no + 1) j++;
    if (j - i + 1 > runLen) { runLen = j - i + 1; anchor = i; }
  }
  if (runLen >= 3) {
    const baseNo = picked[anchor].no;
    picked.forEach((p, i) => { p.no = baseNo + (i - anchor); });
  }

  const filled = [];
  for (let i = 0; i < picked.length; i++) {
    filled.push(picked[i]);
    const nx = picked[i + 1];
    if (!nx) continue;
    const gap = nx.no - picked[i].no;
    for (let k = 1; k < gap; k++) {
      filled.push({
        no: picked[i].no + k,
        x: picked[i].x,
        y: picked[i].y + (nx.y - picked[i].y) * (k / gap),
        h: picked[i].h,
        conf: 0,
        synthetic: true,
      });
    }
  }

  const blocks = [];
  for (let i = 0; i < filled.length; i++) {
    const top = Math.max(0, filled[i].y - Math.round(filled[i].h * 0.5));
    // 宁可多切不可少切：下边界延伸到下一题题号行往下一点，保证本题最后一行不被截断
    const bottom = i === filled.length - 1
      ? page.height - 2
      : filled[i + 1].y + Math.round(filled[i + 1].h * 1.2);
    blocks.push({
      no: filled[i].no,
      type: 'answer',
      y0: Math.max(0, Math.round(top)),
      y1: Math.min(page.height, Math.round(bottom)),
      x0: 0,
      x1: page.width,
      numX: Math.round(filled[i].x),
      numY: Math.round(filled[i].y + filled[i].h / 2),
      synthetic: !!filled[i].synthetic,
    });
  }
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
  if (!page) {
    try {
      page = await paddleLines(imagePath);
    } catch (e) {
      console.warn('[ocr] PaddleOCR 加载失败，改用 tesseract：', e.message);
      onProgress('PaddleOCR 不可用，改用 tesseract…');
      page = await tessLines(imagePath);
    }
  }

  const picked = pickNumbers(page.lines, page);
  if (picked.length < 2) {
    throw new Error(`OCR 只找到 ${picked.length} 个题号，请检查图像方向或清晰度`);
  }
  const blocks = buildBlocks(picked, page);
  if (blocks.length < 2) throw new Error('没有切出足够的题目');
  onProgress(`找到 ${blocks.length} 道题：${blocks.map(b => b.no).join(', ')}`);
  return { width: page.width, height: page.height, blocks };
}

function countQuestionNumbers(page) {
  try { return pickNumbers(page.lines || [], page).length; } catch (_) { return 0; }
}

module.exports = { split, paddleLines, countQuestionNumbers };
