import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { initAssistant } from '../js/lib/assistant.js';

// The real Assistant, drawer, UI helper and handlers run with a minimal DOM.
// Speech is simulated: these tests never request a microphone or play audio.
const globalNames = ['document', 'navigator', 'window', 'speechSynthesis', 'SpeechSynthesisUtterance', 'Audio', 'URL'];
const originalGlobals = new Map(globalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
test.afterEach(() => { for (const [name, descriptor] of originalGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });

class Element {
  constructor(tag, text = '') { this.tagName = tag; this.nodeType = tag === '#text' ? 3 : 1; this.text = text; this.children = []; this.attributes = {}; this.listeners = {}; this.value = ''; this.disabled = false; this.hidden = false; this.history = []; this.classList = { add() {}, remove() {}, toggle() {} }; }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  setAttribute(name, value) { this.attributes[name] = value; if (['id', 'name'].includes(name)) this[name] = value; if (['disabled', 'hidden'].includes(name)) this[name] = true; }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  remove() { this.parentElement.children = this.parentElement.children.filter(el => el !== this); this.parentElement = null; }
  focus() { document.activeElement = this; }
  scrollIntoView() {}
  showModal() { this.open = true; }
  close() { this.open = false; for (const callback of this.listeners.close || []) callback({}); }
  get isConnected() { return this === document.body || !!this.parentElement?.isConnected; }
  set textContent(text) { this.text = ''; this.children = [new Element('#text', String(text))]; this.history.push(String(text)); }
  get textContent() { return this.nodeType === 3 ? this.text : this.children.map(child => child.textContent).join(''); }
}
const descendants = element => [element, ...element.children.flatMap(descendants)];
const localVoice = { name: 'Fixture local voice', lang: 'en-US', localService: true };
function setup({ voices = [], browserDemo = false, supported = true, enabled = true, speakError = null, cancelError = null, outputProvider, mode = 'live', speechAvailable = true, whisperAvailable = true, speechApi = async () => new Blob(['fixture audio'], { type: 'audio/mpeg' }), playResults = [], nativeSpeech = false } = {}) {
  globalThis.document = { body: new Element('body'), createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text) };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US' } });
  let installedVoices = voices;
  const spoken = [], apiCalls = [], requests = [], audio = [], revoked = [], created = [], nativeMessages = [];
  const voiceConfig = { enabled, outputProvider };
  const OriginalURL = globalThis.URL;
  globalThis.URL = class extends OriginalURL {
    static createObjectURL(blob) { const url = `blob:fixture-${created.length}`; created.push({ url, blob }); return url; }
    static revokeObjectURL(url) { revoked.push(url); }
  };
  globalThis.Audio = class {
    constructor(src) { this.src = src; this.plays = 0; this.paused = false; audio.push(this); }
    play() { this.plays++; const result = playResults.shift(); return result instanceof Error ? Promise.reject(result) : Promise.resolve(result); }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    load() { this.loaded = true; }
  };
  class Utterance { constructor(text) { this.text = text; } }
  const synth = { getVoices: () => installedVoices, cancel: () => { if (cancelError) spoken.at(-1)?.onerror({ error: cancelError }); }, speak: utterance => { if (speakError) throw speakError; spoken.push(utterance); } };
  globalThis.window = supported ? { speechSynthesis: synth, SpeechSynthesisUtterance: Utterance } : {};
  if (nativeSpeech) window.webkit = { messageHandlers: { yunusSpeech: { postMessage: message => nativeMessages.push(message) } } };
  globalThis.speechSynthesis = supported ? synth : undefined;
  globalThis.SpeechSynthesisUtterance = supported ? Utterance : undefined;
  const assistant = initAssistant({
    browserDemo, getConfig: () => ({ assistant: { provider: 'local' }, voice: voiceConfig, mode }),
    getCapabilities: () => ({ voice: { available: whisperAvailable }, speech: { provider: voiceConfig.outputProvider || 'system', available: speechAvailable, reason: speechAvailable ? undefined : 'ElevenLabs needs a saved key and voice ID.' } }),
    api: async (route, options) => { apiCalls.push(route); requests.push({ route, options }); if (route === '/api/speech') return speechApi(options); if (route === '/api/assistant') return { text: `Fixture reply to ${options.body.message}` }; if (route === '/api/assistant/cancel') return { ok: true }; throw new Error('Unexpected route'); },
    onRefresh: async () => {}, openConnections() {},
  });
  assistant.open();
  const elements = descendants(document.body), find = predicate => elements.find(predicate);
  const form = find(el => el.tagName === 'form'), input = find(el => el.id === 'assistant-message');
  const note = find(el => el.className === 'field-help'), status = find(el => el.className === 'assistant-status');
  const stop = find(el => el.tagName === 'button' && el.textContent === 'Stop');
  const log = find(el => el.className === 'conversation');
  const playReply = find(el => el.tagName === 'button' && el.textContent === 'Play reply'), record = find(el => el.tagName === 'button' && el.textContent === 'Record');
  const snapshot = () => ({ note: note.textContent, status: status.textContent, stopDisabled: stop.disabled, spoken: spoken.length, replyVisible: log.textContent.includes('Fixture reply'), noteHistory: [...note.history], playHidden: playReply.hidden, playDisabled: playReply.disabled, recordDisabled: record.disabled });
  return { assistant, spoken, snapshot, apiCalls, requests, audio, revoked, created, nativeMessages, playReply: () => playReply.listeners.click[0](), setVoice: values => { Object.assign(voiceConfig, values); assistant.sync(); }, setMode: value => { mode = value; assistant.sync(); }, close: () => find(el => el.tagName === 'dialog').close(), setEnabled: value => { voiceConfig.enabled = value; assistant.sync(); }, setVoices: value => { installedVoices = value; },
    submit: async (text = 'Show my tasks') => { input.value = text; await form.listeners.submit[0]({ preventDefault() {} }); },
    stop: async () => { stop.listeners.click[0](); await Promise.resolve(); await Promise.resolve(); },
  };
}

for (const browserDemo of [false, true]) test(`missing local voice feedback survives refresh in ${browserDemo ? 'browser demo' : 'local app'}`, async () => {
  const app = setup({ browserDemo, voices: [{ name: 'Remote only', lang: 'en-US', localService: false }] });
  await app.submit(); app.assistant.sync(); app.close(); app.assistant.open();
  assert.match(app.snapshot().note, /No local browser voice/);
  assert.equal(app.snapshot().replyVisible, true);
  assert.equal(app.spoken.length, 0, 'A remote voice is never used as fallback');
  assert.equal(app.snapshot().stopDisabled, true);
});

test('missing browser speech APIs give persistent feedback without losing the reply', async () => {
  const app = setup({ supported: false }); await app.submit(); app.assistant.sync();
  assert.match(app.snapshot().note, /not supported|unavailable/i);
  assert.equal(app.snapshot().replyVisible, true); assert.equal(app.spoken.length, 0);
});

test('speech playback errors persist after sync and preserve written replies', async () => {
  const app = setup({ voices: [localVoice] }); await app.submit();
  assert.equal(app.snapshot().stopDisabled, false);
  app.spoken[0].onerror({ error: 'not-allowed' }); app.assistant.sync();
  assert.match(app.snapshot().note, /could not play/i);
  assert.equal(app.snapshot().replyVisible, true); assert.equal(app.snapshot().stopDisabled, true);
  assert.equal(app.snapshot().status, 'Ready');
});

test('synchronous speech failure remains playback feedback rather than a failed text request', async () => {
  const app = setup({ voices: [localVoice], speakError: new Error('fixture engine detail') }); await app.submit();
  assert.match(app.snapshot().note, /could not play/i);
  assert.doesNotMatch(app.snapshot().note + app.snapshot().status, /fixture engine detail/);
  assert.equal(app.snapshot().status, 'Ready'); assert.equal(app.snapshot().replyVisible, true);
  assert.equal(app.snapshot().stopDisabled, true);
});

test('a later successful attempt clears the voice notice and completes normally', async () => {
  const app = setup(); await app.submit(); assert.match(app.snapshot().note, /No local browser voice/);
  app.setVoices([localVoice]); await app.submit('Try again');
  assert.equal(app.spoken.length, 1); assert.equal(app.spoken[0].voice, localVoice);
  assert.doesNotMatch(app.snapshot().note, /No local|could not play/i); assert.equal(app.snapshot().stopDisabled, false);
  app.spoken[0].onend(); assert.equal(app.snapshot().stopDisabled, true);
});

test('disabled read-aloud never starts speech and clears earlier feedback', async () => {
  const app = setup(); await app.submit(); app.setEnabled(false); await app.submit('Typed only');
  assert.match(app.snapshot().note, /Voice is off/); assert.equal(app.spoken.length, 0);
  assert.equal(app.snapshot().replyVisible, true); assert.equal(app.snapshot().stopDisabled, true);
});

for (const action of ['stop', 'close']) test(`${action} and delayed cancellation callbacks are not playback failures`, async () => {
  const app = setup({ voices: [localVoice] }); await app.submit(); const utterance = app.spoken[0];
  if (action === 'stop') await app.stop(); else { app.close(); await Promise.resolve(); }
  await nextTurn(); // Let the cancellation response settle before checking Stopped.
  for (const error of ['canceled', 'interrupted']) utterance.onerror({ error });
  assert.equal(app.snapshot().status, 'Stopped'); assert.equal(app.snapshot().stopDisabled, true);
  assert.doesNotMatch(app.snapshot().note, /could not play|failed/i);
});

test('callbacks from an earlier utterance cannot stop or report failure for a later reply', async () => {
  const app = setup({ voices: [localVoice] }); await app.submit('First'); const old = app.spoken[0];
  await app.stop(); await app.submit('Second'); const current = app.spoken[1];
  old.onerror({ error: 'synthesis-failed' }); old.onend();
  assert.equal(app.snapshot().stopDisabled, false, 'The current reply can still be stopped');
  assert.doesNotMatch(app.snapshot().note, /could not play|failed/i);
  current.onend(); assert.equal(app.snapshot().stopDisabled, true);
});


test('synchronous cancellation callbacks do not turn Stop or replacement speech into an error', async () => {
  const app = setup({ voices: [localVoice], cancelError: 'interrupted' }); await app.submit('First');
  await app.stop(); assert.equal(app.snapshot().status, 'Stopped');
  assert.doesNotMatch(app.snapshot().note, /could not play|failed/i);
  await app.submit('Second'); assert.equal(app.snapshot().stopDisabled, false);
  assert.doesNotMatch(app.snapshot().note, /could not play|failed/i);
  app.spoken.at(-1).onend(); assert.equal(app.snapshot().stopDisabled, true);
});

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const cloudCalls = app => app.requests.filter(request => request.route === '/api/speech');

test('ElevenLabs speaks only the displayed reply and works without Whisper', async () => {
  const generation = deferred();
  const app = setup({ outputProvider: 'elevenlabs', whisperAvailable: false, speechApi: () => generation.promise });
  assert.match(app.snapshot().note, /Spoken replies use ElevenLabs.*Microphone input is unavailable/);
  await app.submit('Show my tasks');
  assert.equal(app.snapshot().replyVisible, true); assert.equal(app.snapshot().recordDisabled, true);
  assert.match(app.snapshot().note, /Generating.*ElevenLabs/); assert.equal(app.snapshot().stopDisabled, false);
  const request = cloudCalls(app)[0];
  assert.deepEqual(request.options.body, { text: 'Fixture reply to Show my tasks' });
  assert.equal(request.options.responseType, 'blob');
  assert.notEqual(request.options.signal, app.requests[0].options.signal, 'Speech has a separate cancellation controller');
  const blob = new Blob(['fixture audio'], { type: 'audio/mpeg' }); generation.resolve(blob); await nextTurn();
  assert.equal(app.created[0].blob, blob); assert.equal(app.audio[0].plays, 1);
  assert.match(app.snapshot().note, /Playing.*ElevenLabs/); assert.equal(app.spoken.length, 0);
  app.audio[0].onended();
  assert.deepEqual(app.revoked, ['blob:fixture-0']); assert.equal(app.snapshot().stopDisabled, true);
  assert.match(app.snapshot().note, /finished/);
});

for (const action of ['stop', 'close']) test(`${action} aborts ElevenLabs generation and discards a late response`, async () => {
  const generation = deferred(), app = setup({ outputProvider: 'elevenlabs', speechApi: () => generation.promise });
  await app.submit(); const signal = cloudCalls(app)[0].options.signal;
  if (action === 'stop') await app.stop(); else app.close();
  await nextTurn(); assert.equal(signal.aborted, true);
  generation.resolve(new Blob(['late'])); await nextTurn();
  assert.equal(app.created.length, 0); assert.equal(app.audio.length, 0);
  assert.equal(app.snapshot().status, 'Stopped'); assert.equal(app.snapshot().replyVisible, true);
  assert.doesNotMatch(app.snapshot().note, /Generating|could not generate/);
});

test('autoplay denial offers cached Play reply without another synthesis request', async () => {
  const denied = new Error('Autoplay needs interaction'); denied.name = 'NotAllowedError';
  const app = setup({ outputProvider: 'elevenlabs', playResults: [denied] });
  await app.submit(); await nextTurn();
  assert.equal(app.snapshot().playHidden, false); assert.equal(app.snapshot().playDisabled, false);
  assert.match(app.snapshot().note, /Press Play reply/); assert.equal(cloudCalls(app).length, 1);
  app.playReply(); await nextTurn();
  assert.equal(cloudCalls(app).length, 1); assert.equal(app.audio[0].plays, 2);
  assert.equal(app.snapshot().playHidden, true); assert.match(app.snapshot().note, /Playing/);
  app.audio[0].onended(); assert.equal(app.revoked.length, 1);
});

test('closing a cached autoplay-blocked reply releases its audio', async () => {
  const denied = new Error('Blocked'); denied.name = 'NotAllowedError';
  const app = setup({ outputProvider: 'elevenlabs', playResults: [denied] });
  await app.submit(); await nextTurn(); app.close(); await nextTurn(); app.assistant.open();
  assert.equal(app.snapshot().playHidden, true); assert.equal(app.audio[0].paused, true);
  assert.deepEqual(app.revoked, ['blob:fixture-0']); assert.equal(cloudCalls(app).length, 1);
});

test('ElevenLabs failure preserves text without system fallback or generation retry', async () => {
  const app = setup({ outputProvider: 'elevenlabs', voices: [localVoice], nativeSpeech: true, speechApi: async () => { throw new Error('ElevenLabs rate limit reached. Please try again later.'); } });
  await app.submit(); await nextTurn(); app.assistant.sync();
  assert.match(app.snapshot().note, /ElevenLabs could not generate/);
  assert.match(app.snapshot().note, /rate limit reached/); assert.equal(app.snapshot().replyVisible, true);
  assert.equal(app.snapshot().status, 'Ready'); assert.equal(app.snapshot().playHidden, true);
  assert.equal(cloudCalls(app).length, 1); assert.equal(app.spoken.length, 0);
  assert.equal(app.nativeMessages.filter(message => message.text).length, 0);
});

test('starting a new request invalidates old generation and old playback callbacks', async () => {
  const first = deferred(); let generations = 0;
  const app = setup({ outputProvider: 'elevenlabs', speechApi: async () => ++generations === 1 ? first.promise : new Blob(['current']) });
  await app.submit('First'); const oldSignal = cloudCalls(app)[0].options.signal;
  await app.submit('Second'); await nextTurn();
  assert.equal(oldSignal.aborted, true); first.resolve(new Blob(['stale'])); await nextTurn();
  assert.equal(app.audio.length, 1); const oldAudio = app.audio[0], onended = oldAudio.onended, onerror = oldAudio.onerror;
  await app.submit('Third'); await nextTurn();
  onended(); onerror();
  assert.equal(oldAudio.paused, true); assert.equal(app.snapshot().stopDisabled, false);
  assert.match(app.snapshot().note, /Playing.*ElevenLabs/); assert.equal(app.audio.length, 2);
  app.audio[1].onended(); assert.equal(app.snapshot().stopDisabled, true);
});

for (const change of [{ enabled: false }, { outputProvider: 'system' }, { elevenlabsVoiceId: 'different-voice' }, { elevenlabsModel: 'different-model' }, { hasElevenlabsApiKey: false }]) {
  test(`voice configuration change tears down generated audio: ${Object.keys(change)[0]}`, async () => {
    const app = setup({ outputProvider: 'elevenlabs' }); await app.submit(); await nextTurn();
    app.setVoice(change);
    assert.equal(app.audio[0].paused, true); assert.equal(app.revoked.length, 1);
    assert.equal(app.snapshot().playHidden, true); assert.equal(app.snapshot().stopDisabled, true);
    assert.doesNotMatch(app.snapshot().note, /Playing|Generating/);
  });
}

test('mode changes abort pending speech without generating another reply', async () => {
  const generation = deferred(), app = setup({ outputProvider: 'elevenlabs', speechApi: () => generation.promise });
  await app.submit(); app.setMode('demo');
  assert.equal(cloudCalls(app)[0].options.signal.aborted, true);
  generation.resolve(new Blob(['stale'])); await nextTurn();
  assert.equal(app.audio.length, 0); assert.equal(cloudCalls(app).length, 1);
});

test('unavailable ElevenLabs and local demo mode never synthesize or fall back', async () => {
  for (const options of [{ speechAvailable: false }, { mode: 'demo' }]) {
    const app = setup({ outputProvider: 'elevenlabs', voices: [localVoice], ...options });
    await app.submit(); await nextTurn();
    assert.equal(cloudCalls(app).length, 0); assert.equal(app.spoken.length, 0);
    assert.equal(app.snapshot().replyVisible, true); assert.equal(app.snapshot().stopDisabled, true);
    assert.match(app.snapshot().note, /ElevenLabs/);
  }
});

test('static browser demo uses local speech even with an injected ElevenLabs selection', async () => {
  const app = setup({ browserDemo: true, outputProvider: 'elevenlabs', voices: [localVoice] });
  await app.submit(); assert.equal(app.spoken.length, 1); assert.equal(cloudCalls(app).length, 0);
});

test('the default provider preserves native system speech', async () => {
  const app = setup({ nativeSpeech: true }); await app.submit('Native');
  assert.deepEqual(app.nativeMessages.filter(message => message.text), [{ text: 'Fixture reply to Native' }]);
  assert.equal(cloudCalls(app).length, 0); assert.equal(app.audio.length, 0);
});


test('Stop can discard an autoplay-blocked cached reply without synthesizing again', async () => {
  const denied = new Error('Blocked'); denied.name = 'NotAllowedError';
  const app = setup({ outputProvider: 'elevenlabs', playResults: [denied] });
  await app.submit(); await nextTurn();
  assert.equal(app.snapshot().stopDisabled, false);
  await app.stop(); await nextTurn();
  assert.equal(app.snapshot().status, 'Stopped'); assert.equal(app.snapshot().playHidden, true);
  assert.equal(app.snapshot().stopDisabled, true); assert.equal(app.audio[0].paused, true);
  assert.equal(app.revoked.length, 1); assert.equal(cloudCalls(app).length, 1);
});

test('a delayed play rejection after Stop cannot restore cached playback or overwrite a newer reply', async () => {
  const oldPlay = deferred(), app = setup({ outputProvider: 'elevenlabs', playResults: [oldPlay.promise] });
  await app.submit('First'); await nextTurn(); await app.stop(); await nextTurn();
  await app.submit('Second'); await nextTurn();
  const denied = new Error('Delayed autoplay denial'); denied.name = 'NotAllowedError';
  oldPlay.reject(denied); await nextTurn();
  assert.equal(app.snapshot().playHidden, true); assert.match(app.snapshot().note, /Playing.*ElevenLabs/);
  assert.equal(app.audio[0].paused, true); assert.equal(app.audio[1].plays, 1);
});

test('a decoding failure releases audio and keeps the written reply without fallback', async () => {
  const app = setup({ outputProvider: 'elevenlabs', voices: [localVoice] });
  await app.submit(); await nextTurn(); app.audio[0].onerror();
  assert.equal(app.snapshot().replyVisible, true); assert.match(app.snapshot().note, /could not be played/);
  assert.equal(app.snapshot().playHidden, true); assert.equal(app.snapshot().stopDisabled, true);
  assert.equal(app.revoked.length, 1); assert.equal(app.spoken.length, 0); assert.equal(cloudCalls(app).length, 1);
});
