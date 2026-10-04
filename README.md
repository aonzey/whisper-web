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
- [下载本地模型权重](#下载本地模型权重fetch-model)
- [API 服务端](#api-服务端)
  - [接口一览](#接口一览)
  - [转写参数](#post-apitranscribe-参数)
  - [返回格式 txt / srt / json](#返回格式txt--srt--json)
  - [curl 示例](#curl-示例)
  - [环境变量](#环境变量)
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
| **Server API** | 由服务端决定（local / openai / command） | 可以接更强的远端模型（Groq、DashScope、faster-whisper 等） | 需要配置上游与 Key | 想要更好识别质量或有自建推理服务 |

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

### 6. Settings 面板逐项说明

| 设置项 | 说明 |
| --- | --- |
| **Transcription engine** | 见[第 2 节](#2-三种转写引擎该怎么选) |
| **Model** | 下拉框。服务端引擎下由 `GET /api/models` 填充，分两组：<br>· **已缓存（服务端可直接用）** —— 权重已在 `LOCAL_CACHE_DIR`，带精度与体积<br>· **其他可填的模型 / 别名** —— 未下载，选中会触发下载或报不可用 |
| **刷新列表** | 重新拉取 `/api/models`（下完新模型后点它） |
| **手动输入** | 切换成文本框，可填写列表里没有的模型 id |
| **Base URL** | 默认 `/api`（vite 已代理到 8787）。独立部署时填 `http://host:8787/api` |
| **API Key** | 服务端设了 `API_TOKEN` 时才需要 |
| **Test connection** | 打 `/api/health`，会回显服务端当前引擎与模型 |
| **Multilingual** | 勾选后可指定语言与 `translate` 任务 |
| **Language** | 源语言；`auto` 为自动检测 |
| **Task** | `transcribe`（原语言）或 `translate`（译成英文） |
| **Quantized** | 浏览器引擎用量化模型（更小更快，精度略降） |

所有设置存 `localStorage`（前缀 `whisper-web:`），刷新不丢。

---

## 下载本地模型权重（fetch-model）

服务端 `local` 引擎需要 ONNX 权重放在磁盘上：

```bash
npm run fetch-model                              # Xenova/whisper-tiny.en（量化，约 42MB）
npm run fetch-model -- Xenova/whisper-small      # 指定模型（约 242MB）
npm run fetch-model -- --full                    # 连 fp32 权重一起下（体积翻倍）
npm run fetch-model -- --force                   # 已存在也重新下载
npm run fetch-model -- --mirror https://hf-mirror.com/
```

- 输出目录：`<LOCAL_CACHE_DIR|./.cache>/<model_id>/<file>`，正好是
  transformers.js `FileSystemCache` 的布局。
- 默认先走 **ModelScope** 镜像，失败自动回退 huggingface.co。
- 已缓存的模型会列在 `/api/models` 里，并出现在 Settings 的 Model 下拉框中。

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
| `GET` | `/api/models` | 可用模型（已缓存 + 别名 + 远端模型） |
| `POST` | `/api/transcribe` | 上传音频转写 |
| `POST` | `/v1/audio/transcriptions` | 上一行的 OpenAI 兼容别名 |

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

开了 `API_TOKEN` 后要带鉴权：

```bash
curl -s -H "Authorization: Bearer $API_TOKEN" -F "file=@a.mp3" \
     http://localhost:8787/api/transcribe
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
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | — | 出网代理，服务端已自动接管 |

---

## 项目结构

```
whisper-web/
├── src/
│   ├── App.tsx / index.tsx         # 入口
│   ├── worker.js                   # 浏览器端 transformers.js worker（含进度上报）
│   ├── components/
│   │   ├── AudioManager.tsx        # 输入源、文件队列、Settings、批量导出
│   │   ├── Transcript.tsx          # 结果展示 + 单文件导出按钮
│   │   ├── TranscribeButton.tsx    # 转写按钮与进度
│   │   ├── Progress.tsx            # 进度条
│   │   ├── AudioPlayer.tsx / AudioRecorder.tsx
│   │   └── modal/                  # Modal / UrlInput（FileTile 在 AudioManager 内）
│   ├── hooks/
│   │   ├── useTranscriber.ts       # 三引擎调度、设置持久化
│   │   └── useWorker.ts
│   ├── assets/ css/ vite-env.d.ts
│   └── utils/
│       ├── ExportFormats.js        # ★ 前后端共用的 txt/srt/json 生成
│       ├── ExportUtils.ts          # 浏览器端下载封装
│       ├── ApiClient.ts            # 前端 API 客户端（health/models/transcribe）
│       ├── AudioUtils.ts / BlobFix.ts / Constants.ts
├── server/
│   ├── index.js                    # Express API（三引擎 + 返回格式）
│   └── .env.example
├── scripts/
│   ├── fetch-local-model.mjs       # npm run fetch-model（镜像优先下载权重）
│   └── dev-all.js                  # npm run dev:all
├── .cache/                         # 权重缓存（gitignored，可能上 GB）
└── vite.config.ts                  # /api 代理（server.proxy + preview.proxy）
```

---

## 开发命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 只起前端（5173） |
| `npm run server` | 只起 API（8787） |
| `npm run dev:all` | 两个一起起 |
| `npm run fetch-model` | 下载权重到 `.cache/` |
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

**B3. 浏览器端模型下不动**

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
