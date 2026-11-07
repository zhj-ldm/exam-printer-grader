const $ = id => document.getElementById(id);
const API = window.api;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const S = {
  mode: 'auto',
  imagePath: null,
  scanMode: 'single',
  collectPages: [],
  collecting: false,
  resultPaths: [],
  pageResults: [],
  batchErrors: [],
  resultIndex: 0,
  printedPages: new Set(),
  pageMode: 'split',
  markSide: 'question',
  impose: 'off',
  reviewOn: false,
  reviewRounds: 1,
  deepGrab: false,
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
  document.body.classList.remove('collecting');
  $('collectCount').textContent = '已扫描 1 页';
  $('printOrb').hidden = true;
  $('printAllOrb').hidden = true;
  clearBg();
  $('list').innerHTML = '';
  $('mChips').innerHTML = '<span class="sub">切题后出现题号</span>';
  $('mBlockInfo').textContent = '';
  $('mDetail').textContent = '';
  $('stdAnswer').value = ''; $('mStd').value = '';
  $('extraPrompt').value = ''; $('mExtra').value = '';
  paintHistory();
  setOrb(null, IDLE_LABEL, IDLE_SUB);
  busy(false);
}

/* ---------------- 选项 ---------------- */
function options() {
  return {
    mode: $('optType').value,
    gradeMode: 'precise',
    pageMode: S.pageMode,
    markSide: S.markSide,
    reviewRounds: S.reviewOn ? (Math.max(1, Math.min(3, Number($('reviewRounds').value) || 1))) : 0,
    deepGrab: S.deepGrab,
    standardAnswer: $('stdAnswer').value,
    extraPrompt: $('extraPrompt').value,
    render: {
      // 作文模式只评分评语，不打勾叉
      ticks: $('optType').value === 'essay' ? false : isOn('optTick'),
      comments: isOn('optComment'),
      answers: isOn('optAnswer'),
    },
  };
}

function optionsManual() {
  return {
    mode: $('optType').value,
    gradeMode: 'precise',
    markSide: S.markSide,
    reviewRounds: S.reviewOn ? (Math.max(1, Math.min(3, Number($('reviewRounds').value) || 1))) : 0,
    deepGrab: S.deepGrab,
    standardAnswer: $('mStd').value || $('stdAnswer').value,
    extraPrompt: $('mExtra').value || $('extraPrompt').value,
    render: {
      ticks: $('mTick').checked,
      comments: $('mText').checked,
      answers: $('mAnswer').checked,
      coords: $('mCoords').checked,
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

function syncFields(a, b) {
  $(a).addEventListener('input', () => { $(b).value = $(a).value; });
  $(b).addEventListener('input', () => { $(a).value = $(b).value; });
}
syncFields('stdAnswer', 'mStd');
syncFields('extraPrompt', 'mExtra');

// 批改范围切换：先切题再批改 / 整页直读（记住选择）
document.querySelectorAll('#segPage button').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('#segPage button').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    S.pageMode = btn.dataset.page;
    API.setConfig({ pageMode: S.pageMode });
  };
});

// 标记位置切换：题上 / 最右侧（记住选择）
document.querySelectorAll('#segMark button').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('#segMark button').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    S.markSide = btn.dataset.side;
    API.setConfig({ markSide: S.markSide });
  };
});

// AI 复合：开 / 关 + 复合次数（记住选择）
document.querySelectorAll('#segReview button').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('#segReview button').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    S.reviewOn = btn.dataset.review === 'on';
    API.setConfig({ reviewOn: S.reviewOn });
  };
});
$('reviewRounds').onchange = () => {
  let n = Number($('reviewRounds').value) || 1;
  n = Math.max(1, Math.min(3, n));
  $('reviewRounds').value = n;
  S.reviewRounds = n;
  API.setConfig({ reviewRounds: n });
};

// 深度抓取：开 / 关（记住选择）
document.querySelectorAll('#segDeep button').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('#segDeep button').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    S.deepGrab = btn.dataset.deep === 'on';
    API.setConfig({ deepGrab: S.deepGrab });
  };
});

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
  const p = await scanOnce();
  setImage(p);
  return p;
}

async function runAuto() {
  if (S.busy || S.resultMode || S.collecting) return;
  busy(true);
  $('list').innerHTML = '';
  S.resultPath = null; S.results = []; S.marks = [];
  S.printed = false; S.autoPrinted = false;
  S.printedPages.clear();
  $('printOrb').hidden = true;
  $('printAllOrb').hidden = true;
  try {
    const imagePath = await ensureImage();
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
    } else if (S.scanMode === 'multi' && S.pageMode === 'whole') {
      setOrb('grade', '整页直读', `${S.collectPages.length} 页一起提交（单次请求）`);
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
  if (S.scanMode === 'multi') startMulti();
  else runAuto();
};
$('btnNextPage').onclick = scanNextPage;
$('btnStartGrade').onclick = gradeCollected;
$('btnClear').onclick = () => resetAll();

// 扫描方式：单页 / 多页（记住选择）
document.querySelectorAll('#segScan button').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('#segScan button').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    S.scanMode = btn.dataset.scan;
    API.setConfig({ scanMode: S.scanMode });
  };
});

// 扫描标准答案纸，自动整理成「题号. 答案」追加到输入框
$('btnScanAnswer').onclick = async () => {
  if (S.busy) return;
  busy(true);
  try {
    const p = await scanOnce();
    setOrb('scan', '正在识别标准答案', '');
    const text = await API.answerScan(p);
    const cur = $('stdAnswer').value.trim();
    $('stdAnswer').value = (cur ? cur + '\n' : '') + String(text || '').trim();
    $('mStd').value = $('stdAnswer').value;
    setOrb(null, '标准答案已填入', '可继续扫描答案纸，或点球开始');
  } catch (e) {
    setOrb(null, '出错了', e.message);
  } finally {
    busy(false);
  }
};

/* ---------------- 手动模式 ---------------- */
$('mScan').onclick = async () => {
  busy(true);
  try {
    setOrb('discover', '正在寻找扫描仪', '');
    const host = await API.discover();
    if (!host) throw new Error('没找到扫描仪');
    setOrb('scan', '正在扫描', '');
    setImage(await API.scanPage(host));
    setOrb(null, '扫描完成', '可以开始切题');
  } catch (e) { setOrb(null, '出错了', e.message); }
  finally { busy(false); }
};

$('mPick').onclick = async () => {
  const p = await API.pickImage();
  if (p) { setImage(p); setOrb(null, '已载入图片', p.split('/').pop()); }
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

// 记住上次的选择：自动打印、批改范围、标记位置，下次打开保持不变
function pickSeg(sel, key, val) {
  document.querySelectorAll(sel + ' button').forEach(b => {
    b.classList.toggle('on', b.dataset[key] === val);
  });
}
(async () => {
  try {
    const cfg = await API.getConfig();
    if (typeof cfg.autoPrint === 'boolean') $('optPrint').checked = cfg.autoPrint;
    if (typeof cfg.reviewOn === 'boolean') {
      S.reviewOn = cfg.reviewOn;
      pickSeg('#segReview', 'review', cfg.reviewOn ? 'on' : 'off');
    }
    if (Number.isFinite(Number(cfg.reviewRounds)) && Number(cfg.reviewRounds) >= 1) {
      S.reviewRounds = Math.min(3, Number(cfg.reviewRounds));
      $('reviewRounds').value = S.reviewRounds;
    }
    if (cfg.scanMode === 'multi' || cfg.scanMode === 'single') {
      S.scanMode = cfg.scanMode;
      pickSeg('#segScan', 'scan', cfg.scanMode);
    }
    if (cfg.pageMode === 'whole' || cfg.pageMode === 'split' || cfg.pageMode === 'locate') {
      S.pageMode = cfg.pageMode;
      pickSeg('#segPage', 'page', cfg.pageMode);
    }
    if (cfg.markSide === 'right' || cfg.markSide === 'question' || cfg.markSide === 'number') {
      S.markSide = cfg.markSide;
      pickSeg('#segMark', 'side', cfg.markSide);
    }
    if (cfg.printImpose === 'on' || cfg.printImpose === 'off') S.impose = cfg.printImpose;
    if (typeof cfg.deepGrab === 'boolean') {
      S.deepGrab = cfg.deepGrab;
      pickSeg('#segDeep', 'deep', cfg.deepGrab ? 'on' : 'off');
    }
  } catch (_) { /* 首次运行无配置 */ }
})();
$('optPrint').addEventListener('change', () => {
  API.setConfig({ autoPrint: $('optPrint').checked });
});
