import { h, relTime } from '/js/lib/ui.js';
const refs = {}; let tasks = [], filter = 'open', context, busy = false;
function render() {
  const open = tasks.filter(task => !task.done), done = tasks.filter(task => task.done);
  refs.count.textContent = String(open.length); refs.summary.textContent = `${done.length} complete · ${tasks.length} total`;
  for (const [name, button] of Object.entries(refs.tabs)) { button.classList.toggle('on', name === filter); button.setAttribute('aria-pressed', String(name === filter)); }
  const shown = filter === 'open' ? open : done;
  refs.list.replaceChildren(...(shown.length ? shown.map(task => {
    const toggle = h('input', { type: 'checkbox', checked: !!task.done, disabled: busy, 'aria-label': `${task.done ? 'Reopen' : 'Complete'} ${task.title}`, onchange: async () => { await mutate(`/api/tasks/${encodeURIComponent(task.id)}`, 'PATCH', { done: toggle.checked }); } });
    const remove = h('button', { class: 'task-remove', type: 'button', disabled: busy, 'aria-label': `Delete task: ${task.title}`, onclick: async () => { await mutate(`/api/tasks/${encodeURIComponent(task.id)}`, 'DELETE'); } }, 'Remove');
    return h('div', { class: `task-row${task.done ? ' done' : ''}` }, toggle, h('div', { class: 'task-copy' }, h('span', {}, task.title), h('small', {}, relTime(task.createdAt))), remove);
  }) : [h('div', { class: 'tasks-empty' }, filter === 'open' ? 'A clear checklist. Add your next task below.' : 'Completed tasks will appear here.')]));
  refs.add.disabled = busy; refs.input.disabled = busy;
  if (context?.aux) context.aux.textContent = 'Saved locally';
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
    refs.list = h('div', { class: 'task-list' }); refs.input = h('input', { type: 'text', id: 'new-task', placeholder: 'Add something to do', maxlength: 240, required: true }); refs.add = h('button', { type: 'submit', class: 'secondary-button' }, 'Add'); refs.status = h('p', { class: 'task-status', role: 'status' });
    const form = h('form', { class: 'task-form' }, h('label', { for: 'new-task', class: 'sr-only' }, 'New local task'), refs.input, refs.add);
    form.addEventListener('submit', async event => { event.preventDefault(); const title = refs.input.value.trim(); if (!title || busy) return; await mutate('/api/tasks', 'POST', { title }); if (!refs.status.textContent) refs.input.value = ''; refs.input.focus(); });
    root.append(h('div', { class: 'tasks-hero' }, refs.count, h('span', {}, 'tasks\nopen')), refs.summary, h('div', { class: 'task-tabs' }, Object.values(refs.tabs)), refs.list, form, refs.status);
    render();
  },
  update(data, ctx) { context = ctx; tasks = Array.isArray(data.tasks?.items) ? data.tasks.items : []; render(); },
};
