function padTime(time: number) {
    return String(time).padStart(2, "0");
}

export function formatAudioTimestamp(time: number) {
    const hours = (time / (60 * 60)) | 0;
    time -= hours * (60 * 60);
    const minutes = (time / 60) | 0;
    time -= minutes * 60;
    const seconds = time | 0;
    return `${hours ? padTime(hours) + ":" : ""}${padTime(minutes)}:${padTime(
        seconds,
    )}`;
}

/**
 * Encode an AudioBuffer as a 16-bit PCM WAV blob.
 * Used when sending microphone recordings / URL audio to the server API.
 */
export function audioBufferToWav(buffer: AudioBuffer): Blob {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const bytesPerSample = 2; // 16-bit PCM
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = buffer.length * blockAlign;
    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);

    const writeString = (offset: number, str: string) => {
        for (let i = 0; i < str.length; ++i) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    };

    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true); // bit depth
    writeString(36, "data");
    view.setUint32(40, dataSize, true);

    const channels: Float32Array[] = [];
    for (let c = 0; c < numChannels; ++c) {
        channels.push(buffer.getChannelData(c));
    }

    let offset = 44;
    for (let i = 0; i < buffer.length; ++i) {
        for (let c = 0; c < numChannels; ++c) {
            const sample = Math.max(-1, Math.min(1, channels[c][i]));
            view.setInt16(
                offset,
                sample < 0 ? sample * 0x8000 : sample * 0x7fff,
                true,
            );
            offset += 2;
        }
    }

    return new Blob([arrayBuffer], { type: "audio/wav" });
}
