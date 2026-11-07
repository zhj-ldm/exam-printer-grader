// 流水线编排：切题 → 并发批改 → 出图，供 CLI 与 Electron 复用
const sharp = require('sharp');
const { split } = require('./ocr');
const { prepareImage } = require('./prepare');
const { gradeBlock, gradeEssay, gradePrecise } = require('./grade');
const { readPage } = require('./localocr');
const { render } = require('./render');

const PAD = 48;
const CONCURRENCY = 2;

async function cropBlock(imagePath, b, page) {
  const x0 = Math.max(0, b.x0);
  const y0 = Math.max(0, b.y0 - PAD);
  const x1 = Math.min(page.width, b.x1);
  const y1 = Math.min(page.height, b.y1 + PAD);
  const buf = await sharp(imagePath)
    .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
    // 淡铅笔/浅蓝笔在 300dpi 缩到 1100 后容易糊掉，这里放大到 1400 再轻微锐化
    .resize({ width: 1400, withoutEnlargement: true })
    .sharpen({ sigma: 0.8 })
    .jpeg({ quality: 94, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return {
    dataUrl: 'data:image/jpeg;base64,' + buf.toString('base64'),
    origin: { x0, y0, w: x1 - x0, h: y1 - y0 },
    buf,
  };
}

function spotFor(block, page) {
  const numX = block.numX ?? page.width * 0.33;
  const numY = block.numY ?? block.y0 + 40;
  return {
    x: Math.max(34, numX - 58),
    y: Math.max(34, numY + 12),
    textX: 56,
    textY: Math.min(page.height - 40, numY + 70),
  };
}

// 模型给的点可能压在字上，在它周围小幅挪到最近的空白处
async function nudgeToBlank(buf, origin, pt, radiusPx = 70) {
  const { data, info } = await sharp(buf)
    .greyscale()
    .resize({ width: 140 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sw = info.width, sh = info.height;
  const sx = origin.w / sw, sy = origin.h / sh;
  const gx = (pt.x - origin.x0) / sx, gy = (pt.y - origin.y0) / sy;
  let best = null;

  for (let y = 5; y < sh - 5; y += 2) {
    for (let x = 5; x < sw - 5; x += 2) {
      const dist = Math.hypot((x - gx) * sx, (y - gy) * sy);
      if (dist > radiusPx) continue;
      let sum = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) sum += data[(y + dy) * sw + (x + dx)];
      }
      const score = sum / 25 - dist * 1.6;
      if (!best || score > best.score) best = { x, y, score };
    }
  }
  if (!best) return pt;
  return {
    x: Math.round(Math.max(origin.x0 + 20, Math.min(origin.x0 + origin.w - 20, origin.x0 + best.x * sx))),
    y: Math.round(Math.max(origin.y0 + 20, Math.min(origin.y0 + origin.h - 20, origin.y0 + best.y * sy))),
  };
}

// 文字不往页边堆：在标记附近找一块够大的空白，优先右侧，其次下方、左侧
async function findTextSpot(buf, origin, mark, page) {
  const { data, info } = await sharp(buf)
    .greyscale()
    .resize({ width: 140 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sw = info.width, sh = info.height;
  const sx = origin.w / sw, sy = origin.h / sh;
  const W = 470, Hh = 96;

  const blank = (px, py, pw, ph) => {
    const x0 = Math.max(0, Math.round((px - origin.x0) / sx));
    const y0 = Math.max(0, Math.round((py - origin.y0) / sy));
    const x1 = Math.min(sw - 1, Math.round((px + pw - origin.x0) / sx));
    const y1 = Math.min(sh - 1, Math.round((py + ph - origin.y0) / sy));
    if (x1 - x0 < 8 || y1 - y0 < 4) return false;
    let dark = 0, n = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) { n++; if (data[y * sw + x] < 205) dark++; }
    }
    return dark / n < 0.01;
  };

  const cands = [
    [mark.x + 70, mark.y - 42],
    [mark.x + 70, mark.y + 26],
    [mark.x + 70, mark.y + 92],
    [mark.x - W - 70, mark.y - 42],
    [mark.x - W - 70, mark.y + 26],
    [mark.x - W - 70, mark.y + 92],
    [mark.x - 40, mark.y + 66],
    [mark.x - 40, mark.y + 130],
  ];
  for (const [x, y] of cands) {
    const px = Math.max(20, Math.min(page.width - W - 20, x));
    const py = Math.max(30, Math.min(page.height - Hh - 30, y));
    if (blank(px, py, W, Hh)) return { textX: Math.round(px), textY: Math.round(py + 60) };
  }
  return { textX: Math.round(Math.max(40, Math.min(page.width - W, mark.x - 40))), textY: Math.round(mark.y + 96) };
}

function toMark(r, spot, page, opts = {}) {
  const showAnswers = opts.answers !== false;
  const textParts = [];
  if (showAnswers && r.verdict === 'wrong' && r.correct) textParts.push('应: ' + r.correct);
  if (r.verdict === 'uncertain') textParts.push('待核');
  if (r.comment) textParts.push(r.comment);
  const fits = spot.x + 480 < page.width;
  const t = {
    x: spot.textX ?? (fits ? spot.x + 62 : Math.max(40, spot.x - 470)),
    y: spot.textY ?? Math.min(page.height - 50, spot.y + 58),
  };
  return {
    x: spot.x,
    y: spot.y,
    text: textParts.join('  '),
    textX: t.x,
    textY: t.y,
    point: true,
    verdict: r.verdict,
  };
}

async function pageInfo(imagePath) {
  const m = await sharp(imagePath).metadata();
  return { width: m.width, height: m.height };
}

async function splitPage(imagePath, onStage = () => {}) {
  const prep = await prepareImage(imagePath, onStage);
  onStage({ stage: 'split', label: '识别题号' });
  const page = prep.page
    ? { width: prep.page.width, height: prep.page.height }
    : await pageInfo(prep.imagePath);
  const { blocks } = await split(prep.imagePath, () => {}, prep.page);
  return {
    page, blocks,
    imagePath: prep.imagePath,
    rotation: prep.rotation,
    cropped: prep.cropped,
  };
}

async function gradeOne({ imagePath, page, block, options = {}, pageText = '' }) {
  const { dataUrl, origin, buf } = await cropBlock(imagePath, block, page);

  // 逐空精确批改：一题可产生多个落点
  if (options.gradeMode === 'precise') {
    const r = await gradePrecise({
      no: block.no,
      imageDataUrl: dataUrl,
      standardAnswer: options.standardAnswer,
      extraPrompt: options.extraPrompt,
      pageText,
    });
    const marks = [];
    for (const b of r.blanks) {
      const [bx1, by1, bx2, by2] = b.box;
      const cx = origin.x0 + (bx1 + bx2) / 2 * origin.w / 1000;
      const cy = origin.y0 + (by1 + by2) / 2 * origin.h / 1000;
      const spot = await nudgeToBlank(buf, origin, { x: cx, y: cy }, 40);
      const text = b.verdict !== 'correct' && options.render?.answers !== false
        ? (b.correct ? '应: ' + b.correct : b.comment)
        : (b.comment || '');
      marks.push({
        x: spot.x,
        y: spot.y,
        verdict: b.verdict,
        point: true,
        blank: b.i,
        text,
        textX: Math.round(Math.max(30, Math.min(page.width - 220, origin.x0 + bx1 * origin.w / 1000))),
        textY: Math.round(Math.max(24, origin.y0 + by1 * origin.h / 1000 - 16)),
      });
    }
    if (!marks.length) {
      // 模型没给出可用空位框时退回整题单点
      const spot = spotFor(block, page);
      marks.push(toMark(r, spot, page, options.render || {}));
    }
    return { result: r, marks };
  }

  const r = await gradeBlock({
    no: block.no,
    imageDataUrl: dataUrl,
    standardAnswer: options.standardAnswer,
    extraPrompt: options.extraPrompt,
  });
  // 模型在“切出来的题目块内”给坐标（0-1000），映射回整页
  const p = r.answer_point;
  let spot;
  if (p && p[0] > 0 && p[1] > 0) {
    const raw = {
      x: origin.x0 + p[0] * origin.w / 1000,
      y: origin.y0 + p[1] * origin.h / 1000,
    };
    spot = await nudgeToBlank(buf, origin, raw, 70);
  } else {
    spot = spotFor(block, page);
  }
  const withText = { ...spot, ...(await findTextSpot(buf, origin, spot, page)) };
  return { result: r, mark: toMark(r, withText, page, options.render || {}) };
}

async function runEssay({ imagePath, outPath, options = {}, onStage = () => {}, page }) {
  onStage({ stage: 'grade', label: '识别内容类型并评阅整页' });
  const { dataUrl } = await cropBlock(
    imagePath, { x0: 0, y0: 0, x1: page.width, y1: page.height }, page
  );
  const summary = await gradeEssay({ imageDataUrl: dataUrl, extraPrompt: options.extraPrompt });
  onStage({ stage: 'render', label: '生成评阅图' });
  await render(imagePath, page, [], outPath, { ...(options.render || {}), summary });
  return { page, mode: 'essay', summary, results: [], marks: [], imagePath };
}

async function runPipeline({ imagePath, outPath, options = {}, onStage = () => {} }) {
  const prep = await prepareImage(imagePath, onStage);
  imagePath = prep.imagePath;
  const page = prep.page
    ? { width: prep.page.width, height: prep.page.height }
    : await pageInfo(imagePath);

  if (options.mode === 'essay') {
    return runEssay({ imagePath, outPath, options, onStage, page });
  }

  let blocks;
  try {
    blocks = (await split(imagePath, () => {}, prep.page)).blocks;
  } catch (e) {
    if (options.mode === 'auto') {
      onStage({ stage: 'split', label: '没识别到题号，转为整页评阅' });
      return runEssay({ imagePath, outPath, options, onStage, page });
    }
    throw e;
  }
  if (!blocks.length) throw new Error('没有切出题目');
  onStage({ stage: 'split', label: `找到 ${blocks.length} 道题`, progress: 1 });

  let pageText = '';
  if (options.gradeMode === 'precise') {
    onStage({ stage: 'ocr', label: '本地 OCR 预处理整页' });
    try { pageText = (await readPage(imagePath)) || ''; } catch (_) { pageText = ''; }
  }

  const results = new Array(blocks.length).fill(null);
  const marks = [];
  let done = 0;

  async function gradeAt(i) {
    const b = blocks[i];
    onStage({ stage: 'grade', label: `批改第 ${b.no} 题`, done, total: blocks.length });
    try {
      const { result, mark, marks: mks } = await gradeOne({ imagePath, page, block: b, options, pageText });
      const list = mks || (mark ? [mark] : []);
      results[i] = { ...result, page_box: list[0] };
      marks.push(...list);
      done += 1;
      onStage({ stage: 'grade', label: `第 ${b.no} 题 ${result.verdict}${list.length > 1 ? `（${list.length} 空）` : ''}`, done, total: blocks.length });
    } catch (e) {
      done += 1;
      // 批改失败也要在该题位置留下一个“待核”标记，保证每题都有落点
      const spot = spotFor(b, page);
      const mark = { ...spot, verdict: 'uncertain', point: true, text: '待核' };
      marks.push(mark);
      results[i] = { no: b.no, verdict: 'error', error: e.message, page_box: mark };
      onStage({ stage: 'grade', label: `第 ${b.no} 题失败`, done, total: blocks.length });
    }
  }

  let next = 0;
  async function worker() {
    while (next < blocks.length) await gradeAt(next++);
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, blocks.length) }, worker));

  onStage({ stage: 'render', label: '生成批改图' });
  await render(imagePath, page, marks, outPath, options.render || {});
  return { page, blocks, results: results.filter(Boolean), marks, imagePath, rotation: prep.rotation };
}

module.exports = { runPipeline, splitPage, gradeOne, pageInfo };
