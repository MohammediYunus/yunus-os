import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The DOM operations used by the widget, including native focus loss when a
// focused subtree is removed or its control is disabled. Browser verification
// remains the oracle for real keyboard navigation and focus rendering.
class Element {
  constructor(tag, text = '') { this.tagName = tag; this.nodeType = tag === '#text' ? 3 : 1; this.text = text; this.children = []; this.attributes = {}; this.listeners = {}; this.value = ''; this.checked = false; this.readOnly = false; this.classList = { toggle() {} }; }
  append(...children) { for (const child of children) this.insertBefore(child, null); }
  insertBefore(child, before) { if (child === before) return; child.remove(); child.parentElement = this; const index = before ? this.children.indexOf(before) : this.children.length; this.children.splice(index, 0, child); }
  remove() { if (!this.parentElement) return; if (this.contains(document.activeElement)) document.activeElement = document.body; this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); }
  contains(element) { return this === element || this.children.some(child => child.contains(element)); }
  get isConnected() { return !!document.body?.contains(this); }
  set disabled(value) { this._disabled = value; if (value && document.activeElement === this) document.activeElement = document.body; }
  get disabled() { return !!this._disabled; }
  focus() { if (this.isConnected && !this.disabled) document.activeElement = this; }
  setAttribute(name, value) { this.attributes[name] = value; if (name === 'checked') this.checked = true; if (name === 'disabled') this.disabled = true; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  set textContent(text) { this.replaceChildren(new Element('#text', text)); }
  get textContent() { return this.nodeType === 3 ? this.text : this.children.map(child => child.textContent).join(''); }
}
const descendants = element => [element, ...element.children.flatMap(descendants)];

test('all saved tasks remain accessible in both tabs, including their actions', async t => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text) };
  t.after(() => { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; });
  // Resolve the browser's root-relative helper import without changing widget code.
  const source = (await readFile(new URL('../js/widgets/tasks.js', import.meta.url), 'utf8'))
    .replace("'../lib/ui.js'", JSON.stringify(new URL('../js/lib/ui.js', import.meta.url).href));
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

let fixtureId = 0;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function keyboardFixture(t, items = [1, 2, 3].map(id => ({ id: String(id), title: `Task ${id}`, done: false }))) {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text) };
  document.body = new Element('body'); document.activeElement = document.body;
  t.after(() => { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; });
  const source = (await readFile(new URL('../js/widgets/tasks.js', import.meta.url), 'utf8'))
    .replace("'../lib/ui.js'", JSON.stringify(new URL('../js/lib/ui.js', import.meta.url).href));
  const widget = (await import(`data:text/javascript;base64,${Buffer.from(source + `\n// fixture ${++fixtureId}`).toString('base64')}`)).default;
  let tasks = items.map(item => ({ createdAt: '2026-01-01T00:00:00Z', ...item })), gate;
  const root = new Element('main'), outside = new Element('button'), calls = [];
  document.body.append(outside, root);
  const context = {
    api: async (route, options) => {
      calls.push([route, options]);
      if (gate) await gate.promise;
      const id = route.split('/').at(-1);
      if (options.method === 'POST') tasks.push({ id: 'new', title: options.body.title, done: false, createdAt: '2026-01-01T00:00:00Z' });
      else if (options.method === 'DELETE') tasks = tasks.filter(task => task.id !== id);
      else tasks = tasks.map(task => task.id === id ? { ...task, done: options.body.done } : task);
    },
    reload: async () => widget.update({ tasks: { items: tasks } }, context),
  };
  widget.mount(root, context); await context.reload();
  return {
    root, outside, calls,
    labeled: label => descendants(root).find(el => el.attributes['aria-label'] === label),
    tab: label => descendants(root).find(el => el.tagName === 'button' && el.textContent === label),
    input: descendants(root).find(el => el.attributes.id === 'new-task'),
    form: descendants(root).find(el => el.tagName === 'form'),
    delay() { gate = deferred(); return gate; },
    refresh: () => context.reload(),
    replace(items) { tasks = items; return context.reload(); },
  };
}
async function activate(control) {
  if (control.disabled) return;
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  await control.listeners.click?.(event);
  if (control.attributes.type === 'checkbox' && !event.defaultPrevented) { control.checked = !control.checked; await control.listeners.change?.(event); }
}

test('unchanged task refresh retains the focused control and its DOM identity', async t => {
  const f = await keyboardFixture(t);
  for (const label of ['Complete Task 2', 'Delete task: Task 2']) {
    const control = f.labeled(label); control.focus();
    await f.refresh();
    assert.equal(f.labeled(label), control);
    assert.equal(document.activeElement, control);
  }
});

test('task updates preserve the focused control while renaming and reordering rows', async t => {
  const f = await keyboardFixture(t), control = f.labeled('Complete Task 2'); control.focus();
  await f.replace([{ id: '2', title: 'Renamed', done: false }, { id: '1', title: 'Task 1', done: false }]);
  assert.equal(f.labeled('Complete Renamed'), control);
  assert.equal(document.activeElement, control);
});

test('completing tasks focuses the next checkbox, previous final row, then the Add input', async t => {
  const f = await keyboardFixture(t);
  f.labeled('Complete Task 2').focus(); await activate(document.activeElement);
  assert.equal(document.activeElement, f.labeled('Complete Task 3'));
  await activate(document.activeElement);
  assert.equal(document.activeElement, f.labeled('Complete Task 1'));
  await activate(document.activeElement);
  assert.equal(document.activeElement, f.input);
  assert.equal(f.calls.length, 3);
});

test('deleting tasks keeps the Remove control in the next or previous row', async t => {
  const f = await keyboardFixture(t);
  f.labeled('Delete task: Task 2').focus(); await activate(document.activeElement);
  assert.equal(document.activeElement, f.labeled('Delete task: Task 3'));
  await activate(document.activeElement);
  assert.equal(document.activeElement, f.labeled('Delete task: Task 1'));
  await activate(document.activeElement);
  assert.equal(document.activeElement, f.input);
});

test('reopening the final completed task gives focus to the Add input', async t => {
  const f = await keyboardFixture(t, [{ id: '1', title: 'Finished', done: true }]);
  f.tab('Done').focus(); await activate(document.activeElement);
  f.labeled('Reopen Finished').focus(); await activate(document.activeElement);
  assert.equal(document.activeElement, f.input);
});

test('a rejected task update retains focus and resets the checkbox for retry', async t => {
  const f = await keyboardFixture(t), gate = f.delay(), control = f.labeled('Complete Task 1');
  control.focus(); const pending = activate(control);
  await Promise.resolve();
  assert.equal(document.activeElement, control);
  gate.reject(new Error('Offline for this test')); await pending;
  assert.equal(document.activeElement, control);
  assert.equal(f.labeled('Complete Task 1'), control);
  assert.equal(control.checked, false);
  assert.match(f.root.textContent, /Offline for this test/);
});

test('pending task mutations cannot be submitted twice', async t => {
  const f = await keyboardFixture(t), gate = f.delay(), control = f.labeled('Complete Task 1');
  control.focus(); const pending = activate(control);
  await Promise.resolve();
  await activate(control); await activate(f.labeled('Delete task: Task 2'));
  assert.equal(f.calls.length, 1);
  gate.resolve(); await pending;
});

test('finishing a request preserves focus moved to another row or outside the checklist', async t => {
  const f = await keyboardFixture(t), gate = f.delay(), control = f.labeled('Complete Task 1');
  control.focus(); const pending = activate(control); await Promise.resolve();
  const next = f.labeled('Delete task: Task 3'); next.focus();
  gate.resolve(); await pending;
  assert.equal(document.activeElement, next);
  const secondGate = f.delay(), second = f.labeled('Complete Task 2');
  second.focus(); const another = activate(second); await Promise.resolve();
  f.outside.focus(); secondGate.resolve(); await another;
  assert.equal(document.activeElement, f.outside);
});

test('a filter change during a pending mutation keeps focus on the chosen tab', async t => {
  const f = await keyboardFixture(t), gate = f.delay(), control = f.labeled('Complete Task 1');
  control.focus(); const pending = activate(control); await Promise.resolve();
  const tab = f.tab('Done'); tab.focus(); await activate(tab);
  gate.resolve(); await pending;
  assert.equal(document.activeElement, tab);
  assert.ok(f.labeled('Reopen Task 1'));
});

test('a rejected mutation does not steal focus from an opened dialog', async t => {
  const f = await keyboardFixture(t), gate = f.delay(), control = f.labeled('Complete Task 1');
  control.focus(); const pending = activate(control); await Promise.resolve();
  const dialog = new Element('dialog'), field = new Element('input'); dialog.append(field); document.body.append(dialog); field.focus();
  gate.reject(new Error('Offline for this test')); await pending;
  assert.equal(document.activeElement, field);
  assert.equal(f.labeled('Complete Task 1').checked, false);
});

test('Add keeps normal input focus without stealing focus after a delayed submission', async t => {
  const f = await keyboardFixture(t);
  f.input.value = 'First'; f.input.focus(); await f.form.listeners.submit({ preventDefault() {} });
  assert.equal(document.activeElement, f.input); assert.equal(f.input.value, '');
  const gate = f.delay(); f.input.value = 'Second';
  const pending = f.form.listeners.submit({ preventDefault() {} });
  assert.equal(document.activeElement, f.input);
  f.outside.focus(); gate.resolve(); await pending;
  assert.equal(document.activeElement, f.outside);
  assert.equal(f.input.value, ''); assert.equal(f.input.disabled, false);
});
