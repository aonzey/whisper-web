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

/** Merge every chunk into a single plain-text transcript. */
export function chunksToText(chunks) {
    return (chunks || [])
        .map((chunk) => chunk.text ?? "")
        .join("")
        .trim();
}

/** Serialize chunks to a SubRip (.srt) subtitle file. */
export function chunksToSRT(chunks) {
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
            const text = String(chunk.text ?? "").trim();
            return `${i + 1}\n${formatSrtTimestamp(
                start,
            )} --> ${formatSrtTimestamp(Math.max(end, start))}\n${text}\n`;
        })
        .join("\n");
}

/**
 * Serialize chunks to JSON. Every chunk carries an extra (empty) `trans`
 * field which is reserved for a manual/translated version of the line.
 */
export function chunksToJSON(chunks) {
    const data = (chunks || []).map((chunk) => ({
        timestamp: chunk.timestamp ?? [0, null],
        text: chunk.text ?? "",
        trans: chunk.trans ?? "",
    }));

    let jsonData = JSON.stringify(data, null, 2);

    // post-process the JSON so that `[ 0, 8 ]` stays on a single line
    const regex = /( {4}"timestamp": )\[\s+(\S+)\s+(\S+)\s+\]/gm;
    return jsonData.replace(regex, "$1[$2 $3]");
}

/** Body, mime type and file extension of one export format. */
export function exportContent(chunks, format) {
    switch (String(format || "").toLowerCase()) {
        case "txt":
            return {
                body: chunksToText(chunks),
                mime: "text/plain; charset=utf-8",
                ext: "txt",
            };
        case "srt":
            return {
                body: chunksToSRT(chunks),
                mime: "application/x-subrip; charset=utf-8",
                ext: "srt",
            };
        default:
            return {
                body: chunksToJSON(chunks),
                mime: "application/json; charset=utf-8",
                ext: "json",
            };
    }
}
