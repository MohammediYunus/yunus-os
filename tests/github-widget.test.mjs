import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise the real widget and DOM helper. Layout and focus are browser checks.
class Element {
  constructor(tag, text = '') { this.tagName = tag; this.nodeType = tag === '#text' ? 3 : 1; this.text = text; this.children = []; this.attributes = {}; this.classList = { toggle() {} }; }
  append(...children) { this.children.push(...children.map(child => typeof child === 'string' ? new Element('#text', child) : child)); }
  replaceChildren(...children) { this.children = children; this.text = ''; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener() {}
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  get textContent() { return this.text + this.children.map(child => child.textContent || '').join(''); }
}
const descendants = element => [element, ...element.children.flatMap(descendants)];

test('GitHub labels its successful sync time independently of dashboard and event times', async t => {
  const oldDocument = globalThis.document, oldWindow = globalThis.window;
  globalThis.document = { createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text) };
  globalThis.window = { location: { href: 'http://127.0.0.1/' } };
  t.after(() => {
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  });
  const source = (await readFile(new URL('../js/widgets/github.js', import.meta.url), 'utf8'))
    .replace("'../lib/ui.js'", JSON.stringify(new URL('../js/lib/ui.js', import.meta.url).href));
  const widget = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
  const root = new Element('main'), ctx = { aux: new Element('aside') };
  widget.mount(root, ctx);
  const data = {
    fetchedAt: '2026-01-03T13:00:00Z',
    sources: { github: { status: 'live', stale: false, updatedAt: '2026-01-03T12:00:00Z' } },
    github: { myOpenPRs: [{ repo: 'example/project', number: 7, title: 'Known pull request', updatedAt: '2026-01-01T11:00:00Z' }] },
  };
  const freshness = () => descendants(root).find(el => el.className === 'gh-freshness');
  const time = () => descendants(root).find(el => el.tagName === 'time');
  widget.update(data, ctx);
  assert.equal(freshness().hidden, false);
  assert.match(freshness().textContent, /^Last updated /);
  assert.equal(time().attributes.datetime, '2026-01-03T12:00:00.000Z');
  data.sources.github.status = 'error'; data.sources.github.stale = true;
  widget.update(data, ctx);
  assert.match(freshness().textContent, /^Last known data/);
  assert.match(root.textContent, /Known pull request/);
  assert.equal(time().attributes.datetime, '2026-01-03T12:00:00.000Z');
  data.sources.github = { status: 'live', stale: false, updatedAt: '2026-01-03T14:00:00Z' };
  widget.update(data, ctx);
  assert.match(freshness().textContent, /^Last updated /);
  assert.equal(time().attributes.datetime, '2026-01-03T14:00:00.000Z');
  data.sources.github = { status: 'error', stale: false }; data.github = null;
  widget.update(data, ctx);
  assert.equal(freshness().hidden, true);
  assert.equal(time(), undefined);
  assert.doesNotMatch(root.textContent, /Known pull request/);
});
