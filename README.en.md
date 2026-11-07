# Exam Printer Grader

[简体中文](README.md) | [English](README.en.md)

> A desktop system that recreates the experience of a dedicated exam-grading machine (like iFLYTEK's) using an ordinary scanner-printer all-in-one.

---

## What It Is

Put a completed worksheet or exam paper **face-up on your printer's scanner glass**, press one button, and the system automatically:

scans → auto-rotates → trims blank margins → runs OCR to split questions → grades each question with a vision LLM → overlays handwritten ticks / crosses / half-marks / comments onto the page → prints a new copy.

This is **not** an "upload a photo and let AI grade it" tool. The whole workflow is tied to the printer: papers come from the scanner and results come out of the printer. The goal is to reproduce an expensive exam-grading machine at home with the cheapest hardware people already own.

## How It Differs From Typical AI Graders

| | Typical AI grading app | This project |
|---|---|---|
| Input | Manual photo / file upload | Automatic scan from printer |
| Output | On-screen result / image download | A newly printed paper copy |
| Hardware | Independent of printers | Scanner and printer are core to the flow |
| Positioning | Image-processing utility | Affordable home "grading machine" |

**Important: the printed output is a new copy of the worksheet, not annotations on the original paper.**
This is intentional. Reprinting works with any paper, printer and binding, while feeding the original sheet back into a printer is fragile and hardware-dependent.

## Demo Video

▶ [Play or download the demo](https://github.com/zhj-ldm/exam-printer-grader/releases/download/v1.0.0/exam-grader-demo.mp4)

<video src="https://github.com/zhj-ldm/exam-printer-grader/releases/download/v1.0.0/exam-grader-demo.mp4" poster="https://raw.githubusercontent.com/zhj-ldm/exam-printer-grader/main/assets/demo-poster.jpg" controls width="720"></video>

> Full flow: place the paper on the scanner → press the button → automatic scan and grading → a newly printed graded copy.

## Features

- **One-click pipeline**: scan, split, grade, render in one flow.
- **Automatic orientation**: detects upside-down (180°) pages by OCR confidence and rotates them back.
- **Automatic margin trimming**: locates the content area and removes blank scanner borders; printed output fills the page.
- **Reliable question splitting**: anchored on OCR-detected question numbers; boundaries are intentionally generous so answers are never cut off.
- **Handwritten-style marks**: smooth, slightly jittery ticks; half-marks are a tick crossed by a slash; crosses are two offset strokes; comments are placed near answers.
- **Toggles**: ticks, comments, correct answers, auto-print after grading.
- **Result-only mode**: after grading, the UI shows only the final graded page with a pill button to print or start the next paper.
- **History**: stored locally; browse previous results, delete single entries; the list starts empty on launch without deleting files.
- **Print controls**: choose printer, quality (draft/normal/high), color or grayscale; settings persist.
- **Model freedom**: any **OpenAI-compatible** vision model, cloud or local (LM Studio / Ollama / vLLM), no vendor lock-in.

## How It Works

```
Scanner (eSCL)
   │  HTTP image fetch
   ▼
Auto-orient (OCR score @ 0° vs 180°)
   ▼
Trim blank margins (OCR text bbox → crop)
   ▼
Split questions (PaddleOCR numbers → block coordinates)
   ▼
Crop each question + vision LLM grading (OpenAI-compatible)
   ▼
Anchor points → SVG handwriting → sharp compositing
   ▼
CUPS (lp) printing / save history
```

## Requirements

- macOS (current release is Apple Silicon / arm64)
- A network scanner supporting **eSCL / AirScan** (most AirPrint all-in-ones do)
- A printer already available in System Settings → Printers & Scanners

> Windows / Linux: grading, OCR and rendering are cross-platform Node code; scanning and printing need platform adapters (see "Cross-platform notes").

## Run From Source

```bash
npm install
npm start
```

### Package the macOS app

```bash
npx @electron/packager . "试卷批改" --platform=darwin --arch=arm64 \
  --out=dist --asar=false --overwrite --prune=true
```

Optionally remove unused native binaries to shrink the bundle:

```bash
rm -rf node_modules/onnxruntime-node/bin/napi-v6/{linux,win32}
```

## Usage

1. Place the paper **face up** on the scanner glass (upside-down is auto-corrected).
2. Open the app and click the central liquid orb.
3. The app scans, detects question numbers and grades each question.
4. When finished, the UI switches to result-only mode showing the graded page.
5. Press **Print** to output a new copy, or **Next** to clear and start another paper.

## Settings

### Grading model

- **Source**: `Cloud (OpenAI-compatible)` or `Local (LM Studio / Ollama, etc.)`
- **Endpoint**: any OpenAI-compatible `/v1/chat/completions`
- **Model name**: any vision-capable model
- **API keys**: comma-separated, rotated automatically; not required for local servers

Only the standard OpenAI protocol (`messages` + `image_url`) is used. No vendor, no vendor-specific environment variables. The default placeholder `https://api.openai.com/v1/chat/completions` is a format example and can be replaced with any compatible service.

### Scanner

- Auto-discovery of eSCL scanners on the LAN
- Manual IP entry
- Status, model, scan source and max dpi display

### Printing

- Select the printer (default or explicit)
- Speed: draft / normal / high
- Color: color / grayscale
- Always plain paper to prevent drivers from switching to slow photo mode

### Storage & cleanup

- Show current storage directory and usage
- Change or open the directory
- Clear temporary files and report freed bytes
- Auto-clean scan temp files older than 24 hours on launch

## Code Structure

```
grade-app/
├── main.js              Electron main process: window, IPC, config, storage, printing
├── preload.js           Secure bridge exposing a whitelisted API
├── cli.js               Headless pipeline: split → grade → render
├── core/
│   ├── scan.js          eSCL discovery/scan + CUPS printing/queue
│   ├── ocr.js           PaddleOCR(ONNX), question-number clustering, block building
│   ├── prepare.js       Auto-orientation + blank-margin trimming
│   ├── pipeline.js      Cropping, concurrent grading, anchors, rendering, essay mode
│   ├── grade.js         OpenAI-compatible client, prompts, retry and rate limiting
│   └── render.js        SVG handwriting engine + sharp compositing
├── ui/
│   ├── index.html       UI and styles (liquid orb, result page, settings)
│   └── app.js           State machine, interactions, IPC calls
├── chi_sim.traineddata  Tesseract Chinese fallback model
└── eng.traineddata      Tesseract English fallback model
```

### Module details

#### `main.js`

- Frameless window (`titleBarStyle: hiddenInset`) loading `ui/index.html`.
- Injects stored API keys into `GRADER_API_KEYS` before loading the grading module.
- IPC: auto pipeline, scan, pick image, split, grade one, render, print, history list/delete, storage select/open, temp cleanup, model connectivity test.
- Config at `~/Library/Application Support/exam-grader/config.json`; scan temp in `out/`, results in `history/` (both can be relocated via settings).
- Deleting history removes the jpg + json; clearing on launch only clears the UI list.
- Printing uses `lp` with `-d`, `fit-to-page`, `PageSize=A4`, `MediaType=stationery`, `cupsPrintQuality`, `ColorModel`.

#### `preload.js`

`contextIsolation: true`; the renderer gets only fixed methods via `contextBridge`.

#### `core/scan.js`

- `discover()` probes `http://IP/eSCL/ScannerCapabilities` on common LAN ranges.
- `scan()` creates a ScanJob and polls `NextDocument` for JPEG; platen, 300 dpi, A4, RGB24.
- `printerInfo()`, `clearQueue()`, `testPrint()` wrap `lpstat` / `cancel` / `lp`.
- Handles XML variations from HP and others.

#### `core/ocr.js`

- PaddleOCR PP-OCRv4 ONNX; long edge scaled to 1600 before recognition; temp files deleted after use.
- Falls back to tesseract (`chi_sim` + `eng`).
- `pickNumbers()` finds question-number candidates, clusters by left edge, keeps the cleanest column, fills gaps.
- `buildBlocks()` starts 0.5 line above the number and ends 1.2 lines below the next question's number (deliberately over-inclusive).
- `split()` accepts precomputed OCR results so orientation and splitting share one pass.

#### `core/prepare.js`

- `orient()`: counts detected question numbers; ≥2 means upright. Otherwise rotate 180° and compare question counts and text mass.
- `trim()`: uses the OCR text bbox (3% horizontal, 2.5% top, 10% bottom padding); without text, falls back to dark-pixel distribution while ignoring noise and paper edges.
- Cropping is translation-only, so OCR coordinates are shifted instead of re-recognized.

#### `core/pipeline.js`

- Preprocess → split → crop each block (48 px padding).
- Concurrent grading with retries; answer points normalized to 0–1000 then mapped to page pixels.
- Builds marks (tick/cross/half/comment/answer text).
- Separate essay/full-page mode with dimension scores and comments.
- Final composite with `render()`.

#### `core/grade.js`

- Standard OpenAI `chat/completions` with `text` + `image_url`.
- Multi-key rotation, RPM limiting, retries.
- Per-question prompt returns strict JSON: `verdict`, `answer_point`, student answer, correct answer, comment.
- Essay prompt scores content/structure/language/handwriting and writes a comment.
- Endpoint/model/keys hot-reload at runtime; nothing hard-coded to a vendor.

#### `core/render.js`

- Seeded RNG: deterministic per result but visually random.
- Catmull-Rom splines with low-frequency vertical jitter.
- Stroke width varies on entry, body and exit to imitate pen pressure.
- `tickMark` one continuous tick; `crossMark` two offset strokes; `halfMark` tick plus a crossing slash; comment text follows anchors.
- Outputs JPEG for printing and history.

#### `ui/index.html` and `ui/app.js`

- Large liquid orb with layered gradients, glass highlight, blob morph and breathing animation, colored by stage.
- Scanned/graded images sit semi-transparent behind the orb.
- Result-only mode hides panels and shows the graded page plus top pill buttons (print / next).
- State machine: idle → scan → split → grade → render → result; mutually exclusive layers.
- History is not auto-loaded; thumbnails lazy-load; delete single entries.
- Auto-print state saved in config and restored on launch.
- Reset clears result arrays and `<img src>` to avoid retaining large images.

#### `cli.js`

```bash
node cli.js --image /path/to/scan.jpg --out /tmp/graded.jpg
```

Runs the full pipeline headlessly and writes a matching `.json` summary.

## Data & Privacy

- Scans and results stay on the local machine; question crops are sent to a cloud endpoint only if you configure one.
- API keys live in the local config file and are not shipped with the repo.
- The repository and release bundles contain no vendor branding, keys or user data.

## Known Limitations

- Current release is macOS arm64; Windows/Linux need scanner and printer adapters.
- Scanning requires eSCL; vendor-private or USB-only scanners must use the manual image mode.
- Handwriting recognition and subjective grading depend on image quality and model capability; complex reading-comprehension tasks can still be imperfect.
- Printing outputs a fresh page and does not preserve staples/folds of the original.

## Cross-platform Notes

- Grading/OCR/rendering is cross-platform Node + sharp.
- Printing: macOS uses `lp`; Windows can use `webContents.print()` or SumatraPDF CLI; Linux can use `lp`.
- Scanning: network eSCL works everywhere; USB scanners need WIA on Windows and ImageCapture on macOS.

## Roadmap

- Integrate structured document-understanding models (e.g., Xiaomi-OCR-0) for better layout and long-passage context in reading-comprehension tasks.
- Grade reading questions with "passage + sub-questions + rubric" jointly.
- Windows / Linux printing and scanning adapters.

## License

[GNU General Public License v3.0](LICENSE)
