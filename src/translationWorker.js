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

        const output = await translator(
            (lines ?? []).map((line) => String(line ?? "").trim()),
            options,
        );

        const translations = (Array.isArray(output) ? output : [output]).map(
            (item) => item?.translation_text ?? "",
        );
        self.postMessage({ status: "complete", id, translations });
    } catch (error) {
        self.postMessage({
            status: "error",
            id,
            message: error?.message ?? String(error),
        });
    }
});
