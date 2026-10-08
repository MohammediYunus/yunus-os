import { mkdtemp, writeFile, rm, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable, runTextProcess } from './assistant.mjs';

const active = new Set();
export function cancelVoice() { for (const controller of active) controller.abort(); }

export async function voiceCapabilities(configuration) {
  const config = configuration.voice || configuration;
  if (!config.enabled) return { enabled: false, available: false, reason: 'Enable local voice in Settings' };
  if (!await findExecutable(config.whisperExecutable || 'whisper-cli')) return { enabled: true, available: false, reason: 'whisper-cli is not installed or its configured path is unavailable' };
  try {
    if (!config.whisperModelPath || !path.isAbsolute(config.whisperModelPath)) throw new Error();
    await access(config.whisperModelPath, constants.R_OK);
    const model = await stat(config.whisperModelPath);
    if (!model.isFile() || !model.size) throw new Error();
  } catch { return { enabled: true, available: false, reason: 'Choose an existing local Whisper model file with an absolute path' }; }
  return { enabled: true, available: true, local: true };
}

export function validateWav(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.length > 10 * 1024 * 1024 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected a WAV recording under 10 MB');
  if (wav.readUInt32LE(4) + 8 > wav.length) throw new Error('Incomplete WAV recording');
  let format = false, audioBytes = 0;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const name = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (offset + 8 + size > wav.length) throw new Error('Incomplete WAV chunk');
    if (name === 'fmt ') {
      if (size < 16 || wav.readUInt16LE(offset + 8) !== 1 || wav.readUInt16LE(offset + 10) !== 1 || wav.readUInt32LE(offset + 12) !== 16000 || wav.readUInt16LE(offset + 22) !== 16) throw new Error('Voice expects 16 kHz, mono, 16-bit PCM WAV');
      format = true;
    }
    if (name === 'data') audioBytes += size;
    offset += 8 + size + size % 2;
  }
  if (!format || !audioBytes || audioBytes % 2) throw new Error('WAV recording has no valid PCM audio');
}

export async function transcribe(wav, configuration, { signal, processRunner = runTextProcess, timeoutMs = 60_000 } = {}) {
  validateWav(wav);
  signal?.throwIfAborted();
  const capabilities = await voiceCapabilities(configuration);
  if (!capabilities.available) throw new Error(capabilities.reason);
  const config = configuration.voice || configuration;
  const executable = await findExecutable(config.whisperExecutable || 'whisper-cli');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  active.add(controller);
  let directory;
  try {
    controller.signal.throwIfAborted();
    directory = await mkdtemp(path.join(os.tmpdir(), 'yunus-voice-'));
    const recording = path.join(directory, 'recording.wav');
    await writeFile(recording, wav, { mode: 0o600 });
    const text = await processRunner(executable, ['-m', config.whisperModelPath, '-f', recording, '-nt', '-np'], { cwd: directory, signal: controller.signal, timeoutMs });
    const cleaned = String(text).replace(/\[[^\]\n]*(?:BLANK_AUDIO|SILENCE|MUSIC)[^\]\n]*\]/gi, '').replace(/\s+/g, ' ').trim();
    if (!cleaned) throw new Error('No speech detected. Try a shorter, clearer recording.');
    return { text: cleaned.slice(0, 8000) };
  } finally {
    active.delete(controller); signal?.removeEventListener('abort', abort);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
