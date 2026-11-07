// 打印机 eSCL 扫描（纯 HTTP，无需驱动）
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');

const A4_W = 2480, A4_H = 3508;

function post(url, xml, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname,
      method: 'POST', timeout,
      headers: { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(xml);
    req.end();
  });
}

function get(url, timeout = 90000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'GET', timeout }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function settings({ dpi = 300, mode = 'RGB24', w = A4_W, h = A4_H, intent = 'Document' }) {
  // 顺序很关键：ScanRegions 必须在 DocumentFormat 之前，Intent 放最后，否则 HP 静默降级到 72dpi
  return `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.6</pwg:Version>
  <pwg:ScanRegions>
    <pwg:ScanRegion>
      <pwg:ContentRegion>
        <pwg:XOffset>0</pwg:XOffset><pwg:YOffset>0</pwg:YOffset>
        <pwg:Width>${w}</pwg:Width><pwg:Height>${h}</pwg:Height>
      </pwg:ContentRegion>
      <pwg:InputSource>Platen</pwg:InputSource>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
  <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>
  <scan:ColorMode>${mode}</scan:ColorMode>
  <scan:XResolution>${dpi}</scan:XResolution>
  <scan:YResolution>${dpi}</scan:YResolution>
  <scan:Intent>${intent}</scan:Intent>
</scan:ScanSettings>`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function scan({ host, out, dpi = 300, mode = 'RGB24', onProgress = () => {} }) {
  if (!host || typeof host !== 'string') throw new Error('扫描仪地址为空，请在设置里填写或点「自动发现」');
  const base = host.startsWith('http') ? host : `http://${host}`;
  onProgress('提交扫描任务…');

  let res;
  let job = null;
  for (let i = 0; i < 12; i++) {
    res = await post(`${base}/eSCL/ScanJobs`, settings({ dpi, mode }));
    if (res.status === 201 && (res.headers.location || res.headers.Location)) {
      job = res.headers.location || res.headers.Location;
      break;
    }
    if (res.status === 503) { onProgress('设备忙，等待上一张释放…'); await sleep(2000); continue; }
    throw new Error(`提交扫描任务失败 ${res.status}: ${res.body.toString().slice(0, 160)}`);
  }
  if (!job) throw new Error('扫描仪一直处于忙状态，请等几秒或重新开关机后再试');
  if (job.startsWith('/')) job = base + job;
  if (!/^http/.test(job)) job = base + job;

  onProgress('扫描中…');
  for (let i = 0; i < 150; i++) {
    const r = await get(job + '/NextDocument');
    if (r.status === 200 && r.body.length > 1000) {
      fs.writeFileSync(out, r.body);
      onProgress(`完成 ${Math.round(r.body.length / 1024)}KB`);
      return out;
    }
    if (r.status === 503) { await sleep(800); continue; }
    throw new Error(`取图失败 ${r.status}`);
  }
  throw new Error('扫描超时');
}

function localPrefix() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address.split('.').slice(0, 3).join('.');
    }
  }
  return '192.168.1';
}

async function discover(onProgress = () => {}) {
  const prefix = localPrefix();
  onProgress('搜索局域网扫描仪…');
  const ips = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
  const found = [];
  const batch = 64;
  for (let i = 0; i < ips.length; i += batch) {
    const slice = ips.slice(i, i + batch);
    await Promise.all(slice.map(async ip => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 500);
        const r = await fetch(`http://${ip}/eSCL/ScannerCapabilities`, { signal: ctrl.signal });
        clearTimeout(t);
        if (r.ok) found.push(ip);
      } catch (_) { /* ignore */ }
    }));
    if (found.length) break;
  }
  return found;
}

const { execFile } = require('child_process');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout || '');
    });
  });
}

async function scannerStatus(host) {
  const base = host.startsWith('http') ? host : `http://${host}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const [cap, st] = await Promise.all([
      fetch(`${base}/eSCL/ScannerCapabilities`, { signal: ctrl.signal }).then(r => r.text()),
      fetch(`${base}/eSCL/ScannerStatus`, { signal: ctrl.signal }).then(r => r.text()),
    ]);
    const model = (cap.match(/<pwg:MakeAndModel>([^<]+)</) || cap.match(/<pwg:MakeModel>([^<]+)</) || [])[1] || '未知设备';
    const state = (st.match(/<(?:pwg:|scan:)?State>([^<]+)</) || [])[1] || 'unknown';
    const dpiList = [...cap.matchAll(/<scan:XResolution>(\d+)</g)].map(m => +m[1]);
    return {
      ok: true,
      host,
      model,
      state,
      platen: cap.includes('Platen'),
      adf: cap.includes('ADF'),
      maxDpi: dpiList.length ? Math.max(...dpiList) : 0,
      resolutions: [...new Set(dpiList)].sort((a, b) => a - b),
    };
  } catch (e) {
    return { ok: false, host, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function printerInfo() {
  const info = { defaultPrinter: '', printers: [], jobs: [] };
  try {
    const out = await run('lpstat', ['-p', '-d']);
    const dp = out.match(/(?:系统默认目的位置|system default destination)\s*[：:]\s*(\S+)/);
    if (dp) info.defaultPrinter = dp[1].trim();
    info.printers = out.split('\n')
      .map(line => line.match(/^(?:打印机|printer)\s*(\S+?)(闲置|停用|正在|is idle|is printing|disabled)/))
      .filter(Boolean)
      .map(m => ({
        name: m[1],
        state: /停用|disabled/.test(m[2]) ? 'disabled' : 'idle',
      }));
  } catch (e) { info.error = e.message; }
  try {
    const q = await run('lpstat', ['-o']);
    info.jobs = q.trim().split('\n').filter(Boolean).map(line => {
      const id = line.split(/\s+/)[0];
      return { id, name: line.slice(id.length).trim() };
    });
  } catch (_) { /* 空队列会返回非零码，忽略 */ }
  return info;
}

async function clearQueue() {
  const info = await printerInfo();
  for (const j of info.jobs) {
    try { await run('cancel', [j.id]); } catch (_) { /* ignore */ }
  }
  return info.jobs.length;
}

async function testPrint(text = '试卷批改 · 打印测试') {
  const p = path.join(os.tmpdir(), `print_test_${Date.now()}.txt`);
  fs.writeFileSync(p, `${text}\n\n${new Date().toLocaleString('zh-CN')}\n`);
  await run('lp', [p]);
  return p;
}

module.exports = { scan, discover, scannerStatus, printerInfo, clearQueue, testPrint };
