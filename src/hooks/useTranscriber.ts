import { useCallback, useMemo, useState } from "react";
import { useWorker } from "./useWorker";
import Constants from "../utils/Constants";
import { audioBufferToWav } from "../utils/AudioUtils";
import { transcribeViaApi } from "../utils/ApiClient";

interface ProgressItem {
    file: string;
    loaded: number;
    progress: number;
    total: number;
    name: string;
    status: string;
}

interface TranscriberUpdateData {
    data: [
        string,
        { chunks: { text: string; timestamp: [number, number | null] }[] },
    ];
    text: string;
    progress?: TranscribeProgress;
}

interface TranscriberCompleteData {
    data: {
        text: string;
        chunks: { text: string; timestamp: [number, number | null] }[];
    };
    progress?: TranscribeProgress;
}

export interface Chunk {
    text: string;
    timestamp: [number, number | null];
    /** Reserved for a translated / manually corrected version of the line. */
    trans?: string;
}

/** Progress of the actual (in-browser) transcription step. */
export interface TranscribeProgress {
    /** 0 - 1 */
    value: number;
    /** Seconds of audio processed so far. */
    processed: number;
    /** Total seconds of audio. */
    total: number;
    chunksDone: number;
    chunksTotal: number;
}

export interface TranscriberData {
    isBusy: boolean;
    text: string;
    chunks: Chunk[];
    progress?: TranscribeProgress;
}

/**
 * - "browser" runs the model in a web worker (the original behaviour)
 * - "local"   uploads to the Node API and forces its in-process engine
 *              (transformers.js, weights cached on the server)
 * - "api"     uploads to the Node API and lets the server pick an engine
 */
export type Engine = "browser" | "local" | "api";

export interface Transcriber {
    onInputChange: () => void;
    isBusy: boolean;
    isModelLoading: boolean;
    progressItems: ProgressItem[];
    start: (
        audioData: AudioBuffer | undefined,
        file?: Blob,
        fileName?: string,
    ) => void;
    output?: TranscriberData;
    /** Restore a previously computed transcript (used when browsing results). */
    setOutput: (data?: TranscriberData) => void;
    model: string;
    setModel: (model: string) => void;
    multilingual: boolean;
    setMultilingual: (model: boolean) => void;
    quantized: boolean;
    setQuantized: (model: boolean) => void;
    subtask: string;
    setSubtask: (subtask: string) => void;
    language?: string;
    setLanguage: (language: string) => void;

    // Server API support
    engine: Engine;
    setEngine: (engine: Engine) => void;
    apiBaseUrl: string;
    setApiBaseUrl: (url: string) => void;
    apiKey: string;
    setApiKey: (key: string) => void;
    apiModel: string;
    setApiModel: (model: string) => void;
    /** Model used by the server-side local engine (`tiny.en`, `Xenova/...`). */
    localModel: string;
    setLocalModel: (model: string) => void;
    uploadProgress?: number;
}

const STORAGE_PREFIX = "whisper-web:";

function loadSetting(key: string, fallback: string): string {
    try {
        return localStorage.getItem(STORAGE_PREFIX + key) ?? fallback;
    } catch (e) {
        return fallback;
    }
}

function saveSetting(key: string, value: string) {
    try {
        localStorage.setItem(STORAGE_PREFIX + key, value);
    } catch (e) {
        // Storage might be unavailable (private mode), ignore.
    }
}

export function useTranscriber(): Transcriber {
    const [transcript, setTranscript] = useState<TranscriberData | undefined>(
        undefined,
    );
    const [isBusy, setIsBusy] = useState(false);
    const [isModelLoading, setIsModelLoading] = useState(false);

    const [progressItems, setProgressItems] = useState<ProgressItem[]>([]);

    const webWorker = useWorker((event) => {
        const message = event.data;
        // Update the state with the result
        switch (message.status) {
            case "progress":
                // Model file progress: update one of the progress items.
                setProgressItems((prev) =>
                    prev.map((item) => {
                        if (item.file === message.file) {
                            return { ...item, progress: message.progress };
                        }
                        return item;
                    }),
                );
                break;
            case "update":
                // Received partial update
                // console.log("update", message);
                // eslint-disable-next-line no-case-declarations
                const updateMessage = message as TranscriberUpdateData;
                setTranscript({
                    isBusy: true,
                    text: updateMessage.data[0],
                    chunks: updateMessage.data[1].chunks,
                    progress: updateMessage.progress,
                });
                break;
            case "complete":
                // Received complete transcript
                // console.log("complete", message);
                // eslint-disable-next-line no-case-declarations
                const completeMessage = message as TranscriberCompleteData;
                setTranscript({
                    isBusy: false,
                    text: completeMessage.data.text,
                    chunks: completeMessage.data.chunks,
                    progress: completeMessage.progress,
                });
                setIsBusy(false);
                break;

            case "initiate":
                // Model file start load: add a new progress item to the list.
                setIsModelLoading(true);
                setProgressItems((prev) => [...prev, message]);
                break;
            case "ready":
                setIsModelLoading(false);
                break;
            case "error":
                setIsBusy(false);
                alert(
                    `${message.data.message} This is most likely because you are using Safari on an M1/M2 Mac. Please try again from Chrome, Firefox, or Edge.\n\nIf this is not the case, please file a bug report.`,
                );
                break;
            case "done":
                // Model file loaded: remove the progress item from the list.
                setProgressItems((prev) =>
                    prev.filter((item) => item.file !== message.file),
                );
                break;

            default:
                // initiate/download/done
                break;
        }
    });

    const [model, setModel] = useState<string>(Constants.DEFAULT_MODEL);
    const [subtask, setSubtask] = useState<string>(Constants.DEFAULT_SUBTASK);
    const [quantized, setQuantized] = useState<boolean>(
        Constants.DEFAULT_QUANTIZED,
    );
    const [multilingual, setMultilingual] = useState<boolean>(
        Constants.DEFAULT_MULTILINGUAL,
    );
    const [language, setLanguage] = useState<string>(
        Constants.DEFAULT_LANGUAGE,
    );

    // "local" used to mean the in-browser model; that is called "browser" now.
    const [engine, setEngineState] = useState<Engine>(() => {
        const stored = loadSetting("engine", Constants.DEFAULT_ENGINE);
        if (stored === "local") return "browser";
        return stored === "api" || stored === "browser" ? stored : "browser";
    });
    const [apiBaseUrl, setApiBaseUrlState] = useState<string>(
        loadSetting("apiBaseUrl", Constants.API_BASE_URL),
    );
    const [apiKey, setApiKeyState] = useState<string>(
        loadSetting("apiKey", ""),
    );
    const [apiModel, setApiModelState] = useState<string>(
        loadSetting("apiModel", Constants.API_MODEL),
    );
    const [localModel, setLocalModelState] = useState<string>(
        loadSetting("localModel", Constants.LOCAL_MODEL),
    );
    const [uploadProgress, setUploadProgress] = useState<number | undefined>(
        undefined,
    );

    const setEngine = useCallback((value: Engine) => {
        saveSetting("engine", value);
        setEngineState(value);
    }, []);
    const setApiBaseUrl = useCallback((value: string) => {
        saveSetting("apiBaseUrl", value);
        setApiBaseUrlState(value);
    }, []);
    const setApiKey = useCallback((value: string) => {
        saveSetting("apiKey", value);
        setApiKeyState(value);
    }, []);
    const setApiModel = useCallback((value: string) => {
        saveSetting("apiModel", value);
        setApiModelState(value);
    }, []);
    const setLocalModel = useCallback((value: string) => {
        saveSetting("localModel", value);
        setLocalModelState(value);
    }, []);

    const onInputChange = useCallback(() => {
        setTranscript(undefined);
    }, []);

    const transcribeWithApi = useCallback(
        async (audioData: AudioBuffer, file?: Blob, fileName?: string) => {
            setIsBusy(true);
            setUploadProgress(0);
            setTranscript(undefined);

            try {
                // Prefer the original file (keeps mp3/m4a small); fall back to
                // an encoded WAV for recordings / URL sources.
                const payload = file ?? audioBufferToWav(audioData);
                const name = fileName ?? (file ? "audio" : "audio.wav");

                const result = await transcribeViaApi({
                    baseUrl: apiBaseUrl,
                    apiKey: apiKey,
                    model: engine === "local" ? localModel : apiModel,
                    // "local" pins the server to its in-process engine;
                    // "api" lets the server decide.
                    engine: engine === "local" ? "local" : undefined,
                    language: multilingual
                        ? language === "auto"
                            ? undefined
                            : language
                        : "en",
                    task: subtask,
                    file: payload,
                    fileName: name,
                    onProgress: (value) => setUploadProgress(value),
                });

                setTranscript({
                    isBusy: false,
                    text: result.text,
                    chunks: result.chunks,
                    progress: {
                        value: 1,
                        processed: audioData.duration,
                        total: audioData.duration,
                        chunksDone: 1,
                        chunksTotal: 1,
                    },
                });
            } catch (error: any) {
                console.error("API transcription failed", error);
                setTranscript(undefined);
                alert(
                    `Transcription through the server API failed: ${
                        error?.response?.data?.error ?? error?.message ?? error
                    }`,
                );
            } finally {
                setIsBusy(false);
                setUploadProgress(undefined);
            }
        },
        [
            apiBaseUrl,
            apiKey,
            apiModel,
            localModel,
            engine,
            language,
            multilingual,
            subtask,
        ],
    );

    const postRequest = useCallback(
        async (
            audioData: AudioBuffer | undefined,
            file?: Blob,
            fileName?: string,
        ) => {
            if (!audioData) return;

            if (engine === "api" || engine === "local") {
                await transcribeWithApi(audioData, file, fileName);
                return;
            }

            setTranscript(undefined);
            setIsBusy(true);

            let audio;
            if (audioData.numberOfChannels === 2) {
                const SCALING_FACTOR = Math.sqrt(2);

                const left = audioData.getChannelData(0);
                const right = audioData.getChannelData(1);

                audio = new Float32Array(left.length);
                for (let i = 0; i < audioData.length; ++i) {
                    audio[i] = (SCALING_FACTOR * (left[i] + right[i])) / 2;
                }
            } else {
                // If the audio is not stereo, we can just use the first channel:
                audio = audioData.getChannelData(0);
            }

            webWorker.postMessage({
                audio,
                model,
                multilingual,
                quantized,
                subtask: multilingual ? subtask : null,
                language: multilingual && language !== "auto" ? language : null,
            });
        },
        [
            webWorker,
            engine,
            transcribeWithApi,
            model,
            multilingual,
            quantized,
            subtask,
            language,
        ],
    );

    const transcriber = useMemo(() => {
        return {
            onInputChange,
            isBusy,
            isModelLoading,
            progressItems,
            start: postRequest,
            output: transcript,
            setOutput: setTranscript,
            model,
            setModel,
            multilingual,
            setMultilingual,
            quantized,
            setQuantized,
            subtask,
            setSubtask,
            language,
            setLanguage,
            engine,
            setEngine,
            apiBaseUrl,
            setApiBaseUrl,
            apiKey,
            setApiKey,
            apiModel,
            setApiModel,
            localModel,
            setLocalModel,
            uploadProgress,
        };
    }, [
        isBusy,
        isModelLoading,
        progressItems,
        postRequest,
        transcript,
        model,
        multilingual,
        quantized,
        subtask,
        language,
        engine,
        setEngine,
        apiBaseUrl,
        setApiBaseUrl,
        apiKey,
        setApiKey,
        apiModel,
        setApiModel,
        localModel,
        setLocalModel,
        uploadProgress,
    ]);

    return transcriber;
}
