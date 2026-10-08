import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConfigStore, publicConfig } from '../lib/config.mjs';
import { initConnections } from '../js/lib/connections.js';

// Minimal DOM for the real Connections form, drawer and h() helper.
class Element {
  constructor(tag, text = '') { this.tagName = tag; this.nodeType = tag === '#text' ? 3 : 1; this.text = text; this.children = []; this.attributes = {}; this.listeners = {}; this.value = ''; this.classList = { add() {}, remove() {} }; }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  focus() { globalThis.document.activeElement = this; }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  setAttribute(name, value) { this.attributes[name] = value; if (['id', 'name'].includes(name)) this[name] = value; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  set textContent(text) { this.children = [new Element('#text', text)]; }
  get textContent() { return this.nodeType === 3 ? this.text : this.children.map(child => child.textContent).join(''); }
}
const descendants = element => [element, ...element.children.flatMap(descendants)];
const hidden = element => !!element && (element.hidden || hidden(element.parentElement));

test('Connections serializes independent model fields and preserves edits across provider toggles', async t => {
  const previousDocument = globalThis.document, previousFetch = globalThis.fetch;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yos-connections-models-'));
  const store = await createConfigStore(directory);
  await store.save({ assistant: { provider: 'ollama', model: 'saved-local' } });
  let config = publicConfig(store.get()); const requests = [];
  globalThis.document = { body: new Element('body'), createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text) };
  globalThis.fetch = async (url, options) => {
    if (url === '/api/session') return { ok: true, json: async () => ({ token: 'fixture-session' }) };
    assert.equal(url, '/api/config'); assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body); requests.push(body);
    return { ok: true, json: async () => ({ config: await store.save(body) }) };
  };
  t.after(async () => { globalThis.fetch = previousFetch; if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; await rm(directory, { recursive: true, force: true }); });
  const view = initConnections({ getConfig: () => config, onSaved: async () => { config = publicConfig(store.get()); return { sources: { repos: { status: 'disabled' } } }; } });
  view.open();
  const elements = descendants(document.body), field = name => elements.find(el => el.name === name);
  const provider = field('provider'), ollama = field('model'), claude = field('claudeModel');
  assert.ok(claude, 'Claude has an explicit optional model field');
  assert.equal(ollama.value, 'saved-local'); assert.equal(claude.value, '');
  assert.ok(hidden(claude)); assert.ok(!hidden(ollama));
  ollama.value = 'unsaved-local';
  provider.value = 'claude'; provider.listeners.change();
  assert.ok(hidden(ollama)); assert.ok(!hidden(claude));
  assert.equal(claude.value, '', 'Switching does not copy the Ollama model');
  claude.value = 'custom-claude';
  for (const value of ['local', 'ollama', 'claude']) { provider.value = value; provider.listeners.change(); }
  assert.equal(ollama.value, 'unsaved-local'); assert.equal(claude.value, 'custom-claude');
  const form = elements.find(el => el.tagName === 'form');
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(requests.at(-1).assistant.provider, 'claude');
  assert.equal(requests.at(-1).assistant.model, 'unsaved-local');
  assert.equal(requests.at(-1).assistant.claudeModel, 'custom-claude');
  view.open();
  assert.equal(claude.value, 'custom-claude'); assert.equal(ollama.value, 'unsaved-local');
  claude.value = '';
  await form.listeners.submit({ preventDefault() {} });
  const reopened = await createConfigStore(directory);
  assert.equal(reopened.get().assistant.claudeModel, '');
  assert.equal(reopened.get().assistant.model, 'unsaved-local');
});


test('Connections reports saved repository problems and lets users correct them', async t => {
  const previousDocument = globalThis.document, previousFetch = globalThis.fetch;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yos-connections-problems-'));
  const store = await createConfigStore(directory); let config = publicConfig(store.get());
  let issues = [{ path: '/example/missing', code: 'path-missing', message: 'This path does not exist. Correct the path in Connections.' }];
  globalThis.document = { body: new Element('body'), createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text) };
  globalThis.fetch = async (url, options) => {
    if (url === '/api/session') return { ok: true, json: async () => ({ token: 'fixture-session' }) };
    assert.equal(url, '/api/config'); assert.equal(options.method, 'POST');
    return { ok: true, json: async () => ({ config: await store.save(JSON.parse(options.body)) }) };
  };
  t.after(async () => { globalThis.fetch = previousFetch; if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; await rm(directory, { recursive: true, force: true }); });
  const view = initConnections({ getConfig: () => config, onSaved: async () => { config = publicConfig(store.get()); return { sources: { repos: { status: issues.length ? 'error' : 'live', problems: issues } } }; } });
  view.open();
  const elements = descendants(document.body), field = name => elements.find(el => el.name === name);
  field('mode').value = 'live'; field('workspacePaths').value = '/example/missing';
  const form = elements.find(el => el.tagName === 'form'), status = elements.find(el => el.attributes.role === 'status');
  await form.listeners.submit({ preventDefault() {} });
  assert.match(status.textContent, /Connections saved/); assert.match(status.textContent, /1 repository folder needs attention/);
  assert.doesNotMatch(status.textContent, /close this panel/);
  const problemList = elements.find(el => el.attributes['aria-label'] === 'Repository setup problems');
  assert.equal(problemList.hidden, false); assert.match(problemList.textContent, /example\/missing/); assert.match(problemList.textContent, /does not exist/);
  const edit = descendants(problemList).find(el => el.tagName === 'button');
  edit.listeners.click(); assert.equal(document.activeElement, field('workspacePaths'));
  field('workspacePaths').value = '/example/corrected'; issues = [];
  await form.listeners.submit({ preventDefault() {} });
  assert.match(status.textContent, /You can close this panel/); assert.equal(problemList.hidden, true); assert.equal(problemList.textContent, '');
});


test('Connections distinguishes a saved config from a failed workspace check and can retry', async t => {
  const previousDocument = globalThis.document, previousFetch = globalThis.fetch;
  let saves = 0, result, failure;
  const config = { mode: 'live', workspacePaths: [] };
  globalThis.document = { body: new Element('body'), createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text) };
  globalThis.fetch = async (url, options) => {
    if (url === '/api/session') return { ok: true, json: async () => ({ token: 'fixture-session' }) };
    assert.equal(url, '/api/config'); assert.equal(options.method, 'POST'); saves++;
    return { ok: true, json: async () => ({ config }) };
  };
  t.after(() => { globalThis.fetch = previousFetch; if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; });
  const view = initConnections({ getConfig: () => config, onSaved: async () => { if (failure) throw failure; return result; } });
  view.open();
  const elements = descendants(document.body), form = elements.find(el => el.tagName === 'form');
  const status = elements.find(el => el.attributes.role === 'status'), save = elements.find(el => el.attributes.type === 'submit');
  for (const error of [undefined, new Error('raw-refresh-detail')]) {
    failure = error;
    await form.listeners.submit({ preventDefault() {} });
    assert.match(status.textContent, /Connections saved, but/);
    assert.match(status.textContent, /could not check your workspace/);
    assert.match(status.textContent, /Use Save connections to try again/);
    assert.doesNotMatch(status.textContent, /close this panel|raw-refresh-detail/);
    assert.equal(save.disabled, false);
  }
  failure = undefined; result = { sources: { repos: { status: 'disabled' } } };
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(saves, 3);
  assert.match(status.textContent, /Connections saved. You can close this panel/);
});
