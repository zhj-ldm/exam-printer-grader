// 云端批改：OpenAI 兼容接口，RPM 限速 + 多 Key 轮询
const DEFAULT_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';
const RPM = 10;
const MIN_INTERVAL = 60 / RPM + 0.4;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const parseKeys = s => (s || '').split(',').map(x => x.trim()).filter(Boolean);

// 运行时可配置：接口地址、模型名、Key 列表（设置面板保存后热更新）
const runtime = {
  url: DEFAULT_URL,
  model: DEFAULT_MODEL,
  keys: parseKeys(process.env.GRADER_API_KEYS || process.env.GRADER_API_KEY || ''),
};
let keyState = runtime.keys.map(() => ({ last: 0, busy: false }));
let cursor = 0;
const soloState = { last: 0, busy: false }; // 本地模型不需要 Key，用单通道

function configure({ baseUrl, model, apiKeys } = {}) {
  if (baseUrl && baseUrl.trim()) runtime.url = baseUrl.trim();
  if (model && model.trim()) runtime.model = model.trim();
  if (apiKeys !== undefined) {
    runtime.keys = parseKeys(apiKeys);
    keyState = runtime.keys.map(() => ({ last: 0, busy: false }));
    cursor = 0;
  }
  return { url: runtime.url, model: runtime.model, keys: runtime.keys.length };
}

async function waitTurn() {
  if (!runtime.keys.length) {
    // 本地模型（LM Studio）：无 Key，单通道串行
    while (true) {
      const dt = Date.now() - soloState.last;
      if (!soloState.busy && dt < MIN_INTERVAL * 1000) {
        await sleep(MIN_INTERVAL * 1000 - dt);
      }
      if (!soloState.busy) {
        soloState.busy = true;
        soloState.last = Date.now();
        return { key: null, index: -1 };
      }
      await sleep(200);
    }
  }
  while (true) {
    for (let i = 0; i < runtime.keys.length; i++) {
      const idx = (cursor + i) % runtime.keys.length;
      const st = keyState[idx];
      if (st.busy) continue;
      const dt = Date.now() - st.last;
      if (dt < MIN_INTERVAL * 1000) continue;
      st.busy = true;
      st.last = Date.now();
      cursor = (idx + 1) % runtime.keys.length;
      return { key: runtime.keys[idx], index: idx };
    }
    await sleep(250);
  }
}

function releaseSlot(index) {
  if (index === -1) { soloState.busy = false; return; }
  keyState[index].busy = false;
}

function nextKey(retryIdx) {
  if (retryIdx === -1 || !runtime.keys.length) return null;
  // 重试时换一把 Key 再试
  cursor = (retryIdx + 1) % runtime.keys.length;
  keyState[cursor].last = Date.now();
  return runtime.keys[cursor];
}

// 容错解析：模型输出被截断或格式轻微损坏时，尽量保住已完整的部分
function parseJsonLoose(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  const s = cleaned.indexOf('{');
  if (s === -1) return null;
  const body = cleaned.slice(s);
  try { return JSON.parse(body); } catch (_) {}

  const tails = ['}', ']}', '"]}]}'];
  let idx = body.length;
  for (let n = 0; n < 120; n++) {
    const cut = body.lastIndexOf('}', idx - 1);
    if (cut < 0) break;
    idx = cut;
    const head = body.slice(0, cut + 1).replace(/,\s*$/, '');
    for (const tail of tails) {
      try { return JSON.parse(head + tail); } catch (_) {}
    }
  }
  return null;
}

function parseJson(text) {
  const item = parseJsonLoose(text);
  if (!item) throw new Error('模型未返回可用 JSON：' + String(text).slice(-160));
  return item;
}

async function chat(prompt, imageDataUrl, { maxTokens = 900, retries = 6 } = {}) {
  const content = [{ type: 'text', text: prompt }];
  if (imageDataUrl) {
    content.push({ type: 'image_url', image_url: { url: imageDataUrl } });
  }
  const body = {
    model: runtime.model,
    temperature: 0,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content }],
  };

  for (let attempt = 0; attempt < retries; attempt++) {
    const slot = await waitTurn();
    const token = attempt === 0 ? slot.key : nextKey(slot.index);
    try {
      const res = await fetch(runtime.url, {
        method: 'POST',
        headers: {
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries - 1) {
          await sleep(12000 * (attempt + 1));
          continue;
        }
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = JSON.parse(text);
      return data.choices[0].message.content;
    } catch (err) {
      if (attempt >= retries - 1) throw err;
      await sleep(8000 * (attempt + 1));
    } finally {
      releaseSlot(slot.index);
    }
  }
}

function teacherPrompt(no, { standardAnswer = '', extraPrompt = '' } = {}) {
  const std = standardAnswer.trim()
    ? `\n【标准答案（这是权威答案，必须以它为准，不要自行另算）】\n${standardAnswer.trim()}`
    : '\n【没有提供标准答案】请先自己独立把这道题完整解一遍，得到权威答案，再与学生作答比对。';
  const extra = extraPrompt.trim()
    ? `\n【老师额外要求】\n${extraPrompt.trim()}`
    : '';

  return `这是试卷第 ${no} 题的作答区域（扫描件）。请以任课老师身份批改。${std}${extra}

【先认清题目在问什么】
- 不要预设这是数学，也不要预设年级和学科。先读题干，自己判断这是哪一科、什么题型（选择、填空、判断、简答、材料分析、计算、作图、作文等），再按对应学科的批改标准判。
- 不论语文、历史、地理、政治、生物、物理、化学、英语，你都照常批改；绝对不要回答“这不是数学/不能批改/无权批改”之类的话，这项任务本身就是批改这份卷子。

批改原则：
1. 先确定正确答案，再判断学生答案。只要意思与正确答案等价就算对（数值等价、单位等价、同义表述、人物/事件/术语的常见别称都算等价）。
2. 选择题重点看：括号、方框、横线里填的字母；圈选、打勾、涂黑、划线等选择痕迹；题干要求的组合项（如“A.①②”）。只要作答痕迹明确，就按它判对错，不得判为未作答。
3. 书写潦草、字迹不规范、没写单位符号格式等，只要意思可辨认，一律不扣分、不判错。
4. 解答题看关键步骤与最终结果；作图题看图形位置、形状、方向是否正确；简答、材料题看要点是否齐全。
5. 半对也要判出来：关键步骤正确但最终结果错、要点答到一部分、选择题选对但理由不完整等，verdict 用 "partial"（半对），不要一律判错。
6. 拿不准正确答案时，也要给出你的最佳判断并降低 confidence；实在无法判断时 verdict 用 uncertain，不要拒批。
7. comment 只写真正的错因，15 字以内；做对时留空，半对时写缺了哪一步。

关于“有没有写字”（务必遵守）：
- 扫描件对比度低，铅笔画、浅蓝色/淡墨字、擦过又重写的痕迹都可能很淡，常常和印刷题干混在一起。请放大仔细观察括号内、空白处、行间、页边、图上标注，不要把淡笔迹当成纸面噪点。
- 只要能在作答区看到任何可能是学生手写的笔画、数字、字母、图形或修改痕迹，就不能判 blank，应当尽力辨认；实在辨不清就判 uncertain，并在 comment 里写“字迹过淡”之类。
- 只有整块作答区域确实完全空白（没有任何非印刷的手写痕迹）时，才允许 verdict 为 "blank"，此时 student 必须是 ""。
- 不要把印刷体的题干、括号、下划线、图形、表格和印刷的 A/B/C/D 选项当成学生答案；也不要把学生写的字当成题目的一部分。
- student 字段请抄写你实际看到的全部手写内容；有涂改就写“（有涂改）”；看不清的字符用“□”代替，不要直接留空。

只返回 JSON，不要解释：
{"no":${no},"verdict":"correct|partial|wrong|blank|uncertain","student":"学生答案原文","correct":"正确答案","comment":"错因","answer_point":[x,y],"confidence":0.9}

坐标要求：answer_point 是你要打勾/打叉的位置，用本图 0-1000 归一化坐标（x 相对本图宽、y 相对本图高）。必须落在学生答案旁边、尽量不压住文字的地方；整题确实没有作答时给 [0,0]。`;
}

function inRange(v, max) {
  return typeof v === 'number' && v >= 0 && v <= max;
}

async function gradeBlock({ no, imageDataUrl, standardAnswer = '', extraPrompt = '' }) {
  const reply = await chat(teacherPrompt(no, { standardAnswer, extraPrompt }), imageDataUrl);
  const item = parseJson(reply);
  const pt = Array.isArray(item.answer_point) ? item.answer_point : [0, 0];
  const point = inRange(pt[0], 1000) && inRange(pt[1], 1000) && pt[0] > 0 && pt[1] > 0
    ? pt : null;

  let verdict = item.verdict || 'uncertain';
  if (verdict === 'half' || verdict === 'half_correct' || verdict === '半对' || verdict === '部分正确') verdict = 'partial';
  const conf = typeof item.confidence === 'number' ? item.confidence : 1;
  if (conf < 0.7 && verdict !== 'blank') verdict = 'uncertain';
  // 模型说“空白”但同时又抄到了学生内容，说明它其实看见了字：不能判空
  if (verdict === 'blank' && String(item.student || '').trim()) verdict = 'uncertain';

  // 模型拒批（“非数学/无法批改”等）时统一转成待核，不能整题不判
  const refusal = /不能批改|无法批改|无权批改|非数学|不是数学|无法识别学科|无法判断学科|拒绝/.test(item.comment || '');
  const comment = refusal ? '需人工复核' : (item.comment || '');
  if (refusal && verdict !== 'blank') verdict = 'uncertain';

  return {
    no,
    verdict,
    student: item.student || '',
    correct: item.correct || '',
    comment,
    answer_point: point,
    confidence: conf,
  };
}

function essayPrompt(extraPrompt = '') {
  const extra = extraPrompt.trim() ? `\n【老师额外要求】\n${extraPrompt.trim()}` : '';
  return `你是一位有经验的语文/学科老师，请评阅这张扫描件。${extra}

【第一步：判断内容】
- 如果是学生作文（记叙文、议论文、说明文、读后感、书信等），按作文标准评阅。
- 如果是整页试卷（题目+学生作答密集排布），只做整体分析：指出涉及哪些题型、学生主要失分点，不逐题判分。
- 如果是其它作业（练字、笔记、实验报告等），按对应作业的要求给评语。
不要因为“看不清/不是数学/无法批改”而拒评，这是你的本职任务。

【作文评分规则】
1. 满分以卷面标注为准（如“满分50分”“40分”）；卷面没写就按 50 分。
2. 按四个维度打分并给出小分：内容（立意是否明确、材料是否切题、中心是否突出）、结构（层次是否清楚、首尾是否呼应、详略是否得当）、语言（用词是否准确、句子是否通顺、有无修辞亮点）、书写（字迹是否工整、卷面是否整洁）。
3. 总评 80-150 字：先肯定 1-2 个真实优点，再具体指出 1-2 个可改进之处（指出段落或句子的具体位置），最后给一句可操作的提升建议。
4. 分数要落在常见区间，不要全部给满分；书写差不等于内容差，分别评价。
5. 逐处挑出可修改的地方，输出 corrections 数组（3-8 条）：中文作文挑用词不当、搭配不当、病句、句式单调；英语作文挑语法错误、时态/单复数/冠词、拼写、用词与搭配。每条给出 from（原文片段）、to（改写后）、reason（10 字内原因）。英语作文的 from/to 保留英文原文。

【非作文】
type 填 exam 或 other，score 留 null，dims 留空对象 {}，corrections 给空数组。

只返回 JSON，不要解释：
{"type":"essay|exam|other","score":45,"fullScore":50,"dims":{"内容":18,"结构":12,"语言":12,"书写":3},"comment":"……","corrections":[{"from":"原文","to":"建议","reason":"用词"}]}`;
}

async function gradeEssay({ imageDataUrl, extraPrompt = '' }) {
  const reply = await chat(essayPrompt(extraPrompt), imageDataUrl, { maxTokens: 1600 });
  const item = parseJson(reply);
  const full = typeof item.fullScore === 'number' ? item.fullScore
    : (typeof item.full_score === 'number' ? item.full_score : undefined);
  let score = item.score;
  if (typeof score === 'string') {
    const m = score.match(/(\d+(?:\.\d+)?)/);
    score = m ? parseFloat(m[1]) : null;
  }
  if (typeof score !== 'number') score = null;
  const rawCorr = Array.isArray(item.corrections) ? item.corrections : [];
  const corrections = rawCorr.map(c => {
    if (typeof c === 'string') return { from: '', to: c, reason: '' };
    return {
      from: String(c.from || ''),
      to: String(c.to || ''),
      reason: String(c.reason || ''),
    };
  }).filter(c => c.to || c.from).slice(0, 8);

  return {
    type: item.type || 'other',
    score,
    fullScore: full ?? (score != null ? 50 : undefined),
    dims: item.dims && typeof item.dims === 'object' ? item.dims : {},
    comment: item.comment || '',
    corrections,
  };
}

function precisePrompt(no, { standardAnswer = '', extraPrompt = '', pageText = '' } = {}) {
  const std = standardAnswer.trim()
    ? `\n【标准答案（权威答案，优先以此为准）】\n${standardAnswer.trim()}`
    : '\n【没有提供标准答案】请先独立解出每个空的标准答案，再逐空比对。';
  const extra = extraPrompt.trim() ? `\n【老师额外要求】\n${extraPrompt.trim()}` : '';
  const ctx = pageText.trim()
    ? `\n【整页 OCR 参考文本（仅作上下文，可能有识别错误，以图片为准）】\n${pageText.trim().slice(0, 6000)}`
    : '';

  return `这是试卷第 ${no} 题的作答区域。请按“逐空精确批改”方式批改：把这道题里每一个需要填写的空（横线、括号、表格单元格、选择框）单独识别、单独判定。${std}${extra}${ctx}

规则：
1. 不要预设学科；先读题干判断题型。不要回答“非数学/无法批改”之类的话。
2. 一道题可能有多个空（常见 2-30 个）。每个空都要单独输出一条，包括已经答对的空，不能漏。
3. 每个空给出学生实际写的内容；空白则 student 为 ""，verdict 为 "blank"。
4. 判定按该空的标准答案：correct / partial / wrong / blank / uncertain。等价表达、单位省略、同义术语都算对。
5. 每个空给出 box：该空（横线或括号）在【本图】中的矩形，归一化 0-1000 的 [x1,y1,x2,y2]，必须贴合空位本身，不要给整题框。
6. comment 仅错因，15 字内；做对留空。
7. 选择题若整题只有一个作答痕迹，也要按一个空处理。

只返回 JSON，不要解释：
{"no":${no},"blanks":[{"i":1,"student":"学生答案","correct":"标准答案","verdict":"correct|partial|wrong|blank|uncertain","box":[x1,y1,x2,y2],"comment":"错因"}],"comment":"整题总评"}`;
}

function sanitizeBox(box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const [x1, y1, x2, y2] = box.map(v => Number(v));
  if (![x1, y1, x2, y2].every(v => Number.isFinite(v) && v >= 0 && v <= 1000)) return null;
  const nx1 = Math.min(x1, x2), ny1 = Math.min(y1, y2);
  const nx2 = Math.max(x1, x2), ny2 = Math.max(y1, y2);
  if (nx2 - nx1 < 8 || ny2 - ny1 < 5) return null;
  return [nx1, ny1, nx2, ny2];
}

async function gradePrecise({ no, imageDataUrl, standardAnswer = '', extraPrompt = '', pageText = '' }) {
  const reply = await chat(
    precisePrompt(no, { standardAnswer, extraPrompt, pageText }),
    imageDataUrl,
    { maxTokens: 2200, retries: 4 }
  );
  const item = parseJson(reply);
  const raw = Array.isArray(item.blanks) ? item.blanks : [];
  const blanks = raw.map((b, idx) => {
    let verdict = b.verdict || 'uncertain';
    if (verdict === 'half' || verdict === 'half_correct' || verdict === '半对') verdict = 'partial';
    if (verdict === 'blank' && String(b.student || '').trim()) verdict = 'uncertain';
    return {
      i: Number(b.i) || idx + 1,
      student: String(b.student || ''),
      correct: String(b.correct || ''),
      comment: String(b.comment || ''),
      verdict,
      box: sanitizeBox(b.box),
    };
  }).filter(b => b.box);

  const verdicts = blanks.map(b => b.verdict);
  let verdict = 'uncertain';
  if (blanks.length) {
    if (verdicts.every(v => v === 'correct')) verdict = 'correct';
    else if (verdicts.some(v => v === 'wrong')) verdict = 'wrong';
    else if (verdicts.some(v => v === 'partial')) verdict = 'partial';
    else if (verdicts.every(v => v === 'blank')) verdict = 'blank';
  }
  return {
    no,
    verdict,
    student: blanks.map(b => `${b.i}.${b.student || '（空）'}`).join('  '),
    correct: blanks.map(b => `${b.i}.${b.correct || '-'}`).join('  '),
    comment: item.comment || '',
    blanks,
    confidence: 1,
  };
}

function wholePagePrompt({ standardAnswer = '', extraPrompt = '' } = {}) {
  const std = standardAnswer.trim()
    ? `\n【标准答案（权威答案，优先以此为准）】\n${standardAnswer.trim()}`
    : '\n【没有提供标准答案】请先独立解出每个空的标准答案，再逐空比对。';
  const extra = extraPrompt.trim() ? `\n【老师额外要求】\n${extraPrompt.trim()}` : '';

  return `这是一整页试卷的扫描图。不要切题，直接在这一页里找出所有“需要作答的空”（横线、括号、表格单元格、选择框、解答题的作答区），逐个判定。${std}${extra}

规则：
1. 不要预设学科；先读题干判断题型。不要回答“非数学/无法批改”“并非语文学科”之类的话。
2. 按从上到下、从左到右的顺序，为每个空单独输出一条，包括已经答对的空，不能漏。数量可能很多（几十个）。
3. 每个空给出学生实际写的内容；空白则 student 为 ""，verdict 为 "blank"。
4. 判定按该空的标准答案：correct / partial / wrong / blank / uncertain。等价表达、单位省略、同义术语都算对。
5. 每个空给出 box：该空在【整页图】中的矩形，归一化 0-1000 的 [x1,y1,x2,y2]，必须贴合空位本身，不要给整题框或整页框。
6. comment 仅错因，15 字内；做对留空。
7. 选择题若只有一个作答痕迹，按一个空处理。

只返回 JSON，不要解释：
{"blanks":[{"i":1,"student":"学生答案","correct":"标准答案","verdict":"correct|partial|wrong|blank|uncertain","box":[x1,y1,x2,y2],"comment":"错因"}],"comment":"整页总评"}`;
}

function normalizeBlanks(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((b, idx) => {
    let verdict = b.verdict || 'uncertain';
    if (verdict === 'half' || verdict === 'half_correct' || verdict === '半对') verdict = 'partial';
    if (verdict === 'blank' && String(b.student || '').trim()) verdict = 'uncertain';
    return {
      i: Number(b.i) || idx + 1,
      student: String(b.student || ''),
      correct: String(b.correct || ''),
      comment: String(b.comment || ''),
      verdict,
      box: sanitizeBox(b.box),
    };
  }).filter(b => b.box);
}

async function gradeWholePage({ imageDataUrl, standardAnswer = '', extraPrompt = '' }) {
  const base = wholePagePrompt({ standardAnswer, extraPrompt });
  let lastErr = null;
  let best = { blanks: [], comment: '' };

  for (let attempt = 0; attempt < 3; attempt++) {
    // 上一次被截断/格式出错时，加严输出要求重新批改
    const prompt = attempt === 0
      ? base
      : `${base}

【上一次输出不合法（JSON 被截断或格式错误），请重新完整批改本页】
- 必须输出一个语法完全合法的 JSON，最后一个字符必须是 }。
- 不要输出任何解释、markdown 或代码块。
- 每条只保留必要字段；comment 不超过 10 字；做对的空 comment 留空。
- 如果空太多写不完，优先保证每个空都有 i、verdict、box，其次才是文字。`;

    let reply;
    try {
      reply = await chat(prompt, imageDataUrl, { maxTokens: 4000 + attempt * 2000, retries: 2 });
    } catch (e) {
      lastErr = e;
      continue;
    }

    const item = parseJsonLoose(reply);
    if (!item) { lastErr = new Error('整页批改返回的 JSON 无法解析'); continue; }
    const blanks = normalizeBlanks(item.blanks);
    if (blanks.length > best.blanks.length) {
      best = { blanks, comment: String(item.comment || '') };
    }
    if (blanks.length) return { blanks, comment: String(item.comment || '') };
    lastErr = new Error('整页批改没有返回可用空位');
  }
  // 都失败时，退回截断修复能保住的那部分；一点都没有才报错
  if (best.blanks.length) return best;
  throw lastErr || new Error('整页批改失败');
}

module.exports = { gradeBlock, gradeEssay, gradePrecise, gradeWholePage, chat, configure };
