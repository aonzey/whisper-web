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

function authHeaders(apiKey?: string) {
    const headers: Record<string, string> = {};
    if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
        headers["X-API-Key"] = apiKey;
    }
    return headers;
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
    try {
        const { data } = await axios.get(joinUrl(baseUrl, "/health"), {
            headers: authHeaders(apiKey),
            timeout: 8000,
        });
        return {
            ok: true,
            message: `OK — engine: ${data?.engine ?? "unknown"}, model: ${
                data?.model ?? "unknown"
            }`,
        };
    } catch (error: any) {
        return {
            ok: false,
            message:
                error?.response?.data?.error ??
                error?.message ??
                "Request failed",
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
}

function humanSize(bytes?: number) {
    if (!bytes || bytes <= 0) return "";
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${Math.round(mb)}MB`;
}

/**
 * Ask the server which models it can actually run (cached weights + aliases).
 * Never rejects — inspect `ok` / `error` instead so the UI can explain itself.
 */
export async function fetchApiModels(
    baseUrl: string,
    apiKey?: string,
): Promise<{ ok: boolean; options: ApiModelOption[]; error?: string }> {
    try {
        const { data } = await axios.get(joinUrl(baseUrl, "/models"), {
            headers: authHeaders(apiKey),
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
                note: `已缓存 · ${precision}${size ? ` · ${size}` : ""}`,
                cached: Boolean(item.cached),
                kind: "local",
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
            error:
                error?.response?.data?.error ??
                error?.message ??
                "无法连接服务端",
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

    const form = new FormData();
    form.append("file", file, fileName ?? "audio.wav");
    if (model) form.append("model", model);
    if (language) form.append("language", language);
    if (task) form.append("task", task);
    if (engine) form.append("engine", engine);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");

    const { data } = await axios.post(joinUrl(baseUrl, "/transcribe"), form, {
        headers: authHeaders(apiKey),
        timeout: 0, // transcription can take a long time
        onUploadProgress: (event) => {
            if (onProgress) onProgress(event.progress ?? 0);
        },
    });

    return normalizeTranscription(data);
}
