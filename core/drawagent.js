// 简化版批改引擎：整页图（叠加坐标网格）→ 模型返回绘图指令 → 本地画 → 自查一轮
// 与旧管线（pipeline.js）并存，由设置里的 engine 字段切换
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const { DrawTool } = require('./drawtool');
const { chatMessages } = require('./grade');
const P = require('./prompts');

const RED = '#c81e1e';
const MAX_ROUNDS = 3;
const noop = () => {};

// 容错解析：模型偶尔会在 JSON 前后带解释文字
function parseJson(text) {
  const s0 = String(text || '').replace(/```json|```/g, '').trim();
  const a = s0.indexOf('{'), b = s0.lastIndexOf('}');
  if (a === -1) return null;
  try { return JSON.parse(s0.slice(a, b + 1)); } catch (_) {}
  return null;
}

// 纯图（不叠网格）：模型靠自己按比例估坐标
async function plainDataUrl(imagePath, width = 1500) {
  const buf = await sharp(imagePath).resize({ width }).jpeg({ quality: 90 }).toBuffer();
  return 'data:image/jpeg;base64,' + buf.toString('base64');
}

// 整页叠 0-1000 坐标网格（刻度写上边和左边），模型可直接读数；cells 控制密度
async function gridDataUrl(imagePath, width = 1500, cells = 10) {
  const n = Math.max(2, Math.min(40, Number(cells) || 10));
  const base = await sharp(imagePath).resize({ width }).jpeg({ quality: 90 }).toBuffer();
  const { width: W, height: H } = await sharp(base).metadata();
  const fsz = Math.round(W * 0.019);
  let body = '';
  const step = 1000 / n;
  for (let i = 0; i <= n; i++) {
    const x = i / n * W, y = i / n * H;
    const strong = i % Math.max(1, Math.round(n / 2)) === 0;
    const sw = strong ? 4 : 2.2, op = strong ? 0.55 : 0.3;
    body += `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#0a84ff" stroke-width="${sw}" opacity="${op}"/>`;
    body += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#0a84ff" stroke-width="${sw}" opacity="${op}"/>`;
    body += `<text x="${x + 6}" y="${fsz + 3}" font-size="${fsz}" fill="#0556b8" opacity="0.95" font-family="Menlo, monospace">${Math.round(i * step)}</text>`;
    if (i > 0) {
      body += `<text x="6" y="${y - 6}" font-size="${fsz}" fill="#0556b8" opacity="0.95" font-family="Menlo, monospace">${Math.round(i * step)}</text>`;
      body += `<text x="${W - fsz * 3}" y="${y - 6}" font-size="${fsz}" fill="#0556b8" opacity="0.95" font-family="Menlo, monospace">${Math.round(i * step)}</text>`;
    }
  }
  const overlay = await sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${body}</svg>`,
  )).resize(W, H, { fit: 'fill' }).png().toBuffer();
  const buf = await sharp(base).composite([{ input: overlay }]).jpeg({ quality: 88 }).toBuffer();
  return 'data:image/jpeg;base64,' + buf.toString('base64');
}

// 单页/多页统一入口
async function runAgent({ imagePaths, outPaths, mode = 'exam', options = {}, onStage = noop } = {}) {
  const paths = (imagePaths || []).filter(p => p);
  if (!paths.length) throw new Error('没有可批改的图片');
  if (!outPaths || outPaths.length !== paths.length) throw new Error('输出路径数量不匹配');

  const tools = [];
  for (const p of paths) tools.push(await new DrawTool(p).init());

  const pageCount = paths.length;
  const task = mode === 'essay'
    ? P.essayTask({ pageCount, extraPrompt: options.extraPrompt, essayPage: pageCount })
    : mode === 'whole'
      ? P.wholeTask({ pageCount, extraPrompt: options.extraPrompt })
      : P.examTask({
        pageCount,
        standardAnswer: options.standardAnswer,
        extraPrompt: options.extraPrompt,
        render: options.render || {},
      });

  onStage({ stage: 'grade', label: pageCount > 1 ? `${pageCount} 页一起提交` : '正在批改' });
  const useGrid = options.grid !== false;
  const cells = Number(options.gridCells) || 10;
  const imgs = [];
  for (const p of paths) {
    const url = useGrid
      ? await gridDataUrl(p, pageCount > 2 ? 1200 : 1500, cells)
      : await plainDataUrl(p, pageCount > 2 ? 1200 : 1500);
    imgs.push({ type: 'image_url', image_url: { url } });
  }

  const messages = [
    { role: 'system', content: P.system(useGrid) },
    { role: 'user', content: [{ type: 'text', text: task }, ...imgs] },
  ];

  let essay = null;
  const verdicts = [];
  let summary = '';
  let touched = new Set();
  const autoMap = new Map(); // 题号 → 由 ans 框推出来的标记（跨轮保留最新）
  const maxRounds = Math.max(1, Math.min(MAX_ROUNDS, Number(options.reviewRounds ?? 1) + 1));

  for (let round = 1; round <= maxRounds; round++) {
    const autoOps = [];
    const reply = await chatMessages(messages, { maxTokens: 2200, retries: 3 });
    const act = parseJson(reply);
    if (!act) {
      messages.push({ role: 'assistant', content: reply });
      messages.push({ role: 'user', content: '只返回约定的 JSON，不要任何解释文字。' });
      continue;
    }
    if (act.essay && typeof act.essay === 'object') essay = act.essay;
    if (act.summary && !/^(完成|ok|done|已完成)。?$/.test(String(act.summary).trim())) summary = String(act.summary);
    // 依据 verdicts 的 ans 框自动落笔：模型框“哪一行是作答”比直接报点准得多
    if (Array.isArray(act.verdicts)) {
      for (const v of act.verdicts) {
        if (!v || v.no == null) continue;
        const no = String(v.no);
        const verdict = v.verdict || 'uncertain';
        const page = Number(v.page) || 1;
        verdicts.push({ no, verdict, comment: v.comment || '', page });
        if (Array.isArray(v.ans) && v.ans.length === 4 && verdict !== 'blank') {
          const [ax1, ay1, ax2, ay2] = v.ans;
          if (ax2 > ax1 && ay2 > ay1) {
            const op = verdict === 'correct' ? 'tick' : verdict === 'partial' ? 'half' : 'cross';
            autoOps.push({ page, no, op, ans: [ax1, ay1, ax2, ay2] });
          }
        }
      }
    }

    const ops = Array.isArray(act.ops) ? act.ops : [];
    if (!ops.length && !autoOps.length) break;
    autoOps.forEach(o => autoMap.set(`${o.page}:${o.no}`, o));
    touched = new Set();
    // 自查轮不允许清空：模型偶尔会误发 clear，把整页标记抹掉
    const safeOps = round === 1 ? ops : ops.filter(o => o.op !== 'clear');
    const merged = [...autoMap.values(), ...safeOps.filter(o => !(o.no != null && autoMap.has(`${Number(o.page) || 1}:${String(o.no)}`) && ['tick', 'cross', 'half'].includes(o.op)))];
    for (const o of merged) {
      const idx = Math.max(0, Math.min(pageCount - 1, (Number(o.page) || 1) - 1));
      tools[idx].addOps([o]);
      touched.add(idx);
    }
    onStage({ stage: 'grade', label: `已画 ${tools.reduce((n, t) => n + t.ops.length, 0)} 处，AI 自查中`, progress: round / maxRounds });

    if (round === maxRounds) break;
    // 只回传被改动过的页，避免多页时请求过大
    const previews = [];
    for (const i of touched) {
      const file = path.join(os.tmpdir(), `grader_preview_${Date.now()}_${i}.jpg`);
      const url = await tools[i].preview(file, 1000);
      // 自查时也带坐标网格，模型纠正落点才有参照，否则越改越偏
      const finalUrl = useGrid ? await gridDataUrl(file, 1000, cells) : url;
      previews.push({ type: 'text', text: `第 ${i + 1} 页成品：` }, { type: 'image_url', image_url: { url: finalUrl } });
    }
    messages.push({ role: 'assistant', content: reply });
    messages.push({ role: 'user', content: [{ type: 'text', text: P.review() }, ...previews] });
  }

  // 落盘：原分辨率成品图
  for (let i = 0; i < tools.length; i++) await tools[i].render(outPaths[i]);
  onStage({ stage: 'grade', label: '批改完成', progress: 1 });

  // 多轮自查会把同一题重复登记，按题号取最后一轮的结论
  const latest = new Map();
  for (const v of verdicts) latest.set(`${v.page}:${v.no}`, v);
  const finalVerdicts = [...latest.values()];
  const results = finalVerdicts.length
    ? finalVerdicts.map(v => ({ no: v.no, verdict: v.verdict, comment: v.comment }))
    : [];
  const pages = tools.map((t, i) => ({
    out: outPaths[i],
    results: pageCount > 1
      ? finalVerdicts.filter(v => (v.page || 1) === i + 1).map(v => ({ no: v.no, verdict: v.verdict, comment: v.comment }))
      : results,
    summary: summary || (essay && essay.comment) || '',
    ops: t.ops.length,
    opsList: t.ops.map(o => ({ ...o })),
  }));

  return {
    pages,
    mode,
    summary: essay || (summary ? { type: 'other', comment: summary } : null),
    results,
    ops: pages.reduce((a, p) => a + p.ops, 0),
  };
}

module.exports = { runAgent, gridDataUrl };
