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
    // ---- m2m100 only (NLLB has no equivalent code in our table) ----
    { id: "ast", label: "Asturian", nllb: "" },
    { id: "ba", label: "Bashkir", nllb: "" },
    { id: "br", label: "Breton", nllb: "" },
    { id: "bs", label: "Bosnian", nllb: "" },
    { id: "ceb", label: "Cebuano", nllb: "" },
    { id: "cy", label: "Welsh", nllb: "" },
    { id: "fy", label: "West Frisian", nllb: "" },
    { id: "ga", label: "Irish", nllb: "" },
    { id: "gd", label: "Scottish Gaelic", nllb: "" },
    { id: "ht", label: "Haitian Creole", nllb: "" },
    { id: "ig", label: "Igbo", nllb: "" },
    { id: "ilo", label: "Ilocano", nllb: "" },
    { id: "jv", label: "Javanese", nllb: "" },
    { id: "lb", label: "Luxembourgish", nllb: "" },
    { id: "lg", label: "Ganda", nllb: "" },
    { id: "ln", label: "Lingala", nllb: "" },
    { id: "mg", label: "Malagasy", nllb: "" },
    { id: "ns", label: "Northern Sotho", nllb: "" },
    { id: "oc", label: "Occitan", nllb: "" },
    { id: "or", label: "Odia", nllb: "" },
    { id: "ps", label: "Pashto", nllb: "" },
    { id: "sd", label: "Sindhi", nllb: "" },
    { id: "ss", label: "Swati", nllb: "" },
    { id: "su", label: "Sundanese", nllb: "" },
    { id: "tn", label: "Tswana", nllb: "" },
    { id: "wo", label: "Wolof", nllb: "" },
    { id: "xh", label: "Xhosa", nllb: "" },
    { id: "yi", label: "Yiddish", nllb: "" },
    { id: "zu", label: "Zulu", nllb: "" },
];

/** True when the id must never be offered as a translation model. */
export function isBrokenTranslationModel(id) {
    return BROKEN_TRANSLATION_MODELS.includes(String(id ?? "").trim());
}

/**
 * Weights that are known to be broken under transformers.js. They used to be
 * offered as presets; now they are filtered out of every list (presets,
 * cached weights, upstream models) so nobody can pick them by accident.
 */
export const BROKEN_TRANSLATION_MODELS = [
    "Xenova/opus-mt-en-jap",
    "Xenova/opus-mt-en-ko",
    "Xenova/opus-mt-en-de",
    "Xenova/opus-mt-en-fr",
    "Xenova/opus-mt-en-es",
    "Xenova/opus-mt-en-ru",
];

/** m2m100 does **not** understand NLLB codes like `zho_Hans` — it wants plain
 * two letter codes (`zh`, `en`, `ja`). This maps our language ids onto the
 * 100 codes m2m100_418M accepts; an id missing here is simply not supported.
 */
const M2M100_CODES = {
    af: "af",
    am: "am",
    ar: "ar",
    az: "az",
    be: "be",
    bg: "bg",
    bn: "bn",
    ca: "ca",
    cs: "cs",
    da: "da",
    de: "de",
    el: "el",
    en: "en",
    es: "es",
    et: "et",
    fa: "fa",
    fi: "fi",
    fr: "fr",
    gl: "gl",
    gu: "gu",
    ha: "ha",
    he: "he",
    hi: "hi",
    hr: "hr",
    hu: "hu",
    hy: "hy",
    id: "id",
    is: "is",
    it: "it",
    ja: "ja",
    ka: "ka",
    kk: "kk",
    km: "km",
    kn: "kn",
    ko: "ko",
    lo: "lo",
    lt: "lt",
    lv: "lv",
    mk: "mk",
    ml: "ml",
    mn: "mn",
    mr: "mr",
    ms: "ms",
    my: "my",
    ne: "ne",
    nl: "nl",
    no: "no",
    pa: "pa",
    pl: "pl",
    pt: "pt",
    ro: "ro",
    ru: "ru",
    si: "si",
    sk: "sk",
    sl: "sl",
    sq: "sq",
    sr: "sr",
    sv: "sv",
    sw: "sw",
    ta: "ta",
    th: "th",
    tl: "tl",
    tr: "tr",
    uk: "uk",
    ur: "ur",
    uz: "uz",
    vi: "vi",
    yo: "yo",
    zh: "zh",
    // m2m100 only -------------------------------------------------------
    ast: "ast",
    ba: "ba",
    br: "br",
    bs: "bs",
    ceb: "ceb",
    cy: "cy",
    fy: "fy",
    ga: "ga",
    gd: "gd",
    ht: "ht",
    ig: "ig",
    ilo: "ilo",
    jv: "jv",
    lb: "lb",
    lg: "lg",
    ln: "ln",
    mg: "mg",
    ns: "ns",
    oc: "oc",
    or: "or",
    ps: "ps",
    sd: "sd",
    ss: "ss",
    su: "su",
    tn: "tn",
    wo: "wo",
    xh: "xh",
    yi: "yi",
    zu: "zu",
};

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

/** m2m100 style code for a language id (`zh` -> `zh`). "" when unsupported. */
export function m2mCode(id) {
    if (!id) return "";
    return M2M100_CODES[String(id)] ?? "";
}

/**
 * Which `src_lang` / `tgt_lang` dialect a model expects:
 *   - "nllb"    -> `zho_Hans`, `eng_Latn`, ... (NLLB)
 *   - "m2m100"  -> `zh`, `en`, ... (m2m100)
 *   - "none"    -> the model has a hard wired direction (opus-mt-*), passing
 *                  any language code makes it fail.
 */
export function modelCodeStyle(model) {
    const id = String(model ?? "").toLowerCase();
    if (!id) return "none";
    if (id.includes("nllb")) return "nllb";
    if (id.includes("m2m100") || id.includes("m2m_100")) return "m2m100";
    return "none";
}

/** Fallback code when the caller did not pick a language. */
export function defaultLanguageCode(model, role) {
    const style = modelCodeStyle(model);
    if (style === "m2m100") return role === "source" ? "en" : "zh";
    if (style === "nllb") return role === "source" ? "eng_Latn" : "zho_Hans";
    return "";
}

/**
 * The `src_lang` / `tgt_lang` value to pass for `model`.
 * Returns "" when the model takes no language code at all (opus-mt-*), or when
 * the language is unknown to that model family — the caller must then either
 * leave it out or report the mismatch.
 */
export function languageCodeFor(model, id) {
    const style = modelCodeStyle(model);
    if (style === "none") return "";
    return style === "m2m100" ? m2mCode(id) : nllbCode(id);
}

/** Language ids `model` can translate into ("" for opus-mt-* style guesses). */
export function supportedTargetIds(model) {
    return targetLanguagesForModel(model).map((language) => language.id);
}

/**
 * `opus-mt-en-zh` only does English → Chinese, so its target list is a single
 * language. Returns null for models with no fixed direction.
 */
export function fixedPairLanguages(model) {
    const name = String(model ?? "").split("/").pop() ?? "";
    if (!/opus|marian/i.test(name)) return null;

    const tokens = name.toLowerCase().split(/[-_.]+/).filter(Boolean);
    if (tokens.length < 3) return null;
    const [, srcRaw, tgtRaw] = tokens.slice(-3);
    const normalize = (code) =>
        OPUS_CODE_ALIASES[code] ??
        (TRANSLATION_LANGUAGES.some((language) => language.id === code)
            ? code
            : "");
    const src = normalize(srcRaw);
    const tgt = normalize(tgtRaw);
    if (!src || !tgt) return null;
    return { src, tgt };
}

/** Marian / opus-mt use a mix of ISO 639-1 and 639-3 codes. */
const OPUS_CODE_ALIASES = {
    cmn: "zh",
    zho: "zh",
    chi: "zh",
    jpn: "ja",
    jap: "ja",
    kor: "ko",
    deu: "de",
    ger: "de",
    fra: "fr",
    fre: "fr",
    spa: "es",
    rus: "ru",
    por: "pt",
    nld: "nl",
    dut: "nl",
    ita: "it",
    ara: "ar",
    arb: "ar",
    eng: "en",
};

/**
 * Options for the "Translate subtitles into" dropdown: they depend on the
 * selected model (nllb 200 codes / m2m100 100 codes / one fixed language for
 * opus-mt-*). LLM ("api") engines take any language name.
 */
export function targetLanguagesForModel(model, engine) {
    if (!model || String(engine ?? "").toLowerCase() === "api") {
        return TRANSLATION_LANGUAGES;
    }

    const fixed = fixedPairLanguages(model);
    if (fixed) {
        return TRANSLATION_LANGUAGES.filter(
            (language) => language.id === fixed.tgt,
        );
    }

    const style = modelCodeStyle(model);
    if (style === "nllb") {
        return TRANSLATION_LANGUAGES.filter((language) => !!language.nllb);
    }
    if (style === "m2m100") {
        return TRANSLATION_LANGUAGES.filter((language) => !!m2mCode(language.id));
    }
    // Unknown model: do not restrict anything.
    return TRANSLATION_LANGUAGES;
}

/** Only NLLB / m2m100 accept `src_lang` / `tgt_lang`. */
export function needsLanguageCodes(model) {
    return modelCodeStyle(model) !== "none";
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
