#!/usr/bin/env node
/**
 * Download ONNX weights for the `local` engine into the on-disk cache so the
 * API server can transcribe without reaching huggingface.co at runtime.
 *
 *   node scripts/fetch-local-model.mjs                       # Xenova/whisper-tiny.en
 *   node scripts/fetch-local-model.mjs Xenova/whisper-base.en
 *   node scripts/fetch-local-model.mjs zem214/whisper-medium --list
 *   node scripts/fetch-local-model.mjs onnx-community/whisper-large-v3 --full
 *   node scripts/fetch-local-model.mjs --mirror https://hf-mirror.com/
 *
 * ## Why arbitrary repos used to fail
 *
 * The first version of this script hard-coded `onnx/encoder_model_quantized.onnx`
 * + `onnx/decoder_model_merged_quantized.onnx`. That layout is only guaranteed
 * for the `Xenova/*` repos, so any other repo (`zem214/whisper-medium`,
 * `onnx-community/...`, vendor exports, ...) reported a download failure even
 * though the repo was fine — it simply stores its weights under a different
 * name (`encoder_model.onnx`, `decoder_model_merged_int8.onnx`, ...) or not
 * under `onnx/` at all.
 *
 * This version asks the repository for its file list first (Hugging Face
 * `/api/models/<id>/tree/<rev>` or ModelScope's repo API), picks the best
 * matching config + weight files, and *normalises* them into the layout
 * 🤗 Transformers.js expects:
 *
 *     <cache>/Transcription models/<model-id>/...   (Whisper / ASR)
 *     <cache>/Translation models/<model-id>/...     (opus-mt, nllb, ...)
 *
 * The folder is picked from the repo's `config.json` → `model_type`
 * (whisper → Transcription models, marian/m2m100/nllb/mBART/t5 → Translation
 * models), falling back to the model name and only then to the repo layout.
 * Force it with `--type=`.
 *
 * Options
 *   --list              只列出仓库里的文件并退出（不下载）
 *   --dry-run           只打印将要下载什么
 *   --full              额外下载 fp32 权重（默认只下量化版）
 *   --force             已存在的文件也重新下载
 *   --mirror=<url>      镜像根地址，例如 https://hf-mirror.com/
 *   --revision=<rev>    分支 / commit（HF 默认 main，ModelScope 默认 master）
 *   --quantized-only    只接受量化权重（没有就直接报错）
 *   --type=asr|translation
 *                       强制放到哪个目录；默认自动判断（Whisper → asr）
 *
 * Environment: LOCAL_CACHE_DIR, HF_ENDPOINT, HTTP_PROXY / HTTPS_PROXY / NO_PROXY
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));

function flag(name) {
    return args.some((a) => a === `--${name}`);
}
function option(name) {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : "";
}

const modelId = positional[0] || "Xenova/whisper-tiny.en";
const wantList = flag("list");
const dryRun = flag("dry-run");
const wantFull = flag("full");
const force = flag("force");
const quantizedOnly = flag("quantized-only");
const mirrorArg = option("mirror");
const revisionArg = option("revision");
const typeArg = String(option("type") || "").toLowerCase();

const CACHE_ROOT =
    process.env.LOCAL_CACHE_DIR || path.join(process.cwd(), ".cache");
const ASR_SUBDIR = "Transcription models";
const MT_SUBDIR = "Translation models";
/** Where the weights land, decided once the repo layout is known. */
const dirFor = (category) =>
    path.join(CACHE_ROOT, category === "translation" ? MT_SUBDIR : ASR_SUBDIR);
/** Heuristic used before we can read the repo (e.g. --list / fallback). */
function guessCategory(id) {
    if (/opus-mt|nllb|m2m100|m2m_100|mbart|mt5|translation|[-_](en|zh|ja|ko|fr|de|ru|es)-(en|zh|ja|ko|fr|de|ru|es)$/i.test(
        id,
    )) {
        return "translation";
    }
    return "asr";
}
let category =
    typeArg === "asr" || typeArg === "translation"
        ? typeArg
        : guessCategory(modelId);
let CACHE_DIR = dirFor(category);

// Node's fetch ignores HTTP_PROXY/HTTPS_PROXY — install an env aware dispatcher.
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
        console.warn("[warn] proxy support unavailable:", e?.message ?? e);
    }
}

/* ------------------------------------------------------------------ *
 * Mirrors
 * ------------------------------------------------------------------ */

/** Hugging Face style `/api/models/<id>/tree/<rev>?recursive=true`. */
function hfStyle(name, base, defaultRevision) {
    const root = base.replace(/\/+$/, "");
    return {
        name,
        defaultRevision,
        listUrl: (model, revision) =>
            `${root}/api/models/${model}/tree/${encodeURIComponent(
                revision,
            )}?recursive=true`,
        parseList: (json) =>
            (Array.isArray(json) ? json : [])
                .filter((entry) => entry?.type === "file")
                .map((entry) => ({
                    path: entry.path,
                    size: entry.size ?? 0,
                })),
        resolve: (model, file, revision) =>
            `${root}/${model}/resolve/${revision}/${file}`,
    };
}

const MIRRORS = [
    {
        name: "modelscope",
        defaultRevision: "master",
        listUrl: (model, revision) =>
            `https://www.modelscope.cn/api/v1/models/${model}/repo/files?Revision=${encodeURIComponent(
                revision,
            )}&Recursive=true`,
        parseList: (json) =>
            (json?.Data?.Files ?? [])
                .filter((entry) => entry?.Type === "blob")
                .map((entry) => ({ path: entry.Path, size: entry.Size ?? 0 })),
        resolve: (model, file, revision) =>
            `https://www.modelscope.cn/models/${model}/resolve/${revision}/${file}`,
    },
    hfStyle("huggingface", "https://huggingface.co", "main"),
];

function buildMirrors() {
    if (mirrorArg) return [hfStyle(mirrorArg, mirrorArg, "main")];
    const fromEnv = (process.env.HF_ENDPOINT || "").replace(/\/+$/, "");
    if (fromEnv && !fromEnv.includes("huggingface.co")) {
        return [hfStyle(fromEnv, fromEnv, "main")];
    }
    return MIRRORS;
}

const mirrors = buildMirrors();

/* ------------------------------------------------------------------ *
 * File selection
 * ------------------------------------------------------------------ */

// Required: without generation_config.json Whisper's timestamp processor throws
// "Array must not be empty".
const CONFIG_REQUIRED = ["config.json", "generation_config.json"];
/**
 * Files transformers.js *always* asks for with `fatal=true`:
 * `AutoTokenizer` refuses to build a tokenizer without `tokenizer.json`.
 * If any of these is missing after the download the model is unusable, so
 * the script must say so instead of printing a cheerful "done".
 */
const ESSENTIAL_FILES = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
];
// Recommended: tokenizer / preprocessor. A miss is only a warning.
const CONFIG_RECOMMENDED = [
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
];
// Nice to have.
const CONFIG_OPTIONAL = [
    "added_tokens.json",
    "special_tokens_map.json",
    "normalizer.json",
    "merges.txt",
    "vocab.json",
    "tokenizer.model",
    "sentencepiece.bpe.model",
    "source.spm",
    "target.spm",
    "chat_template.json",
    "quant_config.json",
    "quantize_config.json",
];

/**
 * Weight variants, best first. `target` is where the file ends up in the cache
 * so 🤗 Transformers.js finds it regardless of how the repo named it.
 */
const ENCODER_VARIANTS = [
    { suffix: "_quantized", quantized: true },
    { suffix: "_int8", quantized: true },
    { suffix: "_uint8", quantized: true },
    { suffix: "_q4f16", quantized: true },
    { suffix: "_q4", quantized: true },
    { suffix: "_q8", quantized: true },
    { suffix: "_bnb4", quantized: true },
    { suffix: "_fp16", quantized: true },
    { suffix: "", quantized: false },
];
const DECODER_VARIANTS = ENCODER_VARIANTS.map((variant) => ({
    ...variant,
    target: variant.quantized
        ? "onnx/decoder_model_merged_quantized.onnx"
        : "onnx/decoder_model_merged.onnx",
}));
ENCODER_VARIANTS.forEach((variant) => {
    variant.target = variant.quantized
        ? "onnx/encoder_model_quantized.onnx"
        : "onnx/encoder_model.onnx";
});

/**
 * Generic (non Whisper) ONNX exports — 🤗 Transformers.js loads those from
 * `onnx/model[_quantized].onnx`. Used for translation models such as
 * `Xenova/nllb-200-distilled-600M` or `Xenova/opus-mt-en-zh`.
 */
const GENERIC_VARIANTS = [
    { suffix: "_quantized", quantized: true, target: "onnx/model_quantized.onnx" },
    { suffix: "_int8", quantized: true, target: "onnx/model_quantized.onnx" },
    { suffix: "_uint8", quantized: true, target: "onnx/model_quantized.onnx" },
    { suffix: "_q4f16", quantized: true, target: "onnx/model_quantized.onnx" },
    { suffix: "_q4", quantized: true, target: "onnx/model_quantized.onnx" },
    { suffix: "_q8", quantized: true, target: "onnx/model_quantized.onnx" },
    { suffix: "_fp16", quantized: true, target: "onnx/model_quantized.onnx" },
    { suffix: "", quantized: false, target: "onnx/model.onnx" },
];

const basename = (p) => p.split("/").pop();

/** Find `file` in the repo listing, ignoring the directory it lives in. */
function findFile(files, name) {
    return (
        files.find((f) => f.path === name) ??
        files.find((f) => basename(f.path) === name)
    );
}

/** Pick the first weight variant that exists (preferring `onnx/<name>`). */
function pickWeight(files, variants, baseName) {
    for (const variant of variants) {
        const name = `${baseName}${variant.suffix}.onnx`;
        const hit =
            files.find((f) => f.path === `onnx/${name}`) ??
            files.find((f) => basename(f.path) === name);
        if (hit) return { hit, variant, name };
    }
    return null;
}

/** ONNX external-data blobs that must sit next to the model file. */
function externalDataFor(files, sourcePath) {
    const base = basename(sourcePath);
    return files.filter((f) => {
        const name = basename(f.path);
        return (
            name.startsWith(`${base}_data`) ||
            name.startsWith(`${base}.data`) ||
            /\.onnx_data$/.test(name) && name.startsWith(base.replace(/\.onnx$/, ""))
        );
    });
}

function human(bytes) {
    if (!bytes) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function download(url, dest) {
    let lastError;
    // One retry: a transient mirror hiccup must not leave a half-downloaded
    // model behind (optional files used to be skipped silently, which later
    // surfaced as "file was not found locally" at load time).
    for (let attempt = 1; attempt <= 2; ++attempt) {
        try {
            const response = await fetch(url, { redirect: "follow" });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} for ${url}`);
            }
            const buffer = Buffer.from(await response.arrayBuffer());
            if (!buffer.length) throw new Error(`empty body for ${url}`);
            await fsp.mkdir(path.dirname(dest), { recursive: true });
            await fsp.writeFile(dest, buffer);
            return buffer.length;
        } catch (error) {
            lastError = error;
            if (attempt < 2) {
                await new Promise((r) => setTimeout(r, 800));
            }
        }
    }
    throw lastError;
}

async function fetchJson(url) {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return response.json();
}

/**
 * Read `model_type` out of the repository's config.json.
 * This is the same signal the API server uses to tag a cached model as
 * `asr` / `translation`, so both sides always agree on the folder.
 */
async function readModelType(files, mirror, revision) {
    const hit = findFile(files, "config.json");
    if (!hit) return "";
    try {
        const response = await fetch(
            mirror.resolve(modelId, hit.path, revision),
            { redirect: "follow" },
        );
        if (!response.ok) return "";
        const config = JSON.parse(await response.text());
        return String(config?.model_type ?? "").toLowerCase();
    } catch (error) {
        return "";
    }
}

/** Map a `model_type` onto a cache sub-folder ("" = unknown). */
function categoryFromModelType(type) {
    if (!type) return "";
    if (/whisper/.test(type)) return "asr";
    if (/marian|m2m|mbart|bart|t5|nllb|opus/i.test(type)) return "translation";
    return "";
}

/** Ask every mirror for the repository file list; returns the first hit. */
async function listRepoFiles() {
    const failures = [];
    for (const mirror of mirrors) {
        const revision = revisionArg || mirror.defaultRevision;
        try {
            const json = await fetchJson(mirror.listUrl(modelId, revision));
            const files = mirror.parseList(json);
            if (files.length) return { mirror, revision, files, failures };
            failures.push(`${mirror.name}: 仓库列表为空（模型不存在或没有文件）`);
        } catch (error) {
            const cause = error?.cause?.message ? ` (${error.cause.message})` : "";
            failures.push(
                `${mirror.name}: ${error?.message ?? error}${cause}`,
            );
        }
    }
    return { mirror: null, revision: revisionArg || "main", files: [], failures };
}

function printList(files) {
    console.log(`${modelId} 的仓库文件：`);
    const onnx = files.filter((f) => /\.onnx(_data)?$|\.onnx\.data$/i.test(f.path));
    const rest = files.filter((f) => !onnx.includes(f));
    for (const f of [...rest, ...onnx]) {
        console.log(`  ${String(f.size).padStart(10)}  ${f.path}`);
    }
}

async function main() {
    console.log(`model   : ${modelId}`);
    console.log(`cache   : ${CACHE_ROOT}`);
    console.log(
        `mirror  : ${mirrors.length === 1 ? mirrors[0].name : "auto (" + mirrors.map((m) => m.name).join(" → ") + ")"}`,
    );
    console.log(`proxy   : ${PROXY_URL || "none"}`);
    console.log("");

    const { mirror, revision, files, failures } = await listRepoFiles();

    if (wantList) {
        if (!files.length) {
            console.error("无法读取仓库文件列表：");
            failures.forEach((f) => console.error(`  - ${f}`));
            process.exit(1);
        }
        printList(files);
        const listType = await readModelType(files, mirror, revision);
        const listCategory =
            categoryFromModelType(listType) || guessCategory(modelId);
        console.log(
            `\nmodel_type: ${listType || "(未知)"} → ${listCategory}`,
        );
        console.log(
            `将下载到: ${path.join(dirFor(listCategory), modelId)}` +
                `（可用 --type=asr|translation 强制）`,
        );
        return;
    }

    // No listing → fall back to the hard-coded layout (old behaviour).
    if (!files.length) {
        console.warn(
            "[warn] 无法列出仓库文件（" +
                failures.join("；") +
                "），回退到固定路径尝试。",
        );
        await fallbackDownload();
        return;
    }

    console.log(`revision: ${revision} (via ${mirror.name})`);

    // Decide the cache sub-folder *before* downloading anything.
    // `config.json` → `model_type` is the authoritative signal (the server
    // classifies cached models the same way); the repo layout is only a
    // fallback because m2m100 / mBART also ship encoder + merged decoder.
    const encoder = pickWeight(files, ENCODER_VARIANTS, "encoder_model");
    const decoder = pickWeight(files, DECODER_VARIANTS, "decoder_model_merged");
    const isWhisperLayout = Boolean(encoder || decoder);

    const modelType = await readModelType(files, mirror, revision);
    const fromType = categoryFromModelType(modelType);
    let category;
    let categoryReason;
    if (typeArg === "asr" || typeArg === "translation") {
        category = typeArg;
        categoryReason = "--type 指定";
    } else if (fromType) {
        category = fromType;
        categoryReason = `config.json model_type=${modelType}`;
    } else if (category === "translation") {
        category = "translation";
        categoryReason = "模型名命中翻译模型（opus-mt / nllb / m2m100 / mbart …）";
    } else {
        category = isWhisperLayout ? "asr" : "translation";
        categoryReason = isWhisperLayout
            ? "仓库含 Whisper 布局（config.json 不可用，按布局判断）"
            : "非 Whisper 布局，按通用 ONNX 翻译模型处理";
    }
    CACHE_DIR = dirFor(category);
    console.log(`type    : ${modelType || "(未知)"} → ${category}（${categoryReason}）`);
    console.log(`folder  : ${path.join(CACHE_DIR, modelId)}`);
    console.log("");

    /** @type {{source: string, target: string, optional: boolean, note?: string}[]} */
    const plan = [];

    const addConfig = (name, optional) => {
        const hit = findFile(files, name);
        if (!hit) {
            if (!optional) plan.push({ source: name, target: name, optional: false, missing: true });
            return;
        }
        plan.push({ source: hit.path, target: name, optional });
    };

    CONFIG_REQUIRED.forEach((name) => addConfig(name, false));
    CONFIG_RECOMMENDED.forEach((name) => addConfig(name, true));
    CONFIG_OPTIONAL.forEach((name) => addConfig(name, true));

    /** @type {{source: string, target: string, optional: boolean, note?: string, missing?: boolean, base?: string}[]} */
    const weights = [];

    if (!isWhisperLayout) {
        console.log(
            "[info] 未找到 Whisper 风格的 encoder/decoder，按通用 ONNX 模型处理。",
        );
        const generic = pickWeight(files, GENERIC_VARIANTS, "model");
        if (!generic) {
            console.error(
                `仓库里没有找到 .onnx 权重。用 --list 看看该仓库实际有哪些文件。`,
            );
            process.exit(1);
        }
        weights.push({
            source: generic.hit.path,
            target: generic.variant.target,
            optional: false,
            note: generic.variant.quantized ? "量化" : "fp32",
            base: "generic",
        });
        for (const extra of externalDataFor(files, generic.hit.path)) {
            const suffix = basename(extra.path).slice(
                basename(generic.hit.path).length,
            );
            weights.push({
                source: extra.path,
                target: generic.variant.target + suffix,
                optional: false,
                note: "外部权重数据",
            });
        }
        if (wantFull) {
            const fp32 = pickWeight(
                files,
                [{ suffix: "", quantized: false, target: "onnx/model.onnx" }],
                "model",
            );
            if (fp32 && !weights.some((w) => w.target === "onnx/model.onnx")) {
                weights.push({
                    source: fp32.hit.path,
                    target: "onnx/model.onnx",
                    optional: false,
                    note: "fp32",
                });
            }
        }
    } else {
        if (encoder) {
            weights.push({
                source: encoder.hit.path,
                target: encoder.variant.target,
                optional: false,
                note: encoder.variant.quantized ? "量化" : "fp32",
                base: "encoder",
            });
        }
        if (decoder) {
            weights.push({
                source: decoder.hit.path,
                target: decoder.variant.target,
                optional: false,
                note: decoder.variant.quantized ? "量化" : "fp32",
                base: "decoder",
            });
        }

    // `--full` additionally wants the fp32 pair (when the repo has it).
    if (wantFull && isWhisperLayout) {
        const encoderFp32 = pickWeight(files, [{ suffix: "", quantized: false, target: "onnx/encoder_model.onnx" }], "encoder_model");
        const decoderFp32 = pickWeight(files, [{ suffix: "", quantized: false, target: "onnx/decoder_model_merged.onnx" }], "decoder_model_merged");
        for (const hit of [encoderFp32, decoderFp32]) {
            if (!hit) continue;
            const target =
                hit.name.startsWith("encoder")
                    ? "onnx/encoder_model.onnx"
                    : "onnx/decoder_model_merged.onnx";
            if (!weights.some((w) => w.target === target)) {
                weights.push({
                    source: hit.hit.path,
                    target,
                    optional: false,
                    note: "fp32",
                });
            }
        }
    }
    }

    if (!isWhisperLayout) {
        if (!weights.length) {
            console.error("没有可下载的权重。");
            process.exit(1);
        }
    } else {
        if (!decoder && !encoder) {
            console.error(
                `仓库里没有找到可用的 ONNX 权重（需要 encoder_model*.onnx 与 ` +
                    `decoder_model_merged*.onnx）。\n用 --list 查看该仓库实际有哪些文件；` +
                    `该仓库可能只提供 PyTorch / safetensors 权重，需要先转成 ONNX。`,
            );
            process.exit(1);
        }
        if (!decoder) {
            console.error(
                `缺少 decoder_model_merged*.onnx —— 🤗 Transformers.js 需要 "merged" ` +
                    `（带 past key/value）版本的 decoder，只有 decoder_model.onnx 无法使用。`,
            );
        }
        if (!encoder) {
            console.error(`缺少 encoder_model*.onnx。`);
        }
    }
    if (quantizedOnly && weights.some((w) => w.note === "fp32")) {
        console.error("该仓库只有 fp32 权重，已指定 --quantized-only，停止。");
        process.exit(1);
    }

    console.log("");

    for (const weight of weights) {
        for (const extra of externalDataFor(files, weight.source)) {
            const suffix = basename(extra.path).slice(
                basename(weight.source).length,
            );
            if (!weights.some((w) => w.target === weight.target + suffix)) {
                weights.push({
                    source: extra.path,
                    target: weight.target + suffix,
                    optional: false,
                    note: "外部权重数据",
                });
            }
        }
    }

    const tasks = [...plan, ...weights];
    let failuresCount = 0;

    for (const task of tasks) {
        const dest = path.join(CACHE_DIR, modelId, task.target);

        if (task.missing) {
            if (!task.optional) {
                failuresCount += 1;
                console.log(`  FAIL   ${task.target} :: 仓库中不存在`);
            }
            continue;
        }

        if (!force && fs.existsSync(dest)) {
            const size = fs.statSync(dest).size;
            console.log(`  skip   ${task.target} (${human(size)})`);
            continue;
        }

        const url = mirror.resolve(modelId, task.source, revision);
        if (dryRun) {
            const source = files.find((f) => f.path === task.source);
            console.log(
                `  plan   ${task.target} <- ${task.source}` +
                    `${source ? ` (${human(source.size)})` : ""}` +
                    `${task.note ? ` [${task.note}]` : ""}`,
            );
            continue;
        }

        try {
            const size = await download(url, dest);
            console.log(
                `  ok     ${task.target} (${human(size)}) <- ${task.source}` +
                    `${task.note ? ` [${task.note}]` : ""}`,
            );
        } catch (error) {
            if (task.optional) {
                console.log(
                    `  warn   ${task.target} 下载失败：${error?.message ?? error}`,
                );
            } else {
                failuresCount += 1;
                console.log(
                    `  FAIL   ${task.target} :: ${error?.message ?? error}`,
                );
            }
        }
    }

    // Verify, don't assume. A model that is missing `tokenizer.json` looks
    // perfectly fine in Settings (the .onnx weights are there), but the
    // server then marks it "cached" and disables remote fetching — and the
    // user only sees `file was not found locally at ".../models/..."`.
    if (!dryRun) {
        for (const name of ESSENTIAL_FILES) {
            if (fs.existsSync(path.join(CACHE_DIR, modelId, name))) continue;
            if (findFile(files, name)) {
                failuresCount += 1;
                console.log(
                    `  FAIL   ${name} :: 仓库里有该文件但本地缺失` +
                        `（重新运行本命令即可补齐）`,
                );
            } else {
                console.log(
                    `  warn   ${name} :: 仓库里没有该文件，` +
                        `transformers.js 可能无法加载这个模型`,
                );
            }
        }
    }

    console.log("");
    if (failuresCount) {
        console.error(
            `${failuresCount} file(s) failed.\n` +
                `  换镜像：--mirror https://hf-mirror.com/（或设 HF_ENDPOINT）\n` +
                `  看仓库里到底有什么：node scripts/fetch-local-model.mjs ${modelId} --list`,
        );
        process.exit(1);
    }
    if (dryRun) {
        console.log("dry-run 完成，未下载任何文件。");
        return;
    }
    const usedQuantized = weights.some(
        (w) => w.base !== undefined && w.note === "量化",
    );
    console.log(
        `done. 权重目录：${path.join(CACHE_DIR, modelId)}\n` +
            `     启动服务：WHISPER_ENGINE=local 或请求里带 -F engine=local -F model=${modelId}`,
    );
    if (!usedQuantized) {
        console.log(
            "note: 该仓库没有量化权重，服务端会自动以 fp32 方式加载（速度较慢、占用更大）。",
        );
    }
    if (!isWhisperLayout) {
        console.log(
            "note: 通用 ONNX 模型（非 Whisper）—— 可作为翻译模型使用，例如 " +
                "Translation engine = Local engine。",
        );
    }
}

/** Legacy behaviour: try the canonical paths on every mirror. */
async function fallbackDownload() {
    const files = [
        ...CONFIG_REQUIRED.map((f) => ({ file: f, optional: false })),
        ...CONFIG_RECOMMENDED.map((f) => ({ file: f, optional: true })),
        { file: "onnx/encoder_model_quantized.onnx", optional: false },
        { file: "onnx/decoder_model_merged_quantized.onnx", optional: false },
        ...(wantFull
            ? [
                  { file: "onnx/encoder_model.onnx", optional: false },
                  { file: "onnx/decoder_model_merged.onnx", optional: false },
              ]
            : []),
        ...CONFIG_OPTIONAL.map((f) => ({ file: f, optional: true })),
    ];

    let failures = 0;
    for (const { file, optional } of files) {
        const dest = path.join(CACHE_DIR, modelId, file);
        if (!force && fs.existsSync(dest)) {
            console.log(`  skip   ${file} (${human(fs.statSync(dest).size)})`);
            continue;
        }
        let done = false;
        let lastError = "";
        for (const mirror of mirrors) {
            try {
                const size = await download(
                    mirror.resolve(modelId, file, revisionArg || mirror.defaultRevision),
                    dest,
                );
                console.log(`  ok     ${file} (${human(size)}) <- ${mirror.name}`);
                done = true;
                break;
            } catch (error) {
                lastError = error?.message ?? String(error);
            }
        }
        if (!done) {
            if (optional) {
                console.log(`  warn   ${file} 不存在，已跳过`);
            } else {
                failures += 1;
                console.log(`  FAIL   ${file} :: ${lastError}`);
            }
        }
    }
    console.log("");
    if (failures) {
        console.error(
            `${failures} file(s) failed.\n` +
                `  该模型可能不在当前镜像上（ModelScope 只同步了一部分仓库），试试 ` +
                `--mirror https://hf-mirror.com/ 或先 --list 看看。`,
        );
        process.exit(1);
    }
    console.log("done. Start the server with WHISPER_ENGINE=local.");
}

await main();
