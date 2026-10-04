#!/usr/bin/env node
/**
 * Download ONNX weights for the `local` engine into the on-disk cache so the
 * API server can transcribe without reaching huggingface.co at runtime.
 *
 *   node scripts/fetch-local-model.mjs                       # Xenova/whisper-tiny.en (quantized)
 *   node scripts/fetch-local-model.mjs Xenova/whisper-base.en
 *   node scripts/fetch-local-model.mjs --full                # also fetch the fp32 weights
 *   node scripts/fetch-local-model.mjs --mirror https://hf-mirror.com/
 *
 * Files are written to `<LOCAL_CACHE_DIR|./.cache>/<model-id>/<file>`, which is
 * exactly the layout @xenova/transformers expects from its FileSystemCache.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

const modelId = positional[0] || "Xenova/whisper-tiny.en";
const wantFull = flags.has("--full");
const force = flags.has("--force");
const mirrorArg =
    args.find((a) => a.startsWith("--mirror="))?.split("=").slice(1).join("=") ||
    "";

const CACHE_DIR =
    process.env.LOCAL_CACHE_DIR || path.join(process.cwd(), ".cache");

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

/** @type {{ name: string, resolve: (model: string, file: string) => string }[]} */
const MIRRORS = [
    {
        name: "modelscope",
        resolve: (model, file) =>
            `https://www.modelscope.cn/models/${model}/resolve/master/${file}`,
    },
    {
        name: "huggingface",
        resolve: (model, file) =>
            `https://huggingface.co/${model}/resolve/main/${file}`,
    },
];

function pickMirror() {
    if (mirrorArg) {
        const base = mirrorArg.replace(/\/+$/, "");
        return {
            name: base,
            resolve: (model, file) => `${base}/${model}/resolve/main/${file}`,
        };
    }
    const fromEnv = (process.env.HF_ENDPOINT || "").replace(/\/+$/, "");
    if (fromEnv && !fromEnv.includes("huggingface.co")) {
        return {
            name: fromEnv,
            resolve: (model, file) =>
                `${fromEnv}/${model}/resolve/main/${file}`,
        };
    }
    return null; // auto: try each in order
}

const JSON_FILES = [
    "config.json",
    // Required by Whisper's timestamp logits processor — without it the
    // decoder fails with "Array must not be empty".
    "generation_config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
];
// Nice to have; a 404 here is only a warning.
const OPTIONAL_FILES = [
    "added_tokens.json",
    "special_tokens_map.json",
    "normalizer.json",
    "merges.txt",
    "vocab.json",
];
const WEIGHTS = ["onnx/encoder_model.onnx", "onnx/decoder_model_merged.onnx"];
const WEIGHTS_QUANTIZED = [
    "onnx/encoder_model_quantized.onnx",
    "onnx/decoder_model_merged_quantized.onnx",
];

function human(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function download(url, dest) {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error(`empty body for ${url}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, buffer);
    return buffer.length;
}

async function main() {
    const files = [
        ...[...JSON_FILES, ...WEIGHTS_QUANTIZED].map((f) => ({
            file: f,
            optional: false,
        })),
        ...(wantFull ? WEIGHTS.map((f) => ({ file: f, optional: false })) : []),
        ...OPTIONAL_FILES.map((f) => ({ file: f, optional: true })),
    ];

    const configured = pickMirror();
    const mirrors = configured ? [configured] : MIRRORS;

    console.log(`model   : ${modelId}`);
    console.log(`cache   : ${path.join(CACHE_DIR, modelId)}`);
    console.log(`mirror  : ${configured ? configured.name : "auto"}`);
    console.log(`proxy   : ${PROXY_URL || "none"}`);
    console.log("");

    let failures = 0;
    for (const { file, optional } of files) {
        const dest = path.join(CACHE_DIR, modelId, file);
        if (!force && fs.existsSync(dest)) {
            const size = fs.statSync(dest).size;
            console.log(`  skip   ${file} (${human(size)})`);
            continue;
        }

        let done = false;
        let lastError = "";
        for (const mirror of mirrors) {
            const url = mirror.resolve(modelId, file);
            try {
                const size = await download(url, dest);
                console.log(
                    `  ok     ${file} (${human(size)}) <- ${mirror.name}`,
                );
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
            `${failures} file(s) failed. Try --mirror https://hf-mirror.com/ or ` +
                `copy the weights in manually.`,
        );
        process.exit(1);
    }
    console.log("done. Start the server with WHISPER_ENGINE=local.");
}

await main();
