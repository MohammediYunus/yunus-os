const MAX_TEXT = 4000;
const MAX_AUDIO = 8 * 1024 * 1024;
const MAX_ERROR = 16 * 1024;
class SpeechError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export function speechCapabilities(config) {
  const voice = config.voice || {}, provider = voice.outputProvider || 'system';
  const unavailable = reason => ({ provider, available: false, reason });
  if (!voice.enabled) return unavailable('Enable spoken replies in Connections');
  if (provider === 'system') return { provider, available: true, reason: 'Uses an available local system voice' };
  if (provider !== 'elevenlabs') return unavailable('Choose a supported speech provider');
  if (config.mode !== 'live') return unavailable('ElevenLabs speech requires My workspace mode');
  if (!voice.elevenlabsApiKey) return unavailable('Add an ElevenLabs API key in Connections');
  if (!voice.elevenlabsVoiceId) return unavailable('Choose an ElevenLabs voice ID in Connections');
  return { provider, available: true, reason: 'Uses your ElevenLabs account when a spoken reply is requested' };
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function providerErrorStatus(response, signal) {
  if (!response.body) return null;
  if (Number(response.headers.get('content-length')) > MAX_ERROR) {
    void response.body.cancel().catch(() => {}); return null;
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0, completed = false;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) { completed = true; break; }
      size += value.byteLength;
      if (size > MAX_ERROR) return null;
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))?.detail?.status; }
    catch { return null; }
  } finally {
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createSpeech({ getConfig, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const active = new Set();
  return {
    cancel() { for (const controller of active) controller.abort(); },
    async speak(text, { signal } = {}) {
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) throw new SpeechError('Use speech text between 1 and 4,000 characters', 400);
      const config = getConfig(), voice = config.voice || {}, capability = speechCapabilities(config);
      if (!capability.available || capability.provider !== 'elevenlabs') throw new SpeechError(capability.provider === 'system' ? 'Choose ElevenLabs for cloud speech in Connections' : capability.reason, 403);
      signal?.throwIfAborted();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) controller.abort();
      let timedOut = false, reader, completed = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      active.add(controller);
      try {
        controller.signal.throwIfAborted();
        const pending = Promise.resolve(fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.elevenlabsVoiceId)}?output_format=mp3_44100_128`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg', 'xi-api-key': voice.elevenlabsApiKey },
          body: JSON.stringify({ text, model_id: voice.elevenlabsModel }),
        })).then(response => {
          if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); controller.signal.throwIfAborted(); }
          return response;
        });
        const response = await abortable(pending, controller.signal);
        if (!response.ok) {
          const providerStatus = await providerErrorStatus(response, controller.signal);
          if (providerStatus === 'quota_exceeded') throw new SpeechError('ElevenLabs speech quota is exhausted. Check your account before trying again.', 429);
          if ([401, 403].includes(response.status)) throw new SpeechError('ElevenLabs rejected the API key or voice access. Check Connections.', 502);
          if (response.status === 429) throw new SpeechError('ElevenLabs usage or rate limit reached. Check your account before trying again.', 429);
          throw new SpeechError('ElevenLabs could not prepare this spoken reply. You can try again.', 502);
        }
        if (response.headers.get('content-type')?.split(';')[0].trim() !== 'audio/mpeg') {
          void response.body?.cancel().catch(() => {});
          throw new SpeechError('ElevenLabs returned an unsupported audio response', 502);
        }
        const length = Number(response.headers.get('content-length'));
        if (length > MAX_AUDIO) {
          void response.body?.cancel().catch(() => {});
          throw new SpeechError('The spoken reply exceeded the audio size limit', 502);
        }
        reader = response.body?.getReader();
        if (!reader) throw new SpeechError('ElevenLabs returned no audio', 502);
        const chunks = []; let size = 0;
        while (true) {
          const { done, value } = await abortable(reader.read(), controller.signal);
          if (done) break;
          size += value.byteLength;
          if (size > MAX_AUDIO) throw new SpeechError('The spoken reply exceeded the audio size limit', 502);
          chunks.push(Buffer.from(value));
        }
        if (!size) throw new SpeechError('ElevenLabs returned no audio', 502);
        completed = true;
        return Buffer.concat(chunks, size);
      } catch (error) {
        if (timedOut) throw new SpeechError('ElevenLabs speech timed out. You can try again.', 504);
        if (controller.signal.aborted) throw new SpeechError('Spoken reply cancelled', 409);
        if (error instanceof SpeechError) throw error;
        throw new SpeechError('Could not connect to ElevenLabs. Check your speech settings and try again.', 502);
      } finally {
        clearTimeout(timer); active.delete(controller); signal?.removeEventListener('abort', abort);
        if (reader) {
          if (!completed) void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
    },
  };
}
