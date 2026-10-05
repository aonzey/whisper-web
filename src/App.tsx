import { useCallback, useRef, useState } from "react";
import { AudioManager } from "./components/AudioManager";
import Transcript from "./components/Transcript";
import { useTranscriber } from "./hooks/useTranscriber";

function App() {
    const transcriber = useTranscriber();
    const [fileName, setFileName] = useState<string | undefined>(undefined);

    // Shared with Transcript so the subtitle list can follow (and control)
    // the player.
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const [currentTime, setCurrentTime] = useState(0);

    const seekTo = useCallback((time: number) => {
        const element = audioRef.current;
        if (!element) return;
        element.currentTime = time;
        // Autoplay may be blocked until the user interacts; ignore failures.
        void element.play().catch(() => {});
    }, []);

    return (
        <div className='flex justify-center items-center min-h-screen'>
            <div className='container flex flex-col justify-center items-center'>
                <h1 className='text-5xl font-extrabold tracking-tight text-slate-900 sm:text-7xl text-center'>
                    Whisper Web
                </h1>
                <h2 className='mt-3 mb-5 px-4 text-center text-1xl font-semibold tracking-tight text-slate-900 sm:text-2xl'>
                    ML-powered speech recognition directly in your browser
                </h2>
                <AudioManager
                    transcriber={transcriber}
                    onSelectedFileChange={setFileName}
                    audioRef={audioRef}
                    onTimeUpdate={setCurrentTime}
                />
                <Transcript
                    transcribedData={transcriber.output}
                    fileName={fileName}
                    currentTime={currentTime}
                    onSeek={seekTo}
                />
            </div>

            <div className='absolute bottom-4'>
                Made with{" "}
                <a
                    className='underline'
                    href='https://github.com/xenova/transformers.js'
                >
                    🤗 Transformers.js
                </a>
            </div>
        </div>
    );
}

export default App;
