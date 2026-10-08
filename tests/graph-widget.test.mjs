import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Simulate the graph's DOM operations and focus loss on removal, as in the
// task widget tests. Real Tab behavior and canvas rendering need browser checks.
class Element {
  constructor(tag, text = '') {
    this.tagName = tag; this.nodeType = tag === '#text' ? 3 : 1; this.text = text;
    this.children = []; this.attributes = {}; this.listeners = {}; this.style = {};
    this.classList = { toggle() {}, add() {} };
  }
  append(...children) { for (let child of children) { if (!child?.nodeType) child = new Element('#text', String(child)); child.remove(); child.parentElement = this; this.children.push(child); } }
  remove() {
    if (!this.parentElement) return;
    if (this.contains(document.activeElement)) document.activeElement = document.body;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null;
  }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); }
  contains(element) { return this === element || this.children.some(child => child.contains(element)); }
  focus() { if (document.body.contains(this)) document.activeElement = this; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 500, height: 330 }; }
  getContext() { return { setTransform() {} }; }
  setPointerCapture() {}
  querySelector(selector) { return descendants(this).find(el => el.className?.split(' ').includes(selector.slice(1))) || null; }
  set textContent(text) { this.replaceChildren(new Element('#text', String(text))); }
  get textContent() { return this.nodeType === 3 ? this.text : this.children.map(child => child.textContent).join(''); }
}
const descendants = element => [element, ...element.children.flatMap(descendants)];
const graph = {
  nodes: [
    { id: 'a', label: 'src/router.ts', community: 0, degree: 3 },
    { id: 'b', label: 'src/runtime.ts', community: 0, degree: 2 },
    { id: 'c', label: 'src/tasks.ts', community: 1, degree: 1 },
  ],
  links: [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }],
  stats: { nodes: 3, links: 2, communities: 2 },
};
let fixtureId = 0;
async function fixture(t) {
  const names = ['document', 'window', 'getComputedStyle', 'matchMedia', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const windowListeners = {};
  Object.assign(globalThis, {
    document: { createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text), addEventListener() {} },
    window: { devicePixelRatio: 1, addEventListener: (name, handler) => { windowListeners[name] = handler; } },
    getComputedStyle: () => ({ getPropertyValue: name => name === 'color-scheme' ? 'dark' : '#fff' }),
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    ResizeObserver: class { constructor(callback) { this.callback = callback; } observe() { this.callback(); } },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  });
  document.body = new Element('body'); document.documentElement = new Element('html'); document.activeElement = document.body;
  t.after(() => { for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  const source = (await readFile(process.env.GRAPH_WIDGET_SOURCE || new URL('../js/widgets/graph.js', import.meta.url), 'utf8'))
    .replace("'../lib/ui.js'", JSON.stringify(new URL('../js/lib/ui.js', import.meta.url).href));
  const widget = (await import(`data:text/javascript;base64,${Buffer.from(source + `\n// fixture ${++fixtureId}`).toString('base64')}`)).default;
  const root = new Element('main'), outside = new Element('button'); document.body.append(outside, root);
  widget.mount(root); widget.update({ demo: true, graph });
  const elements = () => descendants(root);
  const button = label => elements().find(el => el.tagName === 'button' && el.textContent === label);
  const activate = control => { control.focus(); control.listeners.click?.({ stopPropagation() {} }); };
  return {
    widget, root, outside, activate,
    explore: button('Explore a node'), reset: button('Reset view'),
    heading: () => elements().find(el => el.className === 'gx-focus-name'),
    related: () => elements().filter(el => el.className === 'gx-focus-nb'),
    panel: () => elements().find(el => el.className === 'gx-focus'),
    canvas: elements().find(el => el.tagName === 'canvas'),
    escape: () => windowListeners.keydown({ key: 'Escape' }),
    refresh: () => widget.update({ demo: true, graph }),
    changeSource: () => widget.update({ demo: true, graph: { ...graph, sourceId: 'other-repository' } }),
  };
}

test('Explore focuses the selected heading before its related controls', async t => {
  const f = await fixture(t); f.activate(f.explore);
  assert.equal(document.activeElement, f.heading());
  assert.equal(f.heading().textContent, 'src/router.ts');
  assert.equal(f.heading().attributes.role, 'heading');
  assert.equal(f.heading().attributes['aria-level'], '3');
  assert.equal(f.heading().attributes.tabindex, '-1');
  const order = descendants(f.root), after = order.slice(order.indexOf(f.heading()) + 1);
  assert.equal(after.find(el => el.tagName === 'button'), f.related()[0]);
});

test('activating a related node moves focus to its replacement heading', async t => {
  const f = await fixture(t); f.activate(f.explore);
  const related = f.related()[0]; f.activate(related);
  assert.equal(f.heading().textContent, 'src/runtime.ts');
  assert.equal(document.activeElement, f.heading());
  assert.equal(document.body.contains(related), false);
  assert.equal(f.related()[0].textContent, 'src/router.ts');
});

test('unchanged refresh preserves the focused related button and its DOM identity', async t => {
  const f = await fixture(t); f.activate(f.explore);
  const control = f.related()[0]; control.focus(); f.refresh();
  assert.equal(document.activeElement, control);
  assert.equal(document.body.contains(control), true);
});

test('Escape from a related control restores Explore when the panel hides', async t => {
  const f = await fixture(t); f.activate(f.explore); f.related()[0].focus(); f.escape();
  assert.equal(f.panel().style.display, 'none');
  assert.equal(document.activeElement, f.explore);
});

test('Escape from the result heading restores Explore', async t => {
  const f = await fixture(t); f.activate(f.explore);
  assert.equal(document.activeElement, f.heading());
  f.escape();
  assert.equal(document.activeElement, f.explore);
});

test('Escape while focus is outside the selected panel does not steal it', async t => {
  const f = await fixture(t); f.activate(f.explore); f.outside.focus(); f.escape();
  assert.equal(f.panel().style.display, 'none');
  assert.equal(document.activeElement, f.outside);
});

test('changing graph source restores Explore only when focus was in the removed panel', async t => {
  const f = await fixture(t); f.activate(f.explore); f.related()[0].focus(); f.changeSource();
  assert.equal(f.panel().style.display, 'none');
  assert.equal(document.activeElement, f.explore);
});

test('changing graph source does not move focus from an unrelated control', async t => {
  const f = await fixture(t); f.activate(f.explore); f.outside.focus(); f.changeSource();
  assert.equal(document.activeElement, f.outside);
});

test('canvas-originated selection does not steal outside keyboard focus', async t => {
  const f = await fixture(t); f.outside.focus();
  // Before the first animation frame, all projected nodes are at (0, 0).
  f.canvas.listeners.pointerdown({ clientX: 0, clientY: 0, button: 0, pointerId: 1 });
  f.canvas.listeners.pointerup({ clientX: 0, clientY: 0, button: 0 });
  assert.equal(f.heading().textContent, 'src/router.ts');
  assert.equal(document.activeElement, f.outside);
});

test('clearing a selection from the canvas restores Explore if its panel had focus', async t => {
  const f = await fixture(t); f.activate(f.explore); f.related()[0].focus();
  f.canvas.listeners.pointerdown({ clientX: 500, clientY: 330, button: 0, pointerId: 1 });
  f.canvas.listeners.pointerup({ clientX: 500, clientY: 330, button: 0 });
  assert.equal(f.panel().style.display, 'none');
  assert.equal(document.activeElement, f.explore);
});

test('Reset view retains focus on its own button', async t => {
  const f = await fixture(t); f.activate(f.explore); f.activate(f.reset);
  assert.equal(f.panel().style.display, 'none');
  assert.equal(document.activeElement, f.reset);
});

test('Explore on an empty graph leaves its trigger focused', async t => {
  const f = await fixture(t); f.widget.update({ demo: true, graph: { nodes: [], links: [] } });
  f.activate(f.explore);
  assert.equal(f.heading(), undefined);
  assert.equal(document.activeElement, f.explore);
});
