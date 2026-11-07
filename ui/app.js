const $ = id => document.getElementById(id);
const API = window.api;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const S = {
  mode: 'auto',
  imagePath: null,
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
  document.body.classList.remove('result');
  document.body.classList.add('view');
  $('resultImg').src = 'file://' + h.resultPath + '?t=' + Date.now();
  paintHistory();
}

$('btnPrev').onclick = () => { if (S.histIndex >= 0) showHistory(Math.min(S.history.length - 1, S.histIndex + 1)); };
$('btnNext').onclick = () => { if (S.histIndex > 0) showHistory(S.histIndex - 1); };

/* ---------------- 视图切换 ---------------- */
function enterResult(path) {
  S.resultMode = true;
  document.body.classList.remove('view');
  document.body.classList.add('result');
  $('resultImg').src = 'file://' + path + '?t=' + Date.now();
  clearBg(); // 释放大图内存

  // 开始时没勾「批完打印」，就在成品页留一个打印圆球
  const po = $('printOrb');
  po.hidden = !!S.autoPrinted;
  po.disabled = S.printed;
  po.querySelector('.result-orb-text').textContent = S.printed ? '已打印' : '打印';
}

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
  if (!S.resultPath || S.printed) return;
  const po = $('printOrb');
  const txt = po.querySelector('.result-orb-text');
  po.disabled = true;
  txt.textContent = '打印中';
  try {
    await API.print(S.resultPath);
    S.printed = true;
    txt.textContent = '已打印';
  } catch (e) {
    po.disabled = false;
    txt.textContent = '打印失败';
    setTimeout(() => { if (!S.printed) txt.textContent = '打印'; }, 1800);
  }
};

function resetAll() {
  if (S.busy) return;
  backToOrb();
  S.imagePath = null; S.page = null; S.blocks = [];
  S.results = []; S.marks = []; S.resultPath = null; S.histIndex = -1;
  S.printed = false; S.autoPrinted = false;
  $('printOrb').hidden = true;
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
    standardAnswer: $('stdAnswer').value,
    extraPrompt: $('extraPrompt').value,
    render: {
      ticks: isOn('optTick'),
      comments: isOn('optComment'),
      answers: isOn('optAnswer'),
    },
  };
}

function optionsManual() {
  return {
    mode: $('optType').value,
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

function syncFields(a, b) {
  $(a).addEventListener('input', () => { $(b).value = $(a).value; });
  $(b).addEventListener('input', () => { $(a).value = $(b).value; });
}
syncFields('stdAnswer', 'mStd');
syncFields('extraPrompt', 'mExtra');

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

/* ---------------- 自动模式：点球开始 ---------------- */
async function ensureImage() {
  if (S.imagePath) return S.imagePath;
  setOrb('discover', '正在寻找扫描仪', '');
  const host = await API.discover();
  if (!host) throw new Error('没找到扫描仪，请在设置里配置地址，或用手动模式选图');
  setOrb('scan', '正在扫描', '');
  const p = await API.scanPage(host);
  setImage(p);
  return p;
}

async function runAuto() {
  if (S.busy || S.resultMode) return;
  busy(true);
  $('list').innerHTML = '';
  S.resultPath = null; S.results = []; S.marks = [];
  S.printed = false; S.autoPrinted = false;
  $('printOrb').hidden = true;
  try {
    const imagePath = await ensureImage();
    setOrb('grade', '正在批改', '逐题识别与判定');
    const res = await API.auto({ imagePath, options: options() });
    S.resultPath = res.out;
    S.results = res.results || [];
    showBg(res.out); // 批改图半透明叠在球后
    if (res.mode === 'essay' && res.summary) {
      renderList([]);
      $('list').innerHTML = `<div class="item"><div class="no ok">评</div>
        <div><div>${res.summary.score != null ? '得分 ' + esc(res.summary.score) : '整页评阅'}</div>
        <div class="sub">${esc(res.summary.comment || '')}</div></div></div>`;
      setOrb('done', '评阅完成', res.summary.score != null ? `${res.summary.score} 分 · ${res.seconds}s` : `整页 · ${res.seconds}s`);
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
$('orb').onclick = runAuto;

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
  refreshStorage();
}

// 打印选项改动即保存
function savePrintCfg() {
  return API.setConfig({
    printerName: $('printPrinter').value,
    printQuality: $('printQuality').value,
    printColor: $('printColor').value,
  });
}
['printPrinter', 'printQuality', 'printColor'].forEach(id => { $(id).onchange = savePrintCfg; });

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

// 自动打印开关：记住上次的选择，下次打开软件保持不变
(async () => {
  try {
    const cfg = await API.getConfig();
    if (typeof cfg.autoPrint === 'boolean') $('optPrint').checked = cfg.autoPrint;
  } catch (_) { /* 首次运行无配置 */ }
})();
$('optPrint').addEventListener('change', () => {
  API.setConfig({ autoPrint: $('optPrint').checked });
});
