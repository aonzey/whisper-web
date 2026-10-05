/* eslint-disable camelcase */
import axios from "axios";
import { classifyApiBase, SELF_API_BASE } from "./ApiClient";
import {
    TRANSLATION_BATCH_SIZE,
    TRANSLATION_CONTEXT_SIZE,
    TRANSLATION_LANGUAGES,
    buildTranslationPrompt,
    languageLabel,
    nllbCode,
    needsLanguageCodes,
    parseNumberedTranslations,
} from "./TranslationFormats.js";

/**
 * Translation helpers for the UI.
 *
 * Three engines, chosen in Settings → "Translation engine":
 *   - "browser" 🤗 Transformers.js translation model inside a Web Worker
 *   - "local"   the same models, but running inside the Node API server
 *   - "api"     an OpenAI compatible chat endpoint (LLM) — the one that can
 *               really use the surrounding subtitle context
 */

export type TranslationEngine = "browser" | "local" | "api";

export {
    TRANSLATION_BATCH_SIZE,
    TRANSLATION_CONTEXT_SIZE,
    TRANSLATION_LANGUAGES,
    buildTranslationPrompt,
    languageLabel,
    nllbCode,
    needsLanguageCodes,
    parseNumberedTranslations,
};

/** Model presets for the browser / local (🤗 Transformers.js) engines. */
export interface TranslationModelOption {
    id: string;
    note: string;
    multilingual: boolean;
    size: string;
}

export const TRANSLATION_MODELS: TranslationModelOption[] = [
    {
        id: "Xenova/nllb-200-distilled-600M",
        note: "200 种语言 · 默认",
        multilingual: true,
        size: "≈250MB(q8)",
    },
    {
        id: "Xenova/nllb-200-1.3B",
        note: "质量更好，更慢更大",
        multilingual: true,
        size: "≈1.4GB(q8)",
    },
    {
        id: "Xenova/m2m100_418M",
        note: "100 种语言（语言码 zh/en/…）",
        multilingual: true,
        size: "≈440MB",
    },
    {
        id: "Xenova/opus-mt-en-zh",
        note: "仅 English → Chinese",
        multilingual: false,
        size: "≈80MB",
    },
    {
        id: "Xenova/opus-mt-en-jap",
        note: "仅 English → Japanese",
        multilingual: false,
        size: "≈80MB",
    },
    {
        id: "Xenova/opus-mt-en-ko",
        note: "仅 English → Korean",
        multilingual: false,
        size: "≈80MB",
    },
    {
        id: "Xenova/opus-mt-en-de",
        note: "仅 English → German",
        multilingual: false,
        size: "≈80MB",
    },
    {
        id: "Xenova/opus-mt-en-fr",
        note: "仅 English → French",
        multilingual: false,
        size: "≈80MB",
    },
    {
        id: "Xenova/opus-mt-en-es",
        note: "仅 English → Spanish",
        multilingual: false,
        size: "≈80MB",
    },
    {
        id: "Xenova/opus-mt-en-ru",
        note: "仅 English → Russian",
        multilingual: false,
        size: "≈80MB",
    },
];

/** Model presets for the Server API engine (OpenAI compatible chat models). */
export const TRANSLATION_API_MODELS = [
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-3.5-turbo",
    "qwen-plus",
    "qwen-turbo",
    "deepseek-chat",
    "glm-4-flash",
    "llama-3.3-70b-versatile",
];

export interface TranslateOptions {
    engine: TranslationEngine;
    /** Destination language id (see TRANSLATION_LANGUAGES) or a free name. */
    targetLanguage: string;
    /** Source language id, may be empty / "auto". */
    sourceLanguage?: string;
    /** 🤗 model id for browser/local, chat model for api. */
    model?: string;
    /** Server API base url (our own server, or an OpenAI compatible root). */
    baseUrl?: string;
    apiKey?: string;
    /** Free-form instructions for the LLM engine (ignored by 🤗 models). */
    prompt?: string;
    lines: string[];
    onProgress?: (done: number, total: number) => void;
}

/* ------------------------------------------------------------------ *
 * Server side engines ("local" transformers.js, "api" OpenAI chat)
 * ------------------------------------------------------------------ */

export interface ServerTranslateOptions extends TranslateOptions {
    engine: "local" | "api";
    /** Lines translated right before this batch (context for the LLM). */
    context?: { text: string; trans: string }[];
}

/** Ask our own API server to translate (it can reach the upstream). */
export async function translateViaServer(
    options: ServerTranslateOptions,
): Promise<string[]> {
    const {
        engine,
        baseUrl,
        apiKey,
        model,
        lines,
        sourceLanguage,
        targetLanguage,
        context,
        prompt,
        onProgress,
    } = options;

    const target = classifyApiBase(baseUrl || "");
    const payload: Record<string, unknown> = {
        engine,
        lines,
        target_language: targetLanguage,
        target_language_code: nllbCode(targetLanguage),
        source_language: sourceLanguage || "",
    };
    if (model) payload.model = model;
    if (prompt && String(prompt).trim()) {
        payload.extra_prompt = String(prompt);
    }
    if (context && context.length) payload.context_lines = context;
    if (target.kind === "openai") {
        payload.upstream_base_url = target.baseUrl;
        if (apiKey) payload.upstream_api_key = apiKey;
        // The chat model differs from the whisper model.
        if (model) payload.upstream_model = model;
    }

    const url =
        target.kind === "openai"
            ? `${SELF_API_BASE}/translate`
            : `${(target.baseUrl || SELF_API_BASE).replace(
                  /\/+$/,
                  "",
              )}/translate`;

    const headers: Record<string, string> =
        target.kind === "self" && apiKey
            ? { Authorization: `Bearer ${apiKey}`, "X-API-Key": apiKey }
            : {};

    const { data } = await axios.post(url, payload, {
        headers,
        timeout: 0,
    });

    const translations = Array.isArray(data?.translations)
        ? data.translations.map((t: unknown) => String(t ?? ""))
        : [];
    if (translations.length !== lines.length) {
        throw new Error(
            `服务端返回 ${translations.length} 行译文，期望 ${lines.length} 行`,
        );
    }
    onProgress?.(lines.length, lines.length);
    return translations;
}

/* ------------------------------------------------------------------ *
 * Browser engine (🤗 Transformers.js inside a Web Worker)
 * ------------------------------------------------------------------ */

type PendingJob = {
    resolve: (value: string[]) => void;
    reject: (error: Error) => void;
};

let workerSingleton: Worker | null = null;
let jobSeq = 0;
const jobs = new Map<number, PendingJob>();

function ensureWorker(): Worker {
    if (workerSingleton) return workerSingleton;
    const worker = new Worker(
        new URL("../translationWorker.js", import.meta.url),
        { type: "module" },
    );
    worker.addEventListener("message", (event) => {
        const message = event.data ?? {};
        const job = jobs.get(message.id);
        if (!job) return;
        if (message.status === "complete") {
            jobs.delete(message.id);
            job.resolve(message.translations ?? []);
        } else if (message.status === "error") {
            jobs.delete(message.id);
            job.reject(new Error(message.message ?? "浏览器内翻译失败"));
        }
    });
    worker.addEventListener("error", (event) => {
        const error = new Error(event.message || "翻译 worker 崩溃");
        jobs.forEach((job) => job.reject(error));
        jobs.clear();
        workerSingleton = null;
    });
    workerSingleton = worker;
    return worker;
}

/** Run a 🤗 translation model inside the browser (Web Worker). */
export function translateInBrowser(
    options: TranslateOptions & { quantized?: boolean },
): Promise<string[]> {
    const { model, lines, sourceLanguage, targetLanguage, quantized } = options;
    const worker = ensureWorker();
    const id = ++jobSeq;
    const idOrEmpty = model || "Xenova/nllb-200-distilled-600M";

    return new Promise<string[]>((resolve, reject) => {
        jobs.set(id, { resolve, reject });
        worker.postMessage({
            id,
            model: idOrEmpty,
            quantized: quantized !== false,
            lines,
            srcLang: needsLanguageCodes(idOrEmpty)
                ? nllbCode(sourceLanguage || "") || "eng_Latn"
                : undefined,
            tgtLang: needsLanguageCodes(idOrEmpty)
                ? nllbCode(targetLanguage) || "zho_Hans"
                : undefined,
        });
    });
}

/** Drop the cached pipeline (e.g. after the model setting changed). */
export function resetBrowserTranslator() {
    workerSingleton?.postMessage({ type: "reset" });
}

/* ------------------------------------------------------------------ *
 * Batching helper used by every engine
 * ------------------------------------------------------------------ */

/**
 * Translate the lines in batches, handing the previous batch to the LLM as
 * context so pronouns / terminology stay consistent.
 */
export async function translateLinesWithContext(
    options: TranslateOptions,
): Promise<string[]> {
    const { lines, onProgress } = options;
    const total = lines.length;
    const size = Math.max(1, TRANSLATION_BATCH_SIZE);
    const result: string[] = new Array(total).fill("");
    let done = 0;
    onProgress?.(0, total);

    for (let start = 0; start < total; start += size) {
        const batch = lines.slice(start, start + size);
        const context: { text: string; trans: string }[] = [];
        for (
            let i = Math.max(0, start - TRANSLATION_CONTEXT_SIZE);
            i < start;
            i++
        ) {
            context.push({ text: lines[i], trans: result[i] });
        }

        const translated = await translateBatch(
            { ...options, lines: batch },
            context,
        );
        for (let i = 0; i < batch.length; i++) {
            result[start + i] = translated[i] ?? "";
        }
        done += batch.length;
        onProgress?.(done, total);
    }

    onProgress?.(total, total);
    return result;
}

async function translateBatch(
    options: TranslateOptions,
    context: { text: string; trans: string }[],
): Promise<string[]> {
    if (options.engine === "browser") {
        return translateInBrowser(options);
    }
    // The server rebuilds the same context-aware prompt from `context_lines`.
    return translateViaServer({
        ...options,
        engine: options.engine === "local" ? "local" : "api",
        context,
    });
}
