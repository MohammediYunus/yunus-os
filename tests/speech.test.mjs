import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { createSpeech, speechCapabilities } from '../lib/speech.mjs';
import { defaults, validateConfig } from '../lib/config.mjs';
import { createApp } from '../server.mjs';

const audio = Buffer.from('ID3-synthetic-audio-fixture');
const live = () => validateConfig({ mode: 'live', voice: { enabled: true, outputProvider: 'elevenlabs', elevenlabsApiKey: 'fixture-speech-key', elevenlabsVoiceId: 'fixtureVoice', elevenlabsModel: 'eleven_multilingual_v2' } });
const response = (body = audio, options = {}) => new Response(body, { headers: { 'content-type': 'audio/mpeg' }, ...options });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('capabilities and unavailable speech never call a provider, including explicitly configured demo mode', async () => {
  const cases = [defaults(), { ...live(), mode: 'demo' }, validateConfig({ voice: { enabled: false } }, live()), validateConfig({ voice: { outputProvider: 'system' } }, live()), validateConfig({ voice: { clearElevenlabsApiKey: true } }, live()), validateConfig({ voice: { elevenlabsVoiceId: '' } }, live())];
  let calls = 0;
  for (const config of cases) {
    const speech = createSpeech({ getConfig: () => config, fetchImpl: () => { calls++; throw new Error('Must not call'); } });
    assert.equal(typeof speechCapabilities(config).available, 'boolean');
    await assert.rejects(speech.speak('A reply'), error => error.status === 403);
  }
  assert.equal(calls, 0);
  assert.equal(speechCapabilities(live()).available, true, 'Speech output does not require a Whisper executable or model');
});

test('one bounded request uses the fixed origin, exact reply and configured voice/model', async () => {
  const calls = [], text = 'Ready to add "the release checklist".\nApprove it when ready.';
  const speech = createSpeech({ getConfig: live, fetchImpl: async (url, options) => { calls.push({ url, options }); return response(); } });
  assert.deepEqual(await speech.speak(text), audio);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/fixtureVoice?output_format=mp3_44100_128');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['xi-api-key'], 'fixture-speech-key');
  assert.deepEqual(JSON.parse(calls[0].options.body), { text, model_id: 'eleven_multilingual_v2' });
  assert.equal(calls[0].options.signal.aborted, false);
  for (const invalid of ['', '  ', 'x'.repeat(4001), null, 5]) await assert.rejects(speech.speak(invalid), error => error.status === 400);
  assert.equal(calls.length, 1, 'Invalid text is rejected before any request');
  assert.deepEqual(await speech.speak('x'.repeat(4000)), audio);
});

for (const status of [401, 403, 429, 500, 302]) test(`upstream ${status} is a safe error without retries or provider body leakage`, async () => {
  let calls = 0;
  const speech = createSpeech({ getConfig: live, fetchImpl: async () => { calls++; return response('fixture-speech-key provider detail', { status, headers: { 'content-type': 'application/json' } }); } });
  await assert.rejects(speech.speak('Reply'), error => {
    assert.equal(error.status, status === 429 ? 429 : 502);
    assert.doesNotMatch(error.message, /fixture-speech-key|provider detail|LOCAL_SESSION_EXPIRED/);
    return true;
  });
  assert.equal(calls, 1);
});

test('an upstream 401 quota code becomes a safe usage error without provider details or retry', async () => {
  let calls = 0;
  await withApp(async () => {
    calls++;
    return response(JSON.stringify({ detail: { status: 'quota_exceeded', message: 'fixture-speech-key private usage details' } }), { status: 401, headers: { 'content-type': 'application/json' } });
  }, async ({ request }) => {
    await request('/api/config', live());
    const result = await request('/api/speech', { text: 'Reply' });
    assert.equal(result.status, 429);
    const error = await result.json();
    assert.equal(error.error, 'ElevenLabs speech quota is exhausted. Check your account before trying again.');
    assert.equal(error.code, undefined);
    assert.doesNotMatch(JSON.stringify(error), /fixture-speech-key|private usage|LOCAL_SESSION_EXPIRED/);
    assert.equal(calls, 1);
  });
});

test('malformed and unknown provider error bodies keep the generic status mapping', async () => {
  for (const body of ['{invalid fixture-speech-key', '', 'null', '{"detail":{"status":"missing_permissions","message":"fixture-speech-key"}}', '{"message":"quota_exceeded"}']) {
    let calls = 0;
    const speech = createSpeech({ getConfig: live, fetchImpl: async () => { calls++; return response(body, { status: 401 }); } });
    await assert.rejects(speech.speak('Reply'), error => error.status === 502 && !/fixture-speech-key|quota|missing_permissions/.test(error.message));
    assert.equal(calls, 1);
  }
});

for (const declared of [false, true]) test(`${declared ? 'declared' : 'streamed'} provider error over16KiB is discarded`, async () => {
  let cancelled = false, calls = 0;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from(JSON.stringify({ detail: { status: 'quota_exceeded', message: 'x'.repeat(16 * 1024) } }))); },
    cancel() { cancelled = true; },
  });
  const speech = createSpeech({ getConfig: live, fetchImpl: async () => {
    calls++; return response(body, { status: 401, headers: { 'content-type': 'application/json', ...(declared ? { 'content-length': '16385' } : {}) } });
  } });
  await assert.rejects(speech.speak('Reply'), error => error.status === 502 && !/quota/.test(error.message));
  assert.equal(cancelled, true); assert.equal(calls, 1);
});

for (const action of ['cancel', 'timeout']) test(`${action} stops a hanging provider error body under the original request deadline`, async () => {
  const ready = deferred(); let cancelled = false, calls = 0;
  const body = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('{"detail":')); }, cancel() { cancelled = true; } });
  const speech = createSpeech({ getConfig: live, timeoutMs: action === 'timeout' ? 20 : 2000, fetchImpl: async () => {
    calls++; ready.resolve(); return response(body, { status: 401 });
  } });
  const checked = assert.rejects(speech.speak('Reply'), error => error.status === (action === 'timeout' ? 504 : 409));
  await ready.promise; await nextTurn();
  if (action === 'cancel') speech.cancel();
  await checked;
  assert.equal(cancelled, true); assert.equal(calls, 1);
});

test('network failures do not disclose upstream details or retry', async () => {
  let calls = 0;
  const speech = createSpeech({ getConfig: live, fetchImpl: async () => { calls++; throw new Error('Authorization fixture-speech-key https://private-detail'); } });
  await assert.rejects(speech.speak('Reply'), error => error.status === 502 && !/fixture|private-detail/.test(error.message));
  assert.equal(calls, 1);
});

test('empty, wrong-type, declared oversize and streamed oversize responses are rejected and cancelled', async () => {
  await assert.rejects(createSpeech({ getConfig: live, fetchImpl: async () => response('') }).speak('Reply'), /no audio/);
  await assert.rejects(createSpeech({ getConfig: live, fetchImpl: async () => response('not audio', { headers: { 'content-type': 'text/html' } }) }).speak('Reply'), /unsupported audio/);
  let declaredCancelled = false, streamedCancelled = false;
  const declared = new ReadableStream({ cancel() { declaredCancelled = true; } });
  await assert.rejects(createSpeech({ getConfig: live, fetchImpl: async () => response(declared, { headers: { 'content-type': 'audio/mpeg', 'content-length': '8388609' } }) }).speak('Reply'), /size limit/);
  const streamed = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); }, cancel() { streamedCancelled = true; } });
  await assert.rejects(createSpeech({ getConfig: live, fetchImpl: async () => response(streamed) }).speak('Reply'), /size limit/);
  assert.equal(declaredCancelled, true); assert.equal(streamedCancelled, true);
});

for (const stage of ['fetch', 'body']) for (const action of ['caller', 'cancel', 'timeout']) {
  test(`${action} stops pending speech ${stage} without waiting for the provider`, async () => {
    const ready = deferred(), gate = deferred(), caller = new AbortController();
    let bodyCancelled = false, upstreamSignal;
    const body = new ReadableStream({ cancel() { bodyCancelled = true; } });
    const speech = createSpeech({ getConfig: live, timeoutMs: action === 'timeout' ? 20 : 2000, fetchImpl: (_url, options) => {
      upstreamSignal = options.signal; ready.resolve(); return stage === 'fetch' ? gate.promise : response(body);
    } });
    const pending = speech.speak('Reply', { signal: caller.signal });
    const checked = assert.rejects(pending, error => error.status === (action === 'timeout' ? 504 : 409));
    await ready.promise; await nextTurn();
    if (action === 'caller') caller.abort();
    if (action === 'cancel') speech.cancel();
    await checked;
    assert.equal(upstreamSignal.aborted, true);
    if (stage === 'fetch') gate.resolve(response(body));
    await nextTurn();
    assert.equal(bodyCancelled, true, 'Late or pending audio is discarded');
  });
}

test('an already aborted caller does not make a speech request', async () => {
  let calls = 0; const caller = new AbortController(); caller.abort();
  const speech = createSpeech({ getConfig: live, fetchImpl: () => { calls++; } });
  await assert.rejects(speech.speak('Reply', { signal: caller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

async function withApp(fetchImpl, run) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'yos-speech-http-'));
  const app = await createApp({ configDir: profile, fetchImpl });
  try {
    const { token } = await (await fetch(`${app.origin}/api/session`)).json();
    const headers = { 'content-type': 'application/json', 'X-Yunus-Token': token, Origin: app.origin };
    const request = (route, body, options = {}) => fetch(`${app.origin}${route}`, { method: 'POST', headers, body: JSON.stringify(body), ...options });
    await run({ app, request, headers });
  } finally { await app.close(); await rm(profile, { recursive: true, force: true }); }
}

test('speech HTTP route is authenticated, origin checked, bounded and unavailable in demo', async () => {
  let calls = 0;
  await withApp(async () => { calls++; return response(); }, async ({ app, request, headers }) => {
    const config = await (await request('/api/config', live())).json();
    assert.equal(config.capabilities.speech.provider, 'elevenlabs');
    assert.equal(config.capabilities.speech.available, true);
    assert.equal(config.config.voice.hasElevenlabsApiKey, true);
    assert.doesNotMatch(JSON.stringify(config), /fixture-speech-key/);
    const read = await (await fetch(`${app.origin}/api/config`, { headers })).json();
    assert.doesNotMatch(JSON.stringify(read), /fixture-speech-key/);
    assert.equal(calls, 0, 'Startup, save and capabilities do not synthesize speech');
    const unauthorized = await request('/api/speech', { text: 'Reply' }, { headers: { 'content-type': 'application/json' } });
    assert.equal(unauthorized.status, 401); assert.equal((await unauthorized.json()).code, 'LOCAL_SESSION_EXPIRED');
    assert.equal((await request('/api/speech', { text: 'Reply' }, { headers: { ...headers, Origin: 'https://unrelated.invalid' } })).status, 403);
    assert.equal((await request('/api/speech', { text: 'Reply' }, { headers: { ...headers, 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await request('/api/speech', { text: 'x'.repeat(4001) })).status, 400);
    assert.equal((await request('/api/speech', { text: 'x'.repeat(65536) })).status, 413);
    await request('/api/config', { mode: 'demo' });
    assert.equal((await request('/api/speech', { text: 'Reply' })).status, 403);
    assert.equal(calls, 0);
    await request('/api/config', { mode: 'live' });
    const spoken = await request('/api/speech', { text: 'Reply' });
    assert.equal(spoken.status, 200); assert.equal(spoken.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual(Buffer.from(await spoken.arrayBuffer()), audio);
    assert.equal(calls, 1);
  });
});

test('upstream authentication failure cannot be mistaken for a local expired session', async () => {
  let calls = 0;
  await withApp(async () => { calls++; return response('fixture-speech-key', { status: 401 }); }, async ({ request }) => {
    await request('/api/config', live());
    const result = await request('/api/speech', { text: 'Reply' });
    assert.equal(result.status, 502);
    const error = await result.json();
    assert.equal(error.code, undefined); assert.doesNotMatch(JSON.stringify(error), /fixture-speech-key|LOCAL_SESSION_EXPIRED/);
    assert.equal(calls, 1);
  });
});

for (const action of ['cancel', 'config', 'disconnect', 'shutdown']) test(`HTTP ${action} aborts pending speech without occupying the assistant slot`, async () => {
  const ready = deferred(), aborted = deferred(); let speechSignal;
  await withApp((_url, options) => {
    speechSignal = options.signal; speechSignal.addEventListener('abort', aborted.resolve, { once: true });
    ready.resolve(); return new Promise(() => {});
  }, async ({ app, request }) => {
    await request('/api/config', live());
    const caller = new AbortController();
    const pending = request('/api/speech', { text: 'Reply' }, { signal: caller.signal }).then(async result => ({ status: result.status, body: await result.json() }), error => ({ name: error.name }));
    await ready.promise;
    const assistant = await request('/api/assistant', { message: 'Add a task: independent text request' });
    assert.equal(assistant.status, 200, 'Pending speech must not block text requests');
    if (action === 'cancel') assert.equal((await request('/api/assistant/cancel', {})).status, 200);
    if (action === 'config') assert.equal((await request('/api/config', { displayName: 'Updated fixture' })).status, 200);
    if (action === 'disconnect') caller.abort();
    if (action === 'shutdown') await app.close();
    await aborted.promise;
    assert.equal(speechSignal.aborted, true);
    const result = await pending;
    if (['cancel', 'config'].includes(action)) assert.equal(result.status, 409);
    else assert.ok(result.name);
  });
});
