# Whisper Web（增强版）

浏览器内 / 服务端双引擎的 Whisper 语音转写应用。基于
[🤗 Transformers.js](https://github.com/xenova/transformers.js)，在
[xenova/whisper-web](https://github.com/xenova/whisper-web) 之上做了功能扩展：

- 转写进度条、多文件 / 整文件夹批量转写
- TXT / **SRT** / JSON 三种导出，JSON 带预留的 `trans`（译文）字段
- 三种转写引擎可切换（浏览器内 / 服务端本地 / 远端 OpenAI 兼容）
- 内置 Node REST API，可被 curl、脚本、其它程序直接调用

> [!IMPORTANT]
> 原项目的实验性 WebGPU 分支见
> [experimental-webgpu](https://github.com/xenova/whisper-web/tree/experimental-webgpu)
> （[demo](https://huggingface.co/spaces/Xenova/whisper-webgpu)）。

## 目录

- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [功能详解](#功能详解)
  - [1. 音频输入](#1-音频输入url--文件--文件夹--录音)
  - [2. 三种转写引擎](#2-三种转写引擎该怎么选)
  - [3. 进度显示](#3-转写进度显示)
  - [4. 批量转写与批量导出](#4-批量转写与批量导出)
  - [5. 导出格式与 trans 字段](#5-导出格式与-trans-字段)
  - [6. Settings 面板逐项说明](#6-settings-面板逐项说明)
  - [7. 字幕联动：实时高亮 + 点击跳转](#7-字幕联动实时高亮--点击跳转)
  - [8. 双语字幕 Bilingual subtitles](#8-双语字幕-bilingual-subtitles)
- [下载本地模型权重](#下载本地模型权重fetch-model)
- [API 服务端](#api-服务端)
  - [接口一览](#接口一览)
  - [转写参数](#post-apitranscribe-参数)
  - [返回格式 txt / srt / json](#返回格式txt--srt--json)
  - [curl 示例](#curl-示例)
  - [POST /api/bilingual 双语](#post-apibilingual-双语)
  - [POST /api/translate 单独翻译](#post-apitranslate-单独翻译)
  - [环境变量](#环境变量)
- [命令行 CLI](#命令行-cli)
- [项目结构](#项目结构)
- [开发命令](#开发命令)
- [避坑指南](#避坑指南)
- [License](#license)

---

## 环境要求

| 依赖 | 版本 | 是否必需 | 说明 |
| --- | --- | --- | --- |
| Node.js | **≥ 20**（建议 20 LTS / 22） | ✅ | `undici@8` 需要 Node ≥ 20.18 |
| npm | 随 Node | ✅ | |
| 现代浏览器 | Chrome / Edge / Firefox 最新版 | ✅ | 浏览器引擎需要 WebAssembly + Web Worker |
| `ffmpeg` | 任意近期版本 | ⚠️ | **仅服务端 `local` 引擎需要**，用于解码 mp3/m4a/flac 等 |
| Python `openai-whisper` | — | ⚪ | 仅 `command` 引擎需要 |

检查 ffmpeg：

```bash
ffmpeg -version
```

---

## 快速开始

```bash
git clone https://github.com/aonzey/whisper-web.git
cd whisper-web
npm install
```

三种跑法，按需要选一种：

**A. 只用浏览器（最原始的用法）**

```bash
npm run dev          # http://localhost:5173
```

模型会在**首次转写时**从 huggingface.co 下载到浏览器缓存里（几十 MB ~ 上 GB）。

**B. 浏览器前端 + API 服务端（推荐）**

```bash
npm run fetch-model  # 下载一次权重到 .cache/（约 42MB，之后可离线）
npm run dev:all      # 同时起 vite(5173) + API(8787)
```

> Firefox 需要在 `about:config` 里把 `dom.workers.modules.enabled` 设为 `true`
> 才能使用 Web Worker，详见
> [这个 issue](https://github.com/xenova/whisper-web/issues/8)。

**C. 生产构建**

```bash
npm run build        # 输出到 dist/
npm run server       # API 会顺带托管 dist/，直接访问 http://localhost:8787
```

---

## 功能详解

### 1. 音频输入（URL / 文件 / 文件夹 / 录音）

| 入口 | 说明 |
| --- | --- |
| **From URL** | 填一个音频直链。注意：目标服务器需允许跨域（CORS），否则下载会失败 |
| **From file** | 弹出选择框，两种模式：<br>· **选择多个音频文件** —— 一次挑多个文件<br>· **选择整个文件夹** —— 用 `webkitdirectory` 递归读取（**含子目录**），自动过滤出音频文件 |
| **Record** | 直接用麦克风录音，录完可回放确认 |
| **Clear** | 清空队列与结果 |

选完文件后，文件会以**队列**形式列在页面上：点击可切换查看某个文件的结果，
每项显示时长与状态（待转写 / 转写中 / 完成 / 失败），可单独删除。

### 2. 三种转写引擎（该怎么选）

| 引擎 | 模型跑在哪 | 优点 | 缺点 | 适用场景 |
| --- | --- | --- | --- | --- |
| **Browser (in-browser model)** | 浏览器 Web Worker | 零部署、音频不出本机、不依赖后端 | 首次要下载模型到浏览器缓存；占浏览器内存；低端机很慢 | 演示、隐私敏感、单机轻量使用 |
| **本地引擎 Local engine (server)** | Node 服务端进程内（transformers.js） | 模型权重只在服务端存一份、可离线、浏览器压力小、可被 API 复用 | 需要跑 `npm run server`；需要 `ffmpeg` | **日常主力用法** |
| **Server API** | 由服务端决定；Base URL 填第三方地址时转发到该端点 | 可以接更强的远端模型（Groq、DashScope、faster-whisper 等），下拉框直接列出上游模型 | 需要配置上游与 Key，且必须开着 `npm run server`（浏览器无法直连） | 想要更好识别质量或有自建推理服务 |

切换位置：**Settings → Transcription engine**。选择会写进 `localStorage`。

### 3. 转写进度显示

转写中按钮显示 `Transcribing... 42%`，下方进度条附带：

```
00:12 / 01:00 · chunk 2/5
```

- 浏览器引擎：进度由 `src/worker.js` 按滑动窗口（30s 窗口 / 5s 步长；
  distil-whisper 为 20s / 3s）估算总 chunk 数后上报。
- 服务端引擎：显示的是**上传进度**，转写本身在服务端跑（页面只能看到上传完成）。
- 批量转写时额外显示 `File 2/10 — xxx.mp3`。

### 4. 批量转写与批量导出

队列里有多个文件时，按钮变成 **Transcribe All (N)**，会**按顺序**逐个转写
（不做并发，避免显存/内存爆掉）。全部完成后可以：

- **Export All TXT**
- **Export All SRT**
- **Export All JSON**

批量导出是逐个触发下载，间隔约 400ms（浏览器会保存成多个文件，不要拦截弹窗）。
文件名取自源文件名（去掉扩展名）。

### 5. 导出格式与 `trans` 字段

单条结果和批量结果都支持三种格式：

| 按钮 | 扩展名 | 内容 |
| --- | --- | --- |
| **Export TXT** | `.txt` | 所有 chunk 文本拼接（保留原有前导空格分隔） |
| **Export SRT** | `.srt` | SubRip 字幕，带序号与 `HH:MM:SS,mmm --> HH:MM:SS,mmm` |
| **Export JSON** | `.json` | 结构化数组，每行含 `timestamp` / `text` / `trans` |

JSON 结构（`trans` 是预留的译文/校对字段，默认空字符串，方便后续挂翻译流程）：

```json
[
  {
    "timestamp": [0, 7.74],
    "text": " And so my fellow Americans",
    "trans": ""
  },
  {
    "timestamp": [7.74, 10.64],
    "text": " ask what you can do for your country.",
    "trans": ""
  }
]
```

SRT 示例：

```srt
1
00:00:00,000 --> 00:00:07,740
And so my fellow Americans

2
00:00:07,740 --> 00:00:10,640
ask what you can do for your country.
```

> 最后一段若只有起始时间，结束时间会退化为「下一段起点」，再退化为 `start + 2s`，
> 不会出现 0 长度字幕。

**双语结果**：只要某条 chunk 的 `trans` 非空（即跑过 *Bilingual subtitles*），
导出自动切换为双语：

| 格式 | 双语表现 |
| --- | --- |
| `.txt` | 每句原文后紧跟一行译文 |
| `.srt` | 每个 cue 里原文一行 + 译文一行（时间轴不变） |
| `.json` | 每句 `trans` 字段带上译文 |

双语时 TXT / SRT 的文件名会追加 `.bilingual`（如 `demo.bilingual.srt`），
便于和单语版本区分；JSON 结构不变，靠 `trans` 字段区分。

### 6. Settings 面板逐项说明

Settings 弹窗**左右并列两栏**：左边 `Transcription engine`，右边
`Translation engine`，各自独立配置、互不干扰。

### 6.1 左栏：Transcription engine

| 设置项 | 说明 |
| --- | --- |
| **Transcription engine** | 见[第 2 节](#2-三种转写引擎该怎么选) |
| **Model** | 下拉框。服务端引擎下由 `GET /api/models` 填充（只列 `task=asr` 的模型），分两组：<br>· **已缓存（服务端可直接用）** —— 权重已在 `.cache/Transcription models`，带精度与体积<br>· **其他可填的模型 / 别名** —— 未下载，选中会触发下载或报不可用 |
| **刷新列表** | 重新拉取 `/api/models`（下完新模型后点它） |
| **手动输入** | 切换成文本框，可填写列表里没有的模型 id |
| **Base URL** | 默认 `/api`（vite 已代理到 8787）。也可填第三方 OpenAI 兼容端点，如 `https://api.groq.com/openai/v1`（见[下节](#接入第三方-openai-兼容端点groq--dashscope-)）。下方会实时显示识别结果 |
| **API Key** | 服务端设了 `API_TOKEN` 时才需要 |
| **Test connection** | 打 `/api/health`，会回显服务端当前引擎与模型 |
| **Multilingual** | 勾选后可指定语言与 `translate` 任务 |
| **Language** | 源语言；`auto` 为自动检测 |
| **Task** | `transcribe`（原语言）或 `translate`（译成英文） |
| **Quantized** | 浏览器引擎用量化模型（更小更快，精度略降） |

### 6.2 右栏：Translation engine

| 设置项 | 说明 |
| --- | --- |
| **Translation engine** | 见[第 8 节](#8-双语字幕-bilingual-subtitles) |
| **Translate subtitles into** | 目标语言，80+ 种可选（含简体/繁体中文） |
| **Translation model** | 浏览器/本地引擎选 🤗 翻译模型；Server API 选聊天模型 |
| **刷新列表** | 重新拉取服务端**翻译**模型（只列 `task=translation` 的），下完新翻译模型后点它 |
| **手动输入** | 切换成文本框，可填写列表里没有的模型 id |

两个下拉框各显示各的已缓存模型：`/api/models` 会按 `config.json` 的
`model_type` 给每个模型打 `asr` / `translation` 标签，转写框里不会出现
`opus-mt` 这类翻译模型，反之亦然。

所有设置存 `localStorage`（前缀 `whisper-web:`），刷新不丢。

---

## 7. 字幕联动：实时高亮 + 点击跳转

转写结果出来后，字幕列表与播放器是双向联动的：

- **播放时**：按当前播放时间定位所属字幕块，自动 `scrollIntoView` 并高亮
  （底色变蓝、时间码加粗）；滚到最后一句后保持高亮最后一句。
- **点击任意一行**：音频立刻跳到该句起点并从那里开始播放
  （浏览器可能因自动播放策略拦下首次播放，点一下播放器即可）。
- 转写进行中（流式输出）仍然保持「贴底滚动」，不会和高亮冲突。

> 时间轴来自 chunk 的 `timestamp`；最后一段只有起点时按
> 「下一段起点 → start + 2s」兜底，与导出规则一致。

---

## 8. 双语字幕 Bilingual subtitles

`Transcribe Audio` 按钮旁边就是 `Bilingual subtitles`（批量时为
`Bilingual All (N)`）。

**两个按钮各显示各的动态效果**：转写中只有 `Transcribe Audio` 转圈并显示
`Transcribing... n%`，`Bilingual subtitles` 保持原样（只是变灰不可点）；
反之双语运行时只有它显示 `Transcribing...` / `Translating... n/N`。

**Bilingual 会复用已有的转写结果**：如果当前文件已经转写过（点过
`Transcribe Audio`），再点 `Bilingual subtitles` 会**跳过 ASR**，直接翻译
现有字幕——按钮文案也会变成 `Bilingual subtitles (translate only)` 提示你。
批量模式逐文件判断：有结果的只翻译，没结果的才走「转写 → 翻译」。

除此之外它做两件事：

1. （没有结果时）先完整跑一遍普通转写（用的就是当前 *Transcription engine* 的设置）；
2. 再按 *Translation engine* 的设置把每句译文填进 `chunk.trans`，
   **按上下文分批翻译**——每批最多 10 句，且把已译好的前 4 句一起交给引擎，
   保证代词、人名、术语前后一致。

界面与导出：

- 列表每句显示两行：原文 + 译文；
- 三个 Export 按钮全部导出双语内容（见[第 5 节](#5-导出格式与-trans-字段)）；
- 批量模式下也是「每个文件转写 → 翻译 → 再下一个文件」。

### 三种 Translation engine 怎么选

| 选项 | 跑在哪 | 适用 | 准备 |
| --- | --- | --- | --- |
| **Browser (in-browser model)** | 浏览器 Web Worker 里的 🤗 Transformers.js | 不想起服务端、机器内存够 | 首次自动下载所选模型（默认 `Xenova/nllb-200-distilled-600M`，约 250MB） |
| **本地引擎 Local engine (server)** | Node 服务端进程内 | 完全离线、想复用服务端缓存 | `npm run fetch-model -- Xenova/opus-mt-en-zh` |
| **Server API** | OpenAI 兼容的 `/chat/completions` | **上下文语境翻译质量最好** | 填好 Base URL + API Key + 聊天模型（复用 Server API 的设置） |

- 浏览器/本地引擎用 🤗 翻译模型（`Xenova/nllb-200-distilled-600M`、
  `Xenova/m2m100_418M`、`Xenova/opus-mt-en-zh` 等），NLLB / m2m100 / mBART
  会自动带上 `src_lang` / `tgt_lang` 语言码。
- Server API 走 LLM：提示词要求「按 `<序号>\t<译文>` 逐行输出」，
  解析失败会退化为按行对齐，保证句数不错位。
- 翻译期间按钮显示 `Translating... n/N`，进度条按句推进。

> 浏览器依然**不能直连**第三方端点（CORS + 不走系统代理），
> Server API 的请求统一经本地服务端中转。
>
> `/api/models` 会按 `config.json` 的 `model_type` 给每个缓存模型打上
> `task`（`asr` / `translation`），因为 opus-mt / NLLB 这类翻译模型同样带
> `encoder_model*.onnx`。转写模型的下拉框会过滤掉翻译模型，
> 翻译模型的下拉框会把「已缓存（服务端）」的排在最前面。

---

## 下载本地模型权重（fetch-model）

服务端 `local` 引擎需要 ONNX 权重放在磁盘上：

```bash
npm run fetch-model                              # Xenova/whisper-tiny.en（量化，约 42MB）
npm run fetch-model -- Xenova/whisper-small      # 指定模型（约 242MB）
npm run fetch-model -- onnx-community/whisper-tiny   # 任意组织/用户的仓库
npm run fetch-model -- Xenova/opus-mt-en-zh      # 翻译模型（通用 ONNX 布局）
npm run fetch-model -- zem214/whisper-medium --list   # 只看这个仓库里有什么文件
npm run fetch-model -- --full                    # 连 fp32 权重一起下（体积翻倍）
npm run fetch-model -- --force                   # 已存在也重新下载
npm run fetch-model -- --dry-run                 # 只打印将要下载什么
npm run fetch-model -- --mirror https://hf-mirror.com/
npm run fetch-model -- --revision main           # 指定分支 / commit
```

**任意仓库都能下（不再只支持 Xenova/*）**。脚本会先用仓库 API 列出文件
（Hugging Face `/api/models/<id>/tree/<rev>`、ModelScope
`/api/v1/models/<id>/repo/files`），再从中挑出配置与权重，并**归一化**到
transformers.js 期望的布局：

| 仓库里的文件 | 落到缓存的位置 |
| --- | --- |
| `config.json` / `generation_config.json` / `tokenizer*.json` … | 同名放根目录 |
| `onnx/encoder_model_quantized.onnx`、`encoder_model_int8.onnx`、… | `onnx/encoder_model_quantized.onnx` |
| `onnx/decoder_model_merged_quantized.onnx`、`…_int8`、… | `onnx/decoder_model_merged_quantized.onnx` |
| 非 Whisper 的通用模型（`model.onnx` 命名） | `onnx/model[_quantized].onnx` |

找不到 encoder/decoder 时会按「通用 ONNX 模型」处理，并提示
`[info] 未找到 Whisper 风格的 encoder/decoder`，这正是下载翻译模型时的正常输出。

**常见失败原因**（都会精确打印，不再只说 “download failed”）：

| 现象 | 原因与处理 |
| --- | --- |
| `modelscope: HTTP 404 …记录不存在` | 该仓库**没有同步到 ModelScope**（如 `zem214/whisper-medium`）。换 `--mirror https://hf-mirror.com/` 或设 `HF_ENDPOINT` |
| `huggingface: fetch failed` | huggingface.co 在本机不可达。同上，换镜像 |
| `缺少 decoder_model_merged*.onnx` | 该仓库只有未合并的 `decoder_model.onnx`，transformers.js 用不了，需要重新导出 |
| 仓库全是 `.bin` / `.safetensors` | 只有 PyTorch 权重，需先转 ONNX |
| 只有 fp32 权重 | 会保存为 `onnx/*.onnx`（不带 `_quantized`），服务端自动以非量化方式加载 |

- 输出目录按模型用途自动分文件夹，正好是 transformers.js
  `FileSystemCache` 的布局：

  | 用途 | 目录 |
  | --- | --- |
  | 转写模型（Whisper 系列） | `<LOCAL_CACHE_DIR\|./.cache>/Transcription models/<model_id>/` |
  | 翻译模型（opus-mt / NLLB / m2m100 …） | `<LOCAL_CACHE_DIR\|./.cache>/Translation models/<model_id>/` |

  脚本按仓库 `config.json` 的 `model_type` 判断用途（`whisper` → 转写，
  其余 → 翻译）；也可用 `--dir "Transcription models"` 手动指定。
  旧的扁平布局 `<cache>/<model_id>/` 仍会被读取，不会白下载。
- 默认先走 **ModelScope** 镜像，失败自动回退 huggingface.co。
- 已缓存的模型会列在 `/api/models` 里（带 `task` = `asr` / `translation`），
  并出现在 Settings 对应的 Model 下拉框中；下完新模型后点下拉框旁的
  **刷新列表**。

常见模型体积参考（量化版，实测）：

| 模型 | 体积 | 备注 |
| --- | --- | --- |
| `Xenova/whisper-tiny.en` | ~42 MB | 英文，最快，质量一般 |
| `Xenova/whisper-small` | ~242 MB | 多语言，性价比较好 |
| `Xenova/whisper-large-v2` | ~1.5 GB | 质量最好，慢，吃内存 |

> `.cache/` 已在 `.gitignore` 中，**不要提交到 Git**。

---

## API 服务端

```bash
npm run server       # http://localhost:8787
```

启动后会打印当前引擎、模型、代理、鉴权与已缓存模型：

```
whisper-web API listening on http://localhost:8787
  engine : auto (local models & tiny/base/... ids -> local, otherwise openai when configured)
  model  : Xenova/whisper-tiny.en
  proxy  : http://127.0.0.1:59597
  auth   : disabled
  local  : ready (Xenova/whisper-large-v2, Xenova/whisper-small, Xenova/whisper-tiny.en)
```

### 接口一览

| Method | Endpoint | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查：引擎、模型、代理、已缓存模型、是否需鉴权 |
| `GET` | `/api/models` | 本服务端可用模型（已缓存 + 别名 + 远端模型） |
| `POST` | `/api/transcribe` | 上传音频转写 |
| `POST` | `/api/bilingual` | 转写 **+ 翻译**，返回双语结果 |
| `POST` | `/api/translate` | 只翻译：`{ lines, target_language }` → `{ translations }` |
| `POST` | `/v1/audio/transcriptions` | `/api/transcribe` 的 OpenAI 兼容别名 |
| `POST` | `/v1/audio/bilingual` | `/api/bilingual` 的别名 |
| `GET` | `/api/upstream/models` | 查询**第三方**端点的模型列表（`baseUrl` / `apiKey`） |
| `GET` | `/api/upstream/health` | 探活第三方端点（同上参数） |

### 三种引擎

`WHISPER_ENGINE` 为空时**按 model id 自动选择**：
`tiny.en`/`base`/`small`... 与 `Xenova/*`、`distil-whisper/*` → `local`；
其它 → `openai`（未配置 Key 时会回退 `local`）。
也可以每次请求用 `-F engine=local|openai|command` 强制指定。

| 引擎 | 说明 |
| --- | --- |
| `local` | 在 Node 进程内跑 transformers.js，与浏览器用的是同一批模型。权重来自 `LOCAL_CACHE_DIR`，`LOCAL_OFFLINE=1` 可禁止联网，`HF_ENDPOINT` 可换镜像。**需要 `ffmpeg`**。`quantized=false` 用 fp32 权重 |
| `openai` | 转发到任意 OpenAI 兼容端点（`OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`），如 OpenAI、Groq、DashScope、自建 faster-whisper |
| `command` | 调本地 CLI，默认 Python 的 `whisper`（`WHISPER_COMMAND`、`WHISPER_COMMAND_ARGS`、`WHISPER_COMMAND_MODEL`） |

### `POST /api/transcribe` 参数

`multipart/form-data`，字段名如下：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `file` | ✅ | 音频文件（**字段名必须叫 `file`**） |
| `model` | | 模型 id 或别名，如 `tiny.en`、`Xenova/whisper-small`、`whisper-1`。不填用服务端默认 |
| `language` | | 如 `en`、`zh`。**`.en` 单语模型不要传**（见避坑） |
| `task` | | `transcribe`（默认）或 `translate` |
| `engine` | | 强制引擎：`local` / `openai` / `command` |
| `quantized` | | `false` 用 fp32 权重（默认 `true`） |
| `response_format` / `format` | | `txt` / `srt` / `json`，见下 |
| `upstream_base_url` | | 用**其它** OpenAI 兼容端点（Groq、DashScope、自建 faster-whisper…），见下节 |
| `upstream_api_key` | | 该端点的 Key |
| `upstream_model` | | 该端点的模型名（默认同 `model`） |

`response_format` 也可以作为 **query 参数**传递（`?format=srt`）。

### 返回格式（txt / srt / json）

三种是**与页面导出按钮字节一致**的内容——服务端与浏览器共用
`src/utils/ExportFormats.js`。

| 值 | Content-Type | 内容 |
| --- | --- | --- |
| 不填 / `verbose_json` | `application/json` | 富对象 `{text, chunks, language, duration, engine, model}` |
| `json` | `application/json` | 导出的 `.json` 文件内容（顶层数组） |
| `txt` | `text/plain` | 导出的 `.txt` 内容 |
| `srt` | `application/x-subrip` | 导出的 `.srt` 字幕 |

响应带 `Content-Disposition`，文件名 = 上传文件的基名 + 对应扩展名；
加 `?download=1` 变成 `attachment`，`curl -OJ` 可直接落盘。

默认（富对象）响应：

```json
{
  "text": " And so my fellow Americans ask not what your country can do for you...",
  "chunks": [
    { "timestamp": [0, 7.74], "text": " And so my fellow Americans", "trans": "" },
    { "timestamp": [7.74, 10.64], "text": " ask what you can do...", "trans": "" }
  ],
  "language": null,
  "duration": 11,
  "engine": "local",
  "model": "Xenova/whisper-tiny.en"
}
```

### curl 示例

**Git Bash / macOS / Linux：**

```bash
# 1. 先探活（不依赖任何模型与网络）
curl -s --noproxy '*' http://localhost:8787/api/health

# 2. 转写（文件名有空格就整体加引号）
curl -s --noproxy '*' -F "file=@Excuse Me.mp3" -F "model=tiny.en" \
     http://localhost:8787/api/transcribe

# 3. 直接要 SRT 字幕并存盘
curl -sOJ --noproxy '*' -F "file=@Excuse Me.mp3" \
     "http://localhost:8787/api/transcribe?format=srt&download=1"

# 4. 用 OpenAI 兼容别名
curl -s --noproxy '*' -F "file=@a.mp3" -F "model=whisper-1" \
     http://localhost:8787/v1/audio/transcriptions
```

**Windows CMD：**

```bat
curl -s http://localhost:8787/api/health
curl -s -F "file=@Excuse Me.mp3" -F "model=tiny.en" -F "language=en" http://localhost:8787/api/transcribe
```

**PowerShell：**

```powershell
curl.exe -s -F "file=@Excuse Me.mp3" -F "model=tiny.en" http://localhost:8787/api/transcribe
```

> PowerShell 的 `curl` 是 `Invoke-WebRequest` 的别名，**不支持 `-F`**，
> 请写 `curl.exe`。

### `POST /api/bilingual` 双语

参数 = [`POST /api/transcribe` 的全部参数](#post-apitranscribe-参数) +
下面这些（同样既支持 form 字段也支持 query）：

| 字段 | 说明 |
| --- | --- |
| `target_language` / `targetLanguage` | 目标语言 id，如 `zh`、`zh-Hant`、`en`、`ja`。默认 `TRANSLATION_TARGET` 或 `zh` |
| `source_language` / `sourceLanguage` | 源语言提示，缺省用转写返回的 `language` |
| `translation_engine` / `translationEngine` | `local`（🤗 翻译模型）或 `openai`（聊天模型）。填了 `upstream_base_url` 时默认 `openai`，否则 `local` |
| `translation_model` / `translationModel` | 翻译模型 / 聊天模型 id，缺省分别为 `TRANSLATION_MODEL`、`TRANSLATION_API_MODEL` |

```bash
# 本地引擎转写 + 本地翻译模型，直接要双语 SRT
curl -sOJ --noproxy '*' -F "file=@demo.mp3" -F "engine=local" -F "model=tiny.en" \
     -F "translation_engine=local" -F "translation_model=Xenova/opus-mt-en-zh" \
     -F "target_language=zh" \
     "http://localhost:8787/api/bilingual?format=srt&download=1"

# 用 Groq 的聊天模型做上下文翻译（转写走本地，翻译走 LLM）
curl -s --noproxy '*' -F "file=@demo.mp3" -F "engine=local" -F "model=tiny.en" \
     -F "translation_engine=openai" \
     -F "upstream_base_url=https://api.groq.com/openai/v1" \
     -F "upstream_api_key=gsk_xxx" -F "translation_model=llama-3.3-70b-versatile" \
     -F "target_language=zh" http://localhost:8787/api/bilingual
```

返回（不带 `response_format` 时）会在普通结果上多一个 `translation` 字段：

```json
{
  "text": " Hello world.",
  "chunks": [
    { "timestamp": [0, 2], "text": " Hello world.", "trans": "你好世界。" }
  ],
  "engine": "local",
  "model": "tiny.en",
  "translation": {
    "engine": "local",
    "model": "Xenova/opus-mt-en-zh",
    "target_language": "zh",
    "label": "Chinese (Simplified)"
  }
}
```

带 `response_format=txt|srt|json` 时返回的就是[双语导出内容](#5-导出格式与-trans-字段)，
与页面 Export 按钮下载到的文件**逐字节一致**。

### `POST /api/translate` 单独翻译

只想翻译文本、不想碰音频时用这个（页面翻译走的也是它）：

```bash
curl -s --noproxy '*' -X POST http://localhost:8787/api/translate \
     -H "Content-Type: application/json" \
     -d '{
           "engine": "local",
           "model": "Xenova/opus-mt-en-zh",
           "target_language": "zh",
           "source_language": "en",
           "lines": ["Hello world.", "The weather is nice today."]
         }'
# {"translations":["你好世界。","今天天气不错"],"engine":"local","target_language":"zh",...}
```

`context_lines: [{ text, trans }]` 可传入已译好的前几句作为上下文（LLM 引擎有效）。

开了 `API_TOKEN` 后要带鉴权：

```bash
curl -s -H "Authorization: Bearer $API_TOKEN" -F "file=@a.mp3" \
     http://localhost:8787/api/transcribe
```

### 接入第三方 OpenAI 兼容端点（Groq / DashScope / ...）

Settings → **Server API** → *API base URL* 可以填三种形式：

| 填法 | 效果 |
| --- | --- |
| `/api`（默认） | 用本项目自带的服务端 |
| `https://api.groq.com/openai/v1` | 第三方端点根地址 |
| `https://api.groq.com/openai/v1/audio/transcriptions` | 完整端点地址（自动归一化成根地址） |

填了第三方地址后，**请求会经本地 Node 服务端中转**，原因是浏览器无法直连：

- 跨域（CORS）会被拦；
- 浏览器**不走系统代理**，而本机出网必须走代理。

服务端已装 `undici` 的 `EnvHttpProxyAgent`，会应用 `HTTP_PROXY` / `HTTPS_PROXY`，
所以由它代发请求才有网。因此**用第三方端点时 `npm run server` 必须开着**。

配套行为：

- *Model* 下拉框会拉 `GET /api/upstream/models`，直接列出上游真实模型
  （如 Groq 的 `whisper-large-v3`、`whisper-large-v3-turbo`），**不用手打**；
  语音类模型排在最前。
- *Test connection* 打 `/api/upstream/health`，会回显 `OK — 可达，N 个模型`，
  或把上游的原始报错（401 无效 Key、404 地址错）原样显示出来。
- 上游的 4xx / 5xx 会**原样透传**，例如模型名打错会看到
  `上游 400 … The model 'xxx' does not exist`。

服务端想禁用这种按请求切换上游（多用户部署时），设 `ALLOW_UPSTREAM_OVERRIDE=0`。

```bash
# 直接用 curl 走中转（不经过页面）
curl -s --noproxy '*' \
  -F "file=@a.mp3" \
  -F "model=whisper-large-v3" \
  -F "upstream_base_url=https://api.groq.com/openai/v1" \
  -F "upstream_api_key=$GROQ_API_KEY" \
  http://localhost:8787/api/transcribe

# 先看这个端点通不通、有哪些模型
curl -s --noproxy '*' -G http://localhost:8787/api/upstream/models \
  --data-urlencode "baseUrl=https://api.groq.com/openai/v1" \
  --data-urlencode "apiKey=$GROQ_API_KEY"
```

### 环境变量

复制 `server/.env.example` 为 `server/.env`，或直接 export。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `API_TOKEN` | 空 | 设置后所有请求需 `Authorization: Bearer <token>` 或 `X-API-Key` |
| `WHISPER_ENGINE` | 空（auto） | `local` / `openai` / `command` |
| `LOCAL_CACHE_DIR` | `.cache` | 权重缓存目录 |
| `LOCAL_MODEL` | `Xenova/whisper-tiny.en` | 未指定 model 时的默认值 |
| `LOCAL_OFFLINE` | `auto` | `1`/`true` 强制离线（权重必须已缓存） |
| `HF_ENDPOINT` | `https://huggingface.co` | 权重下载镜像 |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | 兼容端点 |
| `OPENAI_API_KEY` | 空 | 上游 Key |
| `OPENAI_MODEL` | `whisper-1` | 上游模型 |
| `WHISPER_COMMAND` | `whisper` | CLI 可执行文件名 |
| `WHISPER_COMMAND_ARGS` | `{file} --model {model} --output_format json --output_dir {outdir}` | CLI 参数模板 |
| `WHISPER_COMMAND_MODEL` | `base` | CLI 默认模型 |
| `WHISPER_COMMAND_TIMEOUT_MS` | `1800000` | CLI 超时（30 分钟） |
| `MAX_UPLOAD_MB` | `200` | 单文件上限 |
| `ALLOW_UPSTREAM_OVERRIDE` | `1` | 是否允许请求里带 `upstream_base_url` 切换上游；`0` 禁用 |
| `TRANSLATION_ENGINE` | 空（auto） | 翻译引擎：`local` / `openai` |
| `TRANSLATION_MODEL` | `Xenova/nllb-200-distilled-600M` | `local` 翻译引擎的 🤗 模型 |
| `TRANSLATION_API_MODEL` | `gpt-4o-mini` | `openai` 翻译引擎的聊天模型 |
| `TRANSLATION_TARGET` | `zh` | `/api/bilingual` 默认目标语言 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | — | 出网代理，服务端已自动接管 |

---

## 命令行 CLI

不想开页面、也不想手写 curl 时用 `scripts/cli.mjs`（`npm run cli`）：

```bash
npm run cli -- health                     # 探活
npm run cli -- models                     # 服务端可用模型

# 普通转写：直接要 SRT 并存盘
npm run cli -- transcribe demo.mp3 --engine local --model tiny.en --format srt -o demo.srt

# 双语：本地转写 + 本地翻译模型 → 双语 SRT
npm run cli -- bilingual demo.mp3 --engine local --model tiny.en \
            --translation-engine local --translation-model Xenova/opus-mt-en-zh \
            --target zh --format srt -o demo.zh.srt

# 双语：转写走本地，翻译交给 Groq 的 LLM（上下文语境翻译）
npm run cli -- bilingual demo.mp3 --engine local --model tiny.en \
            --translation-engine openai \
            --upstream-base-url https://api.groq.com/openai/v1 \
            --upstream-api-key gsk_xxx --translation-model llama-3.3-70b-versatile \
            --target zh --format txt -o demo.zh.txt
```

- 所有 `--xxx` 都会原样转成同名的请求字段（`-` 变 `_`），
  因此[转写参数表](#post-apitranscribe-参数)里的字段都能直接用。
- 常用别名：`--target`（`target_language`）、`--source`（`source_language`）。
- 不带 `--format` 返回完整 JSON 对象；带 `--format txt|srt|json` 返回导出内容。
- 目标服务用 `WHISPER_API` 改（默认 `http://localhost:8787/api`），
  鉴权用 `API_TOKEN`。

> 别名命令：`npm run bilingual -- demo.mp3 --target zh ...`

---

## 项目结构

```
whisper-web/
├── src/
│   ├── App.tsx / index.tsx         # 入口
│   ├── worker.js                   # 浏览器端 transformers.js worker（含进度上报）
│   ├── translationWorker.js        # 浏览器端翻译 worker（Browser 翻译引擎）
│   ├── components/
│   │   ├── AudioManager.tsx        # 输入源、文件队列、Settings、批量导出
│   │   ├── Transcript.tsx          # 双语结果 + 高亮跟随 + 点击跳转 + 导出按钮
│   │   ├── TranscribeButton.tsx    # 转写 / 双语按钮与进度
│   │   ├── Progress.tsx            # 进度条
│   │   ├── AudioPlayer.tsx / AudioRecorder.tsx
│   │   └── modal/                  # Modal / UrlInput（FileTile 在 AudioManager 内）
│   ├── hooks/
│   │   ├── useTranscriber.ts       # 三引擎调度、翻译流程、设置持久化
│   │   └── useWorker.ts
│   ├── assets/ css/ vite-env.d.ts
│   └── utils/
│       ├── ExportFormats.js        # ★ 前后端共用的 txt/srt/json（含双语）
│       ├── ExportUtils.ts          # 浏览器端下载封装
│       ├── TranslationFormats.js   # ★ 前后端共用的语言表/提示词/解析
│       ├── TranslationClient.ts    # 前端翻译客户端（浏览器 worker + 服务端）
│       ├── ApiClient.ts            # 前端 API 客户端（health/models/transcribe）
│       ├── AudioUtils.ts / BlobFix.ts / Constants.ts
├── server/
│   ├── index.js                    # Express API（三引擎 + 翻译 + 双语 + 返回格式）
│   └── .env.example
├── scripts/
│   ├── fetch-local-model.mjs       # npm run fetch-model（任意仓库 + 镜像优先）
│   ├── cli.mjs                     # npm run cli（transcribe / bilingual / models）
│   └── dev-all.js                  # npm run dev:all
├── .cache/                         # 权重缓存（gitignored，可能上 GB）
│   ├── Transcription models/       #   Whisper / ASR 模型（fetch-model 自动归类）
│   └── Translation models/         #   opus-mt / NLLB / m2m100 等翻译模型
└── vite.config.ts                  # /api 代理（server.proxy + preview.proxy）
```

---

## 开发命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 只起前端（5173） |
| `npm run server` | 只起 API（8787） |
| `npm run dev:all` | 两个一起起 |
| `npm run fetch-model` | 下载权重到 `.cache/<Transcription\|Translation> models/`（支持任意仓库，自动归类） |
| `npm run cli -- <cmd>` | 命令行转写 / 双语 / 查模型 |
| `npm run build` | `tsc && vite build` |
| `npm run preview` | 预览构建产物（已配置 `/api` 代理） |
| `npm run tsc` | 类型检查 |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run format` | Prettier |

---

## 避坑指南

### A. 端口与进程

**A1. 改了服务端代码但行为没变 —— 8787 上还挂着旧进程**

Windows 下 Node 监听带 `SO_REUSEADDR`，两个进程可以"同时绑定" 8787 且都不报错，
但请求只会被**先启动的那个**处理。

```bat
netstat -ano | findstr :8787
taskkill /PID <PID> /F
```

**A2. 后台起的服务"自己就没了"**

用 `(node server/index.js &)` 这种方式起的服务，会随那次终端调用结束被杀。
正式使用请单独开一个终端跑 `npm run server`，或用 `npm run dev:all`。

**A3. `vite preview` 下 `/api` 报 500**

`server.proxy` 不会自动应用到 preview。本项目已额外配置 `preview.proxy`，
但请确保 API 服务同时在 8787 上跑着。

### B. 网络与代理

**B1. `{"error":"fetch failed"}`**

两个原因叠加：

1. **Node 的全局 `fetch` 默认不读 `HTTP_PROXY` / `HTTPS_PROXY`** —— 服务端已装
   `undici` 并在启动时 `setGlobalDispatcher(new EnvHttpProxyAgent())` 修好，
   `/api/health` 里的 `proxy` 字段可以看到当前代理。
2. 代理可能有**域名白名单**，在 TLS 握手阶段直接掐断某些域名。例如
   `huggingface.co` / `api.openai.com` 被拦时，再怎么重试都是 `fetch failed`。

对策：优先用 **local 引擎 + 已缓存权重**（完全离线），或换可达的兼容端点
（`OPENAI_BASE_URL`）。

**B2. curl 访问 localhost 报 `upstream connect failed`**

curl 把 localhost 也送进了代理。加 `--noproxy '*'`（Git Bash），
或设置 `NO_PROXY=localhost,127.0.0.1`。

**B3. 填了 Groq / 其它第三方地址还是失败**

按顺序自查：

1. **本地服务端必须开着**（`npm run server`）——第三方请求是它代发的。
2. 浏览器**不走系统代理**，所以千万别指望页面直连外网，必须中转。
3. 模型名要用**上游的真实模型名**。Groq 是 `whisper-large-v3` /
   `whisper-large-v3-turbo`，不是本项目本地引擎的 `tiny.en` / `base`。
   用下拉框选，别手打。
4. 看报错：现在上游的 401 / 404 / 400 会原样显示（例如 `Invalid API Key`、
   `The model 'xxx' does not exist`），比原来的 `fetch failed` 好定位得多。

**B4. `pkill -f "server/index.js"` 把自己的 shell 也杀了**

Git Bash 里 `pkill -f` 会匹配到**当前这条命令行本身**（因为里面也有这个字符串），
结果是命令自杀、新服务根本没起来，而旧进程还活着 —— 表现为"改了代码没生效"。
用 `netstat -ano | grep :8787` 拿 PID 再 `taskkill /PID <PID> /F`。

**B5. 浏览器端模型下不动**

浏览器引擎由 `src/worker.js` 里 `env.allowLocalModels = false` 控制，
**强制从 huggingface.co 下载**。HF 不可达时，浏览器引擎等于不可用——
请改用服务端 **local 引擎**。

### C. 模型相关

**C1. `Array must not be empty`**

缓存里缺 `generation_config.json` → `no_timestamps_token_id` 为 `undefined`
→ `timestamp_begin` 变成 `NaN` → `subarray(0, NaN)` 得到空数组。
用 `npm run fetch-model` 下载会自动带上这个文件；手动拷权重时务必检查它存在。

**C2. 不报错但 `text` 是空字符串**

给 `.en` 单语模型（如 `Xenova/whisper-tiny.en`）传了 `language` 或 `task`
参数，解码器会直接吐空。服务端已自动规避；**自己调 API 时别给 `.en` 模型传
`language`**。

**C3. 选了没下载的模型**

`local` 引擎会尝试联网下载该模型；离线模式（`LOCAL_OFFLINE=1`）下会直接失败。
先用 `npm run fetch-model -- <model_id>` 下好，再点 Settings 里的**刷新列表**。

**C4. ffmpeg 不在 PATH**

`local` 引擎靠 ffmpeg 把任意音频转成 16kHz 单声道 f32le 再喂给模型，
缺了它 mp3/m4a/flac 全会失败。

**C5. 非 Xenova 的仓库下载失败**

老版本只认 `onnx/encoder_model_quantized.onnx` + `onnx/decoder_model_merged_quantized.onnx`，
所以 `zem214/whisper-medium` 这类命名不同的仓库必然失败。现在会先列仓库文件再挑，
并按 transformers.js 的布局归一化。仍失败时按提示处理：
镜像上没这个仓库（换 `--mirror`）、只有未合并的 decoder、或根本没有 ONNX 权重。
先跑 `npm run fetch-model -- <id> --list` 看仓库里到底有什么。

**C6. 翻译模型跑不起来**

- `local` 翻译引擎报「权重不在缓存目录」：
  `npm run fetch-model -- Xenova/opus-mt-en-zh`（脚本会按通用 ONNX 布局保存）。
- NLLB / m2m100 / mBART 才需要 `src_lang` / `tgt_lang`，opus-mt 这类单语对模型
  不需要；代码已按模型名自动判断。
- Server API 翻译返回 404：说明那个端点的 `/chat/completions` 不存在
  （只有 `/audio/transcriptions` 的 ASR 端点不能用来翻译）。

### D. 浏览器与前端

**D1. 浏览器模型缓存按 origin 隔离**

模型存在 Cache Storage 的 `transformers-cache` 里。
`localhost:5173` 与 `127.0.0.1:5173` 是**不同 origin**，换地址等于重新下载。
查看方式：DevTools → Application → Cache Storage → `transformers-cache`。

**D2. Settings 的 Model 下拉框里看不到已缓存模型**

说明前端拉 `/api/models` 失败了（通常是 API 没起或 `/api` 没代理）。
此时会用橙色字提示并回退到内置别名列表。**启动服务端后点「刷新列表」**。

**D3. Safari / M1 Mac 上报错**

原项目已知问题：某些 Safari 版本会在 WASM 推理时失败。用 Chrome / Edge / Firefox。

### E. 调用 API

**E1. 上传字段名必须叫 `file`**

```bash
curl -F "file=@a.mp3" ...     # ✅
curl -F "audio=@a.mp3" ...    # ❌ multer 收不到
```

**E2. 文件名含空格**

`-F "file=@Excuse Me.mp3"` —— `@` 后面整体加引号。Windows 路径建议用正斜杠：
`-F "file=@E:/tmp/Excuse Me.mp3"`。

**E3. 大文件被拒**

默认 `MAX_UPLOAD_MB=200`。超长录音先切片，或调大这个变量。

**E4. 长音频很慢**

`local` 引擎是 CPU 推理，参考速度：tiny.en 处理 11 秒语音约 3 秒；
large-v2 慢一个数量级。长音频建议用 `command`（本地 whisper CLI，可能带 GPU）
或远端 `openai` 引擎。

### F. 数据与存储

**F1. 别提交 `.cache/`**

权重目录可达 1.5GB+，已在 `.gitignore` 中。克隆仓库的人需要自己跑
`npm run fetch-model`。

**F2. 设置写在 localStorage**

换浏览器 / 清缓存后设置会恢复默认值（引擎回到 `browser`）。

---

## License

基于原项目的 [MIT License](LICENSE)，版权归原作者与贡献者所有。
本仓库的扩展部分同样以 MIT 发布。
