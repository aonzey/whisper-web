import axios from "axios";
import { Chunk } from "../hooks/useTranscriber";

export interface ApiTranscribeOptions {
    /** Base url of the API, e.g. `/api` (proxied by vite) or `http://localhost:8787/api`. */
    baseUrl: string;
    apiKey?: string;
    model?: string;
    language?: string;
    task?: string;
    /** Force a server side engine: "local" | "openai" | "command". */
    engine?: string;
    /** "txt" | "srt" | "json" — identical to the page's export buttons. */
    responseFormat?: "txt" | "srt" | "json";
    file: Blob;
    fileName?: string;
    /** Upload progress, 0 - 1. */
    onProgress?: (value: number) => void;
}

export interface ApiTranscribeResult {
    text: string;
    chunks: Chunk[];
    raw?: any;
}

function joinUrl(base: string, path: string) {
    const trimmed = (base || "").replace(/\/+$/, "");
    if (!trimmed) return path;
    return trimmed + (path.startsWith("/") ? path : `/${path}`);
}

/**
 * What did the user type into the "Base URL" field?
 *
 * - `self`   → our own Node server (`/api`, `http://host:8787/api`, empty).
 *              Requests are `<base>/transcribe`, `<base>/health`, `<base>/models`.
 * - `openai` → any OpenAI compatible endpoint, e.g.
 *              `https://api.groq.com/openai/v1` **or** the full
 *              `https://api.groq.com/openai/v1/audio/transcriptions`.
 *              The browser cannot call those directly (CORS + it does not use
 *              the system proxy), so requests are relayed through our own
 *              server with `upstream_*` fields.
 */
export type ApiTarget =
    | { kind: "self"; baseUrl: string }
    | { kind: "openai"; baseUrl: string; endpoint: string };

/**
 * Model ids already stored in **this browser** (Cache Storage
 * `transformers-cache`), e.g. after a "Browser" engine run.
 *
 * This is a completely different place from the server's `.cache` folders, so
 * the Settings dropdown has to keep the two apart: an id listed here is
 * immediately usable by the in-browser engine, while a server side one needs
 * the local engine (or the `/models` route of a running server).
 */
export async function listBrowserCachedModels(): Promise<string[]> {
    if (typeof caches === "undefined") return [];
    try {
        const cache = await caches.open("transformers-cache");
        const requests = await cache.keys();
        const ids = new Set<string>();
        for (const request of requests) {
            const id = modelIdFromCacheUrl(String(request.url));
            if (id) ids.add(id);
        }
        return [...ids].sort();
    } catch (error) {
        return [];
    }
}

/**
 * Pull the `<org>/<name>` id out of a cached weight url:
 *   https://huggingface.co/Xenova/nllb-200-distilled-600M/resolve/main/tokenizer.json
 *   http://localhost:8787/models/Xenova/nllb-200-distilled-600M/tokenizer.json
 */
function modelIdFromCacheUrl(url: string): string {
    try {
        const pathname = new URL(url).pathname.replace(/^\/+/, "");
        // Our own server serves the weights below `/models/`.
        const withoutPrefix = pathname.replace(/^models\//, "");
        const parts = withoutPrefix.split("/").filter(Boolean);
        if (parts.length >= 3) return `${parts[0]}/${parts[1]}`;
        if (parts.length === 2) return parts[0];
        return "";
    } catch (error) {
        return "";
    }
}

/** Base url used to reach our own server (the relay). */
export const SELF_API_BASE = "/api";

export function classifyApiBase(input: string): ApiTarget {
    const raw = (input || "").trim();
    const self: ApiTarget = {
        kind: "self",
        baseUrl: raw ? raw.replace(/\/+$/, "") : SELF_API_BASE,
    };

    // Relative paths (`/api`) always mean our own server.
    if (!/^https?:\/\//i.test(raw)) return self;
    // ...as does an explicit .../api on our own host.
    if (/\/api\/?$/i.test(raw)) return self;

    const base = raw.replace(/\/+$/, "");
    // The user may paste the full endpoint — keep the API root separately so
    // `/models` probing still works.
    const full = base.match(/^(.*?)\/audio\/transcriptions?$/i);
    const root = full?.[1] ? full[1].replace(/\/+$/, "") : base;
    return {
        kind: "openai",
        baseUrl: root,
        endpoint: `${root}/audio/transcriptions`,
    };
}

/** Human readable description of the resolved target (shown in Settings). */
export function describeApiTarget(target: ApiTarget): string {
    if (target.kind === "self") {
        return "本项目服务端（Node API）";
    }
    return `第三方 OpenAI 兼容端点：${target.endpoint}（经本地服务端中转）`;
}

function authHeaders(apiKey?: string) {
    const headers: Record<string, string> = {};
    if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
        headers["X-API-Key"] = apiKey;
    }
    return headers;
}

/** Readable error from an axios failure (prefers the server's own message). */
function errorMessage(error: any, fallback: string): string {
    const data = error?.response?.data;
    const detail =
        typeof data === "string"
            ? data.slice(0, 400)
            : data?.error ??
              data?.message ??
              (data ? JSON.stringify(data).slice(0, 400) : "");
    const status = error?.response?.status;
    const prefix = status ? `HTTP ${status}` : "";
    return [prefix, detail || error?.message || fallback]
        .filter(Boolean)
        .join(" — ");
}

/**
 * Normalize the different response shapes (`chunks` from our own server,
 * `segments` from an OpenAI compatible one, or plain `text`) into chunks.
 */
export function normalizeTranscription(data: any): ApiTranscribeResult {
    if (!data) return { text: "", chunks: [] };

    // `response_format=json` returns the bare exported array
    // [{ timestamp, text, trans }, ...] — exactly what the UI downloads.
    if (Array.isArray(data)) {
        const chunks: Chunk[] = data.map((c: any) => ({
            timestamp: c.timestamp ?? [c.start ?? 0, c.end ?? null],
            text: c.text ?? "",
            trans: c.trans ?? "",
        }));
        return {
            text: chunks
                .map((chunk) => chunk.text)
                .join("")
                .trim(),
            chunks,
        };
    }

    if (Array.isArray(data.chunks)) {
        return {
            text: data.text ?? "",
            chunks: data.chunks.map((c: any) => ({
                timestamp: c.timestamp ?? [c.start ?? 0, c.end ?? null],
                text: c.text ?? "",
                trans: c.trans ?? "",
            })),
            raw: data,
        };
    }

    if (Array.isArray(data.segments)) {
        return {
            text: data.text ?? "",
            chunks: data.segments.map((s: any) => ({
                timestamp: [s.start ?? 0, s.end ?? null],
                text: s.text ?? "",
                trans: s.trans ?? "",
            })),
            raw: data,
        };
    }

    const text: string = data.text ?? "";
    return {
        text,
        chunks: text ? [{ timestamp: [0, null], text, trans: "" }] : [],
        raw: data,
    };
}

/** Lightweight health check against the API server. */
export async function checkApiHealth(
    baseUrl: string,
    apiKey?: string,
): Promise<{ ok: boolean; message: string }> {
    const target = classifyApiBase(baseUrl);
    try {
        // Third party endpoints have no /health — probe /models through our
        // server instead (it also proves the key works).
        const url =
            target.kind === "self"
                ? joinUrl(target.baseUrl, "/health")
                : joinUrl(SELF_API_BASE, "/upstream/health");
        const params =
            target.kind === "self"
                ? undefined
                : { baseUrl: target.baseUrl, apiKey: apiKey ?? "" };

        const { data } = await axios.get(url, {
            params,
            headers: authHeaders(target.kind === "self" ? apiKey : undefined),
            timeout: 15000,
        });

        if (target.kind === "self") {
            return {
                ok: true,
                message: `OK — engine: ${data?.engine ?? "unknown"}, model: ${
                    data?.model ?? "unknown"
                }`,
            };
        }
        return {
            ok: true,
            message:
                data?.message ??
                `OK — ${target.baseUrl}（${
                    data?.models?.length ?? "?"
                } 个模型）`,
        };
    } catch (error: any) {
        return {
            ok: false,
            message: errorMessage(error, "Request failed"),
        };
    }
}

export interface ApiModelOption {
    /** Value sent as `model` in the transcribe request. */
    id: string;
    /** Short description shown next to the id (precision, cache state...). */
    note: string;
    /** Weights are already on disk on the server. */
    cached: boolean;
    /** Local (transformers.js) model vs. plain alias / remote model. */
    kind: "local" | "alias" | "remote";
    /** What the model can do: "asr" (whisper) / "translation" / "" unknown. */
    task?: string;
    /** Weights are on disk but `tokenizer.json` is missing → cannot load. */
    incomplete?: boolean;
    /** Which files are missing (only set when `incomplete`). */
    missingFiles?: string[];
}

function humanSize(bytes?: number) {
    if (!bytes || bytes <= 0) return "";
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${Math.round(mb)}MB`;
}

export interface FetchModelsOptions {
    baseUrl: string;
    apiKey?: string;
    /**
     * Which Settings column is asking:
     *   "asr"         -> whisper family (the transcription dropdown)
     *   "translation" -> opus-mt / nllb / ... (the translation dropdown)
     * Omit to receive every cached model.
     */
    task?: "asr" | "translation";
}

/**
 * Ask the server which models it can actually run (cached weights + aliases).
 * Never rejects — inspect `ok` / `error` instead so the UI can explain itself.
 */
export async function fetchApiModels(
    options: FetchModelsOptions | string,
    legacyApiKey?: string,
    legacyTask?: "asr" | "translation",
): Promise<{ ok: boolean; options: ApiModelOption[]; error?: string }> {
    const { baseUrl, apiKey, task } =
        typeof options === "string"
            ? {
                  baseUrl: options,
                  apiKey: legacyApiKey,
                  task: legacyTask,
              }
            : options;
    const target = classifyApiBase(baseUrl);
    try {
        // Third party endpoint → list its own models through our server.
        if (target.kind === "openai") {
            const { data } = await axios.get(
                joinUrl(SELF_API_BASE, "/upstream/models"),
                {
                    params: { baseUrl: target.baseUrl, apiKey: apiKey ?? "" },
                    timeout: 15000,
                },
            );
            const models: string[] = Array.isArray(data?.models)
                ? data.models
                : [];
            // A chat model is what the translation column wants; the
            // transcription column needs audio models.
            const audioLike = task !== "translation";
            const filtered = audioLike
                ? models
                : models.filter((id) => !/whisper|distil/i.test(id));
            return {
                ok: true,
                options: filtered.map((id) => ({
                    id,
                    note: /whisper|asr|audio|distil/i.test(id)
                        ? "上游语音模型"
                        : "上游模型（非语音）",
                    cached: false,
                    kind: "remote" as const,
                    task: "",
                })),
            };
        }

        const { data } = await axios.get(joinUrl(target.baseUrl, "/models"), {
            headers: authHeaders(apiKey),
            params: task ? { task } : undefined,
            timeout: 8000,
        });

        const local = data?.local ?? {};
        const options: ApiModelOption[] = [];

        // Models whose weights are already in the server cache.
        const detailed = Array.isArray(local.models) ? local.models : [];
        for (const item of detailed) {
            if (!item?.id) continue;
            const precision =
                item.quantized && item.fp32
                    ? "量化+fp32"
                    : item.quantized
                    ? "量化"
                    : "fp32";
            const size = humanSize(item.size);
            options.push({
                id: item.id,
                note: item.incomplete
                    ? `已缓存但不完整 · 缺 ${(
                          item.missingFiles ?? []
                      ).join("、")} · 需重新下载`
                    : `已缓存 · ${precision}${size ? ` · ${size}` : ""}`,
                cached: Boolean(item.cached),
                kind: "local",
                task: item.task ?? "",
                incomplete: Boolean(item.incomplete),
                missingFiles: Array.isArray(item.missingFiles)
                    ? item.missingFiles
                    : undefined,
            });
        }

        // Fall back to the plain id list if the server is older.
        if (detailed.length === 0 && Array.isArray(local.available)) {
            for (const id of local.available) {
                options.push({
                    id,
                    note: "已缓存",
                    cached: true,
                    kind: "local",
                });
            }
        }

        // Aliases such as `tiny.en` (mapped to Xenova/whisper-tiny.en).
        const aliases = Array.isArray(local.aliases) ? local.aliases : [];
        for (const item of aliases) {
            const id = typeof item === "string" ? item : item?.id;
            if (!id || options.some((option) => option.id === id)) continue;
            const cached =
                typeof item === "string" ? false : Boolean(item.cached);
            const target = typeof item === "string" ? undefined : item.target;
            options.push({
                id,
                note: cached
                    ? `别名 · 已缓存 ${target ?? ""}`.trim()
                    : target
                    ? `别名 · 未缓存（${target}）`
                    : "别名",
                cached,
                kind: "alias",
            });
        }

        // Remote (OpenAI compatible) model, only useful for the "api" engine.
        const remoteModel = data?.openai?.model;
        if (remoteModel && !options.some((o) => o.id === remoteModel)) {
            options.push({
                id: remoteModel,
                note: "远端模型（openai 引擎）",
                cached: false,
                kind: "remote",
            });
        }

        return { ok: true, options };
    } catch (error: any) {
        return {
            ok: false,
            options: [],
            error: errorMessage(error, "无法连接服务端"),
        };
    }
}

/** Upload an audio blob and return the normalized transcript. */
export async function transcribeViaApi(
    options: ApiTranscribeOptions,
): Promise<ApiTranscribeResult> {
    const {
        baseUrl,
        apiKey,
        model,
        language,
        task,
        engine,
        file,
        fileName,
        onProgress,
    } = options;

    const target = classifyApiBase(baseUrl);
    const form = new FormData();
    form.append("file", file, fileName ?? "audio.wav");
    if (model) form.append("model", model);
    if (language) form.append("language", language);
    if (task) form.append("task", task);
    if (engine) form.append("engine", engine);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");

    let url: string;
    let headers = authHeaders(apiKey);

    if (target.kind === "self") {
        url = joinUrl(target.baseUrl, "/transcribe");
    } else {
        // Relay through our own server: the browser cannot reach Groq & co.
        // directly (CORS, and it ignores the system proxy).
        url = joinUrl(SELF_API_BASE, "/transcribe");
        form.append("upstream_base_url", target.baseUrl);
        if (apiKey) form.append("upstream_api_key", apiKey);
        if (model) form.append("upstream_model", model);
        // Only our own server needs the key header (it may require API_TOKEN).
        headers = {};
    }

    try {
        const { data } = await axios.post(url, form, {
            headers,
            timeout: 0, // transcription can take a long time
            onUploadProgress: (event) => {
                if (onProgress) onProgress(event.progress ?? 0);
            },
        });
        return normalizeTranscription(data);
    } catch (error: any) {
        throw new Error(errorMessage(error, "转写请求失败"));
    }
}
