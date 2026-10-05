import { useEffect, useMemo, useRef } from "react";

import { TranscriberData } from "../hooks/useTranscriber";
import { formatAudioTimestamp } from "../utils/AudioUtils";
import { exportChunks } from "../utils/ExportUtils";

interface Props {
    transcribedData: TranscriberData | undefined;
    /** Used as the base name of the exported files. */
    fileName?: string;
    /** Current playback position in seconds. */
    currentTime?: number;
    /** Seek the audio element (called when a subtitle line is clicked). */
    onSeek?: (time: number) => void;
}

/** Index of the chunk that covers `time` (-1 when none). */
function activeChunkIndex(
    chunks: { timestamp: [number, number | null] }[],
    time: number,
) {
    if (!chunks?.length) return -1;
    for (let i = 0; i < chunks.length; i++) {
        const start = chunks[i].timestamp?.[0] ?? 0;
        const end =
            chunks[i].timestamp?.[1] ?? chunks[i + 1]?.timestamp?.[0] ?? null;
        if (time >= start && (end === null || time < end)) return i;
    }
    // Past the last cue: keep the last one highlighted.
    const lastStart = chunks[chunks.length - 1].timestamp?.[0] ?? 0;
    if (time >= lastStart) return chunks.length - 1;
    return -1;
}

export default function Transcript({
    transcribedData,
    fileName,
    currentTime,
    onSeek,
}: Props) {
    const divRef = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

    const chunks = transcribedData?.chunks ?? [];
    const bilingual = Boolean(
        transcribedData?.bilingual &&
            chunks.some((chunk) => String(chunk.trans ?? "").trim().length > 0),
    );

    const exportAs = (format: "txt" | "srt" | "json") => {
        exportChunks(chunks, fileName ?? "transcript", format, { bilingual });
    };

    const activeIndex = useMemo(
        () => activeChunkIndex(chunks, currentTime ?? -1),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [chunks, currentTime],
    );

    // Follow the audio: scroll the highlighted line into view.
    useEffect(() => {
        if (activeIndex < 0) return;
        if (transcribedData?.isBusy) return;
        const node = itemRefs.current[activeIndex];
        if (node) {
            node.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
    }, [activeIndex, transcribedData?.isBusy]);

    // While the transcript streams in, keep the newest line visible.
    useEffect(() => {
        if (!divRef.current || !transcribedData?.isBusy) return;
        const el = divRef.current;
        const diff = Math.abs(el.offsetHeight + el.scrollTop - el.scrollHeight);
        if (diff <= 64) {
            el.scrollTop = el.scrollHeight;
        }
    }, [chunks.length, transcribedData?.isBusy]);

    return (
        <div
            ref={divRef}
            className='w-full flex flex-col my-2 p-4 max-h-[20rem] overflow-y-auto'
        >
            {bilingual && (
                <div className='w-full mb-2 text-xs text-slate-500'>
                    双语字幕：点任意一行可跳转到该句播放；播放时会自动滚动并高亮当前句。
                </div>
            )}
            {chunks.map((chunk, i) => {
                const active = i === activeIndex;
                return (
                    <div
                        key={`${i}-${chunk.text}`}
                        ref={(node) => {
                            itemRefs.current[i] = node;
                        }}
                        onClick={() => onSeek?.(chunk.timestamp?.[0] ?? 0)}
                        className={`w-full flex flex-row mb-2 rounded-lg p-4 shadow-xl shadow-black/5 ring-1 cursor-pointer transition-colors ${
                            active
                                ? "bg-indigo-50 ring-indigo-400"
                                : "bg-white ring-slate-700/10 hover:bg-slate-50"
                        }`}
                    >
                        <div
                            className={`mr-5 ${
                                active
                                    ? "text-indigo-600 font-semibold"
                                    : "text-slate-500"
                            }`}
                        >
                            {formatAudioTimestamp(chunk.timestamp[0])}
                        </div>
                        <div className='flex-1'>
                            <div
                                className={
                                    active ? "text-slate-900" : "text-slate-700"
                                }
                            >
                                {chunk.text}
                            </div>
                            {bilingual && (
                                <div className='mt-1 text-slate-500'>
                                    {chunk.trans}
                                </div>
                            )}
                        </div>
                    </div>
                );
            })}
            {transcribedData && !transcribedData.isBusy && (
                <div className='w-full text-right'>
                    <button
                        onClick={() => exportAs("txt")}
                        className='text-white bg-green-500 hover:bg-green-600 focus:ring-4 focus:ring-green-300 font-medium rounded-lg text-sm px-4 py-2 text-center mr-2 dark:bg-green-600 dark:hover:bg-green-700 dark:focus:ring-green-800 inline-flex items-center'
                    >
                        Export TXT
                    </button>
                    <button
                        onClick={() => exportAs("srt")}
                        className='text-white bg-green-500 hover:bg-green-600 focus:ring-4 focus:ring-green-300 font-medium rounded-lg text-sm px-4 py-2 text-center mr-2 dark:bg-green-600 dark:hover:bg-green-700 dark:focus:ring-green-800 inline-flex items-center'
                    >
                        Export SRT
                    </button>
                    <button
                        onClick={() => exportAs("json")}
                        className='text-white bg-green-500 hover:bg-green-600 focus:ring-4 focus:ring-green-300 font-medium rounded-lg text-sm px-4 py-2 text-center mr-2 dark:bg-green-600 dark:hover:bg-green-700 dark:focus:ring-green-800 inline-flex items-center'
                    >
                        Export JSON
                    </button>
                    {bilingual && (
                        <div className='mt-1 text-xs text-slate-400'>
                            TXT / SRT 导出包含原文与译文（文件名带
                            .bilingual），JSON 中每句带 trans 字段。
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
