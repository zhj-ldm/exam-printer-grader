# 试卷批改 · Exam Printer Grader

[简体中文](README.md) | [English](README.en.md)

> 一个用普通「扫描打印一体机」复刻科大讯飞改题机的桌面系统。

---

## 这是什么

把一张做完的试卷/作业**正面朝上放进打印机的扫描仪**，在电脑上点一下按钮，这套系统会自动完成：

扫描 → 自动摆正 → 裁掉空白边 → OCR 切题 → 逐题交给视觉大模型批改 → 把手写的对勾 / 叉 / 半对 / 批注叠加到卷面上 → 重新打印出来。

它不是"上传一张照片然后 AI 批改"的工具。**整个流程深度绑定打印机**：题目是从扫描仪里自动拿到的，批改结果也是直接从打印机里出来的。目标是用家里最常见的扫描打印一体机，以最低的成本复刻一台"讯飞改题机"。

## 和常见「AI 批改」项目最大的区别

| | 普通 AI 批改项目 | 本项目 |
|---|---|---|
| 输入方式 | 手动拍照 / 上传图片 | 打印机扫描仪自动扫描 |
| 输出方式 | 在屏幕上查看结果、下载图片 | 直接打印成一张新的纸质作业 |
| 硬件关系 | 与打印机无关 | 扫描、打印全流程绑定打印机 |
| 定位 | 图片处理工具 | 家用、低成本的"改题机"替代方案 |

**重要说明：打印出来的是重新打印的一张新作业，相当于把原作业复印一份再批改，而不是在原来那张纸上涂改。**
这是刻意设计：不同纸张、不同打印机、不同装订方式，把原纸再塞回打印机里改，兼容性极差；重新打印一张则可以适配各种作业类型和打印机。

## 演示视频

▶ [播放或下载演示视频](https://github.com/zhj-ldm/exam-printer-grader/releases/download/v1.0.0/exam-grader-demo.mp4)

<video src="https://github.com/zhj-ldm/exam-printer-grader/releases/download/v1.0.0/exam-grader-demo.mp4" poster="https://raw.githubusercontent.com/zhj-ldm/exam-printer-grader/main/assets/demo-poster.jpg" controls width="720"></video>

> 完整流程：把作业放到扫描仪 → 点击按钮 → 自动扫描、批改 → 打印出批改后的新作业。

## 主要功能

- **一键全流程**：一个液态球按钮，自动扫描、切题、批改、出图。
- **自动方向矫正**：纸放反了（180° 倒置）也能自动识别并摆正，切题和批改不受影响。
- **自动裁空白**：识别卷面内容区域，去掉扫描留下的四周空白，打印时内容更大、更省纸。
- **逐题切块**：基于 OCR 题号定位，宁可多切不可少切，避免把题目的最后一行切掉。
- **手写笔迹批改**：对勾一笔连贯、轻微随机抖动；半对是对勾上划一道斜线；叉为两笔错位；支持批注文字。
- **可选项**：是否画对勾、是否写批注、是否标注正确答案、批改完是否自动打印。
- **完成后只看成品**：批改结束进入"成品模式"，界面只留最终批改图，顶部一个按钮清空并开始下一张。
- **历史回看**：每次结果存本地，可回看、上一张/下一张、单条删除；启动时列表为空但文件保留。
- **打印控制**：选择打印机、打印速度（快速/标准/高质量）、彩色/黑白，设置持久化。
- **模型自由**：任何 **OpenAI 兼容协议** 的视觉模型都可以用——云端或本地（LM Studio / Ollama / vLLM 等），不绑定任何厂商。

## 工作原理

```
扫描仪 (eSCL)
   │  HTTP 取图
   ▼
自动摆正 (OCR 分数比对 0° / 180°)
   ▼
裁掉空白 (OCR 文字包围盒 → 裁切)
   ▼
切题 (PaddleOCR 题号识别 → 题块坐标)
   ▼
逐题裁块 + 视觉大模型判分（OpenAI 兼容接口）
   ▼
落点计算 → SVG 手写笔迹 → sharp 合成图片
   ▼
CUPS (lp) 打印 / 保存历史
```

## 环境与安装

### 运行环境

- macOS（当前发布包为 Apple Silicon / arm64）
- 一台支持 **eSCL / AirScan** 的网络扫描仪（绝大多数支持 AirPrint 的一体机都支持）
- 打印机已在「系统设置 → 打印机与扫描仪」中可用

> Windows / Linux：批改、OCR、渲染逻辑本身是跨平台的；但扫描（当前为 eSCL）与打印（当前为 macOS `lp`）需要各自适配，见文末「跨平台说明」。

### 从源码运行

```bash
npm install
npm start
```

### 打包 macOS 应用

```bash
npx @electron/packager . "试卷批改" --platform=darwin --arch=arm64 \
  --out=dist --asar=false --overwrite --prune=true
```

打包前建议删除不需要的平台原生库以减小体积：

```bash
rm -rf node_modules/onnxruntime-node/bin/napi-v6/{linux,win32}
```

## 使用步骤

1. 把作业**正面朝上**放在扫描仪玻璃板上（放反了也能自动纠正）。
2. 打开软件，点击中央的液态球。
3. 软件自动扫描、识别题号、逐题批改。
4. 批改完成后进入成品页，只显示批改后的整页图。
5. 可点「打印」输出新作业；点「下一张」清空并开始下一份。

## 设置说明

设置面板分为四区：

### 逐空精确批改（本地 OCR）

适用于填空量大的卷子（如化学填空，一题 10–30 个空）。在自动模式右侧把「核批方式」切到 **精确批改（逐空判定，可多个对勾）**：

1. 本地 [Xiaomi-OCR-0（4bit GGUF）](https://huggingface.co/prithivMLmods/Xiaomi-OCR-0-GGUF) 先整页转写，得到题号、题干、空位与手写答案文本；
2. 云端视觉模型逐题返回**每个空的答案、判定与边界框**；
3. 渲染端在每个空位旁分别画对勾/叉/半对，并写答案。

本地模型准备：

```bash
brew install llama.cpp
./scripts/setup-local-ocr.sh   # 下载约 700MB 模型到应用数据目录
```

然后在「设置 → 本地 OCR」里点「启动服务」（默认 `127.0.0.1:18080`）。未启动或模型缺失时会自动跳过整页预处理，退回标准逐题批改。

### 批改模型

- **来源**：`云端（OpenAI 兼容）` 或 `本地（LM Studio / Ollama 等）`
- **接口地址**：任意 OpenAI 兼容的 `/v1/chat/completions` 地址
- **模型名**：任意具备图片理解能力的模型
- **API Keys**：多个 Key 用英文逗号分隔，会轮流使用；本地服务通常留空

程序只依赖标准 OpenAI 协议（`messages` + `image_url`），不绑定任何厂商、不读取任何特定模型的环境变量。接口地址留空时的示例值为 `https://api.openai.com/v1/chat/completions`，仅为格式示例，可替换成任意兼容服务。

### 扫描仪

- 自动发现局域网内的 eSCL 扫描仪
- 可手动填写扫描仪 IP
- 显示状态、型号、扫描源、最高 dpi

### 打印

- 选择使用哪台打印机（默认或指定）
- 打印速度：快速（草稿）/ 标准 / 高质量
- 颜色：彩色 / 黑白
- 统一按普通纸输出，避免驱动把试卷当成照片而严重降速

### 存储与清理

- 显示当前存储目录与占用
- 可更换存储目录、打开目录
- 一键清理临时文件（返回释放空间）
- 启动时自动清理 24 小时前的临时扫描图

## 代码结构

```
grade-app/
├── main.js              Electron 主进程：窗口、IPC、配置、存储、打印
├── preload.js           安全桥：向渲染层暴露白名单 API
├── cli.js              无界面命令行：切题 → 批改 → 出图
├── core/
│   ├── scan.js          eSCL 扫描发现/取图 + CUPS 打印/队列
│   ├── ocr.js           PaddleOCR(ONNX) 识别、题号聚类、题块切分
│   ├── prepare.js       自动摆正 + 裁掉空白
│   ├── pipeline.js      主流水线：裁块、并发批改、落点、渲染、整页评阅
│   ├── grade.js         OpenAI 兼容批改接口、提示词、重试与限速
│   ├── localocr.js      本地 OCR 客户端（llama.cpp / 任意 OpenAI 兼容服务）
│   └── render.js        SVG 手写笔迹引擎 + sharp 合成
├── ui/
│   ├── index.html       界面与样式（液态球、成品页、设置）
│   └── app.js           状态机、交互、IPC 调用
├── chi_sim.traineddata  tesseract 中文兜底模型
└── eng.traineddata      tesseract 英文兜底模型
```

### 各模块细节

#### `main.js` — 主进程

- 创建无边框窗口（`titleBarStyle: hiddenInset`），加载 `ui/index.html`。
- 启动时把配置文件里的 API Key 注入 `GRADER_API_KEYS` 环境变量，再加载批改模块。
- IPC 覆盖：自动流程、扫描、选图、切题、单题批改、渲染、打印、历史列表/删除、存储目录选择/打开、临时清理、模型连通性测试。
- 配置存于 `~/Library/Application Support/exam-grader/config.json`；扫描临时图在 `out/`，批改历史在 `history/`（均为用户数据目录，可按设置的存储目录覆盖）。
- 历史删除只删对应 jpg + json；启动清空的是**界面列表**，不删文件。
- 打印统一走 `lp`：`-d` 指定打印机、`fit-to-page`、`PageSize=A4`、`MediaType=stationery`、`cupsPrintQuality`、`ColorModel`。

#### `preload.js` — 安全桥

`contextIsolation: true`，通过 `contextBridge` 暴露固定方法名，渲染层不能直接访问 Node。

#### `core/scan.js` — 扫描与打印

- `discover()`：并发探测局域网常见网段的 `http://IP/eSCL/ScannerCapabilities`。
- `scan()`：`POST /eSCL/ScanJobs` 创建任务，轮询 `NextDocument` 取 JPEG；参数为平板、300dpi、A4、RGB24。
- `printerInfo()` / `clearQueue()` / `testPrint()`：`lpstat` / `cancel` / `lp`。
- 对 HP 等实现的 XML 差异做了兼容处理。

#### `core/ocr.js` — 识别与切题

- 加载 PaddleOCR PP-OCRv4 ONNX（`@gutenye/ocr-node`），识别前把长边缩到 1600，临时文件用完即删。
- 失败时回退 tesseract（`chi_sim` + `eng`）。
- `pickNumbers()`：按题号正则识别候选题号，按左边缘做聚类，取最整齐的一列，兜底补齐。
- `buildBlocks()`：题块上边界取题号上方 0.5 行，下边界延伸到**下一题题号下方 1.2 行**（宁可多切、不可少切），最后一题切到页底。
- `split()` 支持传入已算好的 OCR 结果，避免方向判断与切题重复识别。

#### `core/prepare.js` — 摆正与裁空白

- `orient()`：先 OCR 一次统计题号数量；≥2 视为正向。否则旋转 180° 再识别，比较题号数与有效文字量，明显变好才采用。
- `trim()`：优先用 OCR 文字行包围盒（左右 3%、上 2.5%、下 10% 余量）；无文字时按暗像素分布找内容区，并排除噪点与纸张边线。
- 裁切只做平移，直接平移 OCR 坐标，不重复识别。

#### `core/pipeline.js` — 主流水线

- 预处理 → 切题 → 逐题裁块（外扩 48px）。
- 并发调用批改模型（带重试），把答案点归一化到题块坐标，换算成整页像素坐标。
- 生成 marks（对勾/叉/半对/批注/答案文字）。
- 整页作文/评阅模式（`essay`）单独走评语与总分支路。
- 最终用 `render()` 合成整页图。

#### `core/grade.js` — 批改接口与提示词

- 标准 OpenAI `chat/completions`：`messages` 中 `text` + `image_url`。
- 多 Key 轮询、RPM 限速、失败重试。
- 单题提示词要求返回严格 JSON：`verdict`（正确/错误/半对/空白/不确定）、`answer_point`（题块内 0–1000 归一化坐标）、学生答案、正确答案、批注。
- 作文/整页评阅提示词单独维护，按内容/结构/语言/书写等维度给分与评语。
- 所有设置（地址、模型、Key）运行时热更新，不写死在代码里。

#### `core/render.js` — 手写笔迹

- 自实现 seeded RNG，保证同一结果每次渲染一致但看起来随机。
- Catmull-Rom 样条把控制点变成平滑笔迹，叠加低频垂直抖动。
- 起笔/行笔/收笔的粗细变化，模拟真实钢笔力度。
- `tickMark` 一笔连贯对勾；`crossMark` 两笔错位；`halfMark` 对勾 + 穿过它的斜线；批注文字沿落点排布。
- 输出 JPEG，供打印与历史保存。

#### `ui/index.html` 与 `ui/app.js`

- 中央巨大液态球：多层渐变、玻璃高光、气泡形变、呼吸动画，随阶段变色。
- 扫描图/批改图半透明叠在球体后方。
- 成品模式：隐藏所有栏，只留批改图 + 顶部胶囊按钮（打印 / 下一张）。
- 状态机：待机 → 扫描 → 切题 → 批改 → 出图 → 成品；互斥显示，避免界面残留。
- 启动不自动载入历史；点「载入」才读取；缩略图懒加载。
- 自动打印开关写入配置，下次启动保持上次状态。
- 重置时清空结果数组与 `<img src>`，避免大图常驻内存。

#### `cli.js` — 命令行

```bash
node cli.js --image /path/to/scan.jpg --out /tmp/graded.jpg
```

无界面跑完整流水线，并输出同名 `.json` 结果，方便调试与批处理。

## 数据与隐私

- 扫描图、批改结果只存在本机；云端只在你配置了云端接口时才会收到题块图片。
- API Key 保存在本机配置文件中，不随仓库分发。
- 仓库与发布包中不包含任何厂商品牌、密钥或用户数据。

## 已知限制

- 当前发布包为 macOS arm64；Windows/Linux 需要适配扫描与打印层。
- 扫描依赖 eSCL；仅支持厂商私有协议或纯 USB 的老扫描仪无法直接使用，可改用手动选图。
- 手写识别与主观题评分受底图清晰度与模型能力影响，复杂阅读题仍可能出现偏差。
- 打印为整页重新输出，不保留原纸上的装订、折痕等信息。

## 跨平台说明

- 批改/OCR/渲染为纯 Node + sharp，跨平台一致。
- 打印：macOS 用 `lp`；Windows 可改为 `webContents.print()` 或 SumatraPDF 命令行；Linux 仍可用 `lp`。
- 扫描：网络 eSCL 三平台通用；USB 扫描仪需在 Windows 走 WIA、macOS 走 ImageCapture。

## Roadmap

- 引入结构化文档理解模型（如 Xiaomi-OCR-0）增强语文阅读题的版面与长文本上下文。
- 阅读题按「材料 + 小题 + 评分要点」联合判分。
- Windows / Linux 打印与扫描适配。

## License

[GNU General Public License v3.0](LICENSE)
