import test from 'node:test';
import assert from 'node:assert/strict';
import { initAssistant } from '../js/lib/assistant.js';

// The real Assistant, drawer, UI helper and handlers run with a minimal DOM.
// Speech is simulated: these tests never request a microphone or play audio.
const globalNames = ['document', 'navigator', 'window', 'speechSynthesis', 'SpeechSynthesisUtterance'];
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
function setup({ voices = [], browserDemo = false, supported = true, enabled = true, speakError = null, cancelError = null } = {}) {
  globalThis.document = { body: new Element('body'), createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text) };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US' } });
  let installedVoices = voices;
  const spoken = [], apiCalls = [];
  class Utterance { constructor(text) { this.text = text; } }
  const synth = { getVoices: () => installedVoices, cancel: () => { if (cancelError) spoken.at(-1)?.onerror({ error: cancelError }); }, speak: utterance => { if (speakError) throw speakError; spoken.push(utterance); } };
  globalThis.window = supported ? { speechSynthesis: synth, SpeechSynthesisUtterance: Utterance } : {};
  globalThis.speechSynthesis = supported ? synth : undefined;
  globalThis.SpeechSynthesisUtterance = supported ? Utterance : undefined;
  const assistant = initAssistant({
    browserDemo, getConfig: () => ({ assistant: { provider: 'local' }, voice: { enabled } }),
    getCapabilities: () => ({ voice: { available: true } }),
    api: async (route, options) => { apiCalls.push(route); if (route === '/api/assistant') return { text: `Fixture reply to ${options.body.message}` }; if (route === '/api/assistant/cancel') return { ok: true }; throw new Error('Unexpected route'); },
    onRefresh: async () => {}, openConnections() {},
  });
  assistant.open();
  const elements = descendants(document.body), find = predicate => elements.find(predicate);
  const form = find(el => el.tagName === 'form'), input = find(el => el.id === 'assistant-message');
  const note = find(el => el.className === 'field-help'), status = find(el => el.className === 'assistant-status');
  const stop = find(el => el.tagName === 'button' && el.textContent === 'Stop');
  const log = find(el => el.className === 'conversation');
  const snapshot = () => ({ note: note.textContent, status: status.textContent, stopDisabled: stop.disabled, spoken: spoken.length, replyVisible: log.textContent.includes('Fixture reply'), noteHistory: [...note.history] });
  return { assistant, spoken, snapshot, apiCalls, close: () => find(el => el.tagName === 'dialog').close(), setEnabled: value => { enabled = value; assistant.sync(); }, setVoices: value => { installedVoices = value; },
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
