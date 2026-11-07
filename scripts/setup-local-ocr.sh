#!/usr/bin/env bash
# 下载 Xiaomi-OCR-0（4bit GGUF）到应用数据目录，供"逐空精确批改"使用
set -euo pipefail

DIR="$HOME/Library/Application Support/exam-grader/models/xiaomi-ocr-0"
BASE="https://huggingface.co/prithivMLmods/Xiaomi-OCR-0-GGUF/resolve/main"

mkdir -p "$DIR"
cd "$DIR"

if ! command -v llama-server >/dev/null 2>&1 && [ ! -x /opt/homebrew/bin/llama-server ]; then
  echo "未找到 llama-server。请先安装：brew install llama.cpp"
  exit 1
fi

for f in "Xiaomi-OCR-0.Q4_K_M.gguf" "Xiaomi-OCR-0.mmproj-bf16.gguf"; do
  if [ -f "$f" ] && [ "$(stat -f%z "$f")" -gt 100000000 ]; then
    echo "已存在：$f"
    continue
  fi
  echo "下载 $f …"
  curl --http1.1 -L --retry 8 --retry-all-errors -o "$f" "$BASE/$f"
done

mv -f "Xiaomi-OCR-0.mmproj-bf16.gguf" mmproj.gguf 2>/dev/null || true
ls -lh "$DIR"
echo "完成。在应用「设置 → 本地 OCR」里点「启动服务」即可。"
