// 本地版面分析：OCR 找出每行文字框，再用像素校验右侧确实是空白，
// 然后把勾叉打在那块空白里。全程不依赖模型坐标。
const path = require('path');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const w = await createWorker('eng', 1, {
        langPath: path.join(__dirname, '..'),
        gzip: false,
        cacheMethod: 'none',
        logger: () => {},
      });
      await w.setParameters({ tessedit_pageseg_mode: '6' });
      return w;
    })();
  }
  return workerPromise;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

async function markSpot(buf, origin) {
  const o = {
    x0: origin.x0,
    y0: origin.y0,
    w: origin.w,
    h: origin.h,
    y1: origin.y1 ?? (origin.y0 + origin.h),
  };

  const meta = await sharp(buf).metadata();
  const bw = meta.width;
  const bh = meta.height;

  // 灰度小图用于像素校验
  const { data: gray, info: gi } = await sharp(buf)
    .greyscale()
    .resize({ width: 140 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const gw = gi.width, gh = gi.height;
  const toG = (x, y) => [Math.round(x / bw * gw), Math.round(y / bh * gh)];

  const isBlank = (x, y, w, h) => {
    const [gx, gy] = toG(x, y);
    const [gx2, gy2] = toG(x + w, y + h);
    for (let yy = gy; yy < gy2; yy++) {
      for (let xx = gx; xx < gx2; xx++) {
        if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
        if (gray[yy * gw + xx] < 200) return false; // 有任何墨迹就不算空
      }
    }
    return true;
  };

  const w = await getWorker();
  const { data } = await w.recognize(buf, {}, { blocks: true });
  const lines = (data.blocks || [])
    .flatMap(b => (b.paragraphs || []).flatMap(p => p.lines || []))
    .filter(l => l.text && l.text.trim().length >= 2 && l.bbox)
    .sort((a, b) => a.bbox.y0 - b.bbox.y0);

  // 从下往上找：最靠下、且右侧确实空白的文字行（通常就是作答行）
  let pick = null;
  for (const l of lines.reverse()) {
    const { x0, y0, x1, y1 } = l.bbox;
    const lh = Math.max(10, y1 - y0);
    if (x1 > bw * 0.86) continue;        // 写满整行，右边没地
    if (x1 < bw * 0.30) continue;        // 太短，可能是页码/杂符
    if (y1 > bh * 0.95) continue;
    const probeW = lh * 1.6;
    if (!isBlank(x1 + 8, y0 - 4, probeW, lh + 8)) continue;
    pick = { l, lh };
    break;
  }

  if (!pick) {
    return {
      x: Math.round(o.x0 + o.w * 0.74),
      y: Math.round(o.y0 + o.h * 0.5),
      textX: Math.round(o.x0 + o.w * 0.74),
      textY: Math.round(o.y0 + o.h * 0.5 + 46),
    };
  }

  const { l, lh } = pick;
  const sx = o.w / bw, sy = o.h / bh;
  const markX = clamp(Math.round(o.x0 + (l.bbox.x1 + lh * 0.7) * sx), 20, o.x0 + o.w - 20);
  const markY = clamp(Math.round(o.y0 + ((l.bbox.y0 + l.bbox.y1) / 2) * sy), o.y0 + 20, o.y1 - 20);
  const textX = clamp(Math.round(o.x0 + l.bbox.x0 * sx), 40, o.x0 + o.w - 360);
  const textY = clamp(Math.round(markY + lh * sy + 26), 40, o.y1 - 20);
  return { x: markX, y: markY, textX, textY };
}

module.exports = { markSpot };
