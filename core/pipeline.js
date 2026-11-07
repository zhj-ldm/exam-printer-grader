// 流水线编排：切题 → 并发批改 → 出图，供 CLI 与 Electron 复用
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { split, paddleLines } = require('./ocr');
const { prepareImage } = require('./prepare');
const { gradeBlock, gradeEssay, gradePrecise, gradeWholePage, gradeWholePages, locateQuestions, gradeDeepCandidates, gradeDeepAgent, deepScanPage, reviewPage } = require('./grade');
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

// 每道题都必须落一个明确的勾或叉：空白/待核一律按错处理
function normalizeVerdicts(marks, results) {
  for (const m of marks) {
    if (['correct', 'wrong', 'partial'].includes(m.verdict)) continue;
    if (m.verdict === 'blank' && !m.text) m.text = '未作答';
    m.verdict = 'wrong';
  }
  for (const r of results) {
    if (!r || ['correct', 'wrong', 'partial'].includes(r.verdict)) continue;
    if (r.verdict === 'blank' && !r.comment) r.comment = '未作答';
    r.verdict = 'wrong';
  }
}

// 标记位置：题号上（OCR 识别的题号处）/ 题上（模型给的作答处）/ 最右侧一列
function applyMarkSide(marks, page, side) {
  if (side === 'number' && marks.length) {
    const used = new Map();
    for (const m of marks) {
      const ax = Number.isFinite(m.subX) ? m.subX : m.numX;
      const ay = Number.isFinite(m.subY) ? m.subY : m.numY;
      if (!Number.isFinite(ax) || !Number.isFinite(ay)) continue;
      const key = `${Math.round(ax)},${Math.round(ay)}`;
      const n = used.get(key) || 0;
      used.set(key, n + 1);
      m.x = Math.round(Math.max(24, Math.min(page.width - 24, ax + (Number.isFinite(m.subX) ? 30 : 14))));
      m.y = Math.round(Math.max(24, Math.min(page.height - 34, ay + n * 34)));
      m.side = 'number';
      if (m.verdict === 'correct') m.text = '';
      if (m.text) {
        m.textX = Math.round(Math.max(30, Math.min(page.width - 470, m.x + 80)));
        m.textY = Math.round(Math.min(page.height - 46, m.y + 10));
      }
    }
    return marks;
  }
  if (side !== 'right' || !marks.length) return marks;
  const x = page.width - 96;
  const list = [...marks].sort((a, b) => a.y - b.y);
  let lastY = -1e9;
  for (const m of list) {
    let y = Math.max(46, Math.min(page.height - 60, m.y));
    if (y - lastY < 92) y = lastY + 92;
    if (y > page.height - 60) y = page.height - 60;
    m.x = x;
    m.y = Math.round(y);
    m.side = 'right';
    m.textX = Math.max(30, page.width - 470);
    m.textY = Math.round(y + 24);
    lastY = y;
  }
  return marks;
}

// 从 OCR 文本行里找大题下面的小题标号（（1）（2）(1)① 等）
function extractSubs(lines, block) {
  const re = /^[（(]\s*([0-9一二三四五六七八九十]+)\s*[）)]|^[①②③④⑤⑥⑦⑧⑨⑩]/;
  const width = Math.max(1, block.x1 - block.x0);
  return (lines || [])
    .filter(l => {
      const t = (l.text || '').trim();
      if (!re.test(t)) return false;
      if (l.y0 < block.y0 - 4 || l.y1 > block.y1 + 4) return false;
      return l.x0 >= block.x0 - 10 && l.x0 <= block.x0 + width * 0.28;
    })
    .map(l => {
      const t = l.text.trim();
      const m = t.match(re);
      return {
        label: m && m[1] ? '(' + m[1] + ')' : t.slice(0, 1),
        x: Math.round(l.x0),
        y: Math.round((l.y0 + l.y1) / 2),
        y0: Math.round(l.y0),
      };
    })
    .sort((a, b) => a.y - b.y);
}

// 把每个标记按所在高度归到所在小题（小题覆盖到下一个小题标号为止）
function attachSubAnchor(marks, block) {
  const subs = block.subs || [];
  if (!subs.length) return;
  for (const m of marks) {
    if (!Number.isFinite(m.y)) continue;
    let idx = 0;
    if (m.y >= subs[0].y) {
      for (let i = 0; i < subs.length; i++) {
        if (m.y >= subs[i].y) idx = i;
      }
    }
    m.subX = subs[idx].x;
    m.subY = subs[idx].y;
  }
}

// 同一个小题下多个空只留一个标记，避免题号旁边堆一串勾叉
function collapseSubMarks(marks) {
  const groups = new Map();
  for (const m of marks) {
    if (!Number.isFinite(m.subX) || !Number.isFinite(m.subY)) continue;
    const key = `${m.subX},${m.subY}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  if (!groups.size) return marks;
  const collapsed = [];
  for (const [key, list] of groups) {
    if (list.length === 1) { collapsed.push(list[0]); continue; }
    const base = { ...list[0] };
    const verdicts = list.map(x => x.verdict);
    base.verdict = verdicts.includes('wrong')
      ? 'wrong'
      : (verdicts.includes('partial') || verdicts.includes('uncertain') ? 'partial' : 'correct');
    const texts = [];
    for (const x of list) if (x.text && !texts.includes(x.text)) texts.push(x.text);
    base.text = texts.join('  ').slice(0, 160);
    collapsed.push(base);
  }
  return collapsed;
}

async function splitPage(imagePath, onStage = () => {}) {
  const prep = await prepareImage(imagePath, onStage);
  onStage({ stage: 'split', label: '识别题号' });
  const page = prep.page
    ? { width: prep.page.width, height: prep.page.height }
    : await pageInfo(prep.imagePath);
  const { blocks, lines } = await split(prep.imagePath, () => {}, prep.page);
  blocks.forEach(b => { b.subs = extractSubs(lines, b); });
  return {
    page, blocks, lines,
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
        numX: block.numX,
        numY: block.numY,
        text,
        textX: Math.round(Math.max(30, Math.min(page.width - 220, origin.x0 + bx1 * origin.w / 1000))),
        textY: Math.round(Math.max(24, origin.y0 + by1 * origin.h / 1000 - 16)),
      });
    }
    if (!marks.length) {
      // 模型没给出可用空位框时退回整题单点
      const spot = spotFor(block, page);
      marks.push({ ...toMark(r, spot, page, options.render || {}), numX: block.numX, numY: block.numY });
    }
    attachSubAnchor(marks, block);
    const finalMarks = collapseSubMarks(marks);
    return { result: r, marks: applyMarkSide(finalMarks, page, options.markSide) };
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
  const mark = { ...toMark(r, withText, page, options.render || {}), numX: block.numX, numY: block.numY };
  attachSubAnchor([mark], block);
  applyMarkSide([mark], page, options.markSide);
  return { result: r, mark };
}

// 用本地 OCR 行找最后一行手写的位置（忽略“400字”标尺和页码），评语从这里往下写
async function essayContentBottom(imagePath, page) {
  try {
    const { lines } = await paddleLines(imagePath);
    let y = 0;
    for (const l of lines) {
      const t = (l.text || '').trim();
      if (!t) continue;
      if (/^\d+\s*字$/.test(t)) continue;
      if (/^\d+\s*\/\s*\d+$/.test(t)) continue;
      if (t.includes('旁批')) continue;
      if (l.y1 > page.height * 0.93) continue;
      if (l.y1 > y) y = l.y1;
    }
    return y;
  } catch (_) {
    return 0;
  }
}

// 作文模式：不框题、不切题、不逐题判，整页直接评阅（显式选中作文时走专用提示词）
async function runEssay({ imagePath, outPath, options = {}, onStage = () => {}, page }) {
  const strictEssay = options.mode === 'essay';
  onStage({ stage: 'grade', label: strictEssay ? '作文模式：整页评阅' : '识别内容类型并评阅整页' });
  const { dataUrl } = await cropBlock(
    imagePath, { x0: 0, y0: 0, x1: page.width, y1: page.height }, page
  );
  const summary = await gradeEssay({
    imageDataUrl: dataUrl,
    extraPrompt: options.extraPrompt,
    strictEssay,
  });
  onStage({ stage: 'render', label: '生成评阅图' });
  const bottom = await essayContentBottom(imagePath, page);
  await render(imagePath, page, [], outPath, {
    ...(options.render || {}),
    summary,
    summaryBottomY: bottom ? bottom + 110 : undefined,
  });
  return { page, mode: 'essay', summary, results: [], marks: [], imagePath };
}

// 多页作文：所有页一次性发给模型，跨页连读后整体评分与评语（不切题、不逐题判）
async function runEssayBatch({ imagePaths, outPaths, options = {}, onStage = () => {} }) {
  const n = imagePaths.length;
  const pages = [];
  for (let i = 0; i < n; i++) {
    onStage({ stage: 'split', label: `第 ${i + 1}/${n} 页：判断方向并裁空白` });
    const prep = await prepareImage(imagePaths[i], onStage);
    const page = prep.page
      ? { width: prep.page.width, height: prep.page.height }
      : await pageInfo(prep.imagePath);
    const { dataUrl } = await cropBlock(prep.imagePath, { x0: 0, y0: 0, x1: page.width, y1: page.height }, page);
    pages.push({ page, imagePath: prep.imagePath, outPath: outPaths[i], dataUrl });
  }

  onStage({ stage: 'grade', label: `作文模式：${n} 页一次性提交，整体评分` });
  const summary = await gradeEssay({
    imageDataUrls: pages.map(p => p.dataUrl),
    extraPrompt: options.extraPrompt,
    strictEssay: true,
  });

  // 评语写在最后一页：先用 OCR 找到最后一行手写，再从下方留白处开始写
  const summaryBottom = n ? await essayContentBottom(pages[n - 1].imagePath, pages[n - 1].page) : 0;

  for (let i = 0; i < n; i++) {
    onStage({ stage: 'render', label: `第 ${i + 1}/${n} 页：生成评阅图` });
    await render(pages[i].imagePath, pages[i].page, [], pages[i].outPath, {
      ...(options.render || {}),
      summary: i === n - 1 ? summary : undefined,
      summaryBottomY: i === n - 1 && summaryBottom ? summaryBottom + 110 : undefined,
    });
  }

  return {
    mode: 'essay-batch',
    summary,
    summaryPage: n,
    pages: pages.map((p, i) => ({
      page: p.page,
      blocks: [],
      results: [],
      marks: [],
      summary,
      imagePath: p.outPath,
      mode: 'essay',
    })),
  };
}

// AI 复合：把成品图发回模型复核漏批/错位/重复，按建议调整后重新出图
async function aiReview({ imagePath, outPath, page, marks, results, options = {}, onStage = () => {} }) {
  const rounds = Math.max(0, Math.min(3, Number(options.reviewRounds) || 0));
  if (!rounds || !marks.length) return;
  for (let r = 0; r < rounds; r++) {
    onStage({ stage: 'render', label: `AI 复合第 ${r + 1} / ${rounds} 轮` });
    let dataUrl;
    try {
      const buf = await sharp(outPath)
        .resize({ width: 1800, withoutEnlargement: true })
        .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
        .toBuffer();
      dataUrl = 'data:image/jpeg;base64,' + buf.toString('base64');
    } catch (_) { return; }

    let adj;
    try {
      adj = await reviewPage({ imageDataUrl: dataUrl, page, marks, results });
    } catch (e) {
      onStage({ stage: 'render', label: `复合失败，保留原图：${e.message}` });
      return;
    }

    let changed = 0;

    // 挪动标记（先做，保证下标还是模型看到的原始顺序）
    for (const m of adj.move) {
      const mk = marks[m.i];
      if (!mk) continue;
      mk.x = Math.round(Math.max(24, Math.min(page.width - 24, m.x * page.width / 1000)));
      mk.y = Math.round(Math.max(24, Math.min(page.height - 40, m.y * page.height / 1000)));
      if (mk.text) {
        mk.textX = Math.round(Math.max(30, Math.min(page.width - 470, mk.x + 80)));
        mk.textY = Math.round(Math.min(page.height - 46, mk.y + 10));
      }
      changed += 1;
    }

    // 批注文字修正
    for (const t of adj.text) {
      const mk = marks[t.i];
      if (!mk) continue;
      mk.text = t.text;
      changed += 1;
    }

    // 删除：只接受“和另一个标记几乎重叠”的重复项，避免误删正常对勾
    const del = new Set();
    for (const i of (adj.remove || [])) {
      const mk = marks[i];
      if (!mk) continue;
      const dup = marks.some((o, j) => j !== i && Math.hypot(o.x - mk.x, o.y - mk.y) < 22);
      if (dup) del.add(i);
    }
    if (del.size) {
      for (const i of [...del].sort((a, b) => b - a)) {
        const mk = marks[i];
        const ri = results.findIndex(r => r.page_box === mk);
        if (ri >= 0) results.splice(ri, 1);
        marks.splice(i, 1);
      }
      changed += del.size;
    }

    // 补漏批：只为“结果里完全没有的题”补标记，避免把已批题的空重复添加
    const gradedNos = new Set(results.map(r => String(r.no)));
    for (const mb of adj.missing) {
      if (mb.no != null && gradedNos.has(String(mb.no))) continue;
      const [bx1, by1, bx2, by2] = mb.box;
      const x = Math.round((bx1 + bx2) / 2 * page.width / 1000);
      const y = Math.round((by1 + by2) / 2 * page.height / 1000);
      if (marks.some(m => Math.hypot(m.x - x, m.y - y) < 40)) continue;
      const text = mb.verdict !== 'correct' && options.render?.answers !== false
        ? (mb.correct ? '应: ' + mb.correct : mb.text)
        : (mb.text || '');
      const mark = {
        x, y, verdict: mb.verdict, point: true, text,
        textX: Math.round(Math.max(30, Math.min(page.width - 220, bx1 * page.width / 1000))),
        textY: Math.round(Math.max(24, by1 * page.height / 1000 - 16)),
      };
      marks.push(mark);
      results.push({
        no: mb.no != null ? mb.no : '补',
        verdict: mb.verdict,
        student: mb.student, correct: mb.correct, comment: mb.text, page_box: mark,
      });
      if (mb.no != null) gradedNos.add(String(mb.no));
      changed += 1;
    }

    if (!changed) {
      onStage({ stage: 'render', label: `复合完成，无需调整（${r + 1} 轮）` });
      return;
    }
    normalizeVerdicts(marks, results);
    applyMarkSide(marks, page, options.markSide);
    await render(imagePath, page, marks, outPath, options.render || {});
  }
}

// 多页 + 整页直读：所有页一次请求交给模型，跨页阅读/作文一起判
async function runWholeBatch({ imagePaths, outPaths, options = {}, onStage = () => {} }) {
  const n = imagePaths.length;
  const pages = [];
  for (let i = 0; i < n; i++) {
    onStage({ stage: 'split', label: `第 ${i + 1}/${n} 页：判断方向并裁空白` });
    const prep = await prepareImage(imagePaths[i], onStage);
    const page = prep.page
      ? { width: prep.page.width, height: prep.page.height }
      : await pageInfo(prep.imagePath);
    const { dataUrl } = await cropBlock(prep.imagePath, { x0: 0, y0: 0, x1: page.width, y1: page.height }, page);
    pages.push({ page, imagePath: prep.imagePath, outPath: outPaths[i], dataUrl });
  }

  onStage({ stage: 'grade', label: `整页直读：${n} 页一起提交（单次请求）` });
  const r = await gradeWholePages({
    imageDataUrls: pages.map(p => p.dataUrl),
    standardAnswer: options.standardAnswer,
    extraPrompt: options.extraPrompt,
  });
  if (!r.blanks.length) throw new Error('多页整页批改没有返回可用空位');

  const perPage = pages.map(() => ({ marks: [], results: [] }));
  for (const b of r.blanks) {
    const idx = Math.max(0, Math.min(n - 1, (b.page || 1) - 1));
    const page = pages[idx].page;
    const [bx1, by1, bx2, by2] = b.box;
    const x = (bx1 + bx2) / 2 * page.width / 1000;
    const y = (by1 + by2) / 2 * page.height / 1000;
    const text = b.verdict !== 'correct' && options.render?.answers !== false
      ? (b.correct ? '应: ' + b.correct : b.comment)
      : (b.comment || '');
    const mark = {
      x: Math.round(x), y: Math.round(y),
      verdict: b.verdict, point: true, blank: b.i, text,
      textX: Math.round(Math.max(30, Math.min(page.width - 220, bx1 * page.width / 1000))),
      textY: Math.round(Math.max(24, by1 * page.height / 1000 - 16)),
    };
    perPage[idx].marks.push(mark);
    perPage[idx].results.push({
      no: b.i, verdict: b.verdict, student: b.student,
      correct: b.correct, comment: b.comment, page_box: mark,
    });
  }

  const outs = [];
  for (let i = 0; i < n; i++) {
    const p = pages[i];
    onStage({ stage: 'render', label: `第 ${i + 1}/${n} 页：${perPage[i].marks.length} 个空，生成批改图` });
    normalizeVerdicts(perPage[i].marks, perPage[i].results);
    applyMarkSide(perPage[i].marks, p.page, options.markSide);
    await render(p.imagePath, p.page, perPage[i].marks, p.outPath, options.render || {});
    await aiReview({
      imagePath: p.imagePath, outPath: p.outPath, page: p.page,
      marks: perPage[i].marks, results: perPage[i].results, options, onStage,
    });
    outs.push({
      page: p.page,
      blocks: [],
      results: perPage[i].results,
      marks: perPage[i].marks,
      imagePath: p.outPath,
      mode: 'whole',
    });
  }
  return { pages: outs, mode: 'whole-batch', comment: r.comment };
}

async function runWholePage({ imagePath, outPath, page, options = {}, onStage = () => {} }) {
  onStage({ stage: 'grade', label: '整页直读（不切题）' });
  const { dataUrl } = await cropBlock(imagePath, { x0: 0, y0: 0, x1: page.width, y1: page.height }, page);
  const r = await gradeWholePage({
    imageDataUrl: dataUrl,
    standardAnswer: options.standardAnswer,
    extraPrompt: options.extraPrompt,
  });
  if (!r.blanks.length) throw new Error('整页批改没有返回可用空位');

  const marks = [];
  const results = [];
  for (const b of r.blanks) {
    const [bx1, by1, bx2, by2] = b.box;
    const x = (bx1 + bx2) / 2 * page.width / 1000;
    const y = (by1 + by2) / 2 * page.height / 1000;
    const text = b.verdict !== 'correct' && options.render?.answers !== false
      ? (b.correct ? '应: ' + b.correct : b.comment)
      : (b.comment || '');
    const mark = {
      x: Math.round(x), y: Math.round(y),
      verdict: b.verdict, point: true, blank: b.i, text,
      textX: Math.round(Math.max(30, Math.min(page.width - 220, bx1 * page.width / 1000))),
      textY: Math.round(Math.max(24, by1 * page.height / 1000 - 16)),
    };
    marks.push(mark);
    results.push({
      no: b.i, verdict: b.verdict, student: b.student,
      correct: b.correct, comment: b.comment, page_box: mark,
    });
  }
  onStage({ stage: 'render', label: `共 ${marks.length} 个空，生成批改图` });
  normalizeVerdicts(marks, results);
  applyMarkSide(marks, page, options.markSide);
  await render(imagePath, page, marks, outPath, options.render || {});
  await aiReview({ imagePath, outPath, page, marks, results, options, onStage });
  return { page, blocks: [], results, marks, imagePath, mode: 'whole' };
}

// 像搜题软件一样：让视觉模型直接框出每道题的完整区域，再逐题批改
async function locateBlocks({ imagePath, page, onStage }) {
  onStage({ stage: 'split', label: '模型正在框出每道题' });
  const { dataUrl } = await cropBlock(imagePath, { x0: 0, y0: 0, x1: page.width, y1: page.height }, page);
  const qs = await locateQuestions({ imageDataUrl: dataUrl });
  if (!qs.length) throw new Error('模型没有框出题目');
  return qs.map((q, i) => {
    const [bx1, by1, bx2, by2] = q.box;
    const x0 = Math.max(0, Math.round(bx1 * page.width / 1000));
    const y0 = Math.max(0, Math.round(by1 * page.height / 1000));
    const x1 = Math.min(page.width, Math.round(bx2 * page.width / 1000));
    const y1 = Math.min(page.height, Math.round(by2 * page.height / 1000));
    return {
      no: q.no || i + 1,
      type: 'answer',
      x0, y0,
      x1: Math.max(x0 + 40, x1),
      y1: Math.max(y0 + 40, y1),
      numX: Math.round(x0 + Math.min(120, (x1 - x0) * 0.2)),
      numY: Math.round(y0 + 26),
      col: 0,
    };
  });
}

// 云端 Agent 请求复核某个区域时，按整页 0-1000 框裁图并跑本地 OCR
async function ocrRegionBoxes(imagePath, page, boxes) {
  const results = [];
  for (let i = 0; i < boxes.length; i++) {
    const [x1, y1, x2, y2] = boxes[i];
    const left = Math.max(0, Math.floor(Math.min(x1, x2) * page.width / 1000));
    const top = Math.max(0, Math.floor(Math.min(y1, y2) * page.height / 1000));
    const width = Math.min(page.width - left, Math.floor(Math.abs(x2 - x1) * page.width / 1000));
    const height = Math.min(page.height - top, Math.floor(Math.abs(y2 - y1) * page.height / 1000));
    if (width < 20 || height < 20) continue;
    const tmp = path.join(os.tmpdir(), `grader-ocr-${process.pid}-${Date.now()}-${i}.jpg`);
    try {
      await sharp(imagePath)
        .extract({ left, top, width, height })
        .resize({ width: Math.min(1600, Math.round(width * 1.5)), withoutEnlargement: false })
        .jpeg({ quality: 92 })
        .toFile(tmp);
      const p = await paddleLines(tmp);
      const lines = (p.lines || []).map(l => ({
        text: l.text,
        x: Math.round(l.x0 + left),
        y: Math.round((l.y0 + l.y1) / 2 + top),
      })).slice(0, 30);
      results.push({ box: boxes[i], lines });
    } catch (e) {
      results.push({ box: boxes[i], lines: [], error: e.message });
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }
  return results;
}

// 深度抓取：本地 OCR 先抓出所有题号/小题号，云端只判对错，程序自动落点
function buildDeepCandidates(blocks) {
  const list = [];
  for (const b of blocks) {
    const subs = b.subs || [];
    if (subs.length) {
      subs.forEach((s, i) => list.push({
        id: `${b.no}-${i + 1}`,
        label: `${b.no}${s.label}`,
        text: s.label,
        x: s.x,
        y: s.y,
        blockNo: b.no,
        isSub: true,
      }));
    } else {
      list.push({
        id: String(b.no),
        label: String(b.no),
        text: '',
        x: b.numX,
        y: b.numY,
        blockNo: b.no,
        isSub: false,
      });
    }
  }
  return list;
}

const deepKey = s => String(s).replace(/[^\d]/g, '');

async function runDeepPage({ imagePath, outPath, page, blocks, options = {}, onStage = () => {} }) {
  const candidates = buildDeepCandidates(blocks).filter(c => Number.isFinite(c.x) && Number.isFinite(c.y));
  if (!candidates.length) throw new Error('本地 OCR 没有抓到可标记的题号');
  onStage({ stage: 'grade', label: `本地 OCR 定位 ${candidates.length} 个题号/小题号` });
  const { dataUrl } = await cropBlock(imagePath, { x0: 0, y0: 0, x1: page.width, y1: page.height }, page);
  let r;
  if (options.deepGrab) {
    onStage({ stage: 'grade', label: `云端 Agent 多轮核对 ${candidates.length} 个位置` });
    try {
      r = await gradeDeepAgent({
        imageDataUrl: dataUrl,
        page,
        candidates,
        standardAnswer: options.standardAnswer,
        extraPrompt: options.extraPrompt,
        ocrRegion: boxes => ocrRegionBoxes(imagePath, page, boxes),
        rounds: 3,
      });
      if (!r) onStage({ stage: 'grade', label: 'Agent 未返回结果，改用单轮判定' });
    } catch (e) {
      onStage({ stage: 'grade', label: 'Agent 调用失败，改用单轮判定：' + e.message });
    }
  }
  if (!r) {
    r = await gradeDeepCandidates({
      imageDataUrl: dataUrl,
      page,
      candidates,
      standardAnswer: options.standardAnswer,
      extraPrompt: options.extraPrompt,
    });
  }
  onStage({ stage: 'grade', label: `云端判定 ${r.items.length} 项` });

  const byKey = new Map();
  for (const it of r.items) byKey.set(deepKey(it.id), it);

  const marks = [];
  const results = [];
  for (const c of candidates) {
    const it = byKey.get(deepKey(c.id)) || { verdict: 'blank', correct: '', comment: '' };
    const text = it.verdict !== 'correct' && options.render?.answers !== false
      ? (it.correct ? '应: ' + it.correct : it.comment).slice(0, 24)
      : '';
    const mark = {
      x: Math.round(c.x + (c.isSub ? 30 : 14)),
      y: Math.round(c.y),
      verdict: it.verdict,
      point: true,
      text,
      textX: Math.round(Math.max(30, Math.min(page.width - 470, c.x + 80))),
      textY: Math.round(Math.min(page.height - 46, c.y + 10)),
      numX: c.x,
      numY: c.y,
    };
    marks.push(mark);
    results.push({
      no: c.label,
      verdict: it.verdict,
      student: '',
      correct: it.correct,
      comment: it.comment,
      page_box: mark,
    });
  }

  // 云端额外指出的漏批位置
  for (const e of r.extra) {
    const [bx1, by1, bx2, by2] = e.box;
    const x = Math.round((bx1 + bx2) / 2 * page.width / 1000);
    const y = Math.round((by1 + by2) / 2 * page.height / 1000);
    const text = e.verdict !== 'correct' && options.render?.answers !== false
      ? (e.correct ? '应: ' + e.correct : e.comment)
      : (e.comment || '');
    const mark = { x, y, verdict: e.verdict, point: true, text, textX: x + 60, textY: y + 8 };
    marks.push(mark);
    results.push({ no: '补', verdict: e.verdict, student: '', correct: e.correct, comment: e.comment, page_box: mark });
  }

  onStage({ stage: 'render', label: '生成批改图' });
  normalizeVerdicts(marks, results);
  applyMarkSide(marks, page, options.markSide);
  await render(imagePath, page, marks, outPath, options.render || {});
  await aiReview({ imagePath, outPath, page, marks, results, options, onStage });
  return { page, blocks, results, marks, imagePath, mode: 'deep' };
}

async function runPipeline({ imagePath, outPath, options = {}, onStage = () => {} }) {
  const prep = await prepareImage(imagePath, onStage);
  imagePath = prep.imagePath;
  const page = prep.page
    ? { width: prep.page.width, height: prep.page.height }
    : await pageInfo(imagePath);

  // 作文模式独立处理：只整页评阅，不框题/不切题/不逐题判，也不做深度抓取与 AI 复合
  if (options.mode === 'essay') {
    return { ...(await runEssay({ imagePath, outPath, options, onStage, page })), rotation: prep.rotation };
  }

  // 深度抓取（通用增强）：给云端开放本地 OCR 调用能力，先整体把握试卷
  if (options.deepGrab && options.markSide !== 'number') {
    try {
      onStage({ stage: 'grade', label: '深度抓取：本地 OCR 预处理整页' });
      const { lines } = await paddleLines(imagePath);
      const { dataUrl } = await cropBlock(imagePath, { x0: 0, y0: 0, x1: page.width, y1: page.height }, page);
      const notes = await deepScanPage({
        imageDataUrl: dataUrl,
        page,
        lines,
        ocrRegion: boxes => ocrRegionBoxes(imagePath, page, boxes),
      });
      if (notes) {
        options = {
          ...options,
          extraPrompt: ((options.extraPrompt || '') + '\n【本地 OCR 深度抓取补充（供批改参考）】\n' + notes).trim(),
        };
        onStage({ stage: 'grade', label: '深度抓取完成，试卷理解已并入批改参考' });
      } else {
        onStage({ stage: 'grade', label: '深度抓取未返回补充信息，按常规批改' });
      }
    } catch (e) {
      onStage({ stage: 'grade', label: '深度抓取失败，按常规批改：' + e.message });
    }
  }

  // 标在题号上：默认先由本地 OCR 抓所有大题/小题标号，云端只判对错、程序按 OCR 坐标落点
  if (options.markSide === 'number') {
    try {
      const { blocks, lines } = await split(imagePath, () => {}, page);
      blocks.forEach(b => { b.subs = extractSubs(lines, b); });
      const r = await runDeepPage({ imagePath, outPath, page, blocks, options, onStage });
      return { ...r, rotation: prep.rotation };
    } catch (e) {
      onStage({ stage: 'split', label: 'OCR 题号定位失败，改用逐题批改：' + e.message });
    }
  }

  // 整页直读：不切题，整页交给模型自己找空位；失败时自动退回切题批改
  if (options.pageMode === 'whole') {
    try {
      const r = await runWholePage({ imagePath, outPath, page, options, onStage });
      return { ...r, rotation: prep.rotation };
    } catch (e) {
      onStage({ stage: 'split', label: '整页直读失败，改按切题批改' });
    }
  }

  let blocks = null;
  // 模型框题：按整道题的视觉区域切，适合一横行并排两题、排版不规则的卷子
  if (options.pageMode === 'locate') {
    try {
      blocks = await locateBlocks({ imagePath, page, onStage });
      onStage({ stage: 'split', label: `模型框出 ${blocks.length} 道题`, progress: 1 });
    } catch (e) {
      onStage({ stage: 'split', label: '模型框题失败，改按题号切题' });
    }
  }

  if (!blocks) {
    try {
      const sp = await split(imagePath, () => {}, prep.page);
      blocks = sp.blocks;
      blocks.forEach(b => { b.subs = extractSubs(sp.lines, b); });
    } catch (e) {
      if (options.mode === 'auto') {
        onStage({ stage: 'split', label: '没识别到题号，转为整页评阅' });
        return runEssay({ imagePath, outPath, options, onStage, page });
      }
      throw e;
    }
  }
  if (!blocks.length) throw new Error('没有切出题目');
  onStage({ stage: 'split', label: `找到 ${blocks.length} 道题`, progress: 1 });

  const results = new Array(blocks.length).fill(null);
  const marks = [];
  let done = 0;

  async function gradeAt(i) {
    const b = blocks[i];
    onStage({ stage: 'grade', label: `批改第 ${b.no} 题`, done, total: blocks.length });
    try {
      const { result, mark, marks: mks } = await gradeOne({ imagePath, page, block: b, options });
      const list = mks || (mark ? [mark] : []);
      results[i] = { ...result, page_box: list[0] };
      marks.push(...list);
      done += 1;
      onStage({ stage: 'grade', label: `第 ${b.no} 题 ${result.verdict}${list.length > 1 ? `（${list.length} 空）` : ''}`, done, total: blocks.length });
    } catch (e) {
      done += 1;
      // 批改失败也必须落一个错号，保证每题都有明确的对/错标记
      const spot = spotFor(b, page);
      const mark = { ...spot, verdict: 'wrong', point: true, text: '批改失败', numX: b.numX, numY: b.numY };
      marks.push(mark);
      results[i] = { no: b.no, verdict: 'wrong', comment: '批改失败：' + e.message, page_box: mark };
      onStage({ stage: 'grade', label: `第 ${b.no} 题失败`, done, total: blocks.length });
    }
  }

  let next = 0;
  async function worker() {
    while (next < blocks.length) await gradeAt(next++);
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, blocks.length) }, worker));

  onStage({ stage: 'render', label: '生成批改图' });
  normalizeVerdicts(marks, results.filter(Boolean));
  applyMarkSide(marks, page, options.markSide);
  await render(imagePath, page, marks, outPath, options.render || {});
  await aiReview({ imagePath, outPath, page, marks, results: results.filter(Boolean), options, onStage });
  return { page, blocks, results: results.filter(Boolean), marks, imagePath, rotation: prep.rotation };
}

module.exports = { runPipeline, runWholeBatch, runEssayBatch, splitPage, gradeOne, pageInfo };
