/**
 * Shared export helpers.
 *
 * This file is plain ESM JavaScript so that it can be imported by both
 *   - the browser app (TypeScript / Vite)  -> src/utils/ExportUtils.ts
 *   - the Node API server                  -> server/index.js
 * That way `response_format=txt|srt|json` on the API is byte-identical to
 * what the "Export TXT / SRT / JSON" buttons produce in the UI.
 *
 * Keep it dependency free and runtime agnostic.
 */

/** The three export formats supported by the UI and the API. */
export const EXPORT_FORMATS = ["txt", "srt", "json"];

function pad(time) {
    return String(time).padStart(2, "0");
}

/** `HH:MM:SS` (hours omitted when zero) — used by the transcript list. */
export function formatAudioTimestamp(time) {
    const hours = (time / (60 * 60)) | 0;
    time -= hours * (60 * 60);
    const minutes = (time / 60) | 0;
    time -= minutes * 60;
    const seconds = time | 0;
    return `${hours ? pad(hours) + ":" : ""}${pad(minutes)}:${pad(seconds)}`;
}

/** `HH:MM:SS,mmm` — the SubRip timestamp format. */
export function formatSrtTimestamp(time) {
    const value = Number.isFinite(time) && time > 0 ? time : 0;
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    let seconds = Math.floor(value % 60);
    let ms = Math.round((value - Math.floor(value)) * 1000);
    if (ms === 1000) {
        // `9.9996` rounds up to 1000ms — carry it into the seconds instead
        ms = 0;
        seconds += 1;
    }
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${String(ms).padStart(
        3,
        "0",
    )}`;
}

/** Does any chunk carry a translation? */
export function isBilingual(chunks) {
    return (chunks || []).some(
        (chunk) => String(chunk?.trans ?? "").trim().length > 0,
    );
}

function lineOf(chunk, bilingual) {
    const text = String(chunk?.text ?? "");
    if (!bilingual) return text;
    const trans = String(chunk?.trans ?? "").trim();
    return trans ? `${text.trim()}\n${trans}` : text.trim();
}

/**
 * Merge every chunk into a plain-text transcript.
 * With `bilingual` each source line is followed by its translation.
 */
export function chunksToText(chunks, options) {
    const bilingual = Boolean(options?.bilingual);
    const list = chunks || [];
    return list
        .map((chunk) => lineOf(chunk, bilingual))
        .join(bilingual ? "\n" : "")
        .trim();
}

/**
 * Serialize chunks to a SubRip (.srt) subtitle file.
 * With `bilingual` every cue holds the original line plus its translation.
 */
export function chunksToSRT(chunks, options) {
    const bilingual = Boolean(options?.bilingual);
    const list = chunks || [];
    return list
        .map((chunk, i) => {
            const start = chunk.timestamp?.[0] ?? 0;
            // The last chunk of a browser transcription has no end timestamp:
            // fall back to the next chunk's start, then to a 2s window.
            const end =
                chunk.timestamp?.[1] ??
                list[i + 1]?.timestamp?.[0] ??
                start + 2;
            const text = lineOf(chunk, bilingual).trim();
            return `${i + 1}\n${formatSrtTimestamp(
                start,
            )} --> ${formatSrtTimestamp(Math.max(end, start))}\n${text}\n`;
        })
        .join("\n");
}

/**
 * Serialize chunks to JSON. Every chunk carries an extra (empty) `trans`
 * field which is reserved for a manual/translated version of the line.
 *
 * `options.bilingual === false` drops the field entirely, so the export
 * matches the "原文 only" variant of txt / srt.
 */
export function chunksToJSON(chunks, options) {
    const withTrans = options?.bilingual !== false;
    const data = (chunks || []).map((chunk) => {
        const entry = {
            timestamp: chunk.timestamp ?? [0, null],
            text: chunk.text ?? "",
        };
        if (withTrans) entry.trans = chunk.trans ?? "";
        return entry;
    });

    let jsonData = JSON.stringify(data, null, 2);

    // post-process the JSON so that `[ 0, 8 ]` stays on a single line
    const regex = /( {4}"timestamp": )\[\s+(\S+)\s+(\S+)\s+\]/gm;
    return jsonData.replace(regex, "$1[$2 $3]");
}

/**
 * Body, mime type and file extension of one export format.
 * `options.bilingual` puts the translation next to every source line.
 */
export function exportContent(chunks, format, options) {
    switch (String(format || "").toLowerCase()) {
        case "txt":
            return {
                body: chunksToText(chunks, options),
                mime: "text/plain; charset=utf-8",
                ext: "txt",
            };
        case "srt":
            return {
                body: chunksToSRT(chunks, options),
                mime: "application/x-subrip; charset=utf-8",
                ext: "srt",
            };
        default:
            return {
                body: chunksToJSON(chunks, options),
                mime: "application/json; charset=utf-8",
                ext: "json",
            };
    }
}
