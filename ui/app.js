const $ = id => document.getElementById(id);
const API = window.api;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const S = {
  mode: 'auto',
  imagePath: null,
  scanMode: 'single',
  collectPages: [],
  manualPages: [],
  manualIndex: 0,
  collecting: false,
  resultPaths: [],
  pageResults: [],
  batchErrors: [],
  resultIndex: 0,
  printedPages: new Set(),
  scanMode: 'single',
  impose: 'off',
  page: null,
  blocks: [],
  results: [],
  marks: [],
  resultPath: null,
  busy: false,
  resultMode: false,
  printed: false,
  autoPrinted: false,
  history: [],
  histIndex: -1,
  loaded: false,
};

const STAGE_TEXT = {
  discover: '搜索设备', scan: '扫描中', split: '识别题号',
  grade: '批改中', render: '生成图像', print: '打印中', done: '完成',
};
const IDLE_LABEL = '点击球体开始';
const IDLE_SUB = '扫描 → 识别题号 → 批改 → 出图';

/* ---------------- 基础 ---------------- */
function setOrb(stage, label, sub) {
  $('orb').dataset.stage = stage || 'idle';
  $('orbText').textContent = stage ? (STAGE_TEXT[stage] || stage) : '待机';
  if (label !== undefined) $('stageLabel').textContent = label;
  $('stageSub').textContent = sub || '';
}

function isOn(id) { const o = $(id); return !!(o && o.closest('.opt') && o.closest('.opt').classList.contains('on')); }

function busy(v) {
  S.busy = v;
  $('orb').style.pointerEvents = v ? 'none' : '';
  $('tray').style.opacity = v ? '.45' : '';
  $('tray').style.pointerEvents = v ? 'none' : '';
  $('mScan').disabled = v;
  $('mPick').disabled = v;
  $('mSplit').disabled = v || !S.imagePath;
  $('mRender').disabled = v || !S.marks.length;
  $('mSplitView').disabled = v || !S.blocks.length;
  $('mPageView').disabled = v || !S.imagePath;
  $('mShowOrig').disabled = v || !S.imagePath;
  $('mPrint').disabled = v || !S.resultPath;
}

/* 扫描图 / 批改图半透明叠在球的背面 */
function showBg(path) {
  const img = $('preview');
  img.src = 'file://' + path + '?t=' + Date.now();
  $('bgLayer').classList.add('on');
}
function clearBg() {
  const img = $('preview');
  img.removeAttribute('src');
  $('bgLayer').classList.remove('on');
}
function setImage(path) {
  S.imagePath = path;
  S.blocks = []; S.results = []; S.marks = []; S.resultPath = null;
  showBg(path);
  busy(false);
}

/* ---------------- 液态圆点开关 ---------------- */
$('tray').addEventListener('click', e => {
  const b = e.target.closest('.mini-orb');
  if (!b || S.busy) return;
  b.closest('.opt').classList.toggle('on');
  if (b.id === 'optAutoPrint') API.setConfig({ autoPrint: isOn('optAutoPrint') });
});

/* ---------------- 历史 ---------------- */
function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function paintHistory() {
  const list = $('histList');
  list.innerHTML = '';
  if (!S.history.length) {
    list.innerHTML = S.loaded
      ? '<div class="hist-empty">还没有保存的批改结果</div>'
      : '<div class="hist-empty">启动时不自动载入<br />点「载入」回看已保存的结果</div>';
    $('btnPrev').disabled = true;
    $('btnNext').disabled = true;
    return;
  }
  S.history.forEach((h, i) => {
    const div = document.createElement('div');
    div.className = 'hist-item' + (i === S.histIndex ? ' on' : '');
    const label = h.kind === 'manual' ? '手动' : (h.mode === 'essay' ? '评阅' : '试卷');
    div.innerHTML = `<img src="file://${h.resultPath}" alt="" loading="lazy" />
      <button class="del" title="删除这条记录">×</button>
      <div class="cap"><b>${label} ${h.count || 0} 题</b><span>${fmtTime(h.createdAt)}</span></div>`;
    div.onclick = () => showHistory(i);
    div.querySelector('.del').onclick = async ev => {
      ev.stopPropagation();
      try { await API.historyDelete(h.id); } catch (_) {}
      S.history.splice(i, 1);
      if (S.histIndex >= S.history.length) S.histIndex = S.history.length - 1;
      if (!S.history.length) backToOrb();
      paintHistory();
    };
    list.appendChild(div);
  });
  $('btnPrev').disabled = S.histIndex >= S.history.length - 1;
  $('btnNext').disabled = S.histIndex <= 0;
}

async function loadHistory() {
  try { S.history = await API.historyList(); } catch (_) { S.history = []; }
  S.loaded = true;
  S.histIndex = -1;
  paintHistory();
}
$('btnLoadHistory').onclick = loadHistory;

function showHistory(i) {
  const h = S.history[i];
  if (!h) return;
  S.histIndex = i;
  S.resultPath = h.resultPath;
  S.resultPaths = [h.resultPath];
  S.pageResults = [];
  S.resultIndex = 0;
  S.batchErrors = [];
  S.printed = false;
  S.printedPages.clear();
  document.body.classList.remove('result', 'collecting');
  document.body.classList.add('view');
  $('resultImg').src = 'file://' + h.resultPath + '?t=' + Date.now();
  paintHistory();
}

$('btnPrev').onclick = () => { if (S.histIndex >= 0) showHistory(Math.min(S.history.length - 1, S.histIndex + 1)); };
$('btnNext').onclick = () => { if (S.histIndex > 0) showHistory(S.histIndex - 1); };

/* ---------------- 成品页（支持多页翻看） ---------------- */
function refreshPrintState() {
  const done = S.printedPages.has(S.resultPath);
  const po = $('printOrb');
  po.hidden = !!S.autoPrinted;
  po.disabled = done;
  po.querySelector('.result-orb-text').textContent = done ? '已打印' : '打印';

  const pa = $('printAllOrb');
  const multi = S.resultPaths.length > 1;
  const allDone = multi && S.resultPaths.every(p => S.printedPages.has(p));
  pa.hidden = !multi || !!S.autoPrinted;
  pa.disabled = allDone;
  pa.querySelector('.result-orb-text').textContent = allDone ? '已打印' : '全部打印';
}

function renderResultPage() {
  const len = S.resultPaths.length;
  if (!len) return;
  const p = S.resultPaths[S.resultIndex];
  S.resultPath = p;
  $('resultImg').src = 'file://' + p + '?t=' + Date.now();
  const multi = len > 1;
  $('resultPageNo').hidden = !multi;
  $('resultPrev').hidden = !multi;
  $('resultNext').hidden = !multi;
  $('resultPageNo').textContent = `${S.resultIndex + 1} / ${len}`;
  $('resultPrev').disabled = S.resultIndex <= 0;
  $('resultNext').disabled = S.resultIndex >= len - 1;
  if (S.pageResults.length) {
    S.results = S.pageResults[S.resultIndex] || [];
    renderList(S.results);
  }
  if (S.batchErrors.length) {
    $('list').innerHTML += `<div class="item"><div class="no bad">!</div>
      <div><div>部分页失败</div><div class="sub">${esc(S.batchErrors.join('；'))}</div></div></div>`;
  }
  refreshPrintState();
}

function enterResult(paths, pageResults = [], batchErrors = [], startIndex = 0) {
  S.resultMode = true;
  S.collecting = false;
  S.resultPaths = Array.isArray(paths) ? paths.slice() : [paths];
  S.pageResults = pageResults;
  S.batchErrors = batchErrors;
  S.resultIndex = Math.max(0, Math.min(S.resultPaths.length - 1, startIndex));
  S.printed = false;
  S.printedPages.clear();
  document.body.classList.remove('view', 'collecting');
  document.body.classList.add('result');
  clearBg(); // 释放大图内存
  renderResultPage();
}

$('resultPrev').onclick = () => {
  if (S.resultIndex > 0) { S.resultIndex -= 1; renderResultPage(); }
};
$('resultNext').onclick = () => {
  if (S.resultIndex < S.resultPaths.length - 1) { S.resultIndex += 1; renderResultPage(); }
};

function backToOrb() {
  S.resultMode = false;
  document.body.classList.remove('result');
  document.body.classList.remove('view');
  const img = $('resultImg');
  img.removeAttribute('src');
  if (S.imagePath && !S.resultPath) showBg(S.imagePath);
}
$('btnBackOrb').onclick = backToOrb;
$('resultOrb').onclick = () => {
  resetAll(); // 清空，回到大球，准备下一张
};
$('printOrb').onclick = async () => {
  if (!S.resultPath || S.printedPages.has(S.resultPath)) return;
  const po = $('printOrb');
  const txt = po.querySelector('.result-orb-text');
  po.disabled = true;
  txt.textContent = '打印中';
  try {
    await API.print(S.resultPath);
    S.printed = true;
    S.printedPages.add(S.resultPath);
  } catch (_) {
    txt.textContent = '打印失败';
    setTimeout(refreshPrintState, 1800);
    return;
  }
  refreshPrintState();
};
// 拼图打印：多页时按长宽比最接近的排布拼到一张纸，最多 4 页
async function printMany(paths, onTick) {
  if (!paths.length) return { fail: false, done: 0 };
  let targets;
  if (S.impose === 'on' && paths.length > 1) {
    try {
      targets = await API.makeSheets(paths);
    } catch (_) {
      targets = paths.map((p, i) => ({ path: p, indexes: [i] }));
    }
  } else {
    targets = paths.map((p, i) => ({ path: p, indexes: [i] }));
  }
  let fail = false, done = 0;
  for (const t of targets) {
    try {
      await API.print(t.path);
      for (const i of t.indexes || []) S.printedPages.add(paths[i]);
      done += (t.indexes || []).length;
    } catch (_) { fail = true; }
    if (onTick) onTick(done);
  }
  return { fail, done };
}

$('printAllOrb').onclick = async () => {
  const pa = $('printAllOrb');
  const txt = pa.querySelector('.result-orb-text');
  pa.disabled = true;
  const todo = S.resultPaths.filter(p => !S.printedPages.has(p));
  const r = await printMany(todo, n => { txt.textContent = `打印 ${n} / ${todo.length}`; });
  if (r.fail) {
    txt.textContent = '部分失败';
    setTimeout(refreshPrintState, 1800);
  } else {
    refreshPrintState();
  }
};

function resetAll() {
  if (S.busy) return;
  backToOrb();
  S.imagePath = null; S.page = null; S.blocks = [];
  S.results = []; S.marks = []; S.resultPath = null; S.histIndex = -1;
  S.printed = false; S.autoPrinted = false;
  S.resultPaths = []; S.pageResults = []; S.resultIndex = 0; S.batchErrors = [];
  S.printedPages.clear();
  S.collectPages = []; S.collecting = false;
  S.manualPages = []; S.manualIndex = 0;
  if ($('mPages')) $('mPages').innerHTML = '';
  document.body.classList.remove('collecting');
  $('collectCount').textContent = '已扫描 1 页';
  $('printOrb').hidden = true;
  $('printAllOrb').hidden = true;
  clearBg();
  $('list').innerHTML = '';
  $('mChips').innerHTML = '<span class="sub">切题后出现题号</span>';
  $('mBlockInfo').textContent = '';
  $('mDetail').textContent = '';
  $('stdAnswer') && ($('stdAnswer').value = '');
  $('mStd').value = '';
  $('mExtra').value = '';
  paintHistory();
  setOrb(null, IDLE_LABEL, IDLE_SUB);
  busy(false);
}

/* ---------------- 选项 ---------------- */
// 主提示词就是全部控制项：判分标准、勾叉位置、评语长短都写在里面
function masterPrompt() {
  const el = $('masterPrompt');
  return el ? el.value.trim() : '';
}

function options() {
  return {
    mode: $('optType').value,
    extraPrompt: masterPrompt(),
    standardAnswer: standardAnswerText(),
    grid: gridOn(),
    gridCells: Number($('gridCells').value) || 10,
    render: {
      // 作文模式只评分评语，不打勾叉
      ticks: $('optType').value === 'essay' ? false : isOn('optTick'),
      comments: isOn('optComment'),
      answers: isOn('optAnswer'),
    },
  };
}

// 标准答案：本套作业的答案优先，其次通用答案
function standardAnswerText() {
  const s = activeSet();
  if (s && s.answer) return s.answer;
  return ($('answerBox') && $('answerBox').value) || '';
}

function optionsManual() {
  return {
    mode: $('optType').value,
    // 手动模式的标准答案框优先，留空则复用「当前作业」里保存的答案
    standardAnswer: ($('mStd') && $('mStd').value.trim()) || standardAnswerText(),
    extraPrompt: [$('mExtra').value, masterPrompt()].filter(Boolean).join('\n'),
    grid: gridOn(),
    gridCells: Number($('gridCells').value) || 10,
    render: {
      ticks: $('mTick').checked,
      comments: $('mText').checked,
      answers: $('mAnswer').checked,
    },
  };
}

// 作文模式不需要勾叉：选中时默认关掉「勾 / 叉」，切回试卷时恢复
function syncEssayMode() {
  const essay = $('optType').value === 'essay';
  const opt = $('optTick').closest('.opt');
  if (essay) {
    opt.dataset.prevOn = opt.classList.contains('on') ? '1' : '0';
    opt.classList.remove('on');
    opt.style.pointerEvents = 'none';
    opt.style.opacity = '.4';
  } else {
    if (opt.dataset.prevOn === '1') opt.classList.add('on');
    opt.style.pointerEvents = '';
    opt.style.opacity = '';
    delete opt.dataset.prevOn;
  }
}
$('optType').onchange = syncEssayMode;
syncEssayMode();

// 主提示词：改动即存（500ms 防抖）+ 「保存提示词」是明确落盘并回读校验
const DEFAULT_PROMPT = '以阅卷老师的身份批改这张卷子：做对的打勾，做错的打叉并写一句 15 字以内的错因；勾叉直接打在学生答案旁边（打在题上），贴近作答、不要压住字，不要统一排到页面右边。';
let savePromptTimer = 0;
const masterEl = $('masterPrompt');
const saveHint = $('saveHint');

function promptHint(text, ok = false) {
  if (!saveHint) return;
  saveHint.textContent = text;
  saveHint.classList.toggle('ok', !!ok);
}

async function savePromptNow() {
  if (!masterEl) return;
  const text = masterEl.value;
  const cfg = await API.setConfig({ masterPrompt: text });
  // 回读配置，确认真的写进去了（防止只改了输入框）
  const got = String(cfg.masterPrompt || '');
  const same = got === text;
  const t = new Date();
  promptHint(same ? `已保存 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} · ${text.length} 字` : '保存失败，请重试', same);
}

if (masterEl) {
  masterEl.value = DEFAULT_PROMPT;
  masterEl.addEventListener('input', () => {
    promptHint('未保存…');
    clearTimeout(savePromptTimer);
    savePromptTimer = setTimeout(savePromptNow, 500);
  });
}
$('btnSavePrompt').onclick = () => {
  clearTimeout(savePromptTimer);
  savePromptNow().catch(e => promptHint('保存失败：' + e.message));
};

/* ---------------- 模式预设 ---------------- */
let PRESETS = { exam: '', essay: '' };
API.promptDefaults().then(d => {
  PRESETS = d || PRESETS;
  // 还没保存过自定义提示词时，直接用「改卷模式预设」作为初始值
  if (masterEl && PRESETS.exam && masterEl.value.trim() === DEFAULT_PROMPT.trim()) {
    masterEl.value = PRESETS.exam;
  }
}).catch(() => {});
document.querySelectorAll('.preset-chip').forEach(btn => {
  btn.onclick = async () => {
    const key = btn.dataset.preset;
    if (!PRESETS[key]) return;
    // 预设与内容类型绑定：点作文预设就把模式切成作文，反之切回试卷
    const typeEl = $('optType');
    if (typeEl && typeEl.value !== key) {
      typeEl.value = key;
      syncEssayMode();
    }
    masterEl.value = PRESETS[key];
    clearTimeout(savePromptTimer);
    await savePromptNow().catch(() => {});
  };
});
// 切换内容类型时，仅当提示词仍是另一模式的默认文案才自动替换，用户自定义的保持不动
$('optType').addEventListener('change', async e => {
  const to = e.target.value;
  const cur = masterEl.value.trim();
  const other = to === 'essay' ? PRESETS.exam : PRESETS.essay;
  if (PRESETS[to] && (!cur || cur === other.trim())) {
    masterEl.value = PRESETS[to];
    clearTimeout(savePromptTimer);
    await savePromptNow().catch(() => {});
  }
});

/* ---------------- 网格开关 / 密度 ---------------- */
const gridSwitch = $('gridSwitch');
const gridCellsEl = $('gridCells');

function gridOn() {
  return !!(gridSwitch && gridSwitch.classList.contains('on'));
}

function setGridOn(on) {
  if (!gridSwitch) return;
  gridSwitch.classList.toggle('on', !!on);
  gridSwitch.setAttribute('aria-checked', on ? 'true' : 'false');
}

if (gridSwitch) {
  gridSwitch.addEventListener('click', () => {
    const on = !gridOn();
    setGridOn(on);
    API.setConfig({ gridOn: on }).catch(() => {});
  });
}

if (gridCellsEl) {
  const saveCells = () => {
    const v = Math.max(2, Math.min(40, Number(gridCellsEl.value) || 10));
    gridCellsEl.value = String(v);
    API.setConfig({ gridCells: v }).catch(() => {});
  };
  gridCellsEl.addEventListener('change', saveCells);
  gridCellsEl.addEventListener('blur', saveCells);
}

/* ---------------- 多模型预设 ---------------- */
let profiles = [];
let activeModelId = '';

function modelLabel(p) {
  if (!p) return '';
  return p.name + (p.apiKeys ? '' : ' · 需填 Key');
}

function renderModels() {
  for (const sel of [$('modelSel'), $('profileSel')]) {
    if (!sel) continue;
    sel.innerHTML = '';
    for (const p of profiles) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = modelLabel(p);
      sel.appendChild(o);
    }
    if (profiles.some(p => p.id === activeModelId)) sel.value = activeModelId;
  }
  const p = profiles.find(x => x.id === activeModelId);
  if ($('modelNote')) $('modelNote').textContent = p ? p.model : '';
}

function fillModelInputs(p) {
  if (!p) return;
  if ($('modelUrl')) $('modelUrl').value = p.baseUrl || '';
  if ($('modelName')) $('modelName').value = p.model || '';
  if ($('modelKeys')) $('modelKeys').value = p.apiKeys || '';
}

async function applyModel(id) {
  const p = profiles.find(x => x.id === id);
  if (!p) return;
  activeModelId = id;
  fillModelInputs(p);
  renderModels();
  await API.setConfig({ baseUrl: p.baseUrl, model: p.model, apiKeys: p.apiKeys, activeModel: id });
}

async function persistProfiles(extra = {}) {
  await API.setConfig({ profiles, activeModel: activeModelId, ...extra });
}

if ($('modelSel')) $('modelSel').onchange = () => applyModel($('modelSel').value);
if ($('profileSel')) $('profileSel').onchange = () => applyModel($('profileSel').value);

if ($('btnProfileSave')) {
  $('btnProfileSave').onclick = async () => {
    const name = window.prompt('给这个模型起个名字（例如：DeepSeek / agnes-2.5-flash）', $('modelName').value || '新模型');
    if (!name || !name.trim()) return;
    const data = {
      id: 'm_' + Date.now().toString(36),
      name: name.trim(),
      baseUrl: $('modelUrl').value.trim(),
      model: $('modelName').value.trim(),
      apiKeys: $('modelKeys').value.trim(),
    };
    profiles = [...profiles, data];
    activeModelId = data.id;
    await persistProfiles();
    renderModels();
    log(`已保存模型预设：${data.name}`);
  };
}

if ($('btnProfileDel')) {
  $('btnProfileDel').onclick = async () => {
    const id = $('profileSel').value;
    const p = profiles.find(x => x.id === id);
    if (!p || !window.confirm(`删除预设「${p.name}」？`)) return;
    profiles = profiles.filter(x => x.id !== id);
    if (activeModelId === id) activeModelId = profiles[0] ? profiles[0].id : '';
    await persistProfiles();
    renderModels();
    if (profiles.find(x => x.id === activeModelId)) await applyModel(activeModelId);
  };
}
const setSel = $('setSel');
const answerEl = $('answerBox');
const answerHint = $('answerHint');
let sets = [];
let activeSetId = '';

function renderSets() {
  if (!setSel) return;
  setSel.innerHTML = '<option value="">不指定（AI 自由批改）</option>';
  for (const s of sets) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name;
    setSel.appendChild(o);
  }
  setSel.value = sets.some(s => s.id === activeSetId) ? activeSetId : '';
}

function activeSet() {
  return sets.find(s => s.id === activeSetId) || null;
}

function loadAnswerIntoBox() {
  if (!answerEl) return;
  const s = activeSet();
  answerEl.value = s ? (s.answer || '') : '';
  answerHint.textContent = s ? `已载入「${s.name}」的答案` : '';
  answerHint.classList.remove('ok');
}

let answerTimer = 0;
async function saveAnswerNow() {
  if (!answerEl) return;
  const text = answerEl.value;
  if (activeSetId) {
    sets = sets.map(s => (s.id === activeSetId ? { ...s, answer: text } : s));
    await API.setConfig({ sets, activeSet: activeSetId });
    answerHint.textContent = '答案已保存到本套作业';
    answerHint.classList.add('ok');
  } else {
    await API.setConfig({ answerText: text });
    answerHint.textContent = '答案已保存（未指定作业，作为通用答案）';
    answerHint.classList.add('ok');
  }
}

if (answerEl) {
  answerEl.addEventListener('input', () => {
    answerHint.textContent = '未保存…';
    answerHint.classList.remove('ok');
    clearTimeout(answerTimer);
    answerTimer = setTimeout(() => saveAnswerNow().catch(() => {}), 500);
  });
}

$('btnNewSet').onclick = async () => {
  const name = window.prompt('作业名称（例如：第三单元测试）', '');
  if (!name || !name.trim()) return;
  const id = 'set_' + Date.now().toString(36);
  sets = [{ id, name: name.trim(), answer: answerEl ? answerEl.value : '', createdAt: Date.now() }, ...sets];
  activeSetId = id;
  renderSets();
  await API.setConfig({ sets, activeSet: id });
  answerHint.textContent = `已创建「${name.trim()}」，扫描答案会存到这一套`;
};

if (setSel) {
  setSel.addEventListener('change', async () => {
    activeSetId = setSel.value;
    await API.setConfig({ activeSet: activeSetId });
    loadAnswerIntoBox();
  });
}

$('btnScanAnswer').onclick = async () => {
  const btn = $('btnScanAnswer');
  try {
    btn.disabled = true;
    answerHint.textContent = '正在扫描答案纸…';
    answerHint.classList.remove('ok');
    const p = await scanOnce();
    answerHint.textContent = '正在识别答案…';
    const text = await API.answerScan(p);
    answerEl.value = text;
    await saveAnswerNow();
    answerHint.textContent = (activeSet() ? `已存入「${activeSet().name}」` : '已保存为通用答案') + ' · 共 ' + text.split('\n').filter(Boolean).length + ' 行';
    answerHint.classList.add('ok');
  } catch (e) {
    answerHint.textContent = '扫描答案失败：' + e.message;
  } finally {
    btn.disabled = false;
  }
};

function renderList(results) {
  const list = $('list');
  list.innerHTML = '';
  for (const r of results) {
    const cls = r.verdict === 'correct' ? 'ok' : r.verdict === 'wrong' ? 'bad' : 'mid';
    const mark = r.verdict === 'correct' ? '✓' : r.verdict === 'wrong' ? '✗'
      : r.verdict === 'partial' ? '半' : r.verdict === 'blank' ? '空'
      : r.verdict === 'uncertain' ? '?' : '!';
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `<div class="no ${cls}">${mark} ${r.no}</div>
      <div><div>${esc(r.student || '（未作答）')}</div>
      <div class="sub">${r.correct ? '应: ' + esc(r.correct) : ''} ${esc(r.comment || '')} ${esc(r.error || '')}</div></div>`;
    list.appendChild(div);
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 作文模式：左侧只显示整体得分、维度小分与总评，不列逐题结果
function renderEssaySummary(summary, seconds) {
  renderList([]);
  const s = summary || {};
  const dims = s.dims && typeof s.dims === 'object'
    ? Object.entries(s.dims).map(([k, v]) => `${esc(k)} ${esc(v)}`).join('　') : '';
  const corr = Array.isArray(s.corrections) ? s.corrections : [];
  const corrText = corr.slice(0, 4).map(c => {
    if (typeof c === 'string') return esc(c);
    return `${esc(c.from || '')}${c.from ? ' → ' : ''}${esc(c.to || '')}${c.reason ? '（' + esc(c.reason) + '）' : ''}`;
  }).join('；');
  const scoreText = s.score != null
    ? `得分 ${esc(s.score)}${s.fullScore != null ? ' / ' + esc(s.fullScore) : ''}`
    : '整页评阅';
  $('list').innerHTML = `<div class="item"><div class="no ok">评</div>
    <div>
      <div>${scoreText}${s.pages ? ` · ${esc(s.pages)} 页` : ''}</div>
      ${dims ? `<div class="sub">${dims}</div>` : ''}
      <div class="sub">${esc(s.comment || '')}</div>
      ${corrText ? `<div class="sub">修改建议：${corrText}</div>` : ''}
    </div></div>`;
  setOrb('done', '评阅完成', s.score != null ? `${s.score} 分 · ${seconds}s` : `整页 · ${seconds}s`);
}

/* ---------------- 自动模式：点球开始 ---------------- */
async function scanOnce() {
  setOrb('discover', '正在寻找扫描仪', '');
  const host = await API.discover();
  if (!host) throw new Error('没找到扫描仪，请在设置里配置地址，或用手动模式选图');
  setOrb('scan', '正在扫描', '');
  return API.scanPage(host);
}

async function ensureImage() {
  if (S.imagePath) return S.imagePath;
  try {
    const p = await scanOnce();
    setImage(p);
    return p;
  } catch (e) {
    // 没有扫描仪（或扫描失败）时，自动改为上传本地图片
    setOrb(null, '没有可用扫描仪', '请选择一张图片');
    const p = await API.pickImage();
    if (!p) throw e;
    setImage(p);
    return p;
  }
}

async function runAuto(picked) {
  if (S.busy || S.resultMode || S.collecting) return;
  busy(true);
  $('list').innerHTML = '';
  S.resultPath = null; S.results = []; S.marks = [];
  S.printed = false; S.autoPrinted = false;
  S.printedPages.clear();
  $('printOrb').hidden = true;
  $('printAllOrb').hidden = true;
  try {
    const imagePath = picked || await ensureImage();
    setOrb('grade', '正在批改', '逐题识别与判定');
    const res = await API.auto({ imagePath, options: options() });
    S.resultPath = res.out;
    S.results = res.results || [];
    showBg(res.out); // 批改图半透明叠在球后
    if (res.mode === 'essay' && res.summary) {
      renderEssaySummary(res.summary, res.seconds);
    } else {
      renderList(S.results);
      setOrb('done', '批改完成', `${S.results.length} 题 · ${res.seconds}s`);
    }
    if (isOn('optAutoPrint')) {
      setOrb('print', '发送到打印机', '');
      try {
        await API.print(res.out);
        S.printed = true;
        S.autoPrinted = true;
        S.printedPages.add(res.out);
      } catch (_) { /* 打印失败不影响出图，成品页仍保留打印按钮 */ }
    }
    if (S.loaded) loadHistory();
    await sleep(1500);
    enterResult(res.out); // 最终批改完，只留这一张
  } catch (e) {
    setOrb(null, '出错了', e.message);
  } finally {
    busy(false);
  }
}

/* ---------------- 多页：先连扫，再统一批改 ---------------- */
function enterCollect() {
  S.collecting = true;
  document.body.classList.remove('view', 'result');
  document.body.classList.add('collecting');
  $('collectCount').textContent = `已扫描 ${S.collectPages.length} 页 · 请换下一张`;
}

async function startMulti() {
  if (S.busy || S.resultMode || S.collecting) return;
  S.scanMode = 'multi';
  busy(true);
  S.collectPages = [];
  S.autoPrinted = false;
  S.printed = false;
  S.printedPages.clear();
  $('list').innerHTML = '';
  try {
    setOrb('scan', '正在扫描第 1 页', '');
    const p = await scanOnce();
    S.collectPages = [p];
    setImage(p);
    enterCollect();
  } catch (e) {
    setOrb(null, '出错了', e.message);
  } finally {
    busy(false);
  }
}

async function scanNextPage() {
  if (S.busy) return;
  busy(true);
  document.body.classList.remove('collecting');
  try {
    const no = S.collectPages.length + 1;
    setOrb('scan', `正在扫描第 ${no} 页`, '');
    const p = await scanOnce();
    S.collectPages.push(p);
    setImage(p);
    enterCollect();
  } catch (e) {
    document.body.classList.add('collecting');
    $('collectCount').textContent = `已扫描 ${S.collectPages.length} 页 · 扫描失败：${e.message}`;
    setOrb(null, '出错了', e.message);
  } finally {
    busy(false);
  }
}

async function gradeCollected() {
  if (S.busy || !S.collectPages.length) return;
  busy(true);
  S.collecting = false;
  document.body.classList.remove('collecting');
  $('list').innerHTML = '';
  const outs = [], pageResults = [], errors = [];
  let essaySummary = null, essaySeconds = 0, essayPage = 1;
  try {
    if (S.scanMode === 'multi' && $('optType').value === 'essay') {
      setOrb('grade', '作文评阅', `${S.collectPages.length} 页一次性提交`);
      const res = await API.autoMultiEssay({ imagePaths: S.collectPages, options: options() });
      essaySummary = res.summary || (res.pages && res.pages[0] ? res.pages[0].summary : null);
      essaySeconds = res.seconds || 0;
      essayPage = res.summaryPage || S.collectPages.length;
      for (const p of res.pages || []) {
        outs.push(p.out);
        pageResults.push([]);
      }
    } else if (S.scanMode === 'multi' && S.collectPages.length > 1) {
      // 试卷多页：一次性提交整份，AI 才能跨页接着判题、不重复登记题号
      setOrb('grade', '整套批改', `${S.collectPages.length} 页一次性提交`);
      const res = await API.autoMultiWhole({ imagePaths: S.collectPages, options: options() });
      for (const p of res.pages || []) {
        outs.push(p.out);
        pageResults.push(p.results || []);
      }
    } else {
      for (let i = 0; i < S.collectPages.length; i++) {
        setOrb('grade', '正在批改', `第 ${i + 1} / ${S.collectPages.length} 页`);
        try {
          const res = await API.auto({ imagePath: S.collectPages[i], options: options() });
          outs.push(res.out);
          pageResults.push(res.results || []);
        } catch (e) {
          errors.push(`第 ${i + 1} 页：${e.message}`);
        }
      }
    }
    if (!outs.length) throw new Error(errors.join('；') || '所有页都批改失败');

    S.results = pageResults[0] || [];
    showBg(outs[0]);
    if (essaySummary && essaySummary.type === 'essay') {
      renderEssaySummary(essaySummary, essaySeconds);
    } else {
      renderList(S.results);
      setOrb('done', '批改完成', `${outs.length} 页 · ${S.results.length} 题`);
    }

    if (isOn('optAutoPrint')) {
      setOrb('print', '逐页发送到打印机', '');
      const r = await printMany(outs, n => setOrb('print', '打印中', `${n} / ${outs.length}`));
      S.printed = r.done > 0;
      S.autoPrinted = r.done === outs.length;
    }
    if (S.loaded) loadHistory();
    await sleep(1200);
    // 作文多页：直接停在写有评语的最后一页
    enterResult(outs, pageResults, errors, essaySummary ? essayPage - 1 : 0);
  } catch (e) {
    setOrb(null, '出错了', e.message);
  } finally {
    busy(false);
  }
}

$('orb').onclick = () => {
  // 作文常有多页：点球后连续扫描，扫完点「开始评阅」一次性提交；试卷仍是一页一批
  if ($('optType').value === 'essay') {
    S.scanMode = 'multi';
    startMulti();
  } else {
    S.scanMode = 'single';
    runAuto();
  }
};
$('btnNextPage').onclick = scanNextPage;
$('btnStartGrade').onclick = gradeCollected;
$('btnClear').onclick = () => resetAll();

/* ---------------- 整套多页入口 ---------------- */
// 扫描：连扫多页再一起批；上传：一张直接批，多张进入收页后整套批
$('btnMultiScan').onclick = () => { if (!S.busy) { S.scanMode = 'multi'; startMulti(); } };
$('btnMultiPick').onclick = async () => {
  if (S.busy || S.resultMode || S.collecting) return;
  const paths = await API.pickImages();
  if (!paths || !paths.length) return;
  if (paths.length === 1) {
    S.scanMode = 'single';
    setImage(paths[0]);
    runAuto(paths[0]);
    return;
  }
  S.scanMode = 'multi';
  S.collectPages = paths.slice();
  S.autoPrinted = false;
  S.printed = false;
  S.printedPages.clear();
  setImage(paths[0]);
  enterCollect();
};

/* ---------------- 手动模式 ---------------- */
// 与自动模式同步：可上传多张，用页签切换，逐页切题/批改
function renderManualPages() {
  const el = $('mPages');
  if (!el) return;
  el.innerHTML = '';
  if (S.manualPages.length < 2) return;
  S.manualPages.forEach((p, i) => {
    const c = document.createElement('div');
    c.className = 'chip' + (i === S.manualIndex ? ' done' : '');
    c.textContent = `第 ${i + 1} 页`;
    c.onclick = () => { if (!S.busy) loadManualPage(i); };
    el.appendChild(c);
  });
}

function loadManualPage(i) {
  if (!S.manualPages[i]) return;
  S.manualIndex = i;
  S.imagePath = S.manualPages[i];
  S.page = null;
  S.blocks = []; S.results = []; S.marks = []; S.resultPath = null;
  showBg(S.imagePath);
  $('mChips').innerHTML = '<span class="sub">切题后出现题号</span>';
  $('mBlockInfo').textContent = '';
  $('mDetail').textContent = '';
  renderList([]);
  renderManualPages();
  busy(false);
  setOrb(null, `第 ${i + 1} 页已载入`, '可以开始切题');
}

$('mScan').onclick = async () => {
  busy(true);
  try {
    setOrb('discover', '正在寻找扫描仪', '');
    const host = await API.discover();
    if (!host) throw new Error('没找到扫描仪');
    setOrb('scan', '正在扫描', '');
    const p = await API.scanPage(host);
    S.manualPages = [p];
    S.manualIndex = 0;
    setImage(p);
    renderManualPages();
    setOrb(null, '扫描完成', '可以开始切题');
  } catch (e) { setOrb(null, '出错了', e.message); }
  finally { busy(false); }
};

$('mPick').onclick = async () => {
  const paths = await API.pickImages();
  if (!paths || !paths.length) return;
  S.manualPages = paths;
  S.manualIndex = 0;
  loadManualPage(0);
};

$('mSplit').onclick = async () => {
  if (!S.imagePath) return;
  busy(true);
  $('mChips').innerHTML = '<span class="sub">识别中…</span>';
  try {
    const { page, blocks, imagePath, rotation, cropped } = await API.split(S.imagePath);
    S.page = page; S.blocks = blocks;
    if (imagePath && imagePath !== S.imagePath) {
      S.imagePath = imagePath;
      showBg(imagePath);
    }
    const chips = $('mChips');
    chips.innerHTML = '';
    for (const b of blocks) {
      const c = document.createElement('div');
      c.className = 'chip';
      c.textContent = `第 ${b.no} 题`;
      c.onclick = () => gradeOne(b, c);
      chips.appendChild(c);
    }
    $('mBlockInfo').innerHTML = blockInfo(page, blocks);
    setOrb(null, `找到 ${blocks.length} 道题`,
      `${rotation === 180 ? '已自动摆正 · ' : ''}${cropped ? '已裁掉空白边 · ' : ''}点击题号逐题批改`);
  } catch (e) {
    $('mChips').innerHTML = '<span class="sub">切题失败</span>';
    $('mBlockInfo').textContent = '';
    setOrb(null, '出错了', e.message);
  } finally { busy(false); }
};

function blockInfo(page, blocks) {
  const head = `<b>${blocks.length}</b> 题 · 页面 ${page.width}×${page.height}`;
  const rows = blocks.map(b => {
    const anchor = b.numY != null ? `锚点(${b.numX},${b.numY})` : '锚点-';
    const tag = b.synthetic ? ' 补' : '';
    return `Q${b.no}  y=${b.y0}–${b.y1}  h=${b.y1 - b.y0}  ${anchor}${tag}`;
  });
  return esc(head) + '\n' + esc(rows.join('\n'));
}

const VERDICT_TEXT = { correct: '正确', partial: '半对', wrong: '错误', blank: '空题', uncertain: '不确定', essay: '评阅' };

function showDetail(block, result, mark) {
  const el = $('mDetail');
  const v = VERDICT_TEXT[result.verdict] || result.verdict;
  const lines = [
    `<b>Q${block.no} · ${esc(v)}</b>`,
    `切块   y=${block.y0}–${block.y1}  x=${block.x0}–${block.x1}`,
    `学生   ${esc(result.student || '（未作答）')}`,
    `应     ${esc(result.correct || '-')}`,
    `批注   ${esc(result.comment || '-')}`,
  ];
  if (result.error) lines.push(`错误   ${esc(result.error)}`);
  if (result.confidence != null) lines.push(`置信   ${result.confidence}`);
  if (result.answer_point) lines.push(`AI点   ${result.answer_point.join(',')} /1000`);
  if (mark) {
    lines.push(`落点   (${Math.round(mark.x)}, ${Math.round(mark.y)})  页面坐标`);
    if (mark.text) lines.push(`文字   (${Math.round(mark.textX)}, ${Math.round(mark.textY)}) ${esc(mark.text)}`);
  }
  el.innerHTML = lines.join('\n') + `\n<span class="row"><button class="ghost" id="mCropBtn" style="font-size:11px;padding:5px 10px">看原题块</button></span>`;
  el.querySelector('#mCropBtn').onclick = async () => {
    try {
      const p = await API.cropBlock({ imagePath: S.imagePath, block });
      showBg(p);
    } catch (e) { setOrb(null, '裁块失败', e.message); }
  };
}

async function gradeOne(block, chip) {
  if (S.busy) return;
  busy(true);
  try {
    const { result, mark } = await API.gradeOne({
      imagePath: S.imagePath, page: S.page, block, options: optionsManual(),
    });
    S.marks.push(mark);
    S.results.push(result);
    chip.className = 'chip ' + (result.verdict === 'correct' ? 'done' : 'err');
    renderList(S.results);
    showDetail(block, result, mark);
    setOrb(null, `第 ${block.no} 题：${VERDICT_TEXT[result.verdict] || result.verdict}`, result.correct || result.comment || '');
  } catch (e) {
    chip.className = 'chip err';
    setOrb(null, '批改失败', e.message);
  } finally { busy(false); }
}

$('mRender').onclick = async () => {
  busy(true);
  try {
    const out = await API.renderMarks({
      imagePath: S.imagePath, marks: S.marks, results: S.results, options: optionsManual(),
    });
    S.resultPath = out;
    showBg(out);
    if (S.loaded) loadHistory();
    setOrb(null, '已生成批改图', '可继续批改其它题后重新生成');
  } catch (e) { setOrb(null, '生成失败', e.message); }
  finally { busy(false); }
};

$('mPrint').onclick = async () => {
  if (!S.resultPath) return;
  busy(true);
  try {
    setOrb('print', '发送到打印机', '');
    await API.print(S.resultPath);
    setOrb('done', '已打印', S.resultPath.split('/').pop());
  } catch (e) { setOrb(null, '打印失败', e.message); }
  finally { busy(false); }
};

/* ---- 调试视图 ---- */
$('mSplitView').onclick = async () => {
  if (!S.blocks.length) return;
  busy(true);
  try {
    const out = await API.renderDebug({ imagePath: S.imagePath, blocks: S.blocks, marks: S.marks });
    showBg(out);
    setOrb(null, '切题预览', `蓝框=切块 Q 号=题号（${S.blocks.length} 题）`);
  } catch (e) { setOrb(null, '预览失败', e.message); }
  finally { busy(false); }
};

$('mPageView').onclick = () => {
  showBg(S.resultPath || S.imagePath);
  setOrb(null, '整页', S.resultPath ? '当前显示批改结果图' : '当前显示原扫描图');
};

$('mShowOrig').onclick = () => {
  showBg(S.imagePath);
  setOrb(null, '原图', '已切回原扫描图');
};

/* ---------------- 模式切换 ---------------- */
$('modes').addEventListener('click', e => {
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  if (S.busy) return;
  S.mode = b.dataset.mode;
  [...$('modes').children].forEach(x => x.classList.toggle('on', x === b));
  document.body.classList.toggle('mode-auto', S.mode === 'auto');
  document.body.classList.toggle('mode-manual', S.mode === 'manual');
  $('auto-panel').classList.toggle('on', S.mode === 'auto');
  $('manual-panel').classList.toggle('on', S.mode === 'manual');
  if (document.body.classList.contains('result')) backToOrb();
  setOrb(null, IDLE_LABEL, S.mode === 'auto' ? IDLE_SUB : '按步骤手动操作');
});

/* ---------------- 设置 ---------------- */
function log(msg) {
  const el = $('debugLog');
  el.textContent = `${new Date().toLocaleTimeString('zh-CN')}  ${msg}\n` + el.textContent;
}

function stateDot(ok, text) {
  const cls = ok === 'busy' ? 'warn' : ok ? 'ok' : 'bad';
  return `<span class="dot ${cls}"></span>${text}`;
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

async function refreshScanner(host) {
  $('scannerState').innerHTML = '检测中…';
  const s = await API.scannerStatus(host || $('scannerHost').value.trim());
  if (!s.ok) {
    $('scannerState').innerHTML = stateDot(false, s.error || '连接失败');
    log(`扫描仪检测失败：${s.error || '未知错误'}`);
    return;
  }
  const bz = /Processing|Testing/.test(s.state);
  $('scannerState').innerHTML = stateDot(bz ? 'busy' : true, s.state + (bz ? '（忙）' : ''));
  $('scannerModel').textContent = s.model;
  $('scannerSource').textContent = (s.platen ? '平板 Platen ' : '') + (s.adf ? '+ ADF 送稿器' : '');
  $('scannerDpi').textContent = s.maxDpi ? `${s.maxDpi}（可用 ${s.resolutions.slice(-4).join('/')}）` : '-';
  $('scannerHost').value = s.host;
  log(`扫描仪在线：${s.model} / ${s.state}`);
}

async function refreshPrinter() {
  const p = await API.printerInfo();
  $('printerDefault').textContent = p.defaultPrinter || '未设置';
  $('printerList').textContent = p.printers.length
    ? p.printers.map(x => `${x.name}${x.state === 'disabled' ? '（停用）' : ''}`).join('、')
    : '未找到打印机';
  $('jobList').textContent = p.jobs.length ? p.jobs.map(j => `${j.id} ${j.name || ''}`).join('；') : '空闲';

  const sel = $('printPrinter');
  const prev = sel.value;
  sel.innerHTML = `<option value="">跟随系统默认（${p.defaultPrinter || '无'}）</option>` +
    p.printers.map(x => `<option value="${x.name}">${x.name}${x.state === 'disabled' ? '（停用）' : ''}</option>`).join('');
  sel.value = p.printers.some(x => x.name === prev) ? prev : '';

  log(`打印队列：${p.defaultPrinter || '无默认打印机'}，${p.jobs.length} 个任务`);
}

async function refreshStorage() {
  try {
    const s = await API.storageInfo();
    $('storeDir').textContent = s.dir;
    $('storeSize').textContent = `${fmtBytes(s.bytes)} · ${s.files} 个文件`;
    return s;
  } catch (_) { return null; }
}

async function openSettings() {
  $('settingsModal').classList.add('on');
  const cfg = await API.getConfig();
  if (cfg.scannerHost) $('scannerHost').value = cfg.scannerHost;
  if (cfg.baseUrl) $('modelUrl').value = cfg.baseUrl;
  if (cfg.model) $('modelName').value = cfg.model;
  if (cfg.apiKeys) $('modelKeys').value = cfg.apiKeys;
  if (cfg.storageDir) $('storeDir').textContent = cfg.storageDir;
  $('modelSource').value = /127\.0\.0\.1|localhost/.test(cfg.baseUrl || '') ? 'local' : 'cloud';
  refreshScanner(cfg.scannerHost || '');
  await refreshPrinter();
  $('printPrinter').value = cfg.printerName || '';
  $('printQuality').value = cfg.printQuality || 'draft';
  $('printColor').value = cfg.printColor || 'color';
  $('printImpose').value = cfg.printImpose || 'off';
  refreshStorage();
}

// 打印选项改动即保存
function savePrintCfg() {
  S.impose = $('printImpose').value;
  return API.setConfig({
    printerName: $('printPrinter').value,
    printQuality: $('printQuality').value,
    printColor: $('printColor').value,
    printImpose: $('printImpose').value,
  });
}
['printPrinter', 'printQuality', 'printColor', 'printImpose'].forEach(id => { $(id).onchange = savePrintCfg; });

$('btnSaveModel').onclick = async () => {
  const baseUrl = $('modelUrl').value.trim();
  const model = $('modelName').value.trim();
  const apiKeys = $('modelKeys').value.trim();
  await API.setConfig({ baseUrl, model, apiKeys });
  // 当前预设同步更新，避免“设置里改了但预设还是旧的”
  if (activeModelId && profiles.some(p => p.id === activeModelId)) {
    profiles = profiles.map(p => (p.id === activeModelId ? { ...p, baseUrl, model, apiKeys } : p));
    await persistProfiles();
    renderModels();
  }
  const n = apiKeys.split(',').filter(Boolean).length;
  log(`模型已应用：${model || '默认'}，${n} 个 Key`);
};

$('modelSource').onchange = () => {
  if ($('modelSource').value === 'local') {
    $('modelUrl').value = 'http://127.0.0.1:1234/v1/chat/completions';
    $('modelName').value = 'qwen3.5-2b';
    $('modelKeys').placeholder = '本地服务一般不需要 Key，留空即可';
  } else {
    $('modelUrl').value = 'https://api.openai.com/v1/chat/completions';
    $('modelName').value = 'gpt-4o-mini';
    $('modelKeys').placeholder = 'sk-xxx,sk-yyy';
  }
  $('modelState').textContent = '';
};

$('btnTestModel').onclick = async () => {
  $('modelState').textContent = '测试中…';
  const model = $('modelName').value.trim();
  const r = await API.testModel({
    baseUrl: $('modelUrl').value.trim(),
    model,
    apiKeys: $('modelKeys').value.trim(),
  });
  if (!r.ok) {
    $('modelState').textContent = r.message;
    log(`模型测试失败：${r.message}`);
    return;
  }
  const parts = [`共 ${r.models.length} 个模型`];
  if (!r.found) parts.push(`列表里没有 ${model}`);
  parts.push(r.vision ? '支持读图' : '不支持读图');
  $('modelState').textContent = parts.join('｜');
  log(`模型测试：${parts.join('，')}${r.vision ? '' : ' ' + (r.visionMsg || '').slice(0, 60)}`);
};

$('btnSettings').onclick = openSettings;
$('btnCloseSettings').onclick = () => $('settingsModal').classList.remove('on');
$('settingsModal').onclick = e => { if (e.target.id === 'settingsModal') $('settingsModal').classList.remove('on'); };
$('btnDetect').onclick = () => refreshScanner();
$('btnSaveCfg').onclick = async () => {
  const host = $('scannerHost').value.trim();
  await API.setConfig({ scannerHost: host });
  log(`已保存扫描仪地址：${host}`);
  setOrb(null, '已保存设备地址', host);
};
$('btnDiscover').onclick = async () => {
  log('开始搜索局域网扫描仪…');
  const host = await API.discover();
  if (!host) { log('没有找到扫描仪'); return; }
  $('scannerHost').value = host;
  await API.setConfig({ scannerHost: host });
  refreshScanner(host);
};
$('btnRefreshPrint').onclick = refreshPrinter;
$('btnClearQueue').onclick = async () => {
  const n = await API.clearQueue();
  log(`已取消 ${n} 个打印任务`);
  refreshPrinter();
};
$('btnTestPrint').onclick = async () => {
  await API.testPrint();
  log('测试页已发送到默认打印机');
  setTimeout(refreshPrinter, 800);
};

/* ---- 存储 ---- */
$('btnPickStore').onclick = async () => {
  const d = await API.storageChoose();
  if (!d) return;
  $('storeDir').textContent = d;
  log(`存储目录已切换：${d}`);
  await refreshStorage();
};
$('btnOpenStore').onclick = () => API.storageOpen();
$('btnOpenStore2').onclick = () => API.storageOpen();
$('btnCleanTemp').onclick = async () => {
  const r = await API.cleanupTemp();
  $('cleanState').textContent = `已清理 ${r.files} 个临时文件，释放 ${fmtBytes(r.bytes)}`;
  log(`清理临时文件：${r.files} 个，释放 ${fmtBytes(r.bytes)}`);
  await refreshStorage();
};

/* ---------------- 进度事件 ---------------- */
API.onStage(s => {
  if (S.resultMode) return;
  const sub = s.total ? `${s.done}/${s.total}` : '';
  if (s.stage === 'grade') setOrb('grade', s.label, sub);
  else if (s.stage === 'ocr') setOrb('grade', s.label, sub);
  else if (s.stage === 'scan') setOrb('scan', s.label, sub);
  else if (s.stage === 'split') setOrb('split', s.label, sub);
  else if (s.stage === 'render') setOrb('render', s.label, sub);
  else if (s.stage === 'print') setOrb('print', s.label, sub);
  else if (s.stage === 'discover') setOrb('discover', s.label, sub);
  else setOrb(null, s.label, sub);
});

/* ---------------- 启动：不自动载入历史 ---------------- */
document.body.classList.add('mode-auto');
setOrb(null, IDLE_LABEL, IDLE_SUB);
paintHistory();

// 记住上次的选择：自动打印、主提示词，下次打开保持不变
(async () => {
  try {
    const cfg = await API.getConfig();
    if (cfg.autoPrint) $('optAutoPrint').closest('.opt').classList.add('on');
    if (masterEl && cfg.masterPrompt) masterEl.value = cfg.masterPrompt;
    if (cfg.printImpose === 'on' || cfg.printImpose === 'off') S.impose = cfg.printImpose;

    // 网格：默认开，密度记住上次
    setGridOn(cfg.gridOn !== false);
    if (gridCellsEl) gridCellsEl.value = String(cfg.gridCells || 10);

    // 模型预设：没有就补上 DeepSeek（当前配置）+ agnes-2.5-flash
    profiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];
    if (!profiles.some(p => p.id === 'deepseek')) {
      profiles.unshift({
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: cfg.baseUrl || 'https://api.deepseek.com/chat/completions',
        model: cfg.model || 'deepseek-flash',
        apiKeys: cfg.apiKeys || '',
      });
    }
    if (!profiles.some(p => p.id === 'agnes')) {
      profiles.push({
        id: 'agnes',
        name: 'agnes-2.5-flash',
        baseUrl: 'https://api.agnes-ai.cn/v1/chat/completions',
        model: 'agnes-2.5-flash',
        apiKeys: '',
      });
    }
    activeModelId = profiles.some(p => p.id === cfg.activeModel) ? cfg.activeModel : profiles[0].id;
    renderModels();

    // 作业（套卷）与标准答案
    sets = Array.isArray(cfg.sets) ? cfg.sets : [];
    activeSetId = cfg.activeSet || '';
    renderSets();
    if (activeSet()) {
      loadAnswerIntoBox();
    } else if (answerEl && cfg.answerText) {
      answerEl.value = cfg.answerText;
    }
  } catch (_) { /* 首次运行无配置 */ }
})();
