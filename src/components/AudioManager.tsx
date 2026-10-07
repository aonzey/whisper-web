import React, { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import Modal from "./modal/Modal";
import { UrlInput } from "./modal/UrlInput";
import AudioPlayer from "./AudioPlayer";
import { TranscribeButton } from "./TranscribeButton";
import Constants from "../utils/Constants";
import { Chunk, Engine, Transcriber } from "../hooks/useTranscriber";
import Progress from "./Progress";
import AudioRecorder from "./AudioRecorder";
import { formatAudioTimestamp } from "../utils/AudioUtils";
import { exportAll } from "../utils/ExportUtils";
import {
    TRANSLATION_API_MODELS,
    TRANSLATION_MODELS,
    TranslationEngine,
    fixedPairLanguages,
    isBrokenTranslationModel,
    languageCodeFor,
    languageLabel,
    modelCodeStyle,
    targetLanguagesForModel,
} from "../utils/TranslationClient";
import {
    checkApiHealth,
    fetchApiModels,
    classifyApiBase,
    describeApiTarget,
    listBrowserCachedModels,
    SELF_API_BASE,
    ApiModelOption,
} from "../utils/ApiClient";

function titleCase(str: string) {
    str = str.toLowerCase();
    return (str.match(/\w+.?/g) || [])
        .map((word) => {
            return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join("");
}

// List of supported languages:
// https://help.openai.com/en/articles/7031512-whisper-api-faq
// https://github.com/openai/whisper/blob/248b6cb124225dd263bb9bd32d060b6517e067f8/whisper/tokenizer.py#L79
const LANGUAGES = {
    en: "english",
    zh: "chinese",
    de: "german",
    es: "spanish/castilian",
    ru: "russian",
    ko: "korean",
    fr: "french",
    ja: "japanese",
    pt: "portuguese",
    tr: "turkish",
    pl: "polish",
    ca: "catalan/valencian",
    nl: "dutch/flemish",
    ar: "arabic",
    sv: "swedish",
    it: "italian",
    id: "indonesian",
    hi: "hindi",
    fi: "finnish",
    vi: "vietnamese",
    he: "hebrew",
    uk: "ukrainian",
    el: "greek",
    ms: "malay",
    cs: "czech",
    ro: "romanian/moldavian/moldovan",
    da: "danish",
    hu: "hungarian",
    ta: "tamil",
    no: "norwegian",
    th: "thai",
    ur: "urdu",
    hr: "croatian",
    bg: "bulgarian",
    lt: "lithuanian",
    la: "latin",
    mi: "maori",
    ml: "malayalam",
    cy: "welsh",
    sk: "slovak",
    te: "telugu",
    fa: "persian",
    lv: "latvian",
    bn: "bengali",
    sr: "serbian",
    az: "azerbaijani",
    sl: "slovenian",
    kn: "kannada",
    et: "estonian",
    mk: "macedonian",
    br: "breton",
    eu: "basque",
    is: "icelandic",
    hy: "armenian",
    ne: "nepali",
    mn: "mongolian",
    bs: "bosnian",
    kk: "kazakh",
    sq: "albanian",
    sw: "swahili",
    gl: "galician",
    mr: "marathi",
    pa: "punjabi/panjabi",
    si: "sinhala/sinhalese",
    km: "khmer",
    sn: "shona",
    yo: "yoruba",
    so: "somali",
    af: "afrikaans",
    oc: "occitan",
    ka: "georgian",
    be: "belarusian",
    tg: "tajik",
    sd: "sindhi",
    gu: "gujarati",
    am: "amharic",
    yi: "yiddish",
    lo: "lao",
    uz: "uzbek",
    fo: "faroese",
    ht: "haitian creole/haitian",
    ps: "pashto/pushto",
    tk: "turkmen",
    nn: "nynorsk",
    mt: "maltese",
    sa: "sanskrit",
    lb: "luxembourgish/letzeburgesch",
    my: "myanmar/burmese",
    bo: "tibetan",
    tl: "tagalog",
    mg: "malagasy",
    as: "assamese",
    tt: "tatar",
    haw: "hawaiian",
    ln: "lingala",
    ha: "hausa",
    ba: "bashkir",
    jw: "javanese",
    su: "sundanese",
};

export enum AudioSource {
    URL = "URL",
    FILE = "FILE",
    RECORDING = "RECORDING",
}

interface AudioItem {
    id: string;
    /** File name, or the path relative to the picked folder. */
    name: string;
    buffer: AudioBuffer;
    url: string;
    source: AudioSource;
    mimeType: string;
    /** Original file, kept so the API engine can upload it untouched. */
    file?: Blob;
    status: "pending" | "done" | "error";
    result?: { text: string; chunks: Chunk[] };
}

const AUDIO_EXTENSION =
    /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba|webm|mp4|mpeg|mpga|aiff|aif|wma)$/i;

function isProbablyAudio(file: File) {
    return (
        file.type.startsWith("audio/") ||
        file.type.startsWith("video/") ||
        AUDIO_EXTENSION.test(file.name)
    );
}

let idCounter = 0;
function makeId(prefix: string) {
    return `${prefix}-${Date.now()}-${idCounter++}`;
}

function nameFromUrl(url: string) {
    try {
        const path = new URL(url).pathname;
        return decodeURIComponent(path.split("/").pop() || "audio");
    } catch (e) {
        return "audio";
    }
}

export function AudioManager(props: {
    transcriber: Transcriber;
    onSelectedFileChange?: (name: string | undefined) => void;
    /** Shared audio element so the subtitle list can follow playback. */
    audioRef?: React.MutableRefObject<HTMLAudioElement | null>;
    onTimeUpdate?: (time: number) => void;
}) {
    const [progress, setProgress] = useState<number | undefined>(undefined);
    const [items, setItems] = useState<AudioItem[]>([]);
    const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
    const [batch, setBatch] = useState<
        { index: number; total: number } | undefined
    >(undefined);
    const [audioDownloadUrl, setAudioDownloadUrl] = useState<
        string | undefined
    >(undefined);

    const itemsRef = useRef<AudioItem[]>([]);
    const selectedIdRef = useRef<string | undefined>(undefined);
    const batchRef = useRef<
        | { running: boolean; index: number; ids: string[]; bilingual: boolean }
        | undefined
    >(undefined);
    /** Does the current run also translate (Bilingual subtitles)? */
    const batchBilingualRef = useRef(false);
    const lastOutputRef = useRef<unknown>(undefined);

    useEffect(() => {
        itemsRef.current = items;
    }, [items]);
    useEffect(() => {
        selectedIdRef.current = selectedId;
    }, [selectedId]);

    const audioData = items.find((item) => item.id === selectedId);
    const isAudioLoading = progress !== undefined;

    const updateItems = useCallback(
        (updater: (prev: AudioItem[]) => AudioItem[]) => {
            setItems((prev) => {
                const next = updater(prev);
                const ids = new Set(next.map((item) => item.id));
                prev.forEach((item) => {
                    if (!ids.has(item.id)) URL.revokeObjectURL(item.url);
                });
                return next;
            });
        },
        [],
    );

    const resetAudio = () => {
        batchRef.current = undefined;
        batchBilingualRef.current = false;
        lastOutputRef.current = undefined;
        setBatch(undefined);
        setSelectedId(undefined);
        selectedIdRef.current = undefined;
        updateItems(() => []);
        props.transcriber.onInputChange();
        props.onSelectedFileChange?.(undefined);
    };

    const selectItem = (id: string) => {
        if (props.transcriber.isBusy) return;
        setSelectedId(id);
        selectedIdRef.current = id;
        const item = itemsRef.current.find((i) => i.id === id);
        if (item?.result) {
            lastOutputRef.current = undefined;
            props.transcriber.setOutput({
                isBusy: false,
                text: item.result.text,
                chunks: item.result.chunks,
            });
        } else {
            props.transcriber.onInputChange();
        }
        props.onSelectedFileChange?.(item?.name);
    };

    const addSingle = (item: AudioItem) => {
        batchRef.current = undefined;
        batchBilingualRef.current = false;
        lastOutputRef.current = undefined;
        setBatch(undefined);
        updateItems(() => [item]);
        setSelectedId(item.id);
        selectedIdRef.current = item.id;
        props.onSelectedFileChange?.(item.name);
    };

    const startTranscribe = (item: AudioItem) => {
        lastOutputRef.current = undefined;
        props.transcriber.start(item.buffer, item.file, item.name, {
            bilingual: batchBilingualRef.current,
        });
    };

    /**
     * A file that already carries a transcript does not need the (expensive)
     * ASR pass again — just translate what is there.
     */
    const hasTranscript = (item?: AudioItem) =>
        (item?.result?.chunks ?? []).some(
            (chunk) => String(chunk.text ?? "").trim().length > 0,
        );

    const startTranslateOnly = (item: AudioItem) => {
        setSelectedId(item.id);
        selectedIdRef.current = item.id;
        props.onSelectedFileChange?.(item.name);
        props.transcriber.translateExisting(item.result?.chunks);
    };

    /** Start (or continue) the queue at `index`. */
    const runStep = (index: number) => {
        const currentBatch = batchRef.current;
        if (!currentBatch) return;
        const id = currentBatch.ids[index];
        const item = itemsRef.current.find((entry) => entry.id === id);
        if (!item) return;
        currentBatch.index = index;
        setBatch({ index, total: currentBatch.ids.length });
        setSelectedId(id);
        selectedIdRef.current = id;
        props.onSelectedFileChange?.(item.name);
        if (currentBatch.bilingual && hasTranscript(item)) {
            startTranslateOnly(item);
        } else {
            startTranscribe(item);
        }
    };

    // Handle a finished transcription: store the result and (in batch mode)
    // move on to the next file. In bilingual mode we wait for the translation
    // step to complete first.
    useEffect(() => {
        const output = props.transcriber.output;
        if (!output || output.isBusy || props.transcriber.isBusy) return;
        // A bilingual run is only finished once `bilingual` is set.
        if (batchBilingualRef.current && !output.bilingual) return;
        if (lastOutputRef.current === output) return;
        lastOutputRef.current = output;

        const result = { text: output.text, chunks: output.chunks };
        const currentBatch = batchRef.current;

        if (currentBatch && currentBatch.running) {
            const id = currentBatch.ids[currentBatch.index];
            if (id) {
                updateItems((prev) =>
                    prev.map((item) =>
                        item.id === id
                            ? { ...item, status: "done", result }
                            : item,
                    ),
                );
            }
            const next = currentBatch.index + 1;
            if (next < currentBatch.ids.length) {
                runStep(next);
            } else {
                batchRef.current = undefined;
                setBatch(undefined);
            }
        } else {
            const id = selectedIdRef.current;
            if (id) {
                updateItems((prev) =>
                    prev.map((item) =>
                        item.id === id
                            ? { ...item, status: "done", result }
                            : item,
                    ),
                );
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.transcriber.output, props.transcriber.isBusy]);

    const setAudioFromDownload = async (
        data: ArrayBuffer,
        mimeType: string,
    ) => {
        const audioCTX = new AudioContext({
            sampleRate: Constants.SAMPLING_RATE,
        });
        const blobUrl = URL.createObjectURL(
            new Blob([data], { type: "audio/*" }),
        );
        const decoded = await audioCTX.decodeAudioData(data);
        addSingle({
            id: makeId("url"),
            name: nameFromUrl(audioDownloadUrl ?? ""),
            buffer: decoded,
            url: blobUrl,
            source: AudioSource.URL,
            mimeType: mimeType,
            status: "pending",
        });
    };

    const setAudioFromRecording = async (data: Blob) => {
        setProgress(0);
        const blobUrl = URL.createObjectURL(data);
        const fileReader = new FileReader();
        fileReader.onprogress = (event) => {
            setProgress(event.loaded / event.total || 0);
        };
        fileReader.onloadend = async () => {
            const audioCTX = new AudioContext({
                sampleRate: Constants.SAMPLING_RATE,
            });
            const arrayBuffer = fileReader.result as ArrayBuffer;
            const decoded = await audioCTX.decodeAudioData(arrayBuffer);
            setProgress(undefined);
            addSingle({
                id: makeId("recording"),
                name: `recording-${new Date()
                    .toISOString()
                    .replace(/[:.]/g, "-")}.wav`,
                buffer: decoded,
                url: blobUrl,
                source: AudioSource.RECORDING,
                mimeType: data.type,
                file: data,
                status: "pending",
            });
        };
        fileReader.readAsArrayBuffer(data);
    };

    const handleFiles = async (files: File[]) => {
        const candidates = files.filter(isProbablyAudio);
        if (candidates.length === 0) {
            alert("没有找到可解码的音频文件。");
            return;
        }

        batchRef.current = undefined;
        batchBilingualRef.current = false;
        lastOutputRef.current = undefined;
        setBatch(undefined);
        props.transcriber.onInputChange();

        setProgress(0);
        const audioCTX = new AudioContext({
            sampleRate: Constants.SAMPLING_RATE,
        });
        const decodedItems: AudioItem[] = [];

        for (let i = 0; i < candidates.length; ++i) {
            const file = candidates[i];
            setProgress(i / candidates.length);
            try {
                const arrayBuffer = await file.arrayBuffer();
                const decoded = await audioCTX.decodeAudioData(arrayBuffer);
                decodedItems.push({
                    id: makeId("file"),
                    name:
                        (file as File & { webkitRelativePath?: string })
                            .webkitRelativePath || file.name,
                    buffer: decoded,
                    url: URL.createObjectURL(file),
                    source: AudioSource.FILE,
                    mimeType: file.type || "audio/*",
                    file: file,
                    status: "pending",
                });
            } catch (error) {
                console.warn(`Failed to decode "${file.name}"`, error);
            }
        }
        setProgress(undefined);

        if (decodedItems.length === 0) {
            alert("所选文件都无法解码，请检查格式是否为浏览器支持的音频。");
            return;
        }

        updateItems((prev) => [...prev, ...decodedItems]);
        setSelectedId((current) => current ?? decodedItems[0].id);
        if (!selectedIdRef.current) {
            selectedIdRef.current = decodedItems[0].id;
            props.onSelectedFileChange?.(decodedItems[0].name);
        }
    };

    const removeItem = (id: string) => {
        if (props.transcriber.isBusy) return;
        updateItems((prev) => prev.filter((item) => item.id !== id));
        if (selectedId === id) {
            setSelectedId(undefined);
            selectedIdRef.current = undefined;
            props.transcriber.onInputChange();
            props.onSelectedFileChange?.(undefined);
        }
    };

    const downloadAudioFromUrl = async (
        requestAbortController: AbortController,
    ) => {
        if (audioDownloadUrl) {
            try {
                setProgress(0);
                const { data, headers } = (await axios.get(audioDownloadUrl, {
                    signal: requestAbortController.signal,
                    responseType: "arraybuffer",
                    onDownloadProgress(progressEvent) {
                        setProgress(progressEvent.progress || 0);
                    },
                })) as {
                    data: ArrayBuffer;
                    headers: { "content-type": string };
                };

                let mimeType = headers["content-type"];
                if (!mimeType || mimeType === "audio/wave") {
                    mimeType = "audio/wav";
                }
                setAudioFromDownload(data, mimeType);
            } catch (error) {
                console.log("Request failed or aborted", error);
            } finally {
                setProgress(undefined);
            }
        }
    };

    // When URL changes, download audio
    useEffect(() => {
        if (audioDownloadUrl) {
            const requestAbortController = new AbortController();
            downloadAudioFromUrl(requestAbortController);
            return () => {
                requestAbortController.abort();
            };
        }
    }, [audioDownloadUrl]);

    const runTranscribeQueue = () => {
        const list = items.filter((item) => item.status !== "error");
        if (list.length === 0) return;

        batchBilingualRef.current = false;

        if (list.length === 1) {
            startTranscribe(list[0]);
            return;
        }

        // Batch mode: transcribe every file one after another
        batchRef.current = {
            running: true,
            index: 0,
            ids: list.map((item) => item.id),
            bilingual: false,
        };
        runStep(0);
    };

    /**
     * "Bilingual subtitles": reuse an existing transcript when there is one and
     * only run the translation step. Files without a result still go through
     * the normal transcribe → translate pipeline.
     */
    const runBilingualQueue = () => {
        const list = items.filter((item) => item.status !== "error");
        if (list.length === 0) return;

        batchBilingualRef.current = true;

        // Single file that is already transcribed: translate in place.
        if (list.length === 1 && hasTranscript(list[0])) {
            batchRef.current = undefined;
            setBatch(undefined);
            startTranslateOnly(list[0]);
            return;
        }

        batchRef.current = {
            running: true,
            index: 0,
            ids: list.map((item) => item.id),
            bilingual: true,
        };
        runStep(0);
    };

    const onTranscribeClick = () => runTranscribeQueue();
    const onBilingualClick = () => runBilingualQueue();

    const doneItems = items.filter((item) => item.result);
    // Any stored result that carries a translation is exported bilingually.
    const anyBilingual = doneItems.some((item) =>
        (item.result?.chunks ?? []).some(
            (chunk) => String(chunk.trans ?? "").trim().length > 0,
        ),
    );

    const exportAllAs = (format: "json" | "txt" | "srt") => {
        exportAll(
            doneItems.map((item) => ({
                name: item.name,
                chunks: item.result?.chunks ?? [],
            })),
            format,
            { bilingual: anyBilingual },
        );
    };

    const transcribeProgress = props.transcriber.output?.progress;
    const uploadProgress = props.transcriber.uploadProgress;
    // "browser" runs the model in a web worker, everything else talks to the
    // Node API (either the server's local engine or an OpenAI compatible one).
    const usesServer = props.transcriber.engine !== "browser";
    const progressValue = usesServer
        ? uploadProgress
        : transcribeProgress?.value;

    const translateProgress = props.transcriber.translationProgress;
    const translationProgressValue =
        translateProgress && translateProgress.total > 0
            ? translateProgress.done / translateProgress.total
            : undefined;

    let progressText = "";
    if (props.transcriber.isTranslating) {
        progressText = `Translating... ${translateProgress?.done ?? 0}/${
            translateProgress?.total ?? "?"
        }`;
    } else if (props.transcriber.isModelLoading) {
        progressText = "Loading model files... (only run once)";
    } else if (usesServer) {
        progressText =
            uploadProgress !== undefined && uploadProgress < 1
                ? `Uploading... ${Math.round(uploadProgress * 100)}%`
                : "Transcribing on the server...";
    } else if (transcribeProgress) {
        progressText = `${formatAudioTimestamp(
            transcribeProgress.processed,
        )} / ${formatAudioTimestamp(transcribeProgress.total)} · chunk ${
            transcribeProgress.chunksDone
        }/${transcribeProgress.chunksTotal}`;
    }

    return (
        <>
            <div className='flex flex-col justify-center items-center rounded-lg bg-white shadow-xl shadow-black/5 ring-1 ring-slate-700/10'>
                <div className='flex flex-row space-x-2 py-2 w-full px-2'>
                    <UrlTile
                        icon={<AnchorIcon />}
                        text={"From URL"}
                        onUrlUpdate={(e) => {
                            props.transcriber.onInputChange();
                            setAudioDownloadUrl(e);
                        }}
                    />
                    <VerticalBar />
                    <FileTile
                        icon={<FolderIcon />}
                        text={"From file"}
                        onFilesUpdate={(files) => {
                            props.transcriber.onInputChange();
                            handleFiles(files);
                        }}
                    />
                    {navigator.mediaDevices && (
                        <>
                            <VerticalBar />
                            <RecordTile
                                icon={<MicrophoneIcon />}
                                text={"Record"}
                                setAudioData={(e) => {
                                    props.transcriber.onInputChange();
                                    setAudioFromRecording(e);
                                }}
                            />
                        </>
                    )}
                    {items.length > 0 && (
                        <>
                            <VerticalBar />
                            <Tile
                                icon={<TrashIcon />}
                                text={"Clear"}
                                onClick={resetAudio}
                            />
                        </>
                    )}
                </div>
                {
                    <AudioDataBar
                        progress={isAudioLoading ? progress : +!!audioData}
                    />
                }
            </div>

            {items.length > 1 && (
                <div className='w-full mt-2 p-2 bg-white shadow-xl shadow-black/5 ring-1 ring-slate-700/10 rounded-lg'>
                    <div className='flex flex-wrap justify-between items-center px-2 pb-2 text-sm text-slate-600'>
                        <span>
                            {items.length} files · {doneItems.length}{" "}
                            transcribed
                        </span>
                        <span className='flex space-x-2'>
                            <button
                                disabled={doneItems.length === 0}
                                onClick={() => exportAllAs("json")}
                                className='text-white bg-green-500 hover:bg-green-600 disabled:bg-gray-300 font-medium rounded-lg text-xs px-3 py-1.5'
                            >
                                Export All JSON
                            </button>
                            <button
                                disabled={doneItems.length === 0}
                                onClick={() => exportAllAs("txt")}
                                className='text-white bg-green-500 hover:bg-green-600 disabled:bg-gray-300 font-medium rounded-lg text-xs px-3 py-1.5'
                            >
                                Export All TXT
                            </button>
                            <button
                                disabled={doneItems.length === 0}
                                onClick={() => exportAllAs("srt")}
                                className='text-white bg-green-500 hover:bg-green-600 disabled:bg-gray-300 font-medium rounded-lg text-xs px-3 py-1.5'
                            >
                                Export All SRT
                            </button>
                        </span>
                    </div>
                    <ul className='max-h-48 overflow-y-auto divide-y divide-slate-100'>
                        {items.map((item, index) => (
                            <li
                                key={item.id}
                                onClick={() => selectItem(item.id)}
                                className={`flex items-center justify-between px-2 py-1.5 text-sm cursor-pointer hover:bg-indigo-50 ${
                                    item.id === selectedId ? "bg-indigo-50" : ""
                                }`}
                            >
                                <span className='truncate flex-1'>
                                    {item.name}
                                </span>
                                <span className='text-xs text-slate-400 ml-2'>
                                    {formatAudioTimestamp(item.buffer.duration)}
                                </span>
                                <span
                                    className={`text-xs ml-2 w-16 text-right ${
                                        item.status === "done"
                                            ? "text-green-600"
                                            : "text-slate-400"
                                    }`}
                                >
                                    {batch && batch.index === index
                                        ? "running"
                                        : item.status === "done"
                                        ? "done"
                                        : "pending"}
                                </span>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        removeItem(item.id);
                                    }}
                                    className='ml-2 px-1 text-slate-300 hover:text-red-500'
                                >
                                    ×
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {audioData && (
                <>
                    <AudioPlayer
                        audioUrl={audioData.url}
                        mimeType={audioData.mimeType}
                        playerRef={props.audioRef}
                        onTimeUpdate={props.onTimeUpdate}
                    />

                    <div className='relative w-full flex flex-wrap justify-center items-center gap-y-2'>
                        <TranscribeButton
                            onClick={onTranscribeClick}
                            isModelLoading={props.transcriber.isModelLoading}
                            // Only lit while a *plain* transcription runs.
                            isTranscribing={
                                props.transcriber.isBusy &&
                                !props.transcriber.bilingualRun
                            }
                            // Greyed out (but not spinning) during a bilingual
                            // run: `bilingualRun` is the single source of
                            // truth and is always cleared when a run ends.
                            blocked={props.transcriber.bilingualRun}
                            progress={progressValue}
                            idleText={
                                items.length > 1
                                    ? `Transcribe All (${items.length})`
                                    : "Transcribe Audio"
                            }
                        />

                        <TranscribeButton
                            onClick={onBilingualClick}
                            isModelLoading={
                                props.transcriber.isModelLoading &&
                                props.transcriber.bilingualRun
                            }
                            isTranscribing={props.transcriber.bilingualRun}
                            blocked={
                                props.transcriber.isBusy &&
                                !props.transcriber.bilingualRun
                            }
                            progress={
                                props.transcriber.isTranslating
                                    ? translationProgressValue
                                    : props.transcriber.bilingualRun
                                    ? progressValue
                                    : undefined
                            }
                            idleText={
                                items.length > 1
                                    ? `Bilingual All (${items.length})`
                                    : hasTranscript(
                                          items.find(
                                              (item) => item.id === selectedId,
                                          ) ?? items[0],
                                      )
                                    ? "Bilingual subtitles (translate only)"
                                    : "Bilingual subtitles"
                            }
                            busyText={
                                props.transcriber.isTranslating
                                    ? "Translating..."
                                    : "Transcribing..."
                            }
                            className='text-white bg-indigo-600 hover:bg-indigo-700 focus:ring-4 focus:ring-indigo-300 font-medium rounded-lg text-sm px-5 py-2.5 text-center mr-2 dark:bg-indigo-500 dark:hover:bg-indigo-600 dark:focus:ring-indigo-800 inline-flex items-center disabled:opacity-60 disabled:cursor-not-allowed'
                        />

                        <SettingsTile
                            className='absolute right-4'
                            transcriber={props.transcriber}
                            icon={<SettingsIcon />}
                        />
                    </div>

                    {props.transcriber.isBusy && (
                        <div className='w-full px-4 pb-2'>
                            {batch && (
                                <div className='text-xs text-slate-500 mb-1 truncate'>
                                    File {batch.index + 1} / {batch.total} —{" "}
                                    {audioData.name}
                                </div>
                            )}
                            <ProgressBar
                                progress={`${Math.round(
                                    ((props.transcriber.isTranslating
                                        ? translationProgressValue
                                        : progressValue) ?? 0) * 100,
                                )}%`}
                            />
                            <div className='text-xs text-slate-500 mt-1'>
                                {progressText}
                            </div>
                        </div>
                    )}

                    {props.transcriber.progressItems.length > 0 && (
                        <div className='relative z-10 p-4 w-full'>
                            <label>
                                Loading model files... (only run once)
                            </label>
                            {props.transcriber.progressItems.map((data) => (
                                <div key={data.file}>
                                    <Progress
                                        text={data.file}
                                        percentage={data.progress}
                                    />
                                </div>
                            ))}
                        </div>
                    )}
                </>
            )}
        </>
    );
}

function SettingsTile(props: {
    icon: JSX.Element;
    className?: string;
    transcriber: Transcriber;
}) {
    const [showModal, setShowModal] = useState(false);

    const onClick = () => {
        setShowModal(true);
    };

    const onClose = () => {
        setShowModal(false);
    };

    const onSubmit = (url: string) => {
        onClose();
    };

    return (
        <div className={props.className}>
            <Tile icon={props.icon} onClick={onClick} />
            <SettingsModal
                show={showModal}
                onSubmit={onSubmit}
                onClose={onClose}
                transcriber={props.transcriber}
            />
        </div>
    );
}

function SettingsModal(props: {
    show: boolean;
    onSubmit: (url: string) => void;
    onClose: () => void;
    transcriber: Transcriber;
}) {
    const [apiStatus, setApiStatus] = useState<string>("");
    const [translationApiStatus, setTranslationApiStatus] =
        useState<string>("");
    const [testing, setTesting] = useState(false);
    const [testingTranslation, setTestingTranslation] = useState(false);

    // One independent list per column: the transcription column only shows
    // whisper family models, the translation column only opus-mt / nllb / chat
    // models. They are fetched, cached and refreshed separately.
    const [asrModels, setAsrModels] = useState<ApiModelOption[]>([]);
    const [asrStatus, setAsrStatus] = useState<string>("");
    const [asrLoading, setAsrLoading] = useState(false);
    const [mtModels, setMtModels] = useState<ApiModelOption[]>([]);
    const [mtStatus, setMtStatus] = useState<string>("");
    const [mtLoading, setMtLoading] = useState(false);
    /**
     * Weights downloaded by the *browser* engine (Cache Storage
     * `transformers-cache`). Kept strictly apart from `mtModels` / `asrModels`,
     * which describe the server's `.cache` folders.
     */
    const [browserCached, setBrowserCached] = useState<string[]>([]);

    const [customModel, setCustomModel] = useState(false);
    const [customTranslationModel, setCustomTranslationModel] = useState(false);

    const names = Object.values(LANGUAGES).map(titleCase);
    const engine = props.transcriber.engine;
    const translationEngine = props.transcriber.translationEngine;
    const isApi = engine === "api";
    // The "local" engine runs the model inside the Node server
    // (transformers.js) instead of inside the browser.
    const isServerLocal = engine === "local";
    const usesServer = isApi || isServerLocal;
    // "/api" (our own server) vs. a third party OpenAI compatible endpoint.
    const apiTarget = classifyApiBase(props.transcriber.apiBaseUrl);

    // The local engine always runs in *our* Node server. A third party base url
    // (typed while "Server API" was selected) must not leak into it — otherwise
    // the model dropdown lists upstream chat models instead of the whisper
    // weights cached in `.cache/Transcription models`.
    const asrBaseUrl =
        isServerLocal && apiTarget.kind !== "self"
            ? SELF_API_BASE
            : props.transcriber.apiBaseUrl;
    const asrTarget = classifyApiBase(asrBaseUrl);

    // The translation engine talks to its own endpoint. The `local` engine
    // always runs on our own server, even when the field points elsewhere.
    const translationBaseUrl =
        translationEngine === "local" &&
        classifyApiBase(props.transcriber.translationApiBaseUrl).kind !== "self"
            ? SELF_API_BASE
            : props.transcriber.translationApiBaseUrl;
    const translationApiTarget = classifyApiBase(translationBaseUrl);

    const currentModel = isServerLocal
        ? props.transcriber.localModel
        : props.transcriber.apiModel;
    const setCurrentModel = isServerLocal
        ? props.transcriber.setLocalModel
        : props.transcriber.setApiModel;

    /** Short summary so the user sees *which* models are actually cached. */
    const summarize = (options: ApiModelOption[], empty: string) => {
        if (options.length === 0) return empty;
        const cached = options.filter((option) => option.cached);
        if (cached.length === 0)
            return `已加载 ${options.length} 个选项（无已缓存）`;
        return `已缓存 ${cached.length} 个：${cached
            .slice(0, 6)
            .map((option) => option.id)
            .join("、")}${cached.length > 6 ? " …" : ""}`;
    };

    /** Transcription column: whisper family models cached on the server. */
    const loadAsrModels = useCallback(async () => {
        // Listing a third party endpoint's models needs its key. The local
        // engine never hits a third party (see `asrBaseUrl`), so it always
        // lists the weights cached on our own server.
        if (asrTarget.kind === "openai" && !props.transcriber.apiKey) {
            setAsrModels([]);
            setAsrStatus(
                "第三方端点：填写上面的 API Key 后点「刷新列表」拉取上游模型",
            );
            return;
        }
        setAsrLoading(true);
        setAsrStatus("正在读取服务端转写模型列表...");
        const result = await fetchApiModels({
            baseUrl: asrBaseUrl,
            // With `asrBaseUrl` forced to our own server the key is the
            // server's API_TOKEN (harmless when the server has none).
            apiKey: props.transcriber.apiKey,
            task: "asr",
        });
        setAsrLoading(false);
        if (result.ok) {
            setAsrModels(result.options);
            setAsrStatus(
                summarize(
                    result.options,
                    "服务端没有转写模型，先执行 npm run fetch-model",
                ),
            );
        } else {
            setAsrModels([]);
            setAsrStatus(
                asrTarget.kind === "openai"
                    ? `无法读取上游模型列表（${result.error}），以下为常见模型名`
                    : `无法读取服务端模型列表（${result.error}）。本地引擎需要 npm run server 启动服务端（默认 8787），以下为内置别名`,
            );
        }
    }, [asrTarget.kind, asrBaseUrl, isServerLocal, props.transcriber.apiKey]);

    /**
     * Translation column: translation models cached on the server, or the
     * chat models of the endpoint configured on this side.
     */
    const loadMtModels = useCallback(async () => {
        if (
            translationApiTarget.kind === "openai" &&
            !props.transcriber.translationApiKey
        ) {
            setMtModels([]);
            setMtStatus(
                "第三方端点：填写下面的 Translation API Key 后点「刷新列表」拉取上游模型",
            );
            return;
        }
        setMtLoading(true);
        setMtStatus("正在读取翻译模型列表...");
        const result = await fetchApiModels({
            baseUrl: translationBaseUrl,
            apiKey: props.transcriber.translationApiKey,
            task: "translation",
        });
        setMtLoading(false);
        if (result.ok) {
            setMtModels(result.options);
            setMtStatus(
                summarize(
                    result.options,
                    "服务端没有翻译模型，先执行 npm run fetch-model -- Xenova/opus-mt-en-zh",
                ),
            );
        } else {
            setMtModels([]);
            setMtStatus(`无法读取翻译模型列表（${result.error}）`);
        }
    }, [
        translationApiTarget.kind,
        translationBaseUrl,
        props.transcriber.translationApiKey,
    ]);

    // Load both lists when the modal opens (and whenever the engine selection
    // changes) so every column starts with its own cached models. Typing in a
    // URL field does not re-trigger this — use the per-column refresh button.
    const autoLoadSignature = `${engine}|${translationEngine}`;
    const loadedSignature = useRef("");
    useEffect(() => {
        if (!props.show) {
            loadedSignature.current = "";
            return;
        }
        if (loadedSignature.current === autoLoadSignature) return;
        loadedSignature.current = autoLoadSignature;
        void loadAsrModels();
        void loadMtModels();
        void listBrowserCachedModels().then(setBrowserCached);
    }, [props.show, autoLoadSignature, loadAsrModels, loadMtModels]);

    // Browser cache split by task, so neither column ever shows the other's
    // models as if they were its own.
    const browserAsrCached = browserCached.filter((id) => /whisper/i.test(id));
    const browserMtCached = browserCached.filter((id) =>
        /nllb|m2m|opus|mbart|mt5|translation/i.test(id),
    );

    // Model choices: server list when available, otherwise built-in aliases.
    const fallbackIds =
        apiTarget.kind === "openai"
            ? ["whisper-large-v3", "whisper-large-v3-turbo", "whisper-1"]
            : [
                  "tiny.en",
                  "tiny",
                  "base.en",
                  "base",
                  "small.en",
                  "small",
                  "medium.en",
                  "distil-large-v2",
              ];
    // Translation models (opus-mt / nllb / ...) also ship an
    // `encoder_model*.onnx`, so `/api/models` reports them too — never offer
    // them as a transcription model.
    const modelOptions: ApiModelOption[] = (
        asrModels.length > 0
            ? asrModels
            : fallbackIds.map((id) => ({
                  id,
                  note: "内置别名",
                  cached: false,
                  kind: "alias" as const,
                  task: "",
              }))
    ).filter((option: ApiModelOption) => option.task !== "translation");
    const currentInList = modelOptions.some((o) => o.id === currentModel);
    const cachedAsrModels = modelOptions.filter((option) => option.cached);

    const models = {
        // Original checkpoints
        "Xenova/whisper-tiny": [41, 152],
        "Xenova/whisper-base": [77, 291],
        "Xenova/whisper-small": [249],
        "Xenova/whisper-medium": [776],

        // Distil Whisper (English-only)
        "distil-whisper/distil-medium.en": [402],
        "distil-whisper/distil-large-v2": [767],
    };

    const onTestApi = async () => {
        setTesting(true);
        setApiStatus("Checking...");
        const result = await checkApiHealth(
            props.transcriber.apiBaseUrl,
            props.transcriber.apiKey,
        );
        setApiStatus((result.ok ? "✓ " : "✗ ") + result.message);
        setTesting(false);
    };

    /** Probe the endpoint configured on the translation side. */
    const onTestTranslationApi = async () => {
        setTestingTranslation(true);
        setTranslationApiStatus("Checking...");
        const result = await checkApiHealth(
            translationBaseUrl,
            props.transcriber.translationApiKey,
        );
        setTranslationApiStatus((result.ok ? "✓ " : "✗ ") + result.message);
        setTestingTranslation(false);
    };

    const inputClass =
        "mt-1 mb-2 bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white";
    const selectClass =
        "mt-1 mb-2 bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:text-white";

    // Which translation model setting applies to the selected engine.
    const currentTranslationModel =
        translationEngine === "api"
            ? props.transcriber.translationApiModel
            : props.transcriber.translationModel;
    const setCurrentTranslationModelValue =
        translationEngine === "api"
            ? props.transcriber.setTranslationApiModel
            : props.transcriber.setTranslationModel;
    // Translation column: cached weights first, then the upstream chat models
    // (only meaningful for a third party endpoint), then the built-in presets.
    const cachedTranslationModels = mtModels
        .filter((option) => option.cached)
        .filter((option) => !isBrokenTranslationModel(option.id))
        // When the browser already holds the weights it is the faster source,
        // so list them once, under "本浏览器已缓存".
        .filter(
            (option) =>
                !(
                    translationEngine === "browser" &&
                    browserMtCached.includes(option.id)
                ),
        )
        .map((option) => ({
            id: option.id,
            // The chat endpoint cannot run 🤗 weights — say so instead of
            // silently offering an unusable model.
            note:
                translationEngine === "local"
                    ? "已缓存（服务端 .cache\\Translation models）"
                    : "已缓存（服务端 · 需切换到本地引擎才能用）",
            multilingual: true,
            size: "",
        }));
    const upstreamTranslationModels =
        translationApiTarget.kind === "openai"
            ? mtModels
                  .filter((option) => !option.cached)
                  .filter((option) => !isBrokenTranslationModel(option.id))
                  .map((option) => ({
                      id: option.id,
                      note: "上游聊天模型",
                      multilingual: true,
                      size: "",
                  }))
            : [];
    const presetTranslationModels = (
        translationEngine === "api"
            ? TRANSLATION_API_MODELS.map((id) => ({
                  id,
                  note: "聊天模型",
                  multilingual: true,
                  size: "",
              }))
            : TRANSLATION_MODELS
    ).filter(
        (option) =>
            !cachedTranslationModels.some(
                (cached) => cached.id === option.id,
            ) &&
            !upstreamTranslationModels.some(
                (remote) => remote.id === option.id,
            ) &&
            // Already listed under "本浏览器已缓存" — do not show it twice.
            !(
                translationEngine === "browser" &&
                browserMtCached.includes(option.id)
            ),
    );
    const translationModelOptions = [
        ...cachedTranslationModels,
        ...upstreamTranslationModels,
        ...presetTranslationModels,
    ];
    const translationModelList = translationModelOptions.map(
        (option) => option.id,
    );
    const translationModelInList = translationModelList.includes(
        currentTranslationModel,
    );
    // Group labels: the two caches live in completely different places, so
    // they never appear under the same heading.
    const serverCacheLabel =
        translationEngine === "local"
            ? "服务端已缓存（.cache\\Translation models · 本地引擎直接用）"
            : translationEngine === "browser"
            ? "服务端已缓存（.cache\\Translation models · 经本地服务端的 /models 拉到浏览器）"
            : "服务端已缓存（本地引擎权重 · 聊天引擎用不到，切到本地引擎才可用）";
    const browserCacheLabel = "本浏览器已缓存（浏览器引擎可直接用）";
    const presetLabel =
        translationEngine === "api"
            ? "内置聊天模型"
            : "🤗 翻译模型预设（首次使用会下载）";

    // Which languages the selected model can actually produce. nllb wants
    // `zho_Hans` style codes, m2m100 plain `zh`, opus-mt-* a single language.
    const targetLanguageOptions = targetLanguagesForModel(
        currentTranslationModel,
        translationEngine,
    );
    const targetLanguageSupported = targetLanguageOptions.some(
        (language) => language.id === props.transcriber.translationTarget,
    );
    const fixedPair = fixedPairLanguages(currentTranslationModel);
    const codeStyle = modelCodeStyle(currentTranslationModel);
    const resolvedTargetCode = languageCodeFor(
        currentTranslationModel,
        props.transcriber.translationTarget,
    );

    /**
     * Switch model **and** keep the target language valid: a model that cannot
     * produce it would only fail later with a cryptic token error.
     */
    const applyTranslationModel = (value: string) => {
        setCurrentTranslationModelValue(value);
        const options = targetLanguagesForModel(value, translationEngine);
        if (
            options.length &&
            !options.some(
                (language) =>
                    language.id === props.transcriber.translationTarget,
            )
        ) {
            const fallback = options.find((language) => language.id === "zh");
            props.transcriber.setTranslationTarget(
                (fallback ?? options[0]).id,
            );
        }
    };

    return (
        <Modal
            show={props.show}
            title={"Settings"}
            panelClassName='max-w-4xl'
            content={
                <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
                    {/* ---------------- Left: transcription ---------------- */}
                    <section className='border border-slate-200 rounded-lg p-3'>
                        <h4 className='text-sm font-semibold text-slate-700 mb-2'>
                            Transcription engine
                        </h4>
                        <select
                            className={selectClass}
                            value={props.transcriber.engine}
                            onChange={(e) => {
                                props.transcriber.setEngine(
                                    e.target.value as Engine,
                                );
                            }}
                        >
                            <option value={"browser"}>
                                Browser (in-browser model)
                            </option>
                            <option value={"local"}>
                                本地引擎 Local engine (server)
                            </option>
                            <option value={"api"}>Server API</option>
                        </select>

                        {usesServer && (
                            <p className='text-xs text-slate-500 mb-2'>
                                {isServerLocal
                                    ? "本地引擎：由 Node 服务用 transformers.js 转写（权重在服务端 .cache，不占浏览器内存）。"
                                    : apiTarget.kind === "openai"
                                    ? "Server API：把音频转发给你填写的 OpenAI 兼容端点（经本地服务端中转）。"
                                    : "Server API：交给服务端自动选择引擎（openai / command / local）。"}
                            </p>
                        )}

                        {/* The local engine needs no endpoint: it always runs
                            inside our own Node server, so the base url / key /
                            test button belong to "Server API" only. */}
                        {isApi && (
                            <>
                                <label>API base URL</label>
                                <input
                                    className={inputClass}
                                    value={props.transcriber.apiBaseUrl}
                                    placeholder='/api 或 https://api.groq.com/openai/v1'
                                    onChange={(e) =>
                                        props.transcriber.setApiBaseUrl(
                                            e.target.value,
                                        )
                                    }
                                />
                                <p className='text-xs text-slate-400 mb-2'>
                                    {describeApiTarget(apiTarget)}
                                    {apiTarget.kind === "openai" && (
                                        <>
                                            <br />
                                            浏览器无法直连第三方（CORS
                                            且不走系统代理），请求会经本地服务端中转。
                                        </>
                                    )}
                                </p>
                                <label>API key (optional)</label>
                                <input
                                    className={inputClass}
                                    type='password'
                                    value={props.transcriber.apiKey}
                                    placeholder='sk-...'
                                    onChange={(e) =>
                                        props.transcriber.setApiKey(
                                            e.target.value,
                                        )
                                    }
                                />
                            </>
                        )}

                        {usesServer ? (
                            <>
                                <div className='flex items-center justify-between'>
                                    <label>
                                        Transcription Model
                                        {isServerLocal && (
                                            <span className='text-xs text-slate-400'>
                                                （🤗 转写模型）
                                            </span>
                                        )}
                                    </label>
                                    <div className='flex items-center space-x-2'>
                                        <>
                                            <button
                                                type='button'
                                                onClick={() =>
                                                    void loadAsrModels()
                                                }
                                                disabled={asrLoading}
                                                className='text-slate-500 hover:text-indigo-600 disabled:text-slate-300 text-xs'
                                            >
                                                {asrLoading
                                                    ? "刷新中..."
                                                    : "刷新列表"}
                                            </button>
                                            <button
                                                type='button'
                                                onClick={() =>
                                                    setCustomModel(!customModel)
                                                }
                                                className='text-slate-500 hover:text-indigo-600 text-xs'
                                            >
                                                {customModel
                                                    ? "从列表选择"
                                                    : "手动输入"}
                                            </button>
                                        </>
                                    </div>
                                </div>

                                {customModel ? (
                                    <input
                                        className={inputClass}
                                        value={currentModel}
                                        placeholder={
                                            isServerLocal
                                                ? "tiny.en"
                                                : "whisper-1"
                                        }
                                        onChange={(e) =>
                                            setCurrentModel(e.target.value)
                                        }
                                    />
                                ) : (
                                    <select
                                        className={inputClass}
                                        value={currentModel}
                                        onChange={(e) =>
                                            setCurrentModel(e.target.value)
                                        }
                                    >
                                        {!currentInList && (
                                            <option value={currentModel}>
                                                {currentModel || "(未选择)"}
                                                {" — 当前值（不在列表中）"}
                                            </option>
                                        )}
                                        <optgroup
                                            label={
                                                isServerLocal
                                                    ? "服务端已缓存（.cache\\Transcription models · 本地引擎直接用）"
                                                    : "服务端已缓存（本地引擎权重 · Server API 端点用不到）"
                                            }
                                        >
                                            {modelOptions
                                                .filter((o) => o.cached)
                                                .map((o) => (
                                                    <option
                                                        key={o.id}
                                                        value={o.id}
                                                    >
                                                        {o.id} — {o.note}
                                                    </option>
                                                ))}
                                        </optgroup>
                                        <optgroup label='其他可填的模型 / 别名'>
                                            {modelOptions
                                                .filter((o) => !o.cached)
                                                .map((o) => (
                                                    <option
                                                        key={o.id}
                                                        value={o.id}
                                                    >
                                                        {o.id} — {o.note}
                                                    </option>
                                                ))}
                                        </optgroup>
                                    </select>
                                )}
                                {isApi && (
                                    <div className='flex items-center space-x-2 mb-2'>
                                        <button
                                            onClick={onTestApi}
                                            disabled={testing}
                                            className='text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 rounded-lg text-xs px-3 py-1.5'
                                        >
                                            Test connection
                                        </button>
                                        <span className='text-xs text-slate-500 break-all'>
                                            {apiStatus}
                                        </span>
                                    </div>
                                )}
                                {isServerLocal && (
                                    <p className='text-xs text-slate-400 mb-2 break-all'>
                                        模型需先下载到服务端：npm run
                                        fetch-model --{" "}
                                        {currentModel || "tiny.en"}
                                        （缓存目录 .cache\Transcription
                                        models）；点「刷新列表」可立即看到新下载的模型。
                                    </p>
                                )}
                            </>
                        ) : (
                            <>
                                <label>Select the model to use.</label>
                                <select
                                    className='mt-1 mb-1 bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white dark:focus:ring-blue-500 dark:focus:border-blue-500'
                                    defaultValue={props.transcriber.model}
                                    onChange={(e) => {
                                        props.transcriber.setModel(
                                            e.target.value,
                                        );
                                    }}
                                >
                                    {browserAsrCached.length > 0 && (
                                        <optgroup label='本浏览器已缓存（浏览器引擎可直接用）'>
                                            {browserAsrCached.map((id) => (
                                                <option key={id} value={id}>
                                                    {id} — 已在浏览器内
                                                </option>
                                            ))}
                                        </optgroup>
                                    )}
                                    <optgroup label='🤗 转写模型（首次使用会下载到浏览器）'>
                                        {Object.keys(models)
                                            .filter(
                                                (key) =>
                                                    props.transcriber
                                                        .quantized ||
                                                    // @ts-ignore
                                                    models[key].length == 2,
                                            )
                                            .filter(
                                                (key) =>
                                                    !props.transcriber
                                                        .multilingual ||
                                                    !key.startsWith(
                                                        "distil-whisper/",
                                                    ),
                                            )
                                            .filter(
                                                (key) =>
                                                    !browserAsrCached.includes(
                                                        key,
                                                    ),
                                            )
                                            .map((key) => (
                                                <option
                                                    key={key}
                                                    value={key}
                                                >{`${key}${
                                                    props.transcriber
                                                        .multilingual ||
                                                    key.startsWith(
                                                        "distil-whisper/",
                                                    )
                                                        ? ""
                                                        : ".en"
                                                } (${
                                                    // @ts-ignore
                                                    models[key][
                                                        props.transcriber
                                                            .quantized
                                                            ? 0
                                                            : 1
                                                    ]
                                                }MB)`}</option>
                                            ))}
                                    </optgroup>
                                </select>
                                <div className='flex justify-between items-center mb-3 px-1'>
                                    <div className='flex'>
                                        <input
                                            id='multilingual'
                                            type='checkbox'
                                            checked={
                                                props.transcriber.multilingual
                                            }
                                            onChange={(e) => {
                                                props.transcriber.setMultilingual(
                                                    e.target.checked,
                                                );
                                            }}
                                        ></input>
                                        <label
                                            htmlFor={"multilingual"}
                                            className='ms-1'
                                        >
                                            Multilingual
                                        </label>
                                    </div>
                                    <div className='flex'>
                                        <input
                                            id='quantize'
                                            type='checkbox'
                                            checked={
                                                props.transcriber.quantized
                                            }
                                            onChange={(e) => {
                                                props.transcriber.setQuantized(
                                                    e.target.checked,
                                                );
                                            }}
                                        ></input>
                                        <label
                                            htmlFor={"quantize"}
                                            className='ms-1'
                                        >
                                            Quantized
                                        </label>
                                    </div>
                                </div>
                                <div className='flex items-center space-x-2 mb-2'>
                                    <button
                                        type='button'
                                        onClick={() => void loadAsrModels()}
                                        disabled={asrLoading}
                                        className='text-slate-500 hover:text-indigo-600 disabled:text-slate-300 text-xs'
                                    >
                                        {asrLoading ? "刷新中..." : "刷新列表"}
                                    </button>
                                    <span className='text-xs text-slate-400'>
                                        {cachedAsrModels.length
                                            ? `服务端已缓存 ${cachedAsrModels.length} 个转写模型`
                                            : "读取服务端已缓存的转写模型"}
                                    </span>
                                </div>
                            </>
                        )}

                        {asrStatus && (
                            <p
                                className={`text-xs mb-2 ${
                                    asrModels.length
                                        ? "text-slate-400"
                                        : "text-amber-600"
                                }`}
                            >
                                {asrStatus}
                            </p>
                        )}

                        {(props.transcriber.multilingual || usesServer) && (
                            <>
                                <label>Select the source language.</label>
                                <select
                                    className='mt-1 mb-3 bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white dark:focus:ring-blue-500 dark:focus:border-blue-500'
                                    value={props.transcriber.language}
                                    onChange={(e) => {
                                        props.transcriber.setLanguage(
                                            e.target.value,
                                        );
                                    }}
                                >
                                    {isApi && (
                                        <option value={"auto"}>
                                            Auto detect
                                        </option>
                                    )}
                                    {Object.keys(LANGUAGES).map((key, i) => (
                                        <option key={key} value={key}>
                                            {names[i]}
                                        </option>
                                    ))}
                                </select>
                                <label>Select the task to perform.</label>
                                <select
                                    className='mt-1 mb-3 bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white dark:focus:ring-blue-500 dark:focus:border-blue-500'
                                    value={props.transcriber.subtask}
                                    onChange={(e) => {
                                        props.transcriber.setSubtask(
                                            e.target.value,
                                        );
                                    }}
                                >
                                    <option value={"transcribe"}>
                                        Transcribe
                                    </option>
                                    <option value={"translate"}>
                                        Translate (to English)
                                    </option>
                                </select>
                            </>
                        )}
                    </section>

                    {/* ---------------- Right: translation ---------------- */}
                    <section className='border border-slate-200 rounded-lg p-3'>
                        <h4 className='text-sm font-semibold text-slate-700 mb-2'>
                            Translation engine
                        </h4>
                        <select
                            className={selectClass}
                            value={props.transcriber.translationEngine}
                            onChange={(e) =>
                                props.transcriber.setTranslationEngine(
                                    e.target.value as TranslationEngine,
                                )
                            }
                        >
                            <option value={"browser"}>
                                Browser (in-browser model)
                            </option>
                            <option value={"local"}>
                                本地引擎 Local engine (server)
                            </option>
                            <option value={"api"}>Server API</option>
                        </select>
                        <p className='text-xs text-slate-500 mb-2'>
                            {translationEngine === "browser"
                                ? "浏览器内用 🤗 Transformers.js 翻译模型（首次会下载模型）。"
                                : translationEngine === "local"
                                ? "由 Node 服务用 🤗 Transformers.js 翻译（权重在服务端 .cache）。"
                                : "调用 OpenAI 兼容的 /chat/completions（LLM，上下文语境翻译效果最好）。"}
                        </p>

                        <label>Translate subtitles into</label>
                        <select
                            className={selectClass}
                            value={props.transcriber.translationTarget}
                            onChange={(e) =>
                                props.transcriber.setTranslationTarget(
                                    e.target.value,
                                )
                            }
                        >
                            {!targetLanguageSupported && (
                                <option
                                    value={props.transcriber.translationTarget}
                                >
                                    {languageLabel(
                                        props.transcriber.translationTarget,
                                    ) || "(未选择)"}
                                    {" — 当前模型不支持"}
                                </option>
                            )}
                            {targetLanguageOptions.map((language) => (
                                <option key={language.id} value={language.id}>
                                    {language.label}
                                    {language.id !==
                                        props.transcriber.translationTarget &&
                                    codeStyle !== "none"
                                        ? ` (${
                                              codeStyle === "m2m100"
                                                  ? language.id
                                                  : language.nllb
                                          })`
                                        : ""}
                                </option>
                            ))}
                        </select>
                        <p className='text-xs text-slate-400 mb-2'>
                            {translationEngine === "api"
                                ? "LLM 引擎：任意语言都可以（直接把语言名写进提示词）。"
                                : fixedPair
                                ? `固定方向模型：只能译成 ${languageLabel(
                                      fixedPair.tgt,
                                  )}（${languageLabel(
                                      fixedPair.src,
                                  )} → ${languageLabel(fixedPair.tgt)}）。`
                                : codeStyle === "m2m100"
                                ? "该模型使用 m2m100 语言码（zh / en / ja …，共约 100 种），已按此过滤。"
                                : codeStyle === "nllb"
                                ? `该模型使用 NLLB 语言码，当前目标为 ${resolvedTargetCode}。`
                                : "未知模型：未做语言限制。"}
                        </p>

                        <div className='flex items-center justify-between'>
                            <label>
                                Translation model
                                <span className='text-xs text-slate-400'>
                                    {translationEngine === "api"
                                        ? "（聊天模型）"
                                        : "（🤗 翻译模型）"}
                                </span>
                            </label>
                            <div className='flex items-center space-x-2'>
                                <button
                                    type='button'
                                    onClick={() => void loadMtModels()}
                                    disabled={mtLoading}
                                    className='text-slate-500 hover:text-indigo-600 disabled:text-slate-300 text-xs'
                                >
                                    {mtLoading ? "刷新中..." : "刷新列表"}
                                </button>
                                <button
                                    type='button'
                                    onClick={() =>
                                        setCustomTranslationModel((v) => !v)
                                    }
                                    className='text-slate-500 hover:text-indigo-600 text-xs'
                                >
                                    {customTranslationModel
                                        ? "从列表选择"
                                        : "手动输入"}
                                </button>
                            </div>
                        </div>
                        {customTranslationModel ? (
                            <input
                                className={inputClass}
                                value={currentTranslationModel}
                                onChange={(e) =>
                                    applyTranslationModel(e.target.value)
                                }
                            />
                        ) : (
                            <select
                                className={selectClass}
                                value={currentTranslationModel}
                                onChange={(e) =>
                                    applyTranslationModel(e.target.value)
                                }
                            >
                                {!translationModelInList && (
                                    <option value={currentTranslationModel}>
                                        {currentTranslationModel || "(未选择)"}
                                        {" — 当前值（不在列表中）"}
                                    </option>
                                )}
                                {translationEngine === "browser" &&
                                    browserMtCached.length > 0 && (
                                        <optgroup label={browserCacheLabel}>
                                            {browserMtCached.map((id) => (
                                                <option key={id} value={id}>
                                                    {id} — 已在浏览器内
                                                </option>
                                            ))}
                                        </optgroup>
                                    )}
                                {cachedTranslationModels.length > 0 && (
                                    <optgroup label={serverCacheLabel}>
                                        {cachedTranslationModels.map(
                                            (option) => (
                                                <option
                                                    key={option.id}
                                                    value={option.id}
                                                >
                                                    {option.id}
                                                    {option.size
                                                        ? ` — ${option.size}`
                                                        : ""}{" "}
                                                    · {option.note}
                                                </option>
                                            ),
                                        )}
                                    </optgroup>
                                )}
                                {upstreamTranslationModels.length > 0 && (
                                    <optgroup label='上游聊天模型（第三方端点）'>
                                        {upstreamTranslationModels.map(
                                            (option) => (
                                                <option
                                                    key={option.id}
                                                    value={option.id}
                                                >
                                                    {option.id}
                                                </option>
                                            ),
                                        )}
                                    </optgroup>
                                )}
                                {presetTranslationModels.length > 0 && (
                                    <optgroup label={presetLabel}>
                                        {presetTranslationModels.map(
                                            (option) => (
                                                <option
                                                    key={option.id}
                                                    value={option.id}
                                                >
                                                    {option.id}
                                                    {option.size
                                                        ? ` — ${option.size}`
                                                        : ""}{" "}
                                                    · {option.note}
                                                </option>
                                            ),
                                        )}
                                    </optgroup>
                                )}
                            </select>
                        )}
                        {mtStatus && (
                            <p
                                className={`text-xs mb-2 ${
                                    mtModels.length
                                        ? "text-slate-400"
                                        : "text-amber-600"
                                }`}
                            >
                                {mtStatus}
                            </p>
                        )}
                        {translationEngine === "browser" && (
                            <p className='text-xs text-slate-400 mb-2 break-all'>
                                本浏览器已缓存的翻译模型（Cache Storage）：
                                {browserMtCached.length
                                    ? browserMtCached.join("、")
                                    : "无，首次使用会自动下载到浏览器"}
                                。这与服务端 .cache\Translation models
                                是两份独立的缓存，上面已分开列出。
                            </p>
                        )}

                        {translationEngine === "api" && (
                            <>
                                <div className='border-t border-slate-200 pt-2 mt-1'>
                                    <p className='text-xs text-slate-500 mb-1'>
                                        以下三项与左侧 Transcription 完全独立，
                                        翻译只使用这里的配置。
                                    </p>
                                    <label>Translation API base URL</label>
                                    <input
                                        className={inputClass}
                                        value={
                                            props.transcriber
                                                .translationApiBaseUrl
                                        }
                                        placeholder='/api 或 https://api.groq.com/openai/v1'
                                        onChange={(e) =>
                                            props.transcriber.setTranslationApiBaseUrl(
                                                e.target.value,
                                            )
                                        }
                                    />
                                    <p className='text-xs text-slate-400 mb-2 break-all'>
                                        {describeApiTarget(
                                            translationApiTarget,
                                        )}
                                        {translationApiTarget.kind ===
                                            "openai" && (
                                            <>
                                                <br />
                                                浏览器无法直连第三方（CORS
                                                且不走系统代理），请求会经本地服务端中转。
                                            </>
                                        )}
                                    </p>
                                    <label>Translation API key</label>
                                    <input
                                        className={inputClass}
                                        type='password'
                                        value={
                                            props.transcriber.translationApiKey
                                        }
                                        placeholder='sk-...'
                                        onChange={(e) =>
                                            props.transcriber.setTranslationApiKey(
                                                e.target.value,
                                            )
                                        }
                                    />
                                    <div className='flex items-center space-x-2 mb-2'>
                                        <button
                                            onClick={onTestTranslationApi}
                                            disabled={testingTranslation}
                                            className='text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 rounded-lg text-xs px-3 py-1.5'
                                        >
                                            Test connection
                                        </button>
                                        <span className='text-xs text-slate-500 break-all'>
                                            {translationApiStatus}
                                        </span>
                                    </div>
                                </div>
                            </>
                        )}

                        {/* The extra prompt is appended to the LLM prompt, so it
                            only exists for the Server API engine. */}
                        {translationEngine === "api" && (
                            <>
                                <label>
                                    Prompt（补充要求）
                                    <span className='text-xs text-slate-400'>
                                        （追加到翻译提示词，仅 Server API 生效）
                                    </span>
                                </label>
                                <textarea
                                    className={inputClass}
                                    rows={3}
                                    value={props.transcriber.translationPrompt}
                                    placeholder={
                                        "例如：使用简体中文口语化表达；人名保留原文；" +
                                        "“Transformer”统一译为“变换器”"
                                    }
                                    onChange={(e) =>
                                        props.transcriber.setTranslationPrompt(
                                            e.target.value,
                                        )
                                    }
                                />
                            </>
                        )}
                        {translationEngine === "local" && (
                            <p className='text-xs text-slate-400 mb-2'>
                                服务端模型需先下载：npm run fetch-model --{" "}
                                {currentTranslationModel ||
                                    "Xenova/nllb-200-distilled-600M"}
                            </p>
                        )}
                    </section>
                </div>
            }
            onClose={props.onClose}
        />
    );
}

function VerticalBar() {
    return <div className='w-[1px] bg-slate-200'></div>;
}

function AudioDataBar(props: { progress: number }) {
    return <ProgressBar progress={`${Math.round(props.progress * 100)}%`} />;
}

function ProgressBar(props: { progress: string }) {
    return (
        <div className='w-full bg-gray-200 rounded-full h-1 dark:bg-gray-700'>
            <div
                className='bg-blue-600 h-1 rounded-full transition-all duration-100'
                style={{ width: props.progress }}
            ></div>
        </div>
    );
}

function UrlTile(props: {
    icon: JSX.Element;
    text: string;
    onUrlUpdate: (url: string) => void;
}) {
    const [showModal, setShowModal] = useState(false);

    const onClick = () => {
        setShowModal(true);
    };

    const onClose = () => {
        setShowModal(false);
    };

    const onSubmit = (url: string) => {
        props.onUrlUpdate(url);
        onClose();
    };

    return (
        <>
            <Tile icon={props.icon} text={props.text} onClick={onClick} />
            <UrlModal show={showModal} onSubmit={onSubmit} onClose={onClose} />
        </>
    );
}

function UrlModal(props: {
    show: boolean;
    onSubmit: (url: string) => void;
    onClose: () => void;
}) {
    const [url, setUrl] = useState(Constants.DEFAULT_AUDIO_URL);

    const onChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        setUrl(event.target.value);
    };

    const onSubmit = () => {
        props.onSubmit(url);
    };

    return (
        <Modal
            show={props.show}
            title={"From URL"}
            content={
                <>
                    {"Enter the URL of the audio file you want to load."}
                    <UrlInput onChange={onChange} value={url} />
                </>
            }
            onClose={props.onClose}
            submitText={"Load"}
            onSubmit={onSubmit}
        />
    );
}

function FileTile(props: {
    icon: JSX.Element;
    text: string;
    onFilesUpdate: (files: File[]) => void;
}) {
    const [showModal, setShowModal] = useState(false);

    const pick = (directory: boolean) => {
        const elem = document.createElement("input");
        elem.type = "file";
        elem.accept = "audio/*,video/*";
        elem.multiple = true;
        if (directory) {
            // Non-standard but supported by Chromium / Firefox / Safari
            elem.setAttribute("webkitdirectory", "");
            elem.setAttribute("directory", "");
        }
        elem.onchange = () => {
            const files = Array.from(elem.files ?? []);
            elem.value = "";
            setShowModal(false);
            elem.remove();
            if (files.length > 0) {
                props.onFilesUpdate(files);
            }
        };
        // Keep it in the DOM (hidden) — detached inputs cannot be targeted by
        // automation tools, and some browsers ignore click() on them.
        elem.style.display = "none";
        document.body.appendChild(elem);
        elem.click();
    };

    const buttonClass =
        "w-full text-left px-3 py-2 mb-2 rounded-lg border border-slate-200 hover:bg-indigo-50 transition-all duration-200";

    return (
        <>
            <Tile
                icon={props.icon}
                text={props.text}
                onClick={() => setShowModal(true)}
            />
            <Modal
                show={showModal}
                title={"From file"}
                content={
                    <div className='flex flex-col'>
                        <button
                            className={buttonClass}
                            onClick={() => pick(false)}
                        >
                            选择多个音频文件
                        </button>
                        <button
                            className={buttonClass}
                            onClick={() => pick(true)}
                        >
                            选择整个文件夹（含子目录）
                        </button>
                        <p className='text-xs text-slate-400'>
                            支持 mp3 / wav / m4a / flac / ogg / webm / mp4
                            等浏览器可解码的格式；多个文件会依次排队转写，可批量导出。
                        </p>
                    </div>
                }
                onClose={() => setShowModal(false)}
            />
        </>
    );
}

function RecordTile(props: {
    icon: JSX.Element;
    text: string;
    setAudioData: (data: Blob) => void;
}) {
    const [showModal, setShowModal] = useState(false);

    const onClick = () => {
        setShowModal(true);
    };

    const onClose = () => {
        setShowModal(false);
    };

    const onSubmit = (data: Blob | undefined) => {
        if (data) {
            props.setAudioData(data);
            onClose();
        }
    };

    return (
        <>
            <Tile icon={props.icon} text={props.text} onClick={onClick} />
            <RecordModal
                show={showModal}
                onSubmit={onSubmit}
                onClose={onClose}
            />
        </>
    );
}

function RecordModal(props: {
    show: boolean;
    onSubmit: (data: Blob | undefined) => void;
    onClose: () => void;
}) {
    const [audioBlob, setAudioBlob] = useState<Blob>();

    const onRecordingComplete = (blob: Blob) => {
        setAudioBlob(blob);
    };

    const onSubmit = () => {
        props.onSubmit(audioBlob);
        setAudioBlob(undefined);
    };

    const onClose = () => {
        props.onClose();
        setAudioBlob(undefined);
    };

    return (
        <Modal
            show={props.show}
            title={"From Recording"}
            content={
                <>
                    {"Record audio using your microphone"}
                    <AudioRecorder onRecordingComplete={onRecordingComplete} />
                </>
            }
            onClose={onClose}
            submitText={"Load"}
            submitEnabled={audioBlob !== undefined}
            onSubmit={onSubmit}
        />
    );
}

function Tile(props: {
    icon: JSX.Element;
    text?: string;
    onClick?: () => void;
}) {
    return (
        <button
            onClick={props.onClick}
            className='flex items-center justify-center rounded-lg p-2 bg-blue text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 transition-all duration-200'
        >
            <div className='w-7 h-7'>{props.icon}</div>
            {props.text && (
                <div className='ml-2 break-text text-center text-md w-30'>
                    {props.text}
                </div>
            )}
        </button>
    );
}

function AnchorIcon() {
    return (
        <svg
            xmlns='http://www.w3.org/2000/svg'
            fill='none'
            viewBox='0 0 24 24'
            strokeWidth='1.5'
            stroke='currentColor'
        >
            <path
                strokeLinecap='round'
                strokeLinejoin='round'
                d='M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244'
            />
        </svg>
    );
}

function FolderIcon() {
    return (
        <svg
            xmlns='http://www.w3.org/2000/svg'
            fill='none'
            viewBox='0 0 24 24'
            strokeWidth='1.5'
            stroke='currentColor'
        >
            <path
                strokeLinecap='round'
                strokeLinejoin='round'
                d='M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776'
            />
        </svg>
    );
}

function TrashIcon() {
    return (
        <svg
            xmlns='http://www.w3.org/2000/svg'
            fill='none'
            viewBox='0 0 24 24'
            strokeWidth='1.5'
            stroke='currentColor'
        >
            <path
                strokeLinecap='round'
                strokeLinejoin='round'
                d='M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0'
            />
        </svg>
    );
}

function SettingsIcon() {
    return (
        <svg
            xmlns='http://www.w3.org/2000/svg'
            fill='none'
            viewBox='0 0 24 24'
            strokeWidth='1.25'
            stroke='currentColor'
        >
            <path
                strokeLinecap='round'
                strokeLinejoin='round'
                d='M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z'
            />
            <path
                strokeLinecap='round'
                strokeLinejoin='round'
                d='M15 12a3 3 0 11-6 0 3 3 0 016 0z'
            />
        </svg>
    );
}

function MicrophoneIcon() {
    return (
        <svg
            xmlns='http://www.w3.org/2000/svg'
            fill='none'
            viewBox='0 0 24 24'
            strokeWidth={1.5}
            stroke='currentColor'
        >
            <path
                strokeLinecap='round'
                strokeLinejoin='round'
                d='M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z'
            />
        </svg>
    );
}
