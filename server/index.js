/**
 * whisper-web API server
 *
 * Exposes a small REST API on top of Whisper:
 *   GET  /api/health       -> service status
 *   GET  /api/models       -> available models
 *   POST /api/transcribe   -> multipart upload ("file"), returns
 *                             { text, chunks: [{ timestamp, text, trans }] }
 *   POST /api/bilingual    -> same, but every chunk is also translated
 *   POST /api/translate    -> JSON { lines, target_language }, returns
 *                             { translations: [...] }
 *   POST /v1/audio/transcriptions  -> OpenAI compatible alias
 *
 * Transcription engines (WHISPER_ENGINE):
 *   - "local"    : runs 🤗 Transformers.js in-process (works offline after the
 *                  first download, model ids like `Xenova/whisper-tiny.en`)
 *   - "openai"   : forwards to any OpenAI compatible endpoint
 *   - "command"  : runs a local CLI (openai-whisper / whisper.cpp / ...)
 *
 * Translation engines (TRANSLATION_ENGINE):
 *   - "local"    : 🤗 Transformers.js `translation` pipeline
 *                  (`Xenova/nllb-200-distilled-600M`, `Xenova/opus-mt-en-zh`, …)
 *   - "openai"   : OpenAI compatible `/chat/completions` — LLM, context aware
 *
 * When WHISPER_ENGINE is not set the engine is auto-selected from the model id.
 *
 * Configuration (see .env.example):
 *   PORT, API_TOKEN, WHISPER_ENGINE, OPENAI_BASE_URL, OPENAI_API_KEY,
 *   OPENAI_MODEL, WHISPER_COMMAND, WHISPER_COMMAND_ARGS, WHISPER_COMMAND_MODEL,
 *   TRANSLATION_ENGINE, TRANSLATION_MODEL, TRANSLATION_API_MODEL,
 *   LOCAL_CACHE_DIR, HTTP_PROXY / HTTPS_PROXY / NO_PROXY
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import cors from "cors";
// Shared with the browser app so `response_format=txt|srt|json` returns
// exactly what the "Export TXT / SRT / JSON" buttons produce.
import { exportContent } from "../src/utils/ExportFormats.js";
import {
    TRANSLATION_BATCH_SIZE,
    TRANSLATION_CONTEXT_SIZE,
    buildTranslationPrompt,
    languageLabel,
    needsLanguageCodes,
    nllbCode,
    parseNumberedTranslations,
} from "../src/utils/TranslationFormats.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8787);
const API_TOKEN = process.env.API_TOKEN || "";
const CONFIGURED_ENGINE = (process.env.WHISPER_ENGINE || "").toLowerCase();
const OPENAI_BASE_URL = (
    process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
).replace(/\/+$/, "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "whisper-1";
const WHISPER_COMMAND = process.env.WHISPER_COMMAND || "whisper";
const WHISPER_COMMAND_ARGS =
    process.env.WHISPER_COMMAND_ARGS ||
    "{file} --model {model} --output_format json --output_dir {outdir}";
const WHISPER_COMMAND_MODEL = process.env.WHISPER_COMMAND_MODEL || "base";
const COMMAND_TIMEOUT_MS = Number(
    process.env.WHISPER_COMMAND_TIMEOUT_MS || 30 * 60 * 1000,
);
// When a request carries `upstream_base_url`, forward to that OpenAI
// compatible endpoint instead of OPENAI_BASE_URL (used by the UI's
// "Server API" engine so the browser does not have to call Groq & friends
// directly — no CORS, and the server's proxy settings apply).
const ALLOW_UPSTREAM_OVERRIDE =
    String(process.env.ALLOW_UPSTREAM_OVERRIDE || "1").toLowerCase() !== "0";
const LOCAL_DEFAULT_MODEL =
    process.env.LOCAL_MODEL || "Xenova/whisper-tiny.en";
/**
 * Root of the on-disk model cache. Two sub-folders keep the two model
 * families apart — they are both `encoder_model*.onnx` shaped, so a flat
 * layout makes it impossible to tell a translation model from a Whisper one
 * without reading every config.json:
 *
 *     <cache>/Transcription models/<model-id>/...
 *     <cache>/Translation models/<model-id>/...
 *
 * The old flat `<cache>/<model-id>/...` layout is still discovered (read
 * only) so caches downloaded before the split keep working.
 */
const CACHE_ROOT =
    process.env.LOCAL_CACHE_DIR || path.join(process.cwd(), ".cache");
const ASR_SUBDIR = "Transcription models";
const MT_SUBDIR = "Translation models";
const ASR_CACHE_DIR = path.join(CACHE_ROOT, ASR_SUBDIR);
const MT_CACHE_DIR = path.join(CACHE_ROOT, MT_SUBDIR);
const LOCAL_CACHE_DIR = CACHE_ROOT;
// When true the `local` engine never touches the network (weights must already
// be in LOCAL_CACHE_DIR — see `npm run fetch-model`).
const LOCAL_OFFLINE = String(
    process.env.LOCAL_OFFLINE || "auto",
).toLowerCase();
const HF_ENDPOINT = (process.env.HF_ENDPOINT || "https://huggingface.co/").replace(
    /\/+$/,
    "",
) + "/";
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 200);

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------
const TRANSLATION_ENGINE = (process.env.TRANSLATION_ENGINE || "").toLowerCase();
/** 🤗 model used by the `local` translation engine. */
const TRANSLATION_MODEL =
    process.env.TRANSLATION_MODEL || "Xenova/nllb-200-distilled-600M";
/** Chat model used by the `openai` translation engine. */
const TRANSLATION_API_MODEL =
    process.env.TRANSLATION_API_MODEL || "gpt-4o-mini";
const TRANSLATION_DEFAULT_TARGET = process.env.TRANSLATION_TARGET || "zh";

// Node's global `fetch` ignores HTTP_PROXY/HTTPS_PROXY, so we install an
// environment aware dispatcher when a proxy is configured.
const PROXY_URL =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    "";
if (PROXY_URL || process.env.NO_PROXY || process.env.no_proxy) {
    try {
        const { EnvHttpProxyAgent, setGlobalDispatcher } = await import(
            "undici"
        );
        setGlobalDispatcher(new EnvHttpProxyAgent());
    } catch (e) {
        console.warn("[warn] could not enable proxy support:", e?.message ?? e);
    }
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

const app = express();
app.use(cors());
// /api/translate and /api/bilingual take JSON bodies
app.use(express.json({ limit: "16mb" }));

/** Optional shared secret: send `Authorization: Bearer <API_TOKEN>` or `X-API-Key`. */
function requireToken(req, res, next) {
    if (!API_TOKEN) return next();
    const header = req.get("authorization") || "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const provided = bearer || req.get("x-api-key") || "";
    if (provided !== API_TOKEN) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
}

const LOCAL_MODEL_PATTERN = /^(Xenova\/|onnx-community\/|distil-whisper\/)/;
// openai-whisper / whisper.cpp style names -> 🤗 Transformers.js repo ids
const SIZE_ALIAS = /^(tiny|base|small|medium|large)(-v\d+)?(\.en)?$/;
const DISTIL_ALIAS = /^distil-(large|medium)(\.en)?(-v\d+)?$/;

/** `tiny.en` -> `Xenova/whisper-tiny.en`, `distil-large-v2` -> `distil-whisper/...`. */
function toLocalModelId(model) {
    if (!model) return "";
    if (LOCAL_MODEL_PATTERN.test(model)) return model;
    if (DISTIL_ALIAS.test(model)) return `distil-whisper/${model}`;
    if (SIZE_ALIAS.test(model)) return `Xenova/whisper-${model}`;
    return model;
}

/** Does `dir` look like a transformers.js model folder? */
function looksLikeModelDir(dir) {
    return (
        fs.existsSync(path.join(dir, "onnx")) ||
        fs.existsSync(path.join(dir, "config.json"))
    );
}

/**
 * Where does `model` actually live? Returns the cache root (what
 * transformers.js needs as `cache_dir`) and the model folder itself.
 * `prefer` decides the root when the model is not downloaded yet.
 */
function resolveModelDir(model, prefer = "asr") {
    const fallback = prefer === "translation" ? MT_CACHE_DIR : ASR_CACHE_DIR;
    if (!model || model.includes("..")) {
        return { root: fallback, dir: path.join(fallback, model ?? "") };
    }
    for (const root of [ASR_CACHE_DIR, MT_CACHE_DIR, CACHE_ROOT]) {
        const dir = path.join(root, model);
        if (fs.existsSync(dir) && looksLikeModelDir(dir)) {
            return { root, dir };
        }
    }
    return { root: fallback, dir: path.join(fallback, model) };
}

const localModelPath = (model, file) =>
    path.join(resolveModelDir(model).dir, file);

/** Which weight files are already on disk for `model`? */
function inspectLocalModel(model) {
    const quantized =
        fs.existsSync(localModelPath(model, "onnx/encoder_model_quantized.onnx")) &&
        fs.existsSync(
            localModelPath(model, "onnx/decoder_model_merged_quantized.onnx"),
        );
    const fp32 =
        fs.existsSync(localModelPath(model, "onnx/encoder_model.onnx")) &&
        fs.existsSync(localModelPath(model, "onnx/decoder_model_merged.onnx"));
    const ready = quantized || fp32;
    return { exists: ready, quantized, fp32 };
}

/** Total size (bytes) of every file under `dir`, best effort. */
function dirSize(dir) {
    let total = 0;
    const walk = (current) => {
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (e) {
            return;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else {
                try {
                    total += fs.statSync(full).size;
                } catch (e) {
                    // ignore unreadable entries
                }
            }
        }
    };
    walk(dir);
    return total;
}

/** Which task a cached model can do, read from its config.json. */
function modelTask(model) {
    try {
        const config = JSON.parse(
            fs.readFileSync(localModelPath(model, "config.json"), "utf8"),
        );
        const type = String(config?.model_type ?? "").toLowerCase();
        // `marian` = opus-mt, `m2m_100` = nllb / m2m100, `mbart` = mBART
        if (/whisper/.test(type)) return "asr";
        if (/marian|m2m|mbart|bart|t5|nllb/.test(type)) return "translation";
    } catch (e) {
        // unreadable config -> unknown
    }
    return "";
}

/** Which cache sub-folder a model lives in ("" = legacy flat layout). */
function modelFolderTask(model) {
    try {
        const rel = path
            .relative(CACHE_ROOT, resolveModelDir(model).dir)
            .split(path.sep)[0];
        if (rel === ASR_SUBDIR) return "asr";
        if (rel === MT_SUBDIR) return "translation";
    } catch (e) {
        // ignore
    }
    return "";
}

/**
 * "asr" | "translation" | "" (unknown).
 * The config.json is authoritative; the cache folder is the fallback so a
 * model whose config cannot be read still lands in the right dropdown.
 */
function classifyModel(model) {
    return modelTask(model) || modelFolderTask(model);
}

/** Keep only the models usable for `task` ("asr" | "translation"). */
function filterByTask(ids, task) {
    if (task === "translation") {
        return ids.filter((id) => classifyModel(id) !== "asr");
    }
    if (task === "asr") {
        return ids.filter((id) => classifyModel(id) !== "translation");
    }
    return ids;
}

/** Every model id that has usable weights in the cache. */
function listLocalModels() {
    const found = new Set();
    const walk = (dir, prefix) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const full = path.join(dir, entry.name);
            const id = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (looksLikeModelDir(full)) {
                found.add(id);
                continue;
            }
            walk(full, id);
        }
    };

    walk(ASR_CACHE_DIR, "");
    walk(MT_CACHE_DIR, "");
    // Legacy flat layout (`<cache>/<model-id>/...`).
    let rootEntries = [];
    try {
        rootEntries = fs.readdirSync(CACHE_ROOT, { withFileTypes: true });
    } catch (e) {
        rootEntries = [];
    }
    for (const entry of rootEntries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === ASR_SUBDIR || entry.name === MT_SUBDIR) continue;
        const full = path.join(CACHE_ROOT, entry.name);
        if (looksLikeModelDir(full)) {
            found.add(entry.name);
            continue;
        }
        walk(full, entry.name);
    }
    return [...found];
}

function resolveEngine(model, explicit, upstreamBase) {
    if (explicit) return explicit;
    if (CONFIGURED_ENGINE) return CONFIGURED_ENGINE;
    // A per-request upstream always means "call that OpenAI compatible API".
    if (upstreamBase) return "openai";
    if (LOCAL_MODEL_PATTERN.test(model || "")) return "local";
    if (SIZE_ALIAS.test(model || "") || DISTIL_ALIAS.test(model || "")) {
        return "local";
    }
    // Reaching an OpenAI compatible endpoint is only possible when we know
    // where to go and have a key — otherwise fall back to the local model.
    if (OPENAI_API_KEY || process.env.OPENAI_BASE_URL) return "openai";
    return "local";
}

function defaultModel() {
    if (CONFIGURED_ENGINE === "command") return WHISPER_COMMAND_MODEL;
    if (CONFIGURED_ENGINE === "local") return LOCAL_DEFAULT_MODEL;
    if (CONFIGURED_ENGINE === "openai") return OPENAI_MODEL;
    // auto: prefer a model that is actually present on disk
    const cached = listLocalModels();
    if (cached.length) return cached.includes(LOCAL_DEFAULT_MODEL)
        ? LOCAL_DEFAULT_MODEL
        : cached[0];
    return LOCAL_DEFAULT_MODEL;
}

/** Normalize any engine output to { text, chunks: [{timestamp, text, trans}] }. */
function normalize(raw, model, engine) {
    const segments = raw?.segments ?? raw?.chunks ?? [];
    const chunks = segments.map((segment) => ({
        timestamp: [
            segment.start ?? segment.timestamp?.[0] ?? 0,
            segment.end ?? segment.timestamp?.[1] ?? null,
        ],
        text: segment.text ?? "",
        trans: segment.trans ?? "",
    }));
    const text =
        raw?.text ?? chunks.map((chunk) => chunk.text).join("").trim();

    return {
        text,
        chunks,
        language: raw?.language ?? null,
        duration: raw?.duration ?? null,
        engine,
        model,
    };
}

/* ------------------------------------------------------------------ *
 * Engine: local (Transformers.js running inside this Node process)
 * ------------------------------------------------------------------ */

const localPipelines = new Map();

function ffmpegToRawFloat32(input, output) {
    return new Promise((resolve, reject) => {
        execFile(
            "ffmpeg",
            [
                "-nostdin",
                "-y",
                "-i",
                input,
                "-ar",
                "16000",
                "-ac",
                "1",
                "-f",
                "f32le",
                "-c:a",
                "pcm_f32le",
                output,
            ],
            { maxBuffer: 8 * 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error) {
                    const detail = String(stderr || error.message).slice(-800);
                    reject(
                        new Error(
                            `ffmpeg 转码失败（需要 ffmpeg 在 PATH 中）: ${detail}`,
                        ),
                    );
                } else {
                    resolve();
                }
            },
        );
    });
}

async function runLocal({ file, model, language, task, quantized }) {
    const { pipeline, env } = await import("@xenova/transformers");
    env.allowLocalModels = true;
    env.useFSCache = true;
    env.cacheDir = CACHE_ROOT; // fallback for the legacy flat layout
    // Per model cache folder, passed per call so a concurrent translation
    // request cannot swap the directory out from under this pipeline.
    const cacheDir = resolveModelDir(model, "asr").root;
    // Allow mirrors (e.g. https://hf-mirror.com) when the default host is blocked
    env.remoteHost = HF_ENDPOINT;

    const weights = inspectLocalModel(model);
    const offline =
        LOCAL_OFFLINE === "1" ||
        LOCAL_OFFLINE === "true" ||
        (LOCAL_OFFLINE === "auto" && weights.exists);
    env.allowRemoteModels = !offline;

    if (!weights.exists && offline) {
        throw new Error(
            `本地模型 ${model} 的权重不在缓存目录里。` +
                `请先执行：npm run fetch-model -- ${model}` +
                `（缓存目录 ${cacheDir}）`,
        );
    }
    // Respect the weights that are actually present on disk.
    if (weights.exists && !weights.quantized) quantized = false;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-"));
    try {
        const ext = path.extname(file.originalname || "") || ".wav";
        const input = path.join(dir, `input${ext}`);
        const raw = path.join(dir, "audio.raw");
        fs.writeFileSync(input, file.buffer);
        await ffmpegToRawFloat32(input, raw);

        const buffer = fs.readFileSync(raw);
        const audio = new Float32Array(
            buffer.buffer,
            buffer.byteOffset,
            Math.floor(buffer.byteLength / 4),
        );

        const key = `${model}|${quantized}`;
        let pending = localPipelines.get(key);
        if (!pending) {
            console.log(
                `[local] loading pipeline ${model} (quantized=${quantized})`,
            );
            pending = pipeline("automatic-speech-recognition", model, {
                quantized,
                cache_dir: cacheDir,
            });
            localPipelines.set(key, pending);
            pending.catch(() => localPipelines.delete(key));
        }
        const transcriber = await pending;

        // `.en` models have no language/task tokens — passing them makes the
        // decoder emit an empty transcript, so we only send them when the
        // model is multilingual.
        const englishOnly = /(\.en$)|(^distil-[a-z0-9-]*\.en)/.test(model);

        const output = await transcriber(audio, {
            top_k: 0,
            do_sample: false,
            chunk_length_s: 30,
            stride_length_s: 5,
            return_timestamps: true,
            force_full_sequences: false,
            ...(englishOnly
                ? {}
                : {
                      language: language || undefined,
                      task: task === "translate" ? "translate" : "transcribe",
                  }),
        });

        const duration = audio.length / 16000;
        return {
            text: output.text ?? "",
            chunks: output.chunks ?? [],
            duration,
            language: language || null,
        };
    } catch (error) {
        const haveWeights = inspectLocalModel(model).exists;
        throw new Error(
            `本地模型 ${model} 加载/推理失败: ${error?.message ?? error}. ` +
                (haveWeights
                    ? `权重已存在，检查 ${resolveModelDir(model).dir} 是否完整。`
                    : `请先下载权重：npm run fetch-model -- ${model}` +
                      `（如 huggingface.co 不可达可设 HF_ENDPOINT 指向镜像，或用 ` +
                      `--mirror https://www.modelscope.cn 走 ModelScope）。`),
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/* ------------------------------------------------------------------ *
 * Engine: openai (forward to an OpenAI compatible endpoint)
 * ------------------------------------------------------------------ */

async function forwardToOpenAI({ file, model, language, task, apiKey, baseUrl }) {
    const form = new FormData();
    const blob = new Blob([file.buffer], {
        type: file.mimetype || "application/octet-stream",
    });
    form.append("file", blob, file.originalname || "audio.wav");
    form.append("model", model);
    if (language) form.append("language", language);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    if (task === "translate") form.append("task", "translate");

    const base = upstreamRoot(baseUrl || OPENAI_BASE_URL);
    const url = `${base}/audio/transcriptions`;
    let response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
            body: form,
        });
    } catch (error) {
        const cause = error?.cause?.message ? ` (${error.cause.message})` : "";
        throw new Error(
            `无法访问上游 ${url}: ${error?.message ?? error}${cause}. ` +
                `若在代理环境下请设置 HTTPS_PROXY/HTTP_PROXY（服务会自动应用）；` +
                `或设置 WHISPER_ENGINE=local 用本地模型转写。`,
        );
    }

    const body = await response.text();
    if (!response.ok) {
        // Surface the upstream payload: model typos (e.g. `whisper-large-v3`
        // vs `whisper-large-v3-turbo`) and bad keys are only visible there.
        throw new Error(
            `上游 ${response.status} ${response.statusText}: ${body.slice(0, 600)}`,
        );
    }
    try {
        return JSON.parse(body);
    } catch (e) {
        // Some servers reply with plain text
        return { text: body };
    }
}

/* ------------------------------------------------------------------ *
 * Engine: command (local CLI such as `whisper`)
 * ------------------------------------------------------------------ */

function runCommand({ file, model, language, task }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-"));
    const ext = path.extname(file.originalname || "") || ".wav";
    const input = path.join(dir, `input${ext}`);
    fs.writeFileSync(input, file.buffer);

    const args = WHISPER_COMMAND_ARGS.split(/\s+/)
        .map((part) =>
            part
                .replaceAll("{file}", input)
                .replaceAll("{model}", model)
                .replaceAll("{outdir}", dir)
                .replaceAll("{language}", language || "")
                .replaceAll("{task}", task || "transcribe"),
        )
        .filter((part) => part.length > 0);

    return new Promise((resolve, reject) => {
        execFile(
            WHISPER_COMMAND,
            args,
            { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
            (error, stdout, stderr) => {
                try {
                    if (error) {
                        reject(
                            new Error(
                                `${WHISPER_COMMAND} failed: ${
                                    stderr || error.message
                                }`.slice(0, 2000),
                            ),
                        );
                        return;
                    }
                    const base = path.basename(input, ext);
                    const jsonPath = path.join(dir, `${base}.json`);
                    const candidates = fs
                        .readdirSync(dir)
                        .filter((name) => name.endsWith(".json"))
                        .map((name) => path.join(dir, name));
                    const target =
                        candidates.find((p) => p === jsonPath) ??
                        candidates[0];
                    if (!target) {
                        resolve({ text: (stdout || "").trim() });
                        return;
                    }
                    resolve(JSON.parse(fs.readFileSync(target, "utf8")));
                } catch (e) {
                    reject(e);
                } finally {
                    fs.rmSync(dir, { recursive: true, force: true });
                }
            },
        );
    });
}

/* ------------------------------------------------------------------ *
 * Engine: translation
 *   "local"  -> 🤗 Transformers.js `translation` pipeline
 *   "openai" -> OpenAI compatible /chat/completions (context aware LLM)
 * ------------------------------------------------------------------ */

const translationPipelines = new Map();

/** Does the cache hold usable weights for a generic (non whisper) model? */
function inspectGenericModel(model) {
    const quantized = fs.existsSync(
        localModelPath(model, "onnx/model_quantized.onnx"),
    );
    const specific = fs.existsSync(
        localModelPath(model, "onnx/encoder_model_quantized.onnx"),
    );
    const specificFp32 = fs.existsSync(
        localModelPath(model, "onnx/encoder_model.onnx"),
    );
    const fp32 =
        fs.existsSync(localModelPath(model, "onnx/model.onnx")) ||
        specificFp32;
    return { exists: quantized || specific || fp32, quantized: quantized || specific, fp32 };
}

async function runLocalTranslation({
    lines,
    model,
    sourceLanguage,
    targetLanguage,
    quantized,
}) {
    const { pipeline, env } = await import("@xenova/transformers");
    env.allowLocalModels = true;
    env.useFSCache = true;
    env.cacheDir = CACHE_ROOT; // fallback for the legacy flat layout
    const cacheDir = resolveModelDir(model, "translation").root;
    env.remoteHost = HF_ENDPOINT;

    const weights = inspectGenericModel(model);
    const offline =
        LOCAL_OFFLINE === "1" ||
        LOCAL_OFFLINE === "true" ||
        (LOCAL_OFFLINE === "auto" && weights.exists);
    env.allowRemoteModels = !offline;

    if (!weights.exists && offline) {
        throw new Error(
            `本地翻译模型 ${model} 的权重不在缓存目录里。` +
                `请先执行：npm run fetch-model -- ${model}（缓存目录 ${cacheDir}）`,
        );
    }
    if (weights.exists && !weights.quantized) quantized = false;

    const key = `${model}|${quantized}`;
    let pending = translationPipelines.get(key);
    if (!pending) {
        console.log(`[translate] loading pipeline ${model} (from ${cacheDir})`);
        pending = pipeline("translation", model, {
            quantized,
            cache_dir: cacheDir,
        });
        translationPipelines.set(key, pending);
        pending.catch(() => translationPipelines.delete(key));
    }
    const translator = await pending;

    const options = {};
    if (needsLanguageCodes(model)) {
        options.src_lang = nllbCode(sourceLanguage) || "eng_Latn";
        options.tgt_lang = nllbCode(targetLanguage) || nllbCode("zh") || "zho_Hans";
    }

    const output = await translator(
        lines.map((line) => String(line ?? "").trim()),
        options,
    );
    return (Array.isArray(output) ? output : [output]).map(
        (item) => item?.translation_text ?? "",
    );
}

/** Call an OpenAI compatible chat endpoint and parse the numbered reply. */
async function translateViaChat({
    lines,
    model,
    sourceLanguage,
    targetLanguage,
    context,
    extraPrompt,
    apiKey,
    baseUrl,
}) {
    const prompt = buildTranslationPrompt({
        lines,
        context: context ?? [],
        sourceLanguage,
        targetLanguage,
        extraPrompt,
    });

    const base = upstreamRoot(baseUrl || OPENAI_BASE_URL);
    const url = `${base}/chat/completions`;
    const body = {
        model: model || TRANSLATION_API_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
    };

    let response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify(body),
        });
    } catch (error) {
        const cause = error?.cause?.message ? ` (${error.cause.message})` : "";
        throw new Error(
            `无法访问上游 ${url}: ${error?.message ?? error}${cause}. ` +
                `若在代理环境下请设置 HTTPS_PROXY/HTTP_PROXY；或改用 ` +
                `"translation_engine": "local"（先 npm run fetch-model -- ${TRANSLATION_MODEL}）。`,
        );
    }

    const text = await response.text();
    if (!response.ok) {
        throw new Error(`上游 ${response.status} ${response.statusText}: ${text.slice(0, 600)}`);
    }
    let content = "";
    try {
        const json = JSON.parse(text);
        content = json?.choices?.[0]?.message?.content ?? "";
    } catch (e) {
        content = text;
    }
    if (!content) {
        throw new Error(`上游未返回译文：${text.slice(0, 300)}`);
    }
    return parseNumberedTranslations(content, lines.length);
}

/**
 * Translate every line, batched, carrying the previous lines over as context
 * for the LLM engines. Returns an array with the same length as `lines`.
 */
async function translateLines({
    lines,
    engine,
    model,
    sourceLanguage,
    targetLanguage,
    contextLines,
    upstreamBase,
    upstreamKey,
    upstreamModel,
    extraPrompt,
}) {
    const list = (lines ?? []).map((line) => String(line ?? ""));
    const size = Math.max(1, TRANSLATION_BATCH_SIZE);
    const result = new Array(list.length).fill("");

    for (let start = 0; start < list.length; start += size) {
        const batch = list.slice(start, start + size);
        const context = [];
        for (
            let i = Math.max(0, start - TRANSLATION_CONTEXT_SIZE);
            i < start;
            i++
        ) {
            context.push({ text: list[i], trans: result[i] });
        }
        // The very first batch can use context supplied by the caller.
        const merged =
            start === 0 && Array.isArray(contextLines) && contextLines.length
                ? contextLines
                : context;

        let translated;
        if (engine === "local") {
            translated = await runLocalTranslation({
                lines: batch,
                model: model || TRANSLATION_MODEL,
                sourceLanguage,
                targetLanguage,
                quantized: true,
            });
        } else {
            translated = await translateViaChat({
                lines: batch,
                model: upstreamModel || model || TRANSLATION_API_MODEL,
                sourceLanguage,
                targetLanguage,
                context: merged,
                extraPrompt,
                apiKey: upstreamKey || OPENAI_API_KEY || "",
                baseUrl: upstreamBase || OPENAI_BASE_URL,
            });
        }
        for (let i = 0; i < batch.length; i++) {
            result[start + i] = translated[i] ?? "";
        }
    }
    return result;
}

/**
 * Free-form instructions for the LLM translation engine. Only the
 * "openai" (chat) engine can use them — 🤗 models ignore them.
 */
function extraPromptOf(req) {
    return String(
        req.body?.extra_prompt ??
            req.body?.translation_prompt ??
            req.body?.prompt ??
            req.query?.extra_prompt ??
            "",
    );
}

/** Which translation engine should handle this request? */
function resolveTranslationEngine(explicit, upstreamBase) {
    if (explicit === "local" || explicit === "openai") return explicit;
    if (upstreamBase) return "openai";
    if (TRANSLATION_ENGINE === "local" || TRANSLATION_ENGINE === "openai") {
        return TRANSLATION_ENGINE;
    }
    // An OpenAI key alone is not enough for translation (it needs a chat
    // model); fall back to the local model.
    return "local";
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/**
 * Run the transcription for an already uploaded file.
 *
 * Rejects with a plain `Error` for runtime problems; request level problems
 * (missing key, disabled upstream override) are signalled through
 * `error.status` so the handler can reply with the right HTTP code.
 */
async function runTranscription(req) {
    const requestedModel = req.body?.model || defaultModel();
    const language = req.body?.language || "";
    const task = req.body?.task === "translate" ? "translate" : "transcribe";
    const quantized = req.body?.quantized !== "false";

    // Per-request upstream (lets the UI target Groq / DashScope / a self hosted
    // faster-whisper without restarting the server). The browser cannot call
    // those directly (CORS + no proxy), so it relays through this server.
    const upstreamBase = String(
        req.body?.upstream_base_url || req.body?.openai_base_url || "",
    ).trim();
    const upstreamKey = String(
        req.body?.upstream_api_key || req.body?.openai_api_key || "",
    ).trim();
    const upstreamModel = String(
        req.body?.upstream_model || req.body?.openai_model || "",
    ).trim();

    // `engine` can be forced per request (form field or ?engine=) which makes
    // curl testing much easier: -F engine=local / engine=command / engine=openai
    const explicitEngine = String(
        req.body?.engine || req.query?.engine || "",
    ).toLowerCase();
    const engine = resolveEngine(requestedModel, explicitEngine, upstreamBase);
    const model =
        engine === "local" ? toLocalModelId(requestedModel) : requestedModel;
    // Allow callers to bring their own upstream key when the server has none.
    const header = req.get("authorization") || "";
    const incomingKey = header.startsWith("Bearer ") ? header.slice(7) : "";

    const useUpstream = Boolean(upstreamBase) && ALLOW_UPSTREAM_OVERRIDE;
    if (upstreamBase && !ALLOW_UPSTREAM_OVERRIDE) {
        const error = new Error(
            "服务端已禁用按请求覆盖上游（ALLOW_UPSTREAM_OVERRIDE=0）",
        );
        error.status = 403;
        throw error;
    }

    const effectiveBase = useUpstream ? upstreamBase : OPENAI_BASE_URL;
    const apiKey = useUpstream
        ? upstreamKey || OPENAI_API_KEY || incomingKey
        : OPENAI_API_KEY || incomingKey || "";
    const effectiveModel = useUpstream && upstreamModel
        ? upstreamModel
        : model;

    if (engine === "openai" && !apiKey && !useUpstream) {
        const error = new Error(
            "openai 引擎未配置：请设置 OPENAI_API_KEY（或 OPENAI_BASE_URL），" +
                "或在请求里带上 upstream_base_url / upstream_api_key。" +
                "本机没有外网到 api.openai.com，建议改用 -F engine=local " +
                "（先 npm run fetch-model）或 -F engine=command。",
        );
        error.status = 400;
        throw error;
    }

    let raw;
    if (engine === "local") {
        raw = await runLocal({
            file: req.file,
            model,
            language,
            task,
            quantized,
        });
    } else if (engine === "command") {
        raw = await runCommand({ file: req.file, model, language, task });
    } else {
        raw = await forwardToOpenAI({
            file: req.file,
            model: effectiveModel,
            language,
            task,
            apiKey,
            baseUrl: effectiveBase,
        });
    }

    return normalize(raw, effectiveModel || model, engine);
}

/**
 * Send a transcription result, honouring `response_format`
 * (txt / srt / json — identical to the UI's export buttons).
 */
function sendTranscription(req, res, result, options = {}) {
    // `response_format` (or `format`) lets callers receive the exact
    // payload the UI exports: txt / srt / json.
    const requestedFormat = String(
        req.body?.response_format ??
            req.body?.format ??
            req.query?.response_format ??
            req.query?.format ??
            "",
    ).toLowerCase();

    if (!requestedFormat) {
        return res.json(result);
    }
    if (!["txt", "srt", "json"].includes(requestedFormat)) {
        // unknown values (verbose_json, text, ...) keep the rich object
        return res.json(result);
    }

    const explicitBilingual = String(
        req.body?.bilingual ?? req.query?.bilingual ?? "",
    ).toLowerCase();
    const hasTranslations = (result.chunks ?? []).some(
        (chunk) => String(chunk?.trans ?? "").trim().length > 0,
    );
    const bilingual =
        options.bilingual ??
        (explicitBilingual === "1" ||
            explicitBilingual === "true" ||
            hasTranslations);

    const { body, mime, ext } = exportContent(result.chunks ?? [], requestedFormat, {
        bilingual,
    });
    const base = (req.file?.originalname || "transcript").replace(
        /\.[^.]+$/,
        "",
    );
    const disposition =
        req.query?.download === "1" || req.query?.download === "true"
            ? "attachment"
            : "inline";
    const suffix = bilingual && ext !== "json" ? ".bilingual" : "";
    res.setHeader("Content-Type", mime);
    res.setHeader(
        "Content-Disposition",
        `${disposition}; filename="${base}${suffix}.${ext}"`,
    );
    res.send(body);
}

function handleError(res, label, error) {
    console.error(`[${label}] failed:`, error);
    res.status(error?.status ?? 500).json({
        error: error?.message ?? String(error),
    });
}

function transcribeHandler(req, res) {
    if (!req.file) {
        return res.status(400).json({ error: "Missing 'file' field" });
    }
    runTranscription(req)
        .then((result) => sendTranscription(req, res, result))
        .catch((error) => handleError(res, "transcribe", error));
}

/**
 * Transcribe **and** translate: every chunk gets a `trans` field, so the UI
 * shows bilingual subtitles and the txt/srt exports contain both languages.
 */
async function bilingualHandler(req, res) {
    if (!req.file) {
        return res.status(400).json({ error: "Missing 'file' field" });
    }
    try {
        const result = await runTranscription(req);

        const targetLanguage = String(
            req.body?.target_language ??
                req.body?.targetLanguage ??
                req.query?.target_language ??
                TRANSLATION_DEFAULT_TARGET,
        );
        const sourceLanguage = String(
            req.body?.source_language ??
                req.body?.sourceLanguage ??
                result?.language ??
                "",
        );
        const translationEngine = resolveTranslationEngine(
            String(
                req.body?.translation_engine ??
                    req.body?.translationEngine ??
                    req.query?.translation_engine ??
                    "",
            ).toLowerCase(),
            String(req.body?.upstream_base_url || "").trim(),
        );
        const translationModel = String(
            req.body?.translation_model ??
                req.body?.translationModel ??
                (translationEngine === "local"
                    ? TRANSLATION_MODEL
                    : TRANSLATION_API_MODEL),
        );

        const lines = (result.chunks ?? []).map((chunk) => chunk.text ?? "");
        const translations = lines.length
            ? await translateLines({
                  lines,
                  engine: translationEngine,
                  model: translationModel,
                  sourceLanguage,
                  targetLanguage,
                  upstreamBase: String(
                      req.body?.upstream_base_url || "",
                  ).trim(),
                  upstreamKey: String(req.body?.upstream_api_key || "").trim(),
                  // The chat model differs from the whisper model.
                  upstreamModel: String(
                      req.body?.translation_model ??
                          req.body?.translationModel ??
                          "",
                  ).trim(),
                  extraPrompt: extraPromptOf(req),
              })
            : [];

        result.chunks = (result.chunks ?? []).map((chunk, i) => ({
            ...chunk,
            trans: translations[i] ?? "",
        }));
        result.translation = {
            engine: translationEngine,
            model: translationModel,
            target_language: targetLanguage,
            label: languageLabel(targetLanguage),
        };

        sendTranscription(req, res, result, { bilingual: true });
    } catch (error) {
        handleError(res, "bilingual", error);
    }
}

/**
 * Translate a list of lines.
 *   POST /api/translate  { lines: [...], target_language: "zh", engine: "local" }
 */
async function translateHandler(req, res) {
    try {
        const lines = Array.isArray(req.body?.lines)
            ? req.body.lines.map((line) => String(line ?? ""))
            : [];
        if (!lines.length) {
            return res.json({
                translations: [],
                engine: null,
                target_language: null,
            });
        }

        const targetLanguage = String(
            req.body?.target_language ??
                req.body?.targetLanguage ??
                TRANSLATION_DEFAULT_TARGET,
        );
        const sourceLanguage = String(
            req.body?.source_language ?? req.body?.sourceLanguage ?? "",
        );
        // `translation_*` lets a caller keep the translation endpoint separate
        // from the transcription one (the UI does this per request anyway).
        const upstreamBase = String(
            req.body?.upstream_base_url ||
                req.body?.translation_base_url ||
                "",
        ).trim();
        const engine = resolveTranslationEngine(
            String(req.body?.engine ?? "").toLowerCase(),
            upstreamBase,
        );

        const translations = await translateLines({
            lines,
            engine,
            model: String(req.body?.model || ""),
            sourceLanguage,
            targetLanguage,
            contextLines: Array.isArray(req.body?.context_lines)
                ? req.body.context_lines
                : [],
            upstreamBase,
            upstreamKey: String(
                req.body?.upstream_api_key ||
                    req.body?.translation_api_key ||
                    "",
            ).trim(),
            upstreamModel: String(req.body?.upstream_model || "").trim(),
            extraPrompt: extraPromptOf(req),
        });

        res.json({
            translations,
            engine,
            target_language: targetLanguage,
            source_language: sourceLanguage || null,
        });
    } catch (error) {
        handleError(res, "translate", error);
    }
}

/**
 * Probe / list models of an arbitrary OpenAI compatible endpoint.
 * The browser cannot do this itself (CORS + no system proxy), so it asks
 * this server:  GET /api/upstream/models?base_url=...&api_key=...
 */
/** Strip a trailing `/audio/transcriptions` so probing `/models` still works. */
function upstreamRoot(baseUrl) {
    const base = String(baseUrl || "").replace(/\/+$/, "");
    return base.replace(/\/audio\/transcriptions?$/i, "") || base;
}

async function queryUpstream(baseUrl, apiKey, path) {
    const base = upstreamRoot(baseUrl);
    if (!/^https?:\/\//i.test(base)) {
        throw new Error(`上游地址无效：${baseUrl}`);
    }
    const url = `${base}${path}`;
    let response;
    try {
        response = await fetch(url, {
            method: "GET",
            headers: {
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
        });
    } catch (error) {
        const cause = error?.cause?.message ? ` (${error.cause.message})` : "";
        throw new Error(
            `无法访问上游 ${url}: ${error?.message ?? error}${cause}. ` +
                `请检查地址、API Key，以及代理设置（服务端会自动应用 HTTP(S)_PROXY）。`,
        );
    }
    const body = await response.text();
    if (!response.ok) {
        throw new Error(
            `上游 ${response.status} ${response.statusText}: ${body.slice(0, 500)}`,
        );
    }
    try {
        return JSON.parse(body);
    } catch (e) {
        throw new Error(`上游返回不是 JSON: ${body.slice(0, 300)}`);
    }
}

/** Ids from an OpenAI style /models response (`{data:[{id}]}` or `[...]`). */
function extractModelIds(payload) {
    const list = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data)
          ? payload.data
          : [];
    return list
        .map((item) => (typeof item === "string" ? item : item?.id))
        .filter((id) => typeof id === "string" && id.length > 0);
}

app.get("/api/upstream/models", requireToken, async (req, res) => {
    const baseUrl = String(
        req.query?.baseUrl ?? req.query?.base_url ?? "",
    );
    if (!baseUrl) {
        return res.status(400).json({ error: "缺少 baseUrl 参数" });
    }
    try {
        const payload = await queryUpstream(
            baseUrl,
            String(req.query?.apiKey ?? req.query?.api_key ?? ""),
            "/models",
        );
        const all = extractModelIds(payload);
        // Audio endpoints only make sense for the whisper family; keep the
        // rest available but sorted last.
        const audio = all.filter((id) => /whisper|asr|audio|distil/i.test(id));
        const rest = all.filter((id) => !audio.includes(id));
        res.json({ ok: true, baseUrl, models: [...audio, ...rest], all });
    } catch (error) {
        res.status(502).json({ ok: false, error: error?.message ?? String(error) });
    }
});

app.get("/api/upstream/health", requireToken, async (req, res) => {
    const baseUrl = String(
        req.query?.baseUrl ?? req.query?.base_url ?? "",
    );
    if (!baseUrl) {
        return res.status(400).json({ error: "缺少 baseUrl 参数" });
    }
    try {
        const payload = await queryUpstream(
            baseUrl,
            String(req.query?.apiKey ?? req.query?.api_key ?? ""),
            "/models",
        );
        const ids = extractModelIds(payload);
        res.json({
            ok: true,
            baseUrl,
            message: `OK — 可达，${ids.length} 个模型`,
            models: ids.slice(0, 200),
        });
    } catch (error) {
        res.status(502).json({
            ok: false,
            baseUrl,
            error: error?.message ?? String(error),
        });
    }
});

app.get("/api/health", (req, res) => {
    const cached = listLocalModels();
    res.json({
        status: "ok",
        engine: CONFIGURED_ENGINE || "auto",
        engines: ["local", "openai", "command"],
        model: defaultModel(),
        responseFormats: ["json", "txt", "srt"],
        upstream:
            CONFIGURED_ENGINE === "command"
                ? WHISPER_COMMAND
                : CONFIGURED_ENGINE === "local" || !CONFIGURED_ENGINE
                  ? "local (transformers.js)"
                  : OPENAI_BASE_URL,
        localModels: cached,
        localCacheDir: CACHE_ROOT,
        asrCacheDir: ASR_CACHE_DIR,
        translationCacheDir: MT_CACHE_DIR,
        localReady: cached.length > 0,
        translation: {
            engines: ["local", "openai"],
            engine: TRANSLATION_ENGINE || "auto",
            model: TRANSLATION_MODEL,
            apiModel: TRANSLATION_API_MODEL,
            defaultTarget: TRANSLATION_DEFAULT_TARGET,
            localReady: inspectGenericModel(TRANSLATION_MODEL).exists,
        },
        proxy: PROXY_URL || null,
        authRequired: Boolean(API_TOKEN),
        upstreamOverride: ALLOW_UPSTREAM_OVERRIDE,
        ffmpeg: true,
        time: new Date().toISOString(),
    });
});

app.get("/api/models", requireToken, (req, res) => {
    // "asr" (transcription column) / "translation" (translation column) /
    // "" (everything). Lets each Settings column list only its own models.
    const taskFilter = String(req.query?.task ?? "").toLowerCase();
    const cached = filterByTask(listLocalModels(), taskFilter);
    const cachedSet = new Set(listLocalModels());

    // Rich per-model info so the UI can mark which ones are actually usable.
    const models = cached.map((id) => {
        const info = inspectLocalModel(id);
        const generic = inspectGenericModel(id);
        return {
            id,
            cached: info.exists || generic.exists,
            quantized: info.quantized || generic.quantized,
            fp32: info.fp32 || generic.fp32,
            size: dirSize(resolveModelDir(id).dir),
            // "asr" (whisper family) / "translation" (opus-mt, nllb, ...) /
            // "" when the config cannot be read. Translation models also ship
            // an `encoder_model*.onnx`, so the UI needs this to tell them
            // apart in the model dropdown.
            task: classifyModel(id),
            // Which cache folder the weights live in.
            folder: path
                .relative(CACHE_ROOT, resolveModelDir(id).dir)
                .split(path.sep)[0],
        };
    });

    // Common aliases accepted by the local engine (transcription only —
    // translation models have no short alias).
    const aliasIds =
        taskFilter === "translation"
            ? []
            : [
                  "tiny",
                  "tiny.en",
                  "base",
                  "base.en",
                  "small",
                  "small.en",
                  "medium",
                  "medium.en",
                  "distil-large-v2",
              ];
    const aliases = aliasIds.map((id) => ({
        id,
        target: toLocalModelId(id),
        cached: cachedSet.has(toLocalModelId(id)),
    }));

    res.json({
        engine: CONFIGURED_ENGINE || "auto",
        // Echoed back so the UI can tell which column this list belongs to.
        task: taskFilter,
        defaultModel: defaultModel(),
        local: {
            cacheDir: LOCAL_CACHE_DIR,
            asrCacheDir: ASR_CACHE_DIR,
            translationCacheDir: MT_CACHE_DIR,
            // Kept as plain strings for backwards compatibility
            available: cached,
            models,
            aliases,
        },
        openai: {
            baseUrl: OPENAI_BASE_URL,
            model: OPENAI_MODEL,
            configured: Boolean(OPENAI_API_KEY || process.env.OPENAI_BASE_URL),
        },
        command: { command: WHISPER_COMMAND, model: WHISPER_COMMAND_MODEL },
    });
});

app.post(
    "/api/transcribe",
    requireToken,
    upload.single("file"),
    transcribeHandler,
);
app.post(
    "/api/bilingual",
    requireToken,
    upload.single("file"),
    bilingualHandler,
);
app.post(
    "/v1/audio/bilingual",
    requireToken,
    upload.single("file"),
    bilingualHandler,
);
app.post("/api/translate", requireToken, translateHandler);
app.post(
    "/v1/audio/transcriptions",
    requireToken,
    upload.single("file"),
    transcribeHandler,
);

// Serve the production build (npm run build) from the same origin.
const distPath = path.join(__dirname, "..", "dist");
if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.use((req, res, next) => {
        if (req.method !== "GET") return next();
        res.sendFile(path.join(distPath, "index.html"));
    });
}

app.listen(PORT, () => {
    console.log(`whisper-web API listening on http://localhost:${PORT}`);
    console.log(
        `  engine : ${CONFIGURED_ENGINE || "auto (local models & tiny/base/... ids -> local, otherwise openai when configured)"}`,
    );
    console.log(`  model  : ${defaultModel()}`);
    console.log(`  proxy  : ${PROXY_URL || "none"}`);
    console.log(`  auth   : ${API_TOKEN ? "enabled" : "disabled"}`);
    const cached = listLocalModels();
    console.log(
        cached.length
            ? `  local  : ready (${cached.join(", ")})`
            : `  local  : 未下载权重，运行 "npm run fetch-model" 后可用`,
    );
});
