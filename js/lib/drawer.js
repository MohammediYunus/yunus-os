import { h } from './ui.js';
export function drawer(id, title, subtitle) {
  const dialog = h('dialog', { id, class: 'drawer', 'aria-labelledby': `${id}-title` });
  const close = h('button', { type: 'button', class: 'ctl-btn', 'aria-label': `Close ${title}`, onclick: () => dialog.close() }, 'Close');
  const content = h('div', { class: 'drawer-content' });
  dialog.append(h('header', { class: 'drawer-head' }, h('div', {}, h('h2', { id: `${id}-title` }, title), h('p', {}, subtitle)), close), content);
  let opener = null;
  dialog.addEventListener('click', event => { if (event.target === dialog && event.clientX < dialog.getBoundingClientRect().left) dialog.close(); });
  dialog.addEventListener('close', () => opener?.focus());
  document.body.append(dialog);
  return { dialog, content, open() { opener = document.activeElement; if (!dialog.open) dialog.showModal(); } };
}
