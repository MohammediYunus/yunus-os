// Record mono PCM and encode a bounded 16 kHz WAV for local whisper.cpp.
export async function recordMicrophone(onLimit) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access is unavailable in this browser. You can still type a request.');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false });
  let context, source, processor, silence, timer;
  const chunks = [];
  let stopped = false;
  const cleanup = async () => {
    clearTimeout(timer); source?.disconnect(); processor?.disconnect(); silence?.disconnect(); stream.getTracks().forEach(track => track.stop());
    if (context && context.state !== 'closed') await context.close().catch(() => {});
  };
  try {
    context = new AudioContext();
    await context.audioWorklet.addModule('/js/lib/pcm-capture.js');
    source = context.createMediaStreamSource(stream); processor = new AudioWorkletNode(context, 'yos-pcm-capture'); silence = context.createGain(); silence.gain.value = 0;
    processor.port.onmessage = event => { if (!stopped && event.data instanceof Float32Array) chunks.push(event.data); };
    source.connect(processor); processor.connect(silence); silence.connect(context.destination);
    await context.resume(); timer = setTimeout(onLimit, 30_000);
    return {
      async stop({ discard = false } = {}) {
        if (stopped) return null;
        stopped = true;
        const rate = context.sampleRate;
        await cleanup();
        if (discard) return null;
        const size = chunks.reduce((n, chunk) => n + chunk.length, 0);
        if (size < rate * 0.15) throw new Error('The recording was too short. Press Record and speak for a moment.');
        const pcm = new Float32Array(size); let offset = 0;
        for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.length; }
        const targetRate = 16_000, samples = Math.min(targetRate * 30, Math.floor(size * targetRate / rate));
        const buffer = new ArrayBuffer(44 + samples * 2), view = new DataView(buffer);
        const word = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
        word(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); word(8, 'WAVE'); word(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, targetRate, true); view.setUint32(28, targetRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); word(36, 'data'); view.setUint32(40, samples * 2, true);
        for (let i = 0; i < samples; i++) {
          const at = i * rate / targetRate, lo = Math.floor(at), fraction = at - lo;
          const sample = Math.max(-1, Math.min(1, pcm[lo] * (1 - fraction) + (pcm[Math.min(lo + 1, size - 1)] || 0) * fraction));
          view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
        }
        return new Blob([buffer], { type: 'audio/wav' });
      },
    };
  } catch (error) { await cleanup(); throw error; }
}
