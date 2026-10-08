import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { initAssistant } from '../js/lib/assistant.js';

// Run the actual drawer handlers with the same minimal DOM used by the speech
// tests. Deferred transport and microphone cleanup make Stop/Send ordering exact.
const globalNames = ['document', 'window'];
const originalGlobals = new Map(globalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
test.afterEach(() => { for (const [name, descriptor] of originalGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

class Element {
  constructor(tag, text = '') { this.tagName = tag; this.nodeType = tag === '#text' ? 3 : 1; this.text = text; this.children = []; this.attributes = {}; this.listeners = {}; this.value = ''; this.disabled = false; this.hidden = false; this.classList = { add() {}, remove() {}, toggle() {} }; }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  setAttribute(name, value) { this.attributes[name] = value; if (['id', 'name'].includes(name)) this[name] = value; if (['disabled', 'hidden'].includes(name)) this[name] = true; }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  remove() { this.parentElement.children = this.parentElement.children.filter(el => el !== this); this.parentElement = null; }
  focus() { document.activeElement = this; }
  scrollIntoView() {}
  showModal() { this.open = true; }
  close() { this.open = false; for (const callback of this.listeners.close || []) callback({}); }
  get isConnected() { return this === document.body || !!this.parentElement?.isConnected; }
  set textContent(text) { this.text = ''; this.children = [new Element('#text', String(text))]; }
  get textContent() { return this.nodeType === 3 ? this.text : this.children.map(child => child.textContent).join(''); }
}
const descendants = element => [element, ...element.children.flatMap(descendants)];

function setup({ replies = [], cancel, recordMicrophone = async () => ({ stop: async () => null }) }) {
  globalThis.document = { body: new Element('body'), createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text) };
  globalThis.window = {};
  const calls = [];
  let recordings = 0;
  const assistant = initAssistant({
    getConfig: () => ({ assistant: { provider: 'local' }, voice: { enabled: true } }),
    getCapabilities: () => ({ voice: { available: true } }),
    recordMicrophone: async (...args) => { recordings++; return recordMicrophone(...args); },
    api: async (route, options) => {
      calls.push({ route, options });
      if (route === '/api/assistant') return replies.shift()?.promise || { text: 'Current reply' };
      if (route === '/api/assistant/cancel') return cancel.promise;
      throw new Error(`Unexpected route: ${route}`);
    },
    onRefresh: async () => {}, openConnections() {},
  });
  assistant.open();
  const elements = descendants(document.body), find = predicate => elements.find(predicate);
  const form = find(el => el.tagName === 'form'), input = find(el => el.id === 'assistant-message');
  const send = find(el => el.tagName === 'button' && el.textContent === 'Send');
  const record = find(el => el.tagName === 'button' && el.textContent === 'Record');
  const stop = find(el => el.tagName === 'button' && el.textContent === 'Stop');
  const status = find(el => el.className === 'assistant-status'), log = find(el => el.className === 'conversation');
  return {
    assistant, calls,
    snapshot: () => ({ sendDisabled: send.disabled, recordDisabled: record.disabled, stopDisabled: stop.disabled, status: status.textContent, conversation: log.textContent, recordings }),
    submit: text => { input.value = text; return form.listeners.submit[0]({ preventDefault() {} }); },
    // Invoke handlers even when disabled to check the guard as well as the UI.
    record: () => record.listeners.click[0](), stop: () => stop.listeners.click[0](),
    close: () => find(el => el.tagName === 'dialog').close(),
  };
}
const callCount = (app, route) => app.calls.filter(call => call.route === route).length;
const assertStopping = app => {
  const state = app.snapshot();
  assert.equal(state.sendDisabled, true); assert.equal(state.recordDisabled, true); assert.equal(state.stopDisabled, true);
  assert.equal(state.status, 'Stopping…');
};

test('Stop blocks a new submit and recording until cancellation is acknowledged', async () => {
  const reply = deferred(), cancel = deferred(), app = setup({ replies: [reply], cancel });
  const first = app.submit('First request');
  try {
    app.stop(); await nextTurn();
    assertStopping(app);
    assert.equal(app.calls[0].options.signal.aborted, true);
    await app.submit('Must wait'); await app.record();
    assert.equal(callCount(app, '/api/assistant'), 1); assert.equal(app.snapshot().recordings, 0);
    reply.resolve({ text: 'Old reply' }); await first;
    assertStopping(app); assert.doesNotMatch(app.snapshot().conversation, /Old reply/);
    cancel.resolve({ ok: true }); await nextTurn();
    assert.equal(app.snapshot().sendDisabled, false); assert.equal(app.snapshot().status, 'Stopped');
    await app.submit('New request');
    assert.equal(callCount(app, '/api/assistant'), 2); assert.match(app.snapshot().conversation, /Current reply/);
    assert.equal(app.snapshot().status, 'Ready');
  } finally { reply.resolve({}); cancel.resolve({ ok: true }); await first; await nextTurn(); }
});

test('recorder cleanup and server cancellation stay one operation across repeated Stop and close', async () => {
  const cleanup = deferred(), cancel = deferred(); let cleanupCalls = 0;
  const app = setup({ cancel, recordMicrophone: async () => ({ stop: async () => { cleanupCalls++; await cleanup.promise; return null; } }) });
  await app.record();
  try {
    app.stop(); app.stop(); app.close(); app.assistant.open();
    assertStopping(app); assert.equal(cleanupCalls, 1);
    await app.submit('Must wait for cleanup'); await app.record();
    assert.equal(callCount(app, '/api/assistant'), 0); assert.equal(app.snapshot().recordings, 1);
    assert.equal(callCount(app, '/api/assistant/cancel'), 0);
    cleanup.resolve(); await nextTurn();
    assertStopping(app); assert.equal(callCount(app, '/api/assistant/cancel'), 1);
    app.stop(); app.close(); app.assistant.open(); await nextTurn();
    assert.equal(callCount(app, '/api/assistant/cancel'), 1);
    cancel.resolve({ ok: true }); await nextTurn();
    assert.equal(app.snapshot().sendDisabled, false); assert.equal(app.snapshot().recordDisabled, false);
    await app.submit('After cleanup'); assert.match(app.snapshot().conversation, /Current reply/);
  } finally { cleanup.resolve(); cancel.resolve({ ok: true }); await nextTurn(); }
});

test('failed recorder cleanup still cancels on the server and releases the controls', async () => {
  const cleanup = deferred(), cancel = deferred(); let sessions = 0;
  const app = setup({ cancel, recordMicrophone: async () => ({ stop: async () => { if (++sessions === 1) await cleanup.promise; return null; } }) });
  await app.record(); app.stop();
  cleanup.reject(new Error('Synthetic microphone cleanup failed'));
  await nextTurn();
  assert.equal(callCount(app, '/api/assistant/cancel'), 1);
  assertStopping(app);
  cancel.resolve({ ok: true }); await nextTurn();
  assert.equal(app.snapshot().sendDisabled, false); assert.equal(app.snapshot().recordDisabled, false);
  assert.match(app.snapshot().status, /microphone/i);
  await app.record(); assert.equal(app.snapshot().recordings, 2);
  app.stop(); await nextTurn();
  assert.equal(app.snapshot().status, 'Stopped'); assert.equal(callCount(app, '/api/assistant/cancel'), 2);
});

test('a failed cancel reports the failure without permanently locking the drawer', async () => {
  const reply = deferred(), cancel = deferred(), app = setup({ replies: [reply], cancel });
  const first = app.submit('First request'); app.stop(); await nextTurn();
  cancel.reject(new Error('Synthetic cancellation transport failed')); await nextTurn();
  assert.equal(app.snapshot().sendDisabled, false); assert.equal(app.snapshot().recordDisabled, false);
  assert.match(app.snapshot().status, /could not confirm/i);
  reply.resolve({ text: 'Stale reply' }); await first;
  assert.doesNotMatch(app.snapshot().conversation, /Stale reply/);
  await app.submit('Try again'); assert.equal(app.snapshot().status, 'Ready');
});

test('closing and reopening during a request cannot bypass pending cancellation', async () => {
  const reply = deferred(), cancel = deferred(), app = setup({ replies: [reply], cancel });
  const first = app.submit('First request');
  try {
    app.close(); app.assistant.open(); await nextTurn(); assertStopping(app);
    await app.submit('Too soon'); assert.equal(callCount(app, '/api/assistant'), 1);
    app.close(); app.assistant.open(); await nextTurn(); assert.equal(callCount(app, '/api/assistant/cancel'), 1);
    cancel.resolve({ ok: true }); await nextTurn();
    await app.submit('After cancellation'); assert.equal(app.snapshot().status, 'Ready');
    reply.resolve({ text: 'Old reply' }); await first;
    assert.equal(app.snapshot().status, 'Ready'); assert.doesNotMatch(app.snapshot().conversation, /Old reply/);
  } finally { reply.resolve({}); cancel.resolve({ ok: true }); await first; await nextTurn(); }
});

test('late failure of the stopped request cannot release a newer request', async () => {
  const firstReply = deferred(), newReply = deferred(), cancel = deferred();
  const app = setup({ replies: [firstReply, newReply], cancel });
  const first = app.submit('First request'); app.stop(); await nextTurn(); cancel.resolve({ ok: true }); await nextTurn();
  const current = app.submit('New request');
  firstReply.reject(new Error('Late old failure')); await first;
  assert.equal(app.snapshot().sendDisabled, true); assert.equal(app.snapshot().status, 'Working…');
  newReply.resolve({ text: 'Fresh reply' }); await current;
  assert.equal(app.snapshot().sendDisabled, false); assert.equal(app.snapshot().status, 'Ready');
  assert.match(app.snapshot().conversation, /Fresh reply/); assert.doesNotMatch(app.snapshot().conversation, /Late old failure/);
});
