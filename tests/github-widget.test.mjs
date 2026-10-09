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

async function widgetFixture(t) {
  const oldDocument = globalThis.document, oldWindow = globalThis.window;
  globalThis.document = { createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text) };
  globalThis.window = { location: { href: 'http://127.0.0.1/' } };
  t.after(() => {
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  });
  const source = (await readFile(new URL('../js/widgets/github.js', import.meta.url), 'utf8'))
    .replace("'../lib/ui.js'", JSON.stringify(new URL('../js/lib/ui.js', import.meta.url).href))
    .replace("'../lib/local-commands.js'", JSON.stringify(new URL('../js/lib/local-commands.js', import.meta.url).href));
  const widget = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
  const root = new Element('main'), ctx = { aux: new Element('aside') };
  widget.mount(root, ctx);
  return { widget, root, ctx };
}

test('GitHub labels its successful sync time independently of dashboard and event times', async t => {
  const { widget, root, ctx } = await widgetFixture(t);
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

test('GitHub distinguishes full totals, loaded pages, incomplete searches and unconfigured searches', async t => {
  const { widget, root, ctx } = await widgetFixture(t);
  const rows = Array.from({ length: 15 }, (_, i) => ({ repo: 'example/project', number: i + 1, title: `Fixture ${i + 1}` }));
  const data = { github: { user: 'example', myOpenPRs: rows, reviewRequested: rows, openIssues: [], search: {
    myOpenPRs: { totalCount: 37, incompleteResults: false }, reviewRequested: { totalCount: 23, incompleteResults: false }, openIssues: { totalCount: 0, incompleteResults: false },
  } }, sources: { github: { status: 'live' } } };
  const badges = () => descendants(root).filter(el => el.className === 'gh-count').map(el => el.textContent);
  const notices = () => descendants(root).filter(el => el.className === 'gh-search-note' && !el.hidden).map(el => el.textContent);
  widget.update(data, ctx);
  assert.deepEqual(badges(), ['23', '37', '0']);
  assert.deepEqual(notices(), ['Showing 15 of 23.', 'Showing 15 of 37.']);
  assert.equal(ctx.aux.textContent, '23·37·0');

  data.github.search.myOpenPRs.incompleteResults = data.github.search.reviewRequested.incompleteResults = true;
  data.github.myOpenPRs = data.github.reviewRequested = [];
  widget.update(data, ctx);
  assert.deepEqual(badges(), ['—', '—', '0']);
  assert.ok(notices().every(text => text === 'Showing 0 results. GitHub search incomplete; total unknown.'));
  assert.doesNotMatch(root.textContent, /review queue clear|no open prs/);

  delete data.github.search;
  data.github.counts = { myOpenPRs: 0, reviewRequested: 0, openIssues: 0 };
  widget.update(data, ctx);
  assert.ok(notices().every(text => text === 'Showing 0 results. Total unavailable.'));
  assert.doesNotMatch(root.textContent, /review queue clear|no open prs/);

  data.github.user = '';
  widget.update(data, ctx);
  assert.ok(notices().every(text => text === 'No GitHub username configured.'));
  assert.equal(ctx.aux.textContent, '—·—·—');
  assert.doesNotMatch(root.textContent, /review queue clear|no open prs/);

  data.github.user = 'example';
  data.github.search = { myOpenPRs: { totalCount: 0, incompleteResults: false }, reviewRequested: { totalCount: 0, incompleteResults: false } };
  widget.update(data, ctx);
  assert.equal(notices().length, 0);
  assert.match(root.textContent, /review queue clear/);
  assert.match(root.textContent, /no open prs/);
});
