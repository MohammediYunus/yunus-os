import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { transcribe, validateWav, voiceCapabilities, cancelVoice } from '../lib/voice.mjs';

function wav() {
  const value = Buffer.alloc(364);
  value.write('RIFF'); value.writeUInt32LE(value.length - 8, 4); value.write('WAVEfmt ', 8);
  value.writeUInt32LE(16, 16); value.writeUInt16LE(1, 20); value.writeUInt16LE(1, 22);
  value.writeUInt32LE(16000, 24); value.writeUInt32LE(32000, 28); value.writeUInt16LE(2, 32); value.writeUInt16LE(16, 34);
  value.write('data', 36); value.writeUInt32LE(value.length - 44, 40);
  return value;
}

async function withConfig(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yos-voice-test-'));
  const model = path.join(directory, 'model.bin');
  await writeFile(model, 'fixture, not a real model');
  try { await fn({ voice: { enabled: true, whisperExecutable: process.execPath, whisperModelPath: model } }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('voice stays disabled or reports missing local prerequisites without executing anything', async () => {
  assert.equal((await voiceCapabilities({ voice: { enabled: false } })).available, false);
  assert.equal((await voiceCapabilities({ voice: { enabled: true, whisperExecutable: '/not/a/real/binary' } })).available, false);
  await assert.rejects(transcribe(wav(), { voice: { enabled: false } }), /Enable local voice/);
});

test('WAV validation rejects malformed chunks, missing speech data and unsupported formats', () => {
  validateWav(wav());
  assert.throws(() => validateWav(Buffer.from('not audio')), /WAV/);
  const sampleRate = wav(); sampleRate.writeUInt32LE(48000, 24);
  assert.throws(() => validateWav(sampleRate), /16 kHz/);
  const malformed = wav(); malformed.writeUInt32LE(0xffffffff, 40);
  assert.throws(() => validateWav(malformed), /Incomplete/);
  const truncated = wav().subarray(0, 44);
  assert.throws(() => validateWav(truncated), /Incomplete/);
});

test('transcription uses explicit local model, private temporary file and removes recordings', async () => {
  await withConfig(async config => {
    let recording;
    const result = await transcribe(wav(), config, { processRunner: async (_executable, args, options) => {
      recording = args[args.indexOf('-f') + 1];
      assert.equal(args[args.indexOf('-m') + 1], config.voice.whisperModelPath);
      assert.deepEqual(await readFile(recording), wav());
      if (process.platform !== 'win32') assert.equal((await stat(recording)).mode & 0o777, 0o600);
      assert.equal(path.dirname(recording), options.cwd);
      return ' Show my open tasks.\n';
    } });
    assert.deepEqual(result, { text: 'Show my open tasks.' });
    await assert.rejects(access(recording));
    await assert.rejects(access(path.dirname(recording)));
  });
});

test('local failure never falls back to a network provider and still removes recording', async () => {
  await withConfig(async config => {
    let recording;
    await assert.rejects(transcribe(wav(), config, { processRunner: async (_binary, args) => { recording = args[args.indexOf('-f') + 1]; throw new Error('local model failed'); } }), /local model failed/);
    await assert.rejects(access(recording));
  });
});

test('voice cancel aborts active child and cleans temporary recording', async () => {
  await withConfig(async config => {
    let recording, started;
    const ready = new Promise(resolve => { started = resolve; });
    const pending = transcribe(wav(), config, { processRunner: async (_binary, args, { signal }) => { recording = args[args.indexOf('-f') + 1]; return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }); started(); }); } });
    await ready; cancelVoice();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(access(recording));
  });
});
