import { h, relTime } from '../lib/ui.js';
const refs = {}, rows = new Map(); let tasks = [], filter = 'open', context, busy = false;
function createRow(task) {
  const toggle = h('input', { type: 'checkbox', onclick: event => { if (busy) event.preventDefault(); }, onchange: async () => { await mutate(`/api/tasks/${encodeURIComponent(task.id)}`, 'PATCH', { done: toggle.checked }); } });
  const remove = h('button', { class: 'task-remove', type: 'button', onclick: async () => { await mutate(`/api/tasks/${encodeURIComponent(task.id)}`, 'DELETE'); } }, 'Remove');
  const title = h('span'), age = h('small');
  return { element: h('div', { class: 'task-row' }, toggle, h('div', { class: 'task-copy' }, title, age), remove), toggle, remove, title, age };
}
function render() {
  const active = document.activeElement;
  const focused = [...rows.entries()].find(([, row]) => row.toggle === active || row.remove === active);
  const focusedIndex = focused ? [...refs.list.children].indexOf(focused[1].element) : -1;
  const open = tasks.filter(task => !task.done), done = tasks.filter(task => task.done);
  refs.count.textContent = String(open.length); refs.summary.textContent = `${done.length} complete · ${tasks.length} total`;
  for (const [name, button] of Object.entries(refs.tabs)) { button.classList.toggle('on', name === filter); button.setAttribute('aria-pressed', String(name === filter)); }
  const shown = filter === 'open' ? open : done;
  const shownIds = new Set(shown.map(task => task.id));
  for (const [id, row] of rows) { if (!shownIds.has(id)) { row.element.remove(); rows.delete(id); } }
  if (shown.length) {
    refs.empty.remove();
    shown.forEach((task, index) => {
      let row = rows.get(task.id);
      if (!row) { row = createRow(task); rows.set(task.id, row); }
      row.element.classList.toggle('done', !!task.done); row.toggle.checked = !!task.done;
      row.toggle.setAttribute('aria-label', `${task.done ? 'Reopen' : 'Complete'} ${task.title}`);
      row.remove.setAttribute('aria-label', `Delete task: ${task.title}`);
      row.toggle.setAttribute('aria-disabled', String(busy)); row.remove.setAttribute('aria-disabled', String(busy));
      row.title.textContent = task.title; row.age.textContent = relTime(task.createdAt);
      if (refs.list.children[index] !== row.element) refs.list.insertBefore(row.element, refs.list.children[index] || null);
    });
  } else {
    refs.empty.textContent = filter === 'open' ? 'A clear checklist. Add your next task below.' : 'Completed tasks will appear here.';
    if (!refs.empty.isConnected) refs.list.append(refs.empty);
  }
  refs.add.setAttribute('aria-disabled', String(busy)); refs.input.readOnly = busy;
  if (focused) {
    const control = focused[1].toggle === active ? 'toggle' : 'remove';
    const target = rows.get(focused[0]) || rows.get(shown[Math.min(focusedIndex, shown.length - 1)]?.id);
    const next = target?.[control] || refs.input;
    if (document.activeElement !== next) next.focus();
  }
  if (context?.aux) context.aux.textContent = context.taskStorage || 'Saved locally';
}
async function mutate(path, method, body) {
  if (busy) return; busy = true; refs.status.textContent = ''; render();
  try { await context.api(path, { method, body }); await context.reload(); }
  catch (error) { refs.status.textContent = error.message; }
  finally { busy = false; render(); }
}
export default {
  mount(root, ctx) {
    context = ctx; refs.count = h('strong', { class: 'tasks-count num' }, '0'); refs.summary = h('p', { class: 'tasks-summary' });
    refs.tabs = Object.fromEntries(['open', 'done'].map(name => [name, h('button', { type: 'button', class: 'task-tab', onclick: () => { filter = name; render(); } }, name === 'open' ? 'To do' : 'Done')]));
    refs.list = h('div', { class: 'task-list' }); refs.empty = h('div', { class: 'tasks-empty' }); refs.input = h('input', { type: 'text', id: 'new-task', placeholder: 'Add something to do', maxlength: 240, required: true }); refs.add = h('button', { type: 'submit', class: 'secondary-button' }, 'Add'); refs.status = h('p', { class: 'task-status', role: 'status' });
    const form = h('form', { class: 'task-form' }, h('label', { for: 'new-task', class: 'sr-only' }, 'New local task'), refs.input, refs.add);
    form.addEventListener('submit', async event => { event.preventDefault(); const title = refs.input.value.trim(); if (!title || busy) return; await mutate('/api/tasks', 'POST', { title }); if (!refs.status.textContent) refs.input.value = ''; if (form.contains(document.activeElement)) refs.input.focus(); });
    root.append(h('div', { class: 'tasks-hero' }, refs.count, h('span', {}, 'tasks\nopen')), refs.summary, h('div', { class: 'task-tabs' }, Object.values(refs.tabs)), refs.list, form, refs.status);
    render();
  },
  update(data, ctx) { context = ctx; tasks = Array.isArray(data.tasks?.items) ? data.tasks.items : []; render(); },
};
