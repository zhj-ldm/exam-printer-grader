// 本地 OCR 客户端：兼容 OpenAI 协议（llama.cpp server / LM Studio / Ollama）
// 用途：整页预处理，把题干、题号、空位、手写答案转成文本，作为判卷上下文
const fs = require('fs');
const sharp = require('sharp');

const runtime = {
  enabled: false,
  url: 'http://127.0.0.1:18080/v1/chat/completions',
  model: 'Xiaomi-OCR-0',
};

function configureLocal({ enabled, url, model } = {}) {
  if (enabled !== undefined) runtime.enabled = !!enabled;
  if (url && url.trim()) runtime.url = url.trim();
  if (model && model.trim()) runtime.model = model.trim();
  return { ...runtime };
}

const PAGE_PROMPT = `请逐字识别这张试卷扫描图，输出 Markdown：
- 保留原始题号与层级顺序；
- 选择题保留选项；
- 填空/横线处如果学生写有内容，用【学生：xxx】标出；空着写【空】；
- 数学、化学公式用 LaTeX；
- 不要总结、不要解题，只做转写。`;

async function readPage(imagePath, { timeoutMs = 180000 } = {}) {
  if (!runtime.enabled) return null;
  let buf;
  try {
    buf = await sharp(imagePath)
      .rotate()
      .resize({ width: 1280, withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch (_) { return null; }

  const body = {
    model: runtime.model,
    temperature: 0,
    max_tokens: 1600,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PAGE_PROMPT },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + buf.toString('base64') } },
      ],
    }],
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(runtime.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { readPage, configureLocal };
