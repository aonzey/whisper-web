#!/usr/bin/env node
/**
 * Command line front-end for the whisper-web API server.
 *
 *   node scripts/cli.mjs health
 *   node scripts/cli.mjs models
 *   node scripts/cli.mjs transcribe audio.mp3 --format srt -o out.srt
 *   node scripts/cli.mjs bilingual audio.mp3 --target zh --format srt -o zh.srt
 *
 * Every switch maps to a request field of the same name, so anything the HTTP
 * API accepts can be used here too (`--engine`, `--model`, `--language`,
 * `--upstream-base-url`, `--upstream-api-key`, `--upstream-model`,
 * `--translation-engine`, `--translation-model`, `--response-format`, ...).
 *
 * Environment: WHISPER_API (default http://localhost:8787/api),
 *              API_TOKEN, HTTP_PROXY / HTTPS_PROXY / NO_PROXY
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const API_BASE = (
    process.env.WHISPER_API || "http://localhost:8787/api"
).replace(/\/+$/, "");
const API_TOKEN = process.env.API_TOKEN || "";

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

const argv = process.argv.slice(2);
const command = (argv[0] || "help").toLowerCase();

/** Parse `--key value` / `--key=value` / boolean flags. */
function parseArgs(rest) {
    const options = {};
    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (!arg.startsWith("--")) continue;
        const body = arg.slice(2);
        if (body.includes("=")) {
            const [key, ...value] = body.split("=");
            options[key] = value.join("=");
            continue;
        }
        const next = rest[i + 1];
        if (next && !next.startsWith("--")) {
            options[body] = next;
            i++;
        } else {
            options[body] = "true";
        }
    }
    return options;
}

const kebabToSnake = (key) => key.replace(/-/g, "_");

function headers(json = false) {
    const result = {};
    if (API_TOKEN) {
        result["Authorization"] = `Bearer ${API_TOKEN}`;
        result["X-API-Key"] = API_TOKEN;
    }
    if (json) result["Content-Type"] = "application/json";
    return result;
}

async function request(url, init = {}) {
    const response = await fetch(url, {
        ...init,
        headers: { ...headers(init.json === true), ...(init.headers ?? {}) },
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 800)}`);
    }
    return text;
}

function die(message) {
    console.error(`error: ${message}`);
    process.exit(1);
}

function usage() {
    console.log(`whisper-web CLI

  node scripts/cli.mjs health
  node scripts/cli.mjs models

  node scripts/cli.mjs transcribe <file> [options]
      --format|-f txt|srt|json   default: json (rich object, like the API)
      --out|-o <file>            write to a file instead of stdout
      --engine local|openai|command
      --model <id>               whisper model (tiny.en, Xenova/whisper-small, ...)
      --language <code>          en, zh, auto, ...
      --task transcribe|translate

  node scripts/cli.mjs bilingual <file> [options]
      all of the above, plus:
      --target <lang>            translation target, default zh
      --source <lang>            source language hint
      --translation-engine local|openai
      --translation-model <id>   Xenova/nllb-200-distilled-600M | gpt-4o-mini ...
      --translation-base-url <url>   translation-only endpoint (default: reuse
                                     --upstream-base-url / the server config)
      --translation-api-key <key>
      --translation-prompt <text>    extra instructions for the LLM engine
      --upstream-base-url <url>  OpenAI compatible endpoint (Groq, DashScope, ...)
      --upstream-api-key <key>
      --upstream-model <id>

Examples
  node scripts/cli.mjs transcribe jfk.mp3 --engine local --format srt -o jfk.srt
  node scripts/cli.mjs bilingual jfk.mp3 --target zh --format srt -o jfk.zh.srt
  node scripts/cli.mjs bilingual jfk.mp3 --target en --translation-engine openai \\
      --upstream-base-url https://api.groq.com/openai/v1 \\
      --upstream-api-key gsk_... --upstream-model gpt-4o-mini --format txt

Environment
  WHISPER_API=http://localhost:8787/api   API_TOKEN=<shared secret>
`);
}

/** CLI shortcuts -> request field names. */
const FIELD_ALIASES = {
    target: "target_language",
    "target-language": "target_language",
    source: "source_language",
    "source-language": "source_language",
    key: "upstream_api_key",
};

async function upload(commandName, file, options) {
    if (!file) die(`缺少音频文件：node scripts/cli.mjs ${commandName} <file>`);
    if (!fs.existsSync(file)) die(`文件不存在：${file}`);

    const form = new FormData();
    const buffer = await fsp.readFile(file);
    form.append(
        "file",
        new Blob([buffer], { type: "application/octet-stream" }),
        path.basename(file),
    );

    for (const [key, value] of Object.entries(options)) {
        if (["out", "o", "format", "f", "help", "h"].includes(key)) continue;
        const field = FIELD_ALIASES[key] ?? kebabToSnake(key);
        if (field === "out") continue;
        form.append(field, value);
    }

    // Without --format the server returns the rich object
    // ({ text, chunks: [{ timestamp, text, trans }] }).
    const format = options.format ?? options.f;
    if (format) form.append("response_format", String(format));

    const response = await fetch(`${API_BASE}/${commandName}`, {
        method: "POST",
        headers: headers(),
        body: form,
    });
    const text = await response.text();
    if (!response.ok) {
        die(`服务端返回 HTTP ${response.status}: ${text.slice(0, 800)}`);
    }
    return text;
}

async function main() {
    if (command === "help" || command === "-h" || command === "--help") {
        usage();
        return;
    }

    if (command === "health") {
        console.log(await request(`${API_BASE}/health`));
        return;
    }

    if (command === "models") {
        console.log(await request(`${API_BASE}/models`));
        return;
    }

    if (command === "transcribe" || command === "bilingual") {
        const [file, ...rest] = argv.slice(1);
        const options = parseArgs(rest);
        const output = await upload(command, file, options);
        const out = options.out ?? options.o;
        if (out) {
            await fsp.writeFile(out, output);
            console.log(`written: ${out}`);
        } else {
            console.log(output);
        }
        return;
    }

    usage();
    die(`unknown command: ${command}`);
}

await main().catch((error) => die(error?.message ?? String(error)));
