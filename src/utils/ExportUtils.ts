import { Chunk } from "../hooks/useTranscriber";
import { exportContent } from "./ExportFormats.js";

/** The three formats the UI can export and the API can return. */
export type ExportFormat = "txt" | "srt" | "json";
export const EXPORT_FORMATS: ExportFormat[] = ["txt", "srt", "json"];

export {
    chunksToText,
    chunksToSRT,
    chunksToJSON,
    formatSrtTimestamp,
} from "./ExportFormats.js";

/** Trigger a browser download for the given blob. */
export function saveBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

/** Remove the extension (and any leading path) from a file name. */
export function baseFilename(name: string) {
    const withoutPath = name.replace(/^.*[\\/]/, "");
    return withoutPath.replace(/\.[^.]+$/, "") || "transcript";
}

/** Export a single transcript as txt / srt / json. */
export function exportChunks(
    chunks: Chunk[],
    name: string,
    format: ExportFormat,
) {
    const base = baseFilename(name);
    const { body, mime, ext } = exportContent(chunks ?? [], format);
    saveBlob(new Blob([body], { type: mime }), `${base}.${ext}`);
}

/** Export a list of transcripts, one download per file. */
export function exportAll(
    entries: { name: string; chunks: Chunk[] }[],
    format: ExportFormat,
) {
    entries.forEach((entry, i) => {
        // Stagger downloads so browsers do not block the burst
        setTimeout(
            () => exportChunks(entry.chunks, entry.name, format),
            i * 400,
        );
    });
}
