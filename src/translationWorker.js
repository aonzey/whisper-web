/* eslint-disable camelcase */
/**
 * Translation worker for the "Browser" translation engine.
 *
 * Runs a 🤗 Transformers.js `translation` pipeline inside a Web Worker so the
 * UI stays responsive while the model downloads / generates.
 *
 * Messages in : { id, model, quantized, lines, srcLang, tgtLang }
 *              | { type: "reset" }
 * Messages out: { status: "progress" | "complete" | "error", id, ... }
 */
import { pipeline, env } from "@xenova/transformers";

// Use the browser cache (IndexedDB) when the model is already there, and only
// fall back to a download — the remote host is often unreachable from a
// corporate network, so hitting the cache matters here.
env.allowLocalModels = true;
env.allowRemoteModels = true;

let cached = { model: null, quantized: null, instance: null };

async function getTranslator(model, quantized, onProgress) {
    if (
        cached.instance &&
        cached.model === model &&
        cached.quantized === quantized
    ) {
        return cached.instance;
    }
    if (cached.instance) {
        try {
            await cached.instance.dispose();
        } catch (e) {
            // ignore
        }
    }
    cached = { model, quantized, instance: null };
    const instance = await pipeline("translation", model, {
        quantized,
        progress_callback: onProgress,
    });
    cached.instance = instance;
    return instance;
}

/**
 * Upper bound for the generated sequence.
 *
 * Some ONNX exports never emit EOS and keep decoding until `max_length`
 * (512), which costs ~100s of CPU per sentence. Scaling the budget to the
 * input keeps real translations intact while capping the pathological case.
 */
function maxNewTokensFor(lines) {
    const longest = lines.reduce((n, line) => Math.max(n, line.length), 8);
    return Math.min(256, Math.max(48, Math.ceil(longest * 0.8) + 16));
}

/**
 * Drop cached entries for `model` from the browser model cache.
 *
 * Before the server grew a `/models` route, every weight request was
 * answered with index.html — and that HTML got stored in the Cache Storage.
 * Later runs then kept reading the corrupted entry straight from cache.
 */
async function purgeModelCache(model) {
    try {
        if (typeof caches === "undefined" || !model) return 0;
        const cache = await caches.open("transformers-cache");
        const keys = await cache.keys();
        let removed = 0;
        for (const request of keys) {
            if (String(request.url).includes(model)) {
                await cache.delete(request);
                removed += 1;
            }
        }
        return removed;
    } catch (e) {
        return 0;
    }
}

self.addEventListener("message", async (event) => {
    const message = event.data ?? {};

    if (message.type === "reset") {
        if (cached.instance) {
            try {
                await cached.instance.dispose();
            } catch (e) {
                // ignore
            }
        }
        cached = { model: null, quantized: null, instance: null };
        self.postMessage({ status: "reset" });
        return;
    }

    const { id, model, quantized, lines, srcLang, tgtLang } = message;
    try {
        const translator = await getTranslator(
            model,
            quantized !== false,
            (data) => {
                self.postMessage({ status: "progress", id, ...data });
            },
        );

        const options = {};
        if (srcLang) options.src_lang = srcLang;
        if (tgtLang) options.tgt_lang = tgtLang;

        const text = (lines ?? []).map((line) => String(line ?? "").trim());
        const output = await translator(text, {
            ...options,
            max_new_tokens: maxNewTokensFor(text),
        });

        const translations = (Array.isArray(output) ? output : [output]).map(
            (item) => item?.translation_text ?? "",
        );

        // Some ONNX exports decode nothing but <pad>. Say so instead of
        // filling the transcript with empty lines.
        if (
            text.some((line) => line.length > 0) &&
            translations.every((item) => !item)
        ) {
            self.postMessage({
                status: "error",
                id,
                message:
                    `模型 ${model} 解码结果为空（只生成 <pad> token），` +
                    `该 ONNX 权重在当前引擎下不可用。` +
                    `建议改用 Xenova/nllb-200-distilled-600M，` +
                    `或把 Translation engine 切到 Server API。`,
            });
            return;
        }

        self.postMessage({ status: "complete", id, translations });
    } catch (error) {
        const raw = error?.message ?? String(error);

        // "Unexpected token '<', "<!DOCTYPE " ... is not valid JSON" means the
        // model files came back as HTML (a dev server / SPA fallback without a
        // `/models` route). Clear the poisoned cache entries so the retry
        // actually re-fetches, and say what to check.
        if (/is not valid JSON|Unexpected token|<!DOCTYPE/i.test(raw)) {
            const removed = await purgeModelCache(model);
            self.postMessage({
                status: "error",
                id,
                message:
                    `模型 ${model} 的文件不是有效模型数据（收到的是 HTML 页面）。` +
                    `已清除浏览器缓存中 ${removed} 项损坏记录，请重试。\n` +
                    `若仍然失败：确认 API 服务已启动（npm run server），` +
                    `浏览器引擎的模型文件由服务端的 /models 提供；` +
                    `开发环境（npm run dev）需要 vite 代理 /models。`,
            });
            return;
        }

        self.postMessage({
            status: "error",
            id,
            message: raw,
        });
    }
});
