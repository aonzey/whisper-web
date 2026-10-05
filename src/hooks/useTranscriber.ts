import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorker } from "./useWorker";
import Constants from "../utils/Constants";
import { audioBufferToWav } from "../utils/AudioUtils";
import {
    SELF_API_BASE,
    classifyApiBase,
    transcribeViaApi,
} from "../utils/ApiClient";
import {
    TranslationEngine,
    translateLinesWithContext,
} from "../utils/TranslationClient";

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
    /** True when the chunks carry a translation (bilingual subtitles). */
    bilingual?: boolean;
}

/**
 * - "browser" runs the model in a web worker (the original behaviour)
 * - "local"   uploads to the Node API and forces its in-process engine
 *              (transformers.js, weights cached on the server)
 * - "api"     uploads to the Node API and lets the server pick an engine
 */
export type Engine = "browser" | "local" | "api";

export interface TranslationProgress {
    done: number;
    total: number;
}

export interface Transcriber {
    onInputChange: () => void;
    /** Transcription or translation is running (blocks the UI). */
    isBusy: boolean;
    /** Only the transcription step is running — drives the Transcribe button. */
    isTranscribing: boolean;
    isModelLoading: boolean;
    /** True while the Bilingual pipeline is translating the transcript. */
    isTranslating: boolean;
    /** True when the job currently running was started by "Bilingual". */
    bilingualRun: boolean;
    translationProgress?: TranslationProgress;
    progressItems: ProgressItem[];
    start: (
        audioData: AudioBuffer | undefined,
        file?: Blob,
        fileName?: string,
        options?: { bilingual?: boolean },
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

    // Translation (used by the "Bilingual subtitles" button)
    translationEngine: TranslationEngine;
    setTranslationEngine: (engine: TranslationEngine) => void;
    /** Target language id, see TRANSLATION_LANGUAGES. */
    translationTarget: string;
    setTranslationTarget: (target: string) => void;
    /** 🤗 model for the browser / local translation engine. */
    translationModel: string;
    setTranslationModel: (model: string) => void;
    /** Chat model for the Server API translation engine. */
    translationApiModel: string;
    setTranslationApiModel: (model: string) => void;
    /**
     * Server API endpoint used *only* by the translation engine — it does not
     * share the transcription side's Base URL / key / model.
     */
    translationApiBaseUrl: string;
    setTranslationApiBaseUrl: (url: string) => void;
    translationApiKey: string;
    setTranslationApiKey: (key: string) => void;
    /** Extra instructions appended to the LLM prompt (Server API only). */
    translationPrompt: string;
    setTranslationPrompt: (prompt: string) => void;
    /**
     * Translate a transcript that is already on screen — the "Bilingual
     * subtitles" button calls this instead of transcribing the audio again.
     */
    translateExisting: (chunks?: Chunk[]) => void;
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
    const [isTranscribing, setIsTranscribing] = useState(false);
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
                // eslint-disable-next-line no-case-declarations
                const completeMessage = message as TranscriberCompleteData;
                setTranscript({
                    isBusy: false,
                    text: completeMessage.data.text,
                    chunks: completeMessage.data.chunks,
                    progress: completeMessage.progress,
                });
                // Only the ASR pass is over — a bilingual run still has to
                // translate, which flips `isBusy` back on.
                setIsTranscribing(false);
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
                setIsTranscribing(false);
                setBilingualRun(false);
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

    // NOTE: "local" used to mean the in-browser model in an older version;
    // that is "browser" now and "local" is the server side engine. Persist and
    // restore all three values as-is, otherwise picking the local engine in
    // Settings silently falls back to the browser engine after a reload.
    const [engine, setEngineState] = useState<Engine>(() => {
        const stored = loadSetting("engine", Constants.DEFAULT_ENGINE);
        return stored === "api" || stored === "local" || stored === "browser"
            ? stored
            : "browser";
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

    const [translationEngine, setTranslationEngineState] =
        useState<TranslationEngine>(() => {
            const stored = loadSetting(
                "translationEngine",
                Constants.DEFAULT_TRANSLATION_ENGINE,
            );
            return stored === "local" || stored === "api" ? stored : "browser";
        });
    const [translationTarget, setTranslationTargetState] = useState<string>(
        loadSetting("translationTarget", Constants.DEFAULT_TRANSLATION_TARGET),
    );
    const [translationModel, setTranslationModelState] = useState<string>(
        loadSetting("translationModel", Constants.DEFAULT_TRANSLATION_MODEL),
    );
    const [translationApiModel, setTranslationApiModelState] = useState<string>(
        loadSetting(
            "translationApiModel",
            Constants.DEFAULT_TRANSLATION_API_MODEL,
        ),
    );
    const [translationApiBaseUrl, setTranslationApiBaseUrlState] =
        useState<string>(
            loadSetting(
                "translationApiBaseUrl",
                Constants.TRANSLATION_API_BASE_URL,
            ),
        );
    const [translationApiKey, setTranslationApiKeyState] = useState<string>(
        loadSetting("translationApiKey", Constants.TRANSLATION_API_KEY),
    );
    const [translationPrompt, setTranslationPromptState] = useState<string>(
        loadSetting("translationPrompt", Constants.TRANSLATION_PROMPT),
    );

    const [isTranslating, setIsTranslating] = useState(false);
    const [translationProgress, setTranslationProgress] = useState<
        TranslationProgress | undefined
    >(undefined);
    /** Set while a bilingual run is in flight (transcribe → translate). */
    const bilingualRef = useRef(false);
    /** Does the job currently running belong to the "Bilingual" button? */
    const [bilingualRun, setBilingualRun] = useState(false);

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
    const setTranslationEngine = useCallback((value: TranslationEngine) => {
        saveSetting("translationEngine", value);
        setTranslationEngineState(value);
    }, []);
    const setTranslationTarget = useCallback((value: string) => {
        saveSetting("translationTarget", value);
        setTranslationTargetState(value);
    }, []);
    const setTranslationModel = useCallback((value: string) => {
        saveSetting("translationModel", value);
        setTranslationModelState(value);
    }, []);
    const setTranslationApiModel = useCallback((value: string) => {
        saveSetting("translationApiModel", value);
        setTranslationApiModelState(value);
    }, []);
    const setTranslationApiBaseUrl = useCallback((value: string) => {
        saveSetting("translationApiBaseUrl", value);
        setTranslationApiBaseUrlState(value);
    }, []);
    const setTranslationApiKey = useCallback((value: string) => {
        saveSetting("translationApiKey", value);
        setTranslationApiKeyState(value);
    }, []);
    const setTranslationPrompt = useCallback((value: string) => {
        saveSetting("translationPrompt", value);
        setTranslationPromptState(value);
    }, []);

    /**
     * Translate every chunk in place (context aware: the previous lines are
     * handed to the engine as context).
     */
    const translateChunks = useCallback(
        async (chunks: Chunk[]): Promise<Chunk[]> => {
            if (!chunks.length) return chunks;
            setIsTranslating(true);
            setTranslationProgress({ done: 0, total: chunks.length });
            try {
                // The translation side has its own endpoint / key / model and
                // never borrows the transcription ones. The `local` engine
                // always runs on our own server, even if the field points at
                // a third party host.
                const translationBase =
                    translationEngine === "local" &&
                    classifyApiBase(translationApiBaseUrl).kind !== "self"
                        ? SELF_API_BASE
                        : translationApiBaseUrl;
                const lines = chunks.map((chunk) => chunk.text ?? "");
                const translations = await translateLinesWithContext({
                    engine: translationEngine,
                    targetLanguage: translationTarget,
                    sourceLanguage:
                        multilingual && language && language !== "auto"
                            ? language
                            : "",
                    model:
                        translationEngine === "api"
                            ? translationApiModel
                            : translationModel,
                    baseUrl: translationBase,
                    apiKey: translationApiKey,
                    prompt: translationPrompt,
                    lines,
                    onProgress: (done, total) =>
                        setTranslationProgress({ done, total }),
                });
                return chunks.map((chunk, i) => ({
                    ...chunk,
                    trans: translations[i] ?? "",
                }));
            } finally {
                setIsTranslating(false);
                setTranslationProgress(undefined);
            }
        },
        [
            translationEngine,
            translationTarget,
            translationModel,
            translationApiModel,
            translationApiBaseUrl,
            translationApiKey,
            translationPrompt,
            multilingual,
            language,
        ],
    );

    /**
     * Translate a transcript that is already computed — the "Bilingual
     * subtitles" button uses this so clicking it after a plain transcription
     * does not run (and pay for) the ASR pass a second time.
     */
    const translateExisting = useCallback(
        (chunks?: Chunk[]) => {
            const source = chunks ?? transcript?.chunks ?? [];
            if (!source.length) return;

            const text = source
                .map((chunk) => chunk.text ?? "")
                .join("")
                .trim();

            setIsBusy(true);
            setBilingualRun(true);
            translateChunks(source)
                .then((translated) => {
                    setTranscript({
                        isBusy: false,
                        text,
                        chunks: translated,
                        bilingual: true,
                    });
                })
                .catch((error) => {
                    console.error("translation failed", error);
                    alert(
                        `翻译失败：${error?.message ?? error}\n\n` +
                            `请检查 Settings → Translation engine（浏览器/本地引擎需要下载模型，Server API 需要可用端点与 Key）。`,
                    );
                    // Keep the untranslated transcript on screen.
                    setTranscript({
                        isBusy: false,
                        text,
                        chunks: source,
                        bilingual: true,
                    });
                })
                .finally(() => {
                    setIsBusy(false);
                    setBilingualRun(false);
                });
        },
        [transcript, translateChunks],
    );

    // The in-browser (worker) pipeline reports completion through a worker
    // message, so its translation step is kicked off from here.
    useEffect(() => {
        const output = transcript;
        if (!output || output.isBusy || isBusy) return;
        if (!bilingualRef.current || output.bilingual) return;
        if (!output.chunks?.length) {
            bilingualRef.current = false;
            return;
        }

        let cancelled = false;
        setIsBusy(true);
        translateChunks(output.chunks)
            .then((chunks) => {
                if (cancelled) return;
                bilingualRef.current = false;
                setTranscript({ ...output, chunks, bilingual: true });
            })
            .catch((error) => {
                console.error("translation failed", error);
                if (cancelled) return;
                bilingualRef.current = false;
                alert(
                    `翻译失败：${error?.message ?? error}\n\n` +
                        `请检查 Settings → Translation engine（浏览器/本地引擎需要下载模型，Server API 需要可用端点与 Key）。`,
                );
                // Mark the run as finished so the queue can advance.
                setTranscript({ ...output, bilingual: true });
            })
            .finally(() => {
                if (cancelled) return;
                setBilingualRun(false);
                setIsBusy(false);
            });

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [transcript, isBusy, translateChunks]);

    const onInputChange = useCallback(() => {
        bilingualRef.current = false;
        setBilingualRun(false);
        setTranscript(undefined);
    }, []);

    const transcribeWithApi = useCallback(
        async (audioData: AudioBuffer, file?: Blob, fileName?: string) => {
            setIsBusy(true);
            setIsTranscribing(true);
            setUploadProgress(0);
            setTranscript(undefined);

            try {
                const payload = file ?? audioBufferToWav(audioData);
                const name = fileName ?? (file ? "audio" : "audio.wav");

                const result = await transcribeViaApi({
                    // The local engine lives in our own Node server — never
                    // relay it to a third party base url typed for "Server API".
                    baseUrl:
                        engine === "local" &&
                        classifyApiBase(apiBaseUrl).kind !== "self"
                            ? SELF_API_BASE
                            : apiBaseUrl,
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

                // Bilingual: transcribe first, then translate the result.
                const wantBilingual = bilingualRef.current;
                let chunks = result.chunks;
                let bilingual = false;
                setIsTranscribing(false);
                if (wantBilingual && chunks.length) {
                    try {
                        chunks = await translateChunks(chunks);
                        bilingual = true;
                    } catch (translationError: any) {
                        console.error("translation failed", translationError);
                        alert(
                            `翻译失败：${
                                translationError?.message ?? translationError
                            }`,
                        );
                        // Still finish the run so a batch can advance; the
                        // chunks simply keep their empty `trans`.
                        bilingual = true;
                    }
                }
                bilingualRef.current = false;

                setTranscript({
                    isBusy: false,
                    text: result.text,
                    chunks,
                    bilingual,
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
                setIsTranscribing(false);
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
            translateChunks,
        ],
    );

    const postRequest = useCallback(
        async (
            audioData: AudioBuffer | undefined,
            file?: Blob,
            fileName?: string,
            options?: { bilingual?: boolean },
        ) => {
            if (!audioData) return;

            // Remember the request so the translation step can pick it up once
            // the transcript arrives (worker path) or immediately (API path).
            bilingualRef.current = Boolean(options?.bilingual);
            setBilingualRun(Boolean(options?.bilingual));

            if (engine === "api" || engine === "local") {
                await transcribeWithApi(audioData, file, fileName);
                return;
            }

            setTranscript(undefined);
            setIsBusy(true);
            setIsTranscribing(true);

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
            isTranscribing,
            isModelLoading,
            isTranslating,
            bilingualRun,
            translationProgress,
            progressItems,
            start: postRequest,
            translateExisting,
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
            translationEngine,
            setTranslationEngine,
            translationTarget,
            setTranslationTarget,
            translationModel,
            setTranslationModel,
            translationApiModel,
            setTranslationApiModel,
            translationApiBaseUrl,
            setTranslationApiBaseUrl,
            translationApiKey,
            setTranslationApiKey,
            translationPrompt,
            setTranslationPrompt,
        };
    }, [
        isBusy,
        isTranscribing,
        isModelLoading,
        isTranslating,
        bilingualRun,
        translationProgress,
        progressItems,
        postRequest,
        translateExisting,
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
        translationEngine,
        setTranslationEngine,
        translationTarget,
        setTranslationTarget,
        translationModel,
        setTranslationModel,
        translationApiModel,
        setTranslationApiModel,
        translationApiBaseUrl,
        setTranslationApiBaseUrl,
        translationApiKey,
        setTranslationApiKey,
        translationPrompt,
        setTranslationPrompt,
    ]);

    return transcriber;
}
