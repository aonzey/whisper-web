/* eslint-env node */
/* eslint-disable camelcase */
/**
 * Translation worker used by the "local" (server side transformers.js)
 * engine.
 *
 * Why a separate process? ONNX Runtime runs synchronously inside the Node
 * thread: a single non-converging generation (some ONNX exports never emit
 * EOS and keep decoding up to `max_length`) blocks the event loop completely
 * — every other request queues up and even a page reload looks "stuck".
 * A `withTimeout` around the promise cannot cancel it, because the CPU is
 * busy in native code. Running the model in a forked child means the parent
 * can `SIGKILL` the job for real.
 *
 * Protocol (IPC):
 *   parent -> child : { id, model, quantized, cacheDir, allowRemote,
 *                       lines, options, probe }
 *   child  -> parent: { id, ok: true, translations }
 *                   | { id, ok: false, message, degraded }
 *                   | { id, ready: true }
 */
import { pipeline, env } from "@xenova/transformers";

/** Cache of loaded pipelines: one per model + quantization setting. */
const pipelines = new Map();
/** Models proven to produce empty output — fail fast instead of hanging. */
const degraded = new Set();
/** Models already sanity-checked (the probe only runs once per model). */
const probed = new Set();

/**
 * Upper bound for the generated sequence.
 *
 * Marian/NLLB exports happily decode until `max_length` (512) when the model
 * does not converge, which costs ~100s per sentence on CPU. Scaling the
 * budget to the input keeps legit translations intact (real output is at
 * most ~1-2× the input length) while capping the pathological case.
 */
function maxNewTokensFor(lines) {
    const longest = lines.reduce((n, line) => Math.max(n, line.length), 8);
    return Math.min(256, Math.max(48, Math.ceil(longest * 0.8) + 16));
}

async function getTranslator({ model, quantized, cacheDir, allowRemote }) {
    const key = `${model}|${quantized ? "q" : "fp"}`;
    const existing = pipelines.get(key);
    if (existing) return existing;

    env.allowLocalModels = true;
    env.useFSCache = true;
    env.allowRemoteModels = Boolean(allowRemote);
    env.cacheDir = cacheDir;
    // Without this transformers.js looks for the model under its own
    // `node_modules/@xenova/transformers/models/` folder, so a cache miss
    // reports a path that has nothing to do with our `.cache` directory.
    if (cacheDir) env.localModelPath = cacheDir;
    if (process.env.HF_ENDPOINT) {
        env.remoteHost = process.env.HF_ENDPOINT.replace(/\/?$/, "/");
    }

    console.log(
        `[mt-worker] loading pipeline ${model} (quantized=${quantized})`,
    );
    const created = pipeline("translation", model, {
        quantized,
        cache_dir: cacheDir,
    });
    pipelines.set(key, created);
    try {
        const instance = await created;
        pipelines.set(key, instance);
        return instance;
    } catch (error) {
        pipelines.delete(key);
        throw error;
    }
}

/**
 * Some ONNX exports (e.g. `Xenova/opus-mt-en-jap`) decode nothing but
 * `<pad>`, which silently yields empty subtitles after ~100s per sentence.
 * A one-sentence probe catches that in a couple of seconds.
 */
async function probe(translator, options, model) {
    try {
        const out = await translator("Hello world.", {
            ...options,
            max_new_tokens: 12,
        });
        const text = Array.isArray(out)
            ? String(out[0]?.translation_text ?? "").trim()
            : String(out?.translation_text ?? "").trim();
        if (text) return null;
    } catch (error) {
        // A failing probe says nothing about the weights — let the real
        // batch surface the error instead.
        console.warn(`[mt-worker] probe failed for ${model}:`, error?.message);
        return null;
    }
    return (
        `翻译模型 ${model} 解码结果为空：该 ONNX 权重在当前引擎下只生成 ` +
        `<pad> token，无法产出译文（量化与非量化权重均已验证为同样结果）。\n` +
        `建议：① 改用 Xenova/nllb-200-distilled-600M（多语，含日语/中文）；` +
        `② 或把 Translation engine 切到 Server API（LLM 翻译）。`
    );
}

async function handle(message) {
    const {
        id,
        model,
        quantized,
        cacheDir,
        allowRemote,
        lines = [],
        options = {},
    } = message ?? {};

    const translator = await getTranslator({
        model,
        quantized,
        cacheDir,
        allowRemote,
    });

    if (!probed.has(model)) {
        probed.add(model);
        const problem = await probe(translator, options, model);
        if (problem) {
            degraded.add(model);
            return { id, ok: false, degraded: true, message: problem };
        }
    }
    if (degraded.has(model)) {
        return {
            id,
            ok: false,
            degraded: true,
            message: `翻译模型 ${model} 已被判定为不可用（解码结果为空），请更换模型。`,
        };
    }

    const text = lines.map((line) => String(line ?? "").trim());
    const merged = {
        ...options,
        max_new_tokens: options.max_new_tokens ?? maxNewTokensFor(text),
    };
    // One call per line: transformers.js pads when it is handed an array,
    // and the padded Marian exports then loop instead of emitting EOS
    // ("Good morning everyone." → "大家早,早,早,早,早,早"). Sequential calls
    // measured *no* slower (10 lines: 17.7s vs 17.8s batched) and are clean.
    const translations = [];
    for (const line of text) {
        const single = await translator(line, merged);
        const first = Array.isArray(single) ? single[0] : single;
        translations.push(first?.translation_text ?? "");
    }
    return { id, ok: true, translations };
}

process.on("message", (message) => {
    handle(message)
        .then((result) => process.send?.(result))
        .catch((error) => {
            process.send?.({
                id: message?.id,
                ok: false,
                message: error?.message ?? String(error),
            });
        });
});

process.send?.({ ready: true });
