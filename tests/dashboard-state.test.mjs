import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Element {
  constructor() { this.hidden = false; this.children = []; this.listeners = {}; this.text = ''; this.classList = { add() {}, toggle() {} }; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.text = ''; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => typeof child === 'string' ? child : child?.textContent || '').join(''); }
}

const dashboard = (mode, status = mode === 'demo' ? 'demo' : 'disabled') => ({
  mode, demo: mode === 'demo', sources: Object.fromEntries(['github', 'repos', 'graph'].map(name => [name, { status, message: status === 'error' ? 'Configured source unavailable' : 'Connect a source' }])),
  tasks: { items: [] }, github: status === 'live' || status === 'demo' ? { recentRuns: [] } : null,
  repos: status === 'live' || status === 'demo' ? { repos: [{ dirtyFiles: 2 }] } : null,
});

async function shell({ dismissed = false, storageUnavailable = false, initialMode = 'demo', browserDemo = false } = {}) {
  const ids = new Map(), selectors = new Map(), saved = new Map(dismissed ? [['yos-welcome-dismissed', '1']] : []);
  const get = (map, key) => { if (!map.has(key)) map.set(key, new Element()); return map.get(key); };
  const document = { getElementById: id => get(ids, id), querySelector: selector => get(selectors, selector), body: new Element() };
  const h = (tag, attributes, ...children) => { const element = new Element(); Object.assign(element, attributes); element.append(...children.flat().filter(child => child != null)); return element; };
  let connectionsOpened = 0;
  let config = { mode: initialMode, displayName: 'Fixture workspace', timezone: 'system' }, data = dashboard(initialMode), connectionOptions;
  const context = vm.createContext({
    document, h, AbortController, browserDemo, setInterval() {}, matchMedia: () => ({ matches: true }), initTheme() {},
    localStorage: {
      getItem(key) { if (storageUnavailable) throw new Error('Storage unavailable'); return saved.get(key) ?? null; },
      setItem(key, value) { if (storageUnavailable) throw new Error('Storage unavailable'); saved.set(key, value); },
    },
    api: async route => route === '/api/config' ? { config, capabilities: {} } : data,
    connectSession: async () => {},
    initConnections: options => { connectionOptions = options; return { open() { connectionsOpened++; } }; },
    initAssistant: () => ({ sync() {}, open() {} }),
  });
  // Run the real shell initialization, renderer and event handlers. Widget
  // imports are unavailable in this minimal DOM and use the shell's catch path;
  // these tests assert shell state/text, not widget rendering or visual layout.
  const source = (await readFile(new URL('../js/app.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export function startApp', 'function startApp');
  vm.runInContext(source, context);
  await vm.runInContext('startApp({ api, connectSession, createConnections: initConnections, browserDemo })', context);
  return {
    ids, saved,
    connectionsOpened: () => connectionsOpened,
    async update(next) { data = next; config = { ...config, mode: next.mode }; return connectionOptions.onSaved(); },
    async change(mode, status) { config = { ...config, mode }; data = dashboard(mode, status); await connectionOptions.onSaved(); },
    chips: () => ids.get('system-chips').children.map(child => child.textContent),
    dismiss: () => ids.get('welcome-dismiss').listeners.click(),
  };
}

test('failed configured sources are distinguished from sources never connected', async () => {
  const app = await shell();
  await app.change('live', 'error');
  assert.ok(app.chips().includes('GitHub unavailable'));
  assert.ok(app.chips().includes('Workspace unavailable'));
  await app.change('live', 'disabled');
  assert.ok(app.chips().includes('GitHub not connected'));
  assert.ok(app.chips().includes('No workspace folders'));
  await app.change('live', 'live');
  assert.ok(app.chips().includes('Recent CI clear'));
  assert.ok(app.chips().includes('2 dirty files'));
  await app.change('demo');
  assert.ok(app.chips().includes('Recent CI clear'));
  assert.ok(app.chips().includes('2 dirty files'));
});

test('returning from live restores a welcome strip that was not dismissed', async () => {
  const app = await shell();
  assert.equal(app.ids.get('welcome-strip').hidden, false);
  await app.change('live'); assert.equal(app.ids.get('welcome-strip').hidden, true);
  await app.change('demo'); assert.equal(app.ids.get('welcome-strip').hidden, false);
});

test('a page first opened in live mode shows the undismissed welcome when changed to demo', async () => {
  const app = await shell({ initialMode: 'live' });
  assert.equal(app.ids.get('welcome-strip').hidden, true);
  await app.change('demo'); assert.equal(app.ids.get('welcome-strip').hidden, false);
});

test('explicit welcome dismissal survives mode changes and a saved dismissal survives startup', async () => {
  const app = await shell();
  app.dismiss(); assert.equal(app.saved.get('yos-welcome-dismissed'), '1');
  await app.change('live'); await app.change('demo');
  assert.equal(app.ids.get('welcome-strip').hidden, true);
  const reopened = await shell({ dismissed: true });
  assert.equal(reopened.ids.get('welcome-strip').hidden, true);
  await reopened.change('live'); await reopened.change('demo');
  assert.equal(reopened.ids.get('welcome-strip').hidden, true);
});

test('welcome dismissal remains effective for the session when localStorage is unavailable', async () => {
  const app = await shell({ storageUnavailable: true });
  assert.equal(app.ids.get('welcome-strip').hidden, false);
  app.dismiss(); await app.change('live'); await app.change('demo');
  assert.equal(app.ids.get('welcome-strip').hidden, true);
});


test('browser demo describes its runtime and local-app path without a live-server claim', async () => {
  const app = await shell({ browserDemo: true });
  assert.ok(app.chips().includes('Browser demo ready'));
  assert.ok(!app.chips().includes('Local server up'));
  assert.equal(app.ids.get('workspace-mode').textContent, 'Browser demo');
  assert.equal(app.ids.get('connections-open').textContent, 'About this demo');
  assert.equal(app.ids.get('welcome-connect').textContent, 'Use on my computer');
  app.dismiss();
  assert.equal(app.saved.get('yos-browser-welcome-dismissed'), '1');
  assert.equal(app.saved.has('yos-welcome-dismissed'), false);
});


test('all failed repositories keep setup guidance visible and can reopen Connections', async () => {
  const app = await shell(), value = dashboard('live', 'error');
  value.sources.repos.problems = [{ path: '/example/project', code: 'git-missing', message: 'Install Git, then restart Yunus OS.' }];
  value.sources.graph.problems = value.sources.repos.problems;
  const returned = await app.update(value);
  assert.equal(returned, value, 'Connections receives the checked dashboard result');
  for (const widget of ['hygiene', 'graph']) {
    const notice = app.ids.get(`panel-${widget}`).children.find(child => child.class === 'source-notice');
    assert.equal(notice.hidden, false); assert.equal(app.ids.get(`panel-${widget}`).children.find(child => child.id === `body-${widget}`).hidden, true);
    assert.match(notice.textContent, /example\/project/); assert.match(notice.textContent, /Install Git/);
    const edit = notice.children.find(child => child.textContent === 'Edit connections');
    assert.equal(edit.type, 'button'); edit.onclick();
  }
  assert.equal(app.connectionsOpened(), 2);
  value.repos = { repos: [{ dirtyFiles: 1 }] };
  await app.update(value);
  assert.equal(app.ids.get('panel-hygiene').children.find(child => child.id === 'body-hygiene').hidden, false, 'Partial repository data stays visible');
});
