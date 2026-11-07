const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const sharp = require('sharp');

// 限制 sharp 的内存缓存，避免长时间运行后内存缓慢上涨
sharp.cache({ files: 0, items: 0, memory: 24 });
sharp.concurrency(Math.min(2, os.cpus().length || 1));

// 先把配置里的 API Key 注入环境，再加载批改模块（模块加载时就会读取 Key）
(function bootstrapKeys() {
  try {
    const p = path.join(app.getPath('userData'), 'config.json');
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (c.apiKeys && !process.env.GRADER_API_KEYS) process.env.GRADER_API_KEYS = c.apiKeys;
  } catch (_) { /* 首次运行没有配置，忽略 */ }
})();

const { discover, scan, scannerStatus, printerInfo, clearQueue, testPrint } = require('./core/scan');
const { runPipeline, runWholeBatch, runEssayBatch, splitPage, gradeOne, pageInfo } = require('./core/pipeline');
const { runAgent } = require('./core/drawagent');
const { prepareImage } = require('./core/prepare');
const { render } = require('./core/render');
const { configure, chat } = require('./core/grade');

let win = null;
app.setName('exam-grader');
// 固定数据目录，避免改名后配置/历史"消失"（沿用 exam-grader 目录）
const DATA_DIR = path.join(app.getPath('appData'), 'exam-grader');
const A4_W = 2480;
const A4_H = 3508;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
app.setPath('userData', DATA_DIR);

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 900, minWidth: 980, minHeight: 680,
    backgroundColor: '#0e1013',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'ui/index.html'));
  win.webContents.on('console-message', (...a) => {
    const m = a.find(x => typeof x === 'string');
    console.log('[renderer]', m);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => console.log('[fail-load]', code, desc));
  win.webContents.on('preload-error', (_e, p, err) => console.log('[preload-error]', p, err && err.message));
}

app.whenReady().then(() => {
  outDir(); histDir();
  sweepTemp();
  // 用本机已保存的设置初始化模型客户端（地址/模型/Key 不写死在代码里）
  const saved = loadCfg();
  configure({ baseUrl: saved.baseUrl, model: saved.model, apiKeys: saved.apiKeys });
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

const stage = payload => win && win.webContents.send('stage', payload);
const BASE_DIR = app.getPath('userData');
const cfgPath = () => path.join(BASE_DIR, 'config.json');
// 已废弃的旧配置项（新架构不再区分这些），启动时顺手从配置文件里清掉
const DEAD_CFG = ['pageMode', 'markSide', 'reviewOn', 'reviewRounds', 'deepGrab', 'scanMode', 'gradeMode'];
let cfgCleaned = false;
function loadCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
    if (!cfgCleaned) {
      cfgCleaned = true;
      let dirty = false;
      for (const k of DEAD_CFG) if (k in c) { delete c[k]; dirty = true; }
      if (dirty) fs.writeFileSync(cfgPath(), JSON.stringify(c, null, 2));
    }
    return c;
  } catch (_) { return {}; }
}
function saveCfg(patch) {
  const c = { ...loadCfg(), ...patch };
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  fs.writeFileSync(cfgPath(), JSON.stringify(c, null, 2));
  return c;
}

// 存储根目录：默认 userData，可在设置里改到任意目录
function dataRoot() {
  const d = (loadCfg().storageDir || '').trim();
  return d || BASE_DIR;
}
function outDir() {
  const d = path.join(dataRoot(), 'out');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function histDir() {
  const d = path.join(dataRoot(), 'history');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const tmp = name => path.join(outDir(), name);

// 批改结果统一存到 history，左栏历史列表从这里读；清空当前不影响历史
// 同一毫秒内连续创建多个历史项时（多页批改）必须保证 id 唯一，否则后一页会覆盖前一页
let lastHistId = 0;
function newHistory(kind) {
  const now = Date.now();
  lastHistId = now > lastHistId ? now : lastHistId + 1;
  const id = `${lastHistId}`;
  return { id, file: path.join(histDir(), `${kind}_${id}.jpg`) };
}
function writeHistory(meta) {
  try {
    fs.writeFileSync(path.join(histDir(), meta.id + '.json'), JSON.stringify(meta, null, 2));
  } catch (e) { dlog('history write failed: ' + e.message); }
}
function dlog(msg) {
  try { fs.appendFileSync('/tmp/exam-grader.log', `${new Date().toISOString()} ${msg}\n`); } catch (_) {}
  console.log(msg);
}

// 启动时清掉 24 小时前的临时扫描/切块图，避免 out 目录无限增长
function sweepTemp() {
  try {
    const d = outDir();
    const now = Date.now();
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && now - st.mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(p);
      } catch (_) {}
    }
  } catch (_) {}
}

ipcMain.handle('config-get', async () => loadCfg());
ipcMain.handle('prompt-defaults', async () => require('./core/prompts').MASTER_DEFAULTS);
ipcMain.handle('config-set', async (_e, patch) => {
  const c = saveCfg(patch);
  configure({ baseUrl: c.baseUrl, model: c.model, apiKeys: c.apiKeys });
  return c;
});

ipcMain.handle('model-test', async (_e, { baseUrl, model, apiKeys }) => {
  const b = (baseUrl || '').trim() || 'https://api.openai.com/v1/chat/completions';
  const base = b.replace(/\/chat\/completions\/?$/, '');
  const key = (apiKeys || '').split(',').map(s => s.trim()).filter(Boolean)[0];
  const headers = key ? { Authorization: `Bearer ${key}` } : {};

  let models = [];
  try {
    const r = await fetch(`${base}/models`, { headers });
    if (!r.ok) return { ok: false, message: `模型列表返回 ${r.status}` };
    const j = await r.json();
    models = (j.data || []).map(m => m.id);
  } catch (e) {
    return { ok: false, message: `连不上：${e.message}` };
  }

  // 用 1×1 像素图探测该模型是否真的能读图
  const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  let vision = null, visionMsg = '';
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 8,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '只回一个字' },
            { type: 'image_url', image_url: { url: px } },
          ],
        }],
      }),
    });
    const t = await r.text();
    if (!r.ok) { vision = false; visionMsg = t.slice(0, 200); } else vision = true;
  } catch (e) { vision = false; visionMsg = e.message; }

  return { ok: true, models, found: models.includes(model), vision, visionMsg };
});

// 启动时把配置里的模型参数应用到批改模块
(function applyModelConfig() {
  const c = loadCfg();
  configure({ baseUrl: c.baseUrl, model: c.model, apiKeys: c.apiKeys });
})();

ipcMain.handle('scanner-status', async (_e, host) => {
  const h = host || loadCfg().scannerHost;
  if (!h) return { ok: false, error: '还没有配置扫描仪地址' };
  return scannerStatus(h);
});

ipcMain.handle('printer-info', async () => printerInfo());
ipcMain.handle('clear-queue', async () => clearQueue());
ipcMain.handle('test-print', async () => {
  const p = path.join(os.tmpdir(), `print_test_${Date.now()}.txt`);
  fs.writeFileSync(p, `试卷批改 · 打印测试\n\n${new Date().toLocaleString('zh-CN')}\n`);
  await printFile(p);
  return p;
});

ipcMain.handle('discover', async () => {
  const cfg = loadCfg();
  if (cfg.scannerHost) {
    const s = await scannerStatus(cfg.scannerHost);
    if (s.ok) return cfg.scannerHost;
  }
  stage({ stage: 'discover', label: '搜索扫描仪' });
  const ips = await discover(() => {});
  if (ips[0]) saveCfg({ scannerHost: ips[0] });
  dlog(`discover -> ${JSON.stringify(ips)}`);
  return ips[0] || null;
});

ipcMain.handle('pick-image', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'tif', 'tiff'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

// 多页一次选图（作文两页、整套卷子）
ipcMain.handle('pick-images', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'tif', 'tiff'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('scan-page', async (_e, host) => {
  dlog(`scan-page host=${JSON.stringify(host)}`);
  const out = tmp(`scan_${Date.now()}.jpg`);
  stage({ stage: 'scan', label: '正在扫描…' });
  await scan({ host, out, dpi: 300, onProgress: m => stage({ stage: 'scan', label: m }) });
  stage({ stage: 'scan', label: '扫描完成', progress: 1 });
  return out;
});

ipcMain.handle('answer-scan', async (_e, imagePath) => {
  stage({ stage: 'grade', label: '识别标准答案' });
  const buf = await sharp(imagePath)
    .resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();
  const dataUrl = 'data:image/jpeg;base64,' + buf.toString('base64');
  const prompt = `这是一张标准答案/参考答案纸的扫描图。请把所有题的答案整理成纯文本，供批改使用。

要求：
1. 每行一题，格式「题号. 答案」，题号用阿拉伯数字。
2. 一道题多个空时，按空的顺序用 / 分隔，例如「12. 3 / 5 / 2」。
3. 选择题直接写字母；判断题写对/错；计算题写最终结果，保留必要单位。
4. 只抄写图上已有的答案，不要自己解题，不要补充图片里没有的内容。
5. 看不清的答案写「?」，不要猜。
6. 不要输出任何解释、标题或多余文字，只输出答案行。`;
  const reply = await chat(prompt, dataUrl, { maxTokens: 1600, retries: 3 });
  const text = String(reply || '').replace(/```[a-z]*|```/g, '').trim();
  stage({ stage: 'grade', label: '标准答案识别完成', progress: 1 });
  return text;
});

ipcMain.handle('split', async (_e, imagePath) => {
  const { page, blocks, imagePath: prepared, rotation, cropped } = await splitPage(imagePath, s => stage(s));
  return { page, blocks, imagePath: prepared, rotation, cropped };
});

ipcMain.handle('grade-one', async (_e, { imagePath, page, block, options }) => {
  stage({ stage: 'grade', label: `批改第 ${block.no} 题` });
  const { result, mark } = await gradeOne({ imagePath, page, block, options });
  stage({ stage: 'grade', label: `第 ${block.no} 题 ${result.verdict}`, progress: 1 });
  return { result, mark };
});

ipcMain.handle('render-marks', async (_e, { imagePath, marks, options, results }) => {
  const { id, file } = newHistory('manual');
  const page = await pageInfo(imagePath);
  await render(imagePath, page, marks, file, (options || {}).render || {});
  writeHistory({
    id,
    kind: 'manual',
    createdAt: Date.now(),
    mode: 'exam',
    count: (results || marks || []).length,
    results: results || [],
    imagePath,
    resultPath: file,
  });
  return file;
});

ipcMain.handle('render-debug', async (_e, { imagePath, blocks, marks, options }) => {
  const out = tmp(`debug_${Date.now()}.png`);
  const page = await pageInfo(imagePath);
  const o = { ...((options || {}).render || {}) };
  if (blocks && blocks.length) o.boxes = blocks;
  await render(imagePath, page, marks || [], out, o);
  return out;
});

ipcMain.handle('crop-block', async (_e, { imagePath, block }) => {
  const out = tmp(`block_${block.no}_${Date.now()}.png`);
  const meta = await sharp(imagePath).metadata();
  const left = Math.max(0, block.x0 || 0);
  const top = Math.max(0, block.y0);
  const width = Math.min(meta.width - left, (block.x1 || meta.width) - left);
  const height = Math.min(meta.height - top, block.y1 - top);
  await sharp(imagePath).extract({ left, top, width, height }).png().toFile(out);
  return out;
});

// 批改引擎：默认走新的"绘图 agent"，设置 engine=legacy 可回退旧管线（旧代码全部保留）
function engine() {
  return (loadCfg().engine === 'legacy') ? 'legacy' : 'agent';
}
function agentMode(options) {
  const m = (options || {}).mode;
  if (m === 'essay') return 'essay';
  if (m === 'whole') return 'whole';
  return 'exam';
}

// 回退旧管线时补齐旧参数（新界面不再提供这些开关）
const legacyOptions = o => ({
  ...o,
  gradeMode: 'precise',
  pageMode: 'split',
  markSide: 'right',
  reviewRounds: 1,
  deepGrab: false,
});

// 批改前先摆正 + 裁掉空白边（新引擎直接用处理后的图去批、去画）
async function preparePaths(paths) {
  const out = [];
  for (const p of paths) out.push((await prepareImage(p, stage)).imagePath);
  return out;
}

ipcMain.handle('auto', async (_e, { imagePath, options }) => {
  const { id, file } = newHistory('auto');
  const t0 = Date.now();
  let mode = agentMode(options);
  let results = [], summary = null;
  if (engine() === 'legacy') {
    const res = await runPipeline({ imagePath, outPath: file, options: legacyOptions(options), onStage: stage });
    mode = res.mode || 'exam';
    results = res.results || [];
    summary = res.summary || null;
    imagePath = res.imagePath || imagePath;
  } else {
    imagePath = (await preparePaths([imagePath]))[0];
    const res = await runAgent({ imagePaths: [imagePath], outPaths: [file], mode, options, onStage: stage });
    results = res.results || [];
    summary = res.summary || null;
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  const meta = {
    id,
    kind: 'auto',
    createdAt: Date.now(),
    mode,
    seconds,
    count: results.length,
    summary,
    results,
    imagePath,
    resultPath: file,
  };
  writeHistory(meta);
  return { out: file, results, mode, summary, seconds };
});

ipcMain.handle('auto-multi-whole', async (_e, { imagePaths, options }) => {
  const items = imagePaths.map(() => newHistory('auto'));
  const t0 = Date.now();
  let pages = [];
  if (engine() === 'legacy') {
    const res = await runWholeBatch({
      imagePaths,
      outPaths: items.map(x => x.file),
      options: legacyOptions(options),
      onStage: stage,
    });
    pages = res.pages.map((p, i) => ({
      out: items[i].file,
      results: p.results || [],
      mode: p.mode || 'whole',
      summary: res.comment || null,
      seconds: 0,
    }));
  } else {
    imagePaths = await preparePaths(imagePaths);
    const mode = agentMode(options);
    const res = await runAgent({
      imagePaths,
      outPaths: items.map(x => x.file),
      mode,
      options,
      onStage: stage,
    });
    pages = res.pages.map(p => ({
      out: p.out,
      results: p.results || [],
      mode,
      summary: res.summary ? (res.summary.comment || '') : '',
      seconds: 0,
    }));
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  pages.forEach((p, i) => {
    writeHistory({
      id: items[i].id,
      kind: 'auto',
      createdAt: Date.now(),
      mode: p.mode || 'whole',
      seconds,
      count: (p.results || []).length,
      summary: p.summary || null,
      results: p.results || [],
      imagePath: imagePaths[i],
      resultPath: items[i].file,
      batch: imagePaths.length,
      batchIndex: i + 1,
    });
    p.seconds = seconds;
  });
  return { pages, seconds, mode: pages[0] && pages[0].mode };
});

ipcMain.handle('auto-multi-essay', async (_e, { imagePaths, options }) => {
  const items = imagePaths.map(() => newHistory('auto'));
  const t0 = Date.now();
  let summary = null;
  let res;
  if (engine() === 'legacy') {
    res = await runEssayBatch({
      imagePaths,
      outPaths: items.map(x => x.file),
      options: legacyOptions({ ...(options || {}), mode: 'essay' }),
      onStage: stage,
    });
    summary = res.summary || null;
  } else {
    imagePaths = await preparePaths(imagePaths);
    res = await runAgent({
      imagePaths,
      outPaths: items.map(x => x.file),
      mode: 'essay',
      options: { ...(options || {}), mode: 'essay' },
      onStage: stage,
    });
    summary = res.summary || null;
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  const pages = res.pages.map((p, i) => {
    const meta = {
      id: items[i].id,
      kind: 'auto',
      createdAt: Date.now(),
      mode: 'essay',
      seconds,
      count: 0,
      summary,
      results: [],
      imagePath: imagePaths[i],
      resultPath: items[i].file,
      batch: imagePaths.length,
      batchIndex: i + 1,
    };
    writeHistory(meta);
    return {
      out: items[i].file,
      results: [],
      mode: 'essay',
      summary,
      seconds,
    };
  });
  return { pages, seconds, mode: 'essay', summary, summaryPage: imagePaths.length };
});

ipcMain.handle('make-sheets', async (_e, imagePaths) => {
  const paths = (imagePaths || []).filter(p => p && fs.existsSync(p));
  if (!paths.length) return [];
  if (paths.length === 1) return [{ path: paths[0], indexes: [0] }];

  const metas = await Promise.all(paths.map(p => sharp(p).metadata()));
  const aspects = metas.map(m => (m.width || 1) / (m.height || 1)).sort((a, b) => a - b);
  const pageAspect = aspects[Math.floor(aspects.length / 2)] || 0.707;
  let best = null;
  for (let cols = 1; cols <= 4; cols++) {
    for (let rows = 1; rows <= 4; rows++) {
      const cells = cols * rows;
      if (cells > 4 || cells < paths.length) continue;
      const cellAspect = (cols / rows) * (A4_W / A4_H) / pageAspect;
      const distortion = Math.abs(Math.log(cellAspect));
      if (!best || distortion < best.distortion - 1e-9 ||
        (Math.abs(distortion - best.distortion) < 1e-9 && cells < best.cells)) {
        best = { cols, rows, distortion, cells };
      }
    }
  }
  const { cols, rows } = best || { cols: 1, rows: 1 };

  const dir = path.join(DATA_DIR, 'sheets');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.jpg')) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} }
  }

  const out = [];
  for (let start = 0; start < paths.length; start += 4) {
    const group = paths.slice(start, start + 4);
    const sheet = sharp({ create: { width: A4_W, height: A4_H, channels: 3, background: '#ffffff' } });
    const composites = [];
    for (let i = 0; i < group.length; i++) {
      const c = i % cols, r = Math.floor(i / cols);
      const cellW = A4_W / cols, cellH = A4_H / rows;
      const buf = await sharp(group[i])
        .resize({
          width: Math.max(1, Math.floor(cellW - 32)),
          height: Math.max(1, Math.floor(cellH - 32)),
          fit: 'inside',
          withoutEnlargement: false,
        })
        .jpeg({ quality: 92 })
        .toBuffer();
      const m = await sharp(buf).metadata();
      composites.push({
        input: buf,
        left: Math.round(c * cellW + (cellW - m.width) / 2),
        top: Math.round(r * cellH + (cellH - m.height) / 2),
      });
    }
    const file = path.join(dir, `sheet-${Date.now()}-${start / 4 + 1}.jpg`);
    await sheet.composite(composites).jpeg({ quality: 92 }).toFile(file);
    out.push({ path: file, indexes: group.map((_, i) => start + i) });
  }
  return out;
});

ipcMain.handle('history-list', async () => {
  const dir = histDir();
  const items = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (m && m.id && m.resultPath && fs.existsSync(m.resultPath)) items.push(m);
    } catch (_) { /* 坏文件跳过 */ }
  }
  items.sort((a, b) => b.createdAt - a.createdAt);
  return items;
});

ipcMain.handle('history-delete', async (_e, id) => {
  if (!id) return false;
  const dir = histDir();
  const jf = path.join(dir, id + '.json');
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(jf, 'utf8')); } catch (_) {}
  try { if (fs.existsSync(jf)) fs.unlinkSync(jf); } catch (_) {}
  if (meta && meta.resultPath) {
    try { if (fs.existsSync(meta.resultPath)) fs.unlinkSync(meta.resultPath); } catch (_) {}
  }
  return true;
});

ipcMain.handle('storage-info', async () => {
  const root = dataRoot();
  const out = outDir();
  const hist = histDir();
  let bytes = 0, files = 0;
  for (const d of [out, hist]) {
    try {
      for (const f of fs.readdirSync(d)) {
        try { const st = fs.statSync(path.join(d, f)); if (st.isFile()) { bytes += st.size; files++; } } catch (_) {}
      }
    } catch (_) {}
  }
  return { dir: root, out, hist, bytes, files };
});

ipcMain.handle('storage-choose', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = r.filePaths[0];
  saveCfg({ storageDir: dir });
  outDir(); histDir();
  return dir;
});

ipcMain.handle('storage-open', async () => {
  await shell.openPath(dataRoot());
  return true;
});

ipcMain.handle('cleanup-temp', async () => {
  const d = outDir();
  let files = 0, bytes = 0;
  try {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        fs.unlinkSync(p);
        files++; bytes += st.size;
      } catch (_) {}
    }
  } catch (_) {}
  return { files, bytes };
});

ipcMain.handle('open-file', async (_e, p) => {
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
});

// 打印参数：普通纸 + 速度档 + 黑白/彩色 + 指定打印机
function printArgs(file, qualityOverride) {
  const c = loadCfg();
  const a = [];
  if (c.printerName) a.push('-d', c.printerName);
  a.push('-o', 'fit-to-page');
  a.push('-o', 'PageSize=A4');
  // 强制普通纸，避免驱动把 JPEG 当成照片走慢速高精度路径
  a.push('-o', 'MediaType=stationery');
  const q = { draft: 'Draft', normal: 'Normal', high: 'High' }[qualityOverride || c.printQuality] || 'Draft';
  a.push('-o', `cupsPrintQuality=${q}`);
  a.push('-o', `ColorModel=${c.printColor === 'mono' ? 'Gray' : 'RGB'}`);
  a.push(file);
  return a;
}
function lp(argv) {
  return new Promise((resolve, reject) => {
    execFile('lp', argv, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || '') + err.message));
      else resolve(stdout);
    });
  });
}

async function printFile(file) {
  if (!file || !fs.existsSync(file)) throw new Error('文件不存在');
  stage({ stage: 'print', label: '发送到打印机' });
  const args = printArgs(file);
  try {
    await lp(args);
  } catch (e) {
    // 部分驱动没有 Draft 档（如 Epson），退回标准档再试一次
    const draft = String(loadCfg().printQuality || 'draft') === 'draft';
    if (draft) {
      try { await lp(printArgs(file, 'normal')); } catch (_) { throw e; }
    } else {
      throw e;
    }
  }
  stage({ stage: 'print', label: '打印完成', progress: 1 });
  return true;
}

ipcMain.handle('print', async (_e, p) => printFile(p));
