import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Only the DOM operations used by this widget and the real h() helper.
class Element {
  constructor(tag, text = '') { this.tagName = tag; this.nodeType = tag === '#text' ? 3 : 1; this.text = text; this.children = []; this.attributes = {}; this.listeners = {}; this.classList = { toggle() {} }; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; if (name === 'checked') this.checked = true; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  set textContent(text) { this.children = [new Element('#text', text)]; }
  get textContent() { return this.nodeType === 3 ? this.text : this.children.map(child => child.textContent).join(''); }
}
const descendants = element => [element, ...element.children.flatMap(descendants)];

test('all saved tasks remain accessible in both tabs, including their actions', async t => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text) };
  t.after(() => { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; });
  // Resolve the browser's root-relative helper import without changing widget code.
  const source = (await readFile(new URL('../js/widgets/tasks.js', import.meta.url), 'utf8'))
    .replace("'/js/lib/ui.js'", JSON.stringify(new URL('../js/lib/ui.js', import.meta.url).href));
  const widget = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
  let tasks = [false, true].flatMap(done => Array.from({ length: 24 }, (_, i) => ({ id: `${done ? 'done' : 'open'}-${i + 1}`, title: `${done ? 'Done' : 'Open'} task ${i + 1}`, done, createdAt: '2026-01-01T00:00:00Z' })));
  const root = new Element('main'), calls = [];
  const context = {
    api: async (route, options) => {
      calls.push([route, options]);
      const id = route.split('/').at(-1);
      if (options.method === 'DELETE') tasks = tasks.filter(task => task.id !== id);
      else tasks.find(task => task.id === id).done = options.body.done;
    },
    reload: async () => widget.update({ tasks: { items: tasks } }, context),
  };
  widget.mount(root, context); await context.reload();
  const labeled = label => descendants(root).find(el => el.attributes['aria-label'] === label);
  const tab = label => descendants(root).find(el => el.tagName === 'button' && el.textContent === label);
  assert.equal(descendants(root).filter(el => el.attributes['aria-label']?.startsWith('Complete ')).length, 24);
  const complete = labeled('Complete Open task 24');
  assert.ok(complete, 'The last open task must have a completion control');
  complete.checked = true; await complete.listeners.change();
  assert.deepEqual(calls.at(-1), ['/api/tasks/open-24', { method: 'PATCH', body: { done: true } }]);

  tab('Done').listeners.click();
  assert.equal(descendants(root).filter(el => el.attributes['aria-label']?.startsWith('Reopen ')).length, 25);
  const reopen = labeled('Reopen Done task 24');
  assert.ok(reopen, 'The last completed task must have a reopen control');
  reopen.checked = false; await reopen.listeners.change();
  assert.deepEqual(calls.at(-1), ['/api/tasks/done-24', { method: 'PATCH', body: { done: false } }]);
  await labeled('Delete task: Done task 23').listeners.click();
  assert.deepEqual(calls.at(-1), ['/api/tasks/done-23', { method: 'DELETE', body: undefined }]);
  assert.equal(labeled('Delete task: Done task 23'), undefined);
  tab('To do').listeners.click();
  assert.ok(labeled('Complete Done task 24'), 'Reopened task must be accessible in To do');
});
