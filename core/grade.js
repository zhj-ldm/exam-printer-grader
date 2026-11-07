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

async function chatMessages(messages, { maxTokens = 900, retries = 6 } = {}) {
  let tokens = maxTokens;
  const body = {
    model: runtime.model,
    temperature: 0,
    max_tokens: tokens,
    messages,
  };
  // DeepSeek 这类带思考的模型会把输出额度花在 reasoning_content 上，正文变成空串；
  // 直接关掉思考（其它厂商不认这个字段，所以只在 DeepSeek 上加）
  if (/deepseek/i.test(runtime.url + ' ' + runtime.model)) {
    body.thinking = { type: 'disabled' };
  }

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
      const msg = data.choices[0].message;
      const content = String(msg.content || '').trim();
      if (!content) {
        // 正文为空：多半是思考把额度吃光（或被截断），加大额度再试
        if (attempt < retries - 1) {
          tokens = Math.min(6000, Math.round(tokens * 1.6));
          body.max_tokens = tokens;
          await sleep(1200);
          continue;
        }
        throw new Error('模型返回空内容（可能思考过长占满输出），请换模型或降低思考');
      }
      return content;
    } catch (err) {
      if (attempt >= retries - 1) throw err;
      await sleep(8000 * (attempt + 1));
    } finally {
      releaseSlot(slot.index);
    }
  }
}

async function chat(prompt, imageDataUrl, opts = {}) {
  const content = [{ type: 'text', text: prompt }];
  if (imageDataUrl) {
    content.push({ type: 'image_url', image_url: { url: imageDataUrl } });
  }
  return chatMessages([{ role: 'user', content }], opts);
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

// 作文模式专用：不判断内容类型、不框题、不找空、不逐题判，只评这一篇作文
function essayOnlyPrompt(extraPrompt = '', pageCount = 1) {
  const extra = extraPrompt.trim() ? `\n【老师额外要求】\n${extraPrompt.trim()}` : '';
  const multi = pageCount > 1
    ? `本次共 ${pageCount} 页，是同一篇学生作文的全部页面，按上传顺序连起来读（前一页末尾接后一页开头，不要重复计分、不要拆成多篇）。`
    : '本次是 1 页完整的作文。';
  return `你现在只做一件事：以阅卷老师身份评阅学生作文。${extra}

【任务边界，必须严格遵守】
- 这是作文评阅，不是试卷判题。${multi}
- 只通读整篇作文，从立意、结构、语言、书写四方面整体打分并写评语。
- 不要框题、不要找作答空、不要逐小题判对错、不要输出 blanks、不要打勾或打叉。
- 不要输出“待核/无法批改/非数学/看不清”等拒评内容；这是你的本职任务，必须给出分数和评语。
- 不要与普通试卷批改混在一起：本任务唯一输出 type 为 essay。

【评分要求（必须执行）】
1. 满分以卷面标注为准（如“满分50分”“40分”）；卷面没写就按 50 分。
2. 必须给出数字总分 score，并给出 fullScore。
3. 必须按四个维度给出小分 dims：内容（立意明确、材料切题、中心突出）、结构（层次清楚、首尾呼应、详略得当）、语言（用词准确、句子通顺、有修辞亮点）、书写（字迹工整、卷面整洁）。
4. 分数要落在常见区间，不要一律满分；书写差不等于内容差，分别评价。
5. 必须给出总评评语 comment（80-150 字）：先肯定 1-2 个真实优点，再具体指出 1-2 处可改进的地方（点明段落或句子），最后给一句可操作的提升建议。
6. 必须逐处挑出可修改的地方，输出 corrections 数组（3-8 条）：中文作文挑用词不当、搭配不当、病句、句式单调；英语作文挑语法错误、时态/单复数/冠词、拼写、用词与搭配。每条 from（原文片段）、to（改写后）、reason（10 字内原因）。英语作文的 from/to 保留英文原文。

只返回 JSON，不要解释，不要附加任何说明文字：
{"type":"essay","score":45,"fullScore":50,"dims":{"内容":18,"结构":12,"语言":12,"书写":3},"comment":"……","corrections":[{"from":"原文","to":"建议","reason":"用词"}]}`;
}

function scoreValue(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const m = v.match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  }
  return null;
}

async function gradeEssay({ imageDataUrl, imageDataUrls, extraPrompt = '', strictEssay = false }) {
  const urls = Array.isArray(imageDataUrls) && imageDataUrls.length
    ? imageDataUrls.filter(Boolean)
    : (imageDataUrl ? [imageDataUrl] : []);
  if (!urls.length) throw new Error('作文评阅没有可用图片');

  const base = strictEssay ? essayOnlyPrompt(extraPrompt, urls.length) : essayPrompt(extraPrompt);
  const maxTokens = 1600 + (urls.length - 1) * 600;
  const attempts = strictEssay ? 3 : 1;
  let item = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const prompt = attempt === 0
      ? base
      : base + `\n\n【重试 ${attempt + 1}】上一次没有返回合格结果。必须：type 为 essay，给出数字 score 和 fullScore，comment 不得为空，corrections 至少 3 条，只返回合法 JSON，不要任何解释文字。`;
    const content = [{ type: 'text', text: prompt }];
    for (const u of urls) content.push({ type: 'image_url', image_url: { url: u } });
    const reply = await chatMessages([{ role: 'user', content }], { maxTokens, retries: 6 });

    let parsed;
    try { parsed = parseJson(reply); } catch (e) {
      if (attempt >= attempts - 1) throw e;
      continue;
    }
    if (strictEssay && scoreValue(parsed.score) == null) continue; // 作文模式必须有分数
    if (strictEssay && !String(parsed.comment || '').trim()) continue;
    item = parsed;
    break;
  }
  if (!item) throw new Error('作文评阅未返回合格的分数和评语，请重试或检查模型配置');

  const full = typeof item.fullScore === 'number' ? item.fullScore
    : (typeof item.full_score === 'number' ? item.full_score : undefined);
  let score = scoreValue(item.score);
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
    type: strictEssay ? 'essay' : (item.type || 'other'),
    score,
    fullScore: full ?? (score != null ? 50 : undefined),
    dims: item.dims && typeof item.dims === 'object' ? item.dims : {},
    comment: item.comment || '',
    corrections,
    pages: urls.length,
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

function questionPrompt() {
  return `这是一整页试卷的扫描图。请像搜题软件一样，先在页面上把每一道题各自框出来，不要按分栏或行切，按题目本身的完整区域切。

规则：
1. 一个框 = 一道题，包含题号、题干、选项/材料、以及这道题的作答区。
2. 按从上到下、从左到右读卷顺序编号；同一横行并排的两道题要分别给框，不能合并。
3. 框之间不要互相包含或大面积重叠；不要输出整页框。
4. 题号读不出来时按顺序自行编号。
5. 不要预设学科，不要拒绝。

只返回 JSON，不要解释：
{"questions":[{"no":1,"box":[x1,y1,x2,y2]}]}
box 为该题在【整页图】中的矩形，归一化 0-1000，必须是贴边紧一点的框。`;
}

async function locateQuestions({ imageDataUrl }) {
  const reply = await chat(questionPrompt(), imageDataUrl, { maxTokens: 2000, retries: 3 });
  const item = parseJson(reply);
  const raw = Array.isArray(item.questions) ? item.questions : [];
  const out = [];
  raw.forEach((q, idx) => {
    const box = sanitizeBox(q.box);
    if (!box) return;
    const [x1, y1, x2, y2] = box;
    // 太小的框多半是把题号或一行字当成了整题，丢掉
    if ((x2 - x1) * (y2 - y1) < 8 * 8) return;
    out.push({ no: Number(q.no) || idx + 1, box });
  });
  return out.sort((a, b) => (a.box[1] - b.box[1]) || (a.box[0] - b.box[0]));
}

function reviewPrompt(page, marks, results) {
  const w = page.width, h = page.height;
  const list = marks.map((m, i) => ({
    i,
    verdict: m.verdict || '',
    x: Math.round(m.x / w * 1000),
    y: Math.round(m.y / h * 1000),
    text: m.text || '',
  }));
  const rs = results.map(r => ({ no: r.no, verdict: r.verdict }));
  return `这是一整页试卷的批改后图片，图上的红色对勾、叉和批注是批改软件画的。请复核这一页，不要重画，只指出需要调整的地方。

【现有标记】（整页归一化坐标 0-1000，原点左上）
${JSON.stringify(list)}
【已批改结果】${JSON.stringify(rs)}

请检查：
1. 有没有该批但图上没有标记的题或空（漏批）；
2. 现有对勾/叉/批注的位置是否压在题干、答案或选项上，是否超出纸面、明显错位；
3. 有没有重复标记、位置明显不对的标记，或批注文字明显不合适。

只返回 JSON，不要解释：
{"missing":[{"no":1,"student":"学生答案","correct":"正确答案","verdict":"correct|wrong|partial|blank","box":[x1,y1,x2,y2],"text":"要写的批注"}],
 "move":[{"i":0,"x":100,"y":200}],
 "remove":[0],
 "text":[{"i":0,"text":"应: ..."}]}

规则：
- box 是该空或该题作答位置在整页中的矩形，归一化 0-1000。
- 不要重复列出原来已经正确、位置也合适的标记；它们省略即可。
- 只有确实漏批、明显错位、重复或文字明显不合适时才返回对应项，没有就给空数组。
- 不要因为看不清就删标记；看不清可以给 move 或保持不动。
- 除明显误判外不要改动对错结论。`;
}

async function reviewPage({ imageDataUrl, page, marks, results }) {
  const reply = await chat(reviewPrompt(page, marks, results), imageDataUrl, { maxTokens: 2400, retries: 3 });
  const item = parseJson(reply);
  const out = { missing: [], move: [], remove: [], text: [] };
  if (Array.isArray(item.missing)) {
    item.missing.forEach(m => {
      const box = sanitizeBox(m.box);
      if (!box) return;
      out.missing.push({
        no: m.no,
        student: String(m.student || ''),
        correct: String(m.correct || ''),
        verdict: ['correct', 'wrong', 'partial', 'blank', 'uncertain'].includes(m.verdict) ? m.verdict : 'uncertain',
        box,
        text: String(m.text || ''),
      });
    });
  }
  if (Array.isArray(item.move)) {
    item.move.forEach(m => {
      const i = Number(m.i), x = Number(m.x), y = Number(m.y);
      if (!Number.isFinite(i) || !Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x < 0 || x > 1000 || y < 0 || y > 1000) return;
      out.move.push({ i, x, y });
    });
  }
  if (Array.isArray(item.remove)) item.remove.forEach(i => { if (Number.isFinite(Number(i))) out.remove.push(Number(i)); });
  if (Array.isArray(item.text)) {
    item.text.forEach(t => {
      const i = Number(t.i);
      if (Number.isFinite(i) && typeof t.text === 'string') out.text.push({ i, text: t.text.slice(0, 120) });
    });
  }
  return out;
}

function deepPrompt(page, candidates, { standardAnswer = '', extraPrompt = '' } = {}) {
  const std = standardAnswer.trim()
    ? `\n【标准答案（权威答案，以它为准）】\n${standardAnswer.trim()}`
    : '';
  const extra = extraPrompt.trim() ? `\n【老师额外要求】\n${extraPrompt.trim()}` : '';
  const list = candidates.map(c => ({
    id: c.id,
    label: c.label,
    text: c.text,
    x: Math.round(c.x / page.width * 1000),
    y: Math.round(c.y / page.height * 1000),
  }));
  return `这是整页试卷。本地 OCR 已经在图上抓出下面这些可批改位置（大题题号或小题标号），坐标为整页 0-1000：
${JSON.stringify(list)}
${std}${extra}

请只做判断，不要重新找位置：逐条看这些位置对应的题目/小题，判断学生作答是对、错、半对还是空白。
- 对：correct；错：wrong；部分正确：partial；没作答或空白：blank。
- 不要预设学科，不要拒评；看不清也按你看到的内容判。
- 必须为每个 id 返回一条结果。
- comment 只写最关键的错因，不超过 12 个字；判对时 comment 留空。

返回 JSON：
{"items":[{"id":"11","verdict":"correct","correct":"","comment":""}],
 "extra":[{"box":[x1,y1,x2,y2],"verdict":"wrong","correct":"","comment":""}]}
extra 仅当你发现还有明显漏批的作答位置时使用，没把握就不要给。`;
}

function normalizeDeepResult(item, candidates) {
  const items = [];
  const byId = new Map();
  if (Array.isArray(item.items)) {
    for (const it of item.items) {
      if (!it || it.id == null) continue;
      const verdict = ['correct', 'wrong', 'partial', 'blank', 'uncertain'].includes(it.verdict) ? it.verdict : 'uncertain';
      const one = {
        id: String(it.id),
        verdict,
        correct: String(it.correct || ''),
        comment: String(it.comment || ''),
      };
      byId.set(one.id, one);
      items.push(one);
    }
  }
  // 每个候选都必须有结论，模型漏掉的按未作答处理
  for (const c of candidates) {
    if (!byId.has(String(c.id))) items.push({ id: String(c.id), verdict: 'blank', correct: '', comment: '' });
  }
  const extra = [];
  if (Array.isArray(item.extra)) {
    for (const e of item.extra) {
      const box = sanitizeBox(e && e.box);
      if (!box) continue;
      extra.push({
        box,
        verdict: ['correct', 'wrong', 'partial', 'blank', 'uncertain'].includes(e.verdict) ? e.verdict : 'uncertain',
        correct: String(e.correct || ''),
        comment: String(e.comment || ''),
      });
    }
  }
  return { items, extra };
}

async function gradeDeepCandidates({ imageDataUrl, page, candidates, standardAnswer, extraPrompt }) {
  const reply = await chat(deepPrompt(page, candidates, { standardAnswer, extraPrompt }), imageDataUrl, { maxTokens: 3200, retries: 3 });
  return normalizeDeepResult(parseJson(reply), candidates);
}

// 深度抓取：云端像 Agent 一样主动调用本地 OCR，多轮核对后再给出判定
async function gradeDeepAgent({ imageDataUrl, page, candidates, standardAnswer = '', extraPrompt = '', ocrRegion, rounds = 3 }) {
  const std = standardAnswer.trim()
    ? `\n【标准答案（权威答案，以它为准）】\n${standardAnswer.trim()}`
    : '';
  const extra = extraPrompt.trim() ? `\n【老师额外要求】\n${extraPrompt.trim()}` : '';
  const list = candidates.map(c => ({
    id: c.id,
    label: c.label,
    text: c.text,
    x: Math.round(c.x / page.width * 1000),
    y: Math.round(c.y / page.height * 1000),
  }));

  const prompt = `这是整页试卷。本地 OCR 已经抓出下面这些大题题号/小题标号（坐标为整页 0-1000）：
${JSON.stringify(list)}
${std}${extra}

你可以像 Agent 一样主动调用本地 OCR：如果某道题/某个小题看不清、需要放大复核、需要抓具体文字，就先返回一条 OCR 请求，不要急着下结论。
请求格式（可一次请求最多 4 个区域）：
{"action":"ocr","boxes":[[x1,y1,x2,y2],[...]],"reason":"为什么要看这些区域"}
你会收到这些区域的 OCR 文字和坐标，再继续判断。最多 ${rounds} 轮。
信息足够后返回最终结果：
{"action":"final","items":[{"id":"11","verdict":"correct","correct":"","comment":""}],
 "extra":[{"box":[x1,y1,x2,y2],"verdict":"wrong","correct":"","comment":""}]}
- 必须为每个 id 给出结论：correct / wrong / partial / blank。
- 不要预设学科，不要拒评。
- comment 只写最关键错因，不超过 12 个字；判对时留空。`;

  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      ...(imageDataUrl ? [{ type: 'image_url', image_url: { url: imageDataUrl } }] : []),
    ],
  }];

  for (let round = 1; round <= rounds; round++) {
    const reply = await chatMessages(messages, { maxTokens: 3200, retries: 3 });
    let parsed;
    try {
      parsed = parseJson(reply);
    } catch (e) {
      // 模型回了一段无法解析的话，直接结束，交给上层回退
      return null;
    }

    if (parsed.action === 'ocr' && Array.isArray(parsed.boxes) && parsed.boxes.length) {
      const boxes = parsed.boxes.slice(0, 4).map(b => sanitizeBox(b)).filter(Boolean);
      if (!boxes.length) return null;
      const got = await ocrRegion(boxes);
      messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: '本地 OCR 返回如下（坐标为整页像素）：\n' + JSON.stringify(got) + '\n请继续：还需要复核就再返回 action=ocr，否则返回 action=final 和完整结果。' }],
      });
      continue;
    }

    return normalizeDeepResult(parsed, candidates);
  }
  return null;
}

// 深度抓取（通用）：云端 Agent 可按需调用本地 OCR，先整体把握试卷，再供后续批改参考
async function deepScanPage({ imageDataUrl, page, lines = [], ocrRegion, rounds = 3 }) {
  const summary = lines.slice(0, 90).map(l => ({
    text: String(l.text || '').slice(0, 60),
    x: Math.round((l.x0 ?? 0) / page.width * 1000),
    y: Math.round(((l.y0 ?? 0) + (l.y1 ?? 0)) / 2 / page.height * 1000),
  }));

  const prompt = `这是整页试卷。本地 OCR 先给出下面的文字行和坐标（0-1000），供你参考：
${JSON.stringify(summary)}

你可以像 Agent 一样主动调用本地 OCR：如果某处看不清、需要放大、需要核对题号或作答区，就先返回 OCR 请求。
请求格式（最多 4 个区域）：
{"action":"ocr","boxes":[[x1,y1,x2,y2],[...]],"reason":"为什么要看"}
你会收到这些区域的 OCR 文字与像素坐标，最多 ${rounds} 轮。
之后请返回对整张试卷的结构化把握，供后续逐题批改使用：
{"action":"final","notes":"用 5-10 句话说明：整页有哪些大题/小题、题号位置、每题的作答区在哪里、容易漏判或看错的地方、建议的打勾落点"}
不要预设学科，不要拒评。`;

  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      ...(imageDataUrl ? [{ type: 'image_url', image_url: { url: imageDataUrl } }] : []),
    ],
  }];

  for (let round = 1; round <= rounds; round++) {
    const reply = await chatMessages(messages, { maxTokens: 1600, retries: 3 });
    let parsed;
    try {
      parsed = parseJson(reply);
    } catch (e) {
      return null;
    }
    if (parsed.action === 'ocr' && Array.isArray(parsed.boxes) && parsed.boxes.length) {
      const boxes = parsed.boxes.slice(0, 4).map(b => sanitizeBox(b)).filter(Boolean);
      if (!boxes.length) return null;
      const got = await ocrRegion(boxes);
      messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: '本地 OCR 返回如下（整页像素坐标）：\n' + JSON.stringify(got) + '\n请继续：还要复核就再 action=ocr，否则 action=final 并给出 notes。' }],
      });
      continue;
    }
    return String(parsed.notes || parsed.text || '').trim() || null;
  }
  return null;
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

async function gradeWholePages({ imageDataUrls, standardAnswer = '', extraPrompt = '' }) {
  const n = imageDataUrls.length;
  const std = standardAnswer.trim()
    ? `\n【标准答案（权威答案，优先以此为准）】\n${standardAnswer.trim()}`
    : '\n【没有提供标准答案】请先独立解出每个空的标准答案，再逐空比对。';
  const extra = extraPrompt.trim() ? `\n【老师额外要求】\n${extraPrompt.trim()}` : '';
  const base = `这里共有 ${n} 页试卷扫描图，按图片顺序为第 1 页到第 ${n} 页。请不要切题，在所有页里找出所有“需要作答的空”（横线、括号、表格单元格、选择框、解答题作答区），逐个判定。阅读、作文、材料题或解答题可能跨页，必须把几页连起来一起读再判，不能按页割裂。${std}${extra}

规则：
1. 不要预设学科；先读题干判断题型。不要回答“非数学/无法批改”“并非语文学科”之类的话。
2. 每个空单独一条，包含已经答对的空，不能漏。每条必须带 page：这个空在第几页（1 到 ${n}）。
3. box 是该空在【对应那一页】里的矩形，归一化 0-1000 的 [x1,y1,x2,y2]，贴合空位本身。
4. 空白空 student 为 ""、verdict 为 "blank"；判定用 correct / partial / wrong / blank / uncertain。
5. 等价表达、单位省略、同义术语都算对；comment 只写错因，15 字内，做对留空。
6. 跨页题在判断时参考前后页内容，但每个空的坐标只写它实际所在的那一页。

只返回 JSON，不要解释：
{"blanks":[{"page":1,"i":1,"student":"学生答案","correct":"标准答案","verdict":"correct|partial|wrong|blank|uncertain","box":[x1,y1,x2,y2],"comment":"错因"}],"comment":"总评"}`;

  let lastErr = null;
  let best = { blanks: [], comment: '' };
  for (let attempt = 0; attempt < 3; attempt++) {
    const prompt = attempt === 0
      ? base
      : `${base}

【上一次输出不合法（JSON 被截断或格式错误），请重新完整批改全部页面】
- 必须输出语法完全合法的 JSON，最后一个字符必须是 }。
- 不要输出解释、markdown 或代码块。
- 空太多写不完时，优先保证每个空都有 page、i、verdict、box。`;

    const content = [{ type: 'text', text: prompt }];
    for (const url of imageDataUrls) {
      content.push({ type: 'image_url', image_url: { url } });
    }
    let reply;
    try {
      reply = await chatMessages([{ role: 'user', content }], { maxTokens: 6000 + attempt * 2000, retries: 2 });
    } catch (e) {
      lastErr = e;
      continue;
    }
    const item = parseJsonLoose(reply);
    if (!item) { lastErr = new Error('多页批改返回的 JSON 无法解析'); continue; }

    const raw = Array.isArray(item.blanks) ? item.blanks : [];
    const blanks = [];
    for (const b of raw) {
      const box = sanitizeBox(b.box);
      if (!box) continue;
      let page = Math.round(Number(b.page) || 1);
      if (page < 1 || page > n) page = 1;
      let verdict = b.verdict || 'uncertain';
      if (verdict === 'half' || verdict === 'half_correct' || verdict === '半对') verdict = 'partial';
      if (verdict === 'blank' && String(b.student || '').trim()) verdict = 'uncertain';
      blanks.push({
        page,
        i: Number(b.i) || blanks.length + 1,
        student: String(b.student || ''),
        correct: String(b.correct || ''),
        comment: String(b.comment || ''),
        verdict,
        box,
      });
    }
    if (blanks.length > best.blanks.length) best = { blanks, comment: String(item.comment || '') };
    if (blanks.length) return { blanks, comment: String(item.comment || '') };
    lastErr = new Error('多页批改没有返回可用空位');
  }
  if (best.blanks.length) return best;
  throw lastErr || new Error('多页整页批改失败');
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

module.exports = { gradeBlock, gradeEssay, gradePrecise, gradeWholePage, gradeWholePages, locateQuestions, gradeDeepCandidates, gradeDeepAgent, deepScanPage, reviewPage, chat, chatMessages, configure };
