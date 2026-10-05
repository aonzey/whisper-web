/**
 * Shared translation helpers.
 *
 * Plain ESM JavaScript so both runtimes use the same data / prompt / parser:
 *   - the browser app  -> src/utils/TranslationClient.ts
 *   - the Node server  -> server/index.js (/api/translate, /api/bilingual)
 *
 * Keep it dependency free and runtime agnostic.
 */

export const TRANSLATION_BATCH_SIZE = 10;
export const TRANSLATION_CONTEXT_SIZE = 4;

/**
 * Target languages. `id` matches the source-language ids used by the
 * transcription settings, `nllb` is the code 🤗 NLLB / m2m100 expect.
 */
export const TRANSLATION_LANGUAGES = [
    { id: "zh", label: "Chinese (Simplified)", nllb: "zho_Hans" },
    { id: "zh-Hant", label: "Chinese (Traditional)", nllb: "zho_Hant" },
    { id: "en", label: "English", nllb: "eng_Latn" },
    { id: "ja", label: "Japanese", nllb: "jpn_Jpan" },
    { id: "ko", label: "Korean", nllb: "kor_Hang" },
    { id: "fr", label: "French", nllb: "fra_Latn" },
    { id: "de", label: "German", nllb: "deu_Latn" },
    { id: "es", label: "Spanish", nllb: "spa_Latn" },
    { id: "pt", label: "Portuguese", nllb: "por_Latn" },
    { id: "ru", label: "Russian", nllb: "rus_Cyrl" },
    { id: "it", label: "Italian", nllb: "ita_Latn" },
    { id: "nl", label: "Dutch", nllb: "nld_Latn" },
    { id: "pl", label: "Polish", nllb: "pol_Latn" },
    { id: "tr", label: "Turkish", nllb: "tur_Latn" },
    { id: "ar", label: "Arabic", nllb: "arb_Arab" },
    { id: "hi", label: "Hindi", nllb: "hin_Deva" },
    { id: "id", label: "Indonesian", nllb: "ind_Latn" },
    { id: "vi", label: "Vietnamese", nllb: "vie_Latn" },
    { id: "th", label: "Thai", nllb: "tha_Thai" },
    { id: "uk", label: "Ukrainian", nllb: "ukr_Cyrl" },
    { id: "sv", label: "Swedish", nllb: "swe_Latn" },
    { id: "da", label: "Danish", nllb: "dan_Latn" },
    { id: "no", label: "Norwegian", nllb: "nob_Latn" },
    { id: "fi", label: "Finnish", nllb: "fin_Latn" },
    { id: "cs", label: "Czech", nllb: "ces_Latn" },
    { id: "el", label: "Greek", nllb: "ell_Grek" },
    { id: "he", label: "Hebrew", nllb: "heb_Hebr" },
    { id: "hu", label: "Hungarian", nllb: "hun_Latn" },
    { id: "ro", label: "Romanian", nllb: "ron_Latn" },
    { id: "sk", label: "Slovak", nllb: "slk_Latn" },
    { id: "bg", label: "Bulgarian", nllb: "bul_Cyrl" },
    { id: "hr", label: "Croatian", nllb: "hrv_Latn" },
    { id: "sr", label: "Serbian", nllb: "srp_Cyrl" },
    { id: "sl", label: "Slovenian", nllb: "slv_Latn" },
    { id: "lt", label: "Lithuanian", nllb: "lit_Latn" },
    { id: "lv", label: "Latvian", nllb: "lvs_Latn" },
    { id: "et", label: "Estonian", nllb: "ekk_Latn" },
    { id: "fa", label: "Persian", nllb: "pes_Arab" },
    { id: "ur", label: "Urdu", nllb: "urd_Arab" },
    { id: "bn", label: "Bengali", nllb: "ben_Beng" },
    { id: "ta", label: "Tamil", nllb: "tam_Taml" },
    { id: "te", label: "Telugu", nllb: "tel_Telu" },
    { id: "ml", label: "Malayalam", nllb: "mal_Mlym" },
    { id: "kn", label: "Kannada", nllb: "kan_Knda" },
    { id: "mr", label: "Marathi", nllb: "mar_Deva" },
    { id: "gu", label: "Gujarati", nllb: "guj_Gujr" },
    { id: "pa", label: "Punjabi", nllb: "pan_Guru" },
    { id: "ne", label: "Nepali", nllb: "npi_Deva" },
    { id: "si", label: "Sinhala", nllb: "sin_Sinh" },
    { id: "km", label: "Khmer", nllb: "khm_Khmr" },
    { id: "lo", label: "Lao", nllb: "lao_Laoo" },
    { id: "my", label: "Burmese", nllb: "mya_Mymr" },
    { id: "tl", label: "Tagalog", nllb: "tgl_Latn" },
    { id: "ms", label: "Malay", nllb: "zsm_Latn" },
    { id: "sw", label: "Swahili", nllb: "swh_Latn" },
    { id: "af", label: "Afrikaans", nllb: "afr_Latns" },
    { id: "ca", label: "Catalan", nllb: "cat_Latn" },
    { id: "gl", label: "Galician", nllb: "glg_Latn" },
    { id: "eu", label: "Basque", nllb: "eus_Latn" },
    { id: "is", label: "Icelandic", nllb: "isl_Latn" },
    { id: "mk", label: "Macedonian", nllb: "mkd_Cyrl" },
    { id: "sq", label: "Albanian", nllb: "als_Latn" },
    { id: "hy", label: "Armenian", nllb: "hye_Armn" },
    { id: "ka", label: "Georgian", nllb: "kat_Geor" },
    { id: "kk", label: "Kazakh", nllb: "kaz_Cyrl" },
    { id: "uz", label: "Uzbek", nllb: "uzn_Latn" },
    { id: "az", label: "Azerbaijani", nllb: "azj_Latn" },
    { id: "be", label: "Belarusian", nllb: "bel_Cyrl" },
    { id: "mn", label: "Mongolian", nllb: "khk_Cyrl" },
    { id: "am", label: "Amharic", nllb: "amh_Ethi" },
    { id: "ha", label: "Hausa", nllb: "hau_Latn" },
    { id: "yo", label: "Yoruba", nllb: "yor_Latn" },
    { id: "la", label: "Latin", nllb: "lat_Latn" },
];

export function languageLabel(id) {
    if (!id) return "";
    const hit = TRANSLATION_LANGUAGES.find((l) => l.id === id);
    if (hit) return hit.label;
    return id === "auto" ? "Auto detect" : id;
}

/** NLLB style code for a language id (`zh` -> `zho_Hans`). */
export function nllbCode(id) {
    if (!id) return "";
    return TRANSLATION_LANGUAGES.find((l) => l.id === id)?.nllb ?? "";
}

/** Only NLLB / m2m100 / mBART accept `src_lang` / `tgt_lang`. */
export function needsLanguageCodes(model) {
    return /nllb|m2m100|mbart/i.test(model ?? "");
}

/**
 * Context aware prompt used by the Server API (LLM) engine.
 * `context` holds the lines translated right before this batch.
 */
export function buildTranslationPrompt({
    lines,
    context,
    sourceLanguage,
    targetLanguage,
    /** Free-form instructions the user typed into Settings. */
    extraPrompt,
}) {
    const src = languageLabel(sourceLanguage || "") || "the source language";
    const tgt = languageLabel(targetLanguage) || targetLanguage;

    const numbered = (lines ?? [])
        .map((line, i) => `${i + 1}\t${String(line ?? "").trim()}`)
        .join("\n");

    const contextBlock =
        context && context.length
            ? `已经翻译好的前几句（仅供保持语气、术语与上下文一致，不要重复输出）：\n${context
                  .map(
                      (c) =>
                          `- ${String(c.text ?? "").trim()} → ${String(
                              c.trans ?? "",
                          ).trim()}`,
                  )
                  .join("\n")}\n\n`
            : "";

    const extra = String(extraPrompt ?? "").trim();
    const extraBlock = extra
        ? `用户补充要求（必须遵守，但不能破坏上面的输出格式）：\n${extra}\n\n`
        : "";

    return (
        `你是专业的字幕翻译引擎。请把下面编号的字幕从 ${src} 翻译成 ${tgt}。\n` +
        `严格要求：\n` +
        `1. 结合上下文（前后句）决定词义，保持语气、人名、术语全文一致；\n` +
        `2. 只输出翻译结果，每行格式为 "<序号>\\t<译文>"，共 ${
            (lines ?? []).length
        } 行；\n` +
        `3. 不要输出序号以外的任何解释、标题或代码块；\n` +
        `4. 保留原文的换行结构，不要合并或拆分行。\n\n` +
        contextBlock +
        extraBlock +
        `需要翻译的字幕：\n${numbered}`
    );
}

/** Parse `1\ttranslation` lines back into an ordered array. */
export function parseNumberedTranslations(raw, expected) {
    const lines = String(raw ?? "")
        .replace(/```[a-zA-Z]*\n?/g, "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    const byIndex = new Map();
    const rest = [];

    for (const line of lines) {
        const match = line.match(/^(\d+)\s*[.:、)│|\-\t]+\s*(.*)$/);
        if (match) {
            const index = Number(match[1]);
            const value = match[2].trim();
            if (index >= 1 && index <= expected && value) {
                byIndex.set(index, value);
                continue;
            }
        }
        rest.push(line);
    }

    const result = [];
    let restCursor = 0;
    for (let i = 1; i <= expected; i++) {
        const hit = byIndex.get(i);
        if (hit !== undefined) {
            result.push(hit);
            continue;
        }
        // Fall back to positional output when the model dropped the numbers.
        result.push(rest[restCursor++] ?? "");
    }
    return result;
}
