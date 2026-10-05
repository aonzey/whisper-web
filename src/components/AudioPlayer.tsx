import { useEffect, useRef } from "react";

export default function AudioPlayer(props: {
    audioUrl: string;
    mimeType: string;
    /** Lets the parent read / control the element (seek from the subtitles). */
    playerRef?: React.MutableRefObject<HTMLAudioElement | null>;
    /** Fired on every timeupdate (~4x per second). */
    onTimeUpdate?: (time: number) => void;
}) {
    const audioPlayer = useRef<HTMLAudioElement>(null);
    const audioSource = useRef<HTMLSourceElement>(null);

    // Keep the parent's ref in sync
    useEffect(() => {
        if (props.playerRef) {
            props.playerRef.current = audioPlayer.current;
        }
    }, [props.playerRef, props.audioUrl]);

    // Updates src when url changes
    useEffect(() => {
        if (audioPlayer.current && audioSource.current) {
            audioSource.current.src = props.audioUrl;
            audioPlayer.current.load();
        }
    }, [props.audioUrl]);

    return (
        <div className='flex relative z-10 p-4 w-full'>
            <audio
                ref={audioPlayer}
                controls
                onTimeUpdate={(event) =>
                    props.onTimeUpdate?.(event.currentTarget.currentTime)
                }
                className='w-full h-14 rounded-lg bg-white shadow-xl shadow-black/5 ring-1 ring-slate-700/10'
            >
                <source ref={audioSource} type={props.mimeType}></source>
            </audio>
        </div>
    );
}
