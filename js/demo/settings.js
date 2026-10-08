import { h } from '../lib/ui.js';
import { drawer } from '../lib/drawer.js';

export function initDemoSettings({ api, getConfig, onSaved }) {
  const view = drawer('demo-settings', 'About this demo', 'Explore Yunus OS before connecting your own workspace.');
  const voice = h('input', { type: 'checkbox', id: 'demo-read-aloud' });
  const status = h('p', { class: 'form-status', role: 'status', 'aria-live': 'polite' });
  const save = h('button', { type: 'submit', class: 'primary-button' }, 'Save preference');
  const form = h('form', { class: 'settings-form' },
    h('fieldset', {}, h('legend', {}, 'A workspace to explore'),
      h('p', { class: 'field-help' }, 'The repositories, graph and activity are fictional. Tasks you add or complete stay in this browser. The demo never connects to your accounts or reads files on your computer.')),
    h('fieldset', {}, h('legend', {}, 'Hear a reply'),
      h('label', { class: 'check-row', for: 'demo-read-aloud' }, voice, h('span', {}, 'Read assistant replies aloud')),
      h('p', { class: 'field-help' }, 'Uses an installed local browser voice, if one is available. Microphone input and connected AI providers are available in the local app.')),
    h('fieldset', {}, h('legend', {}, 'Use your own projects'),
      h('p', { class: 'field-help' }, 'Run the open-source app on your computer to connect repository folders, GitHub activity and optional providers.'),
      h('a', { class: 'text-button', href: 'https://github.com/MohammediYunus/yunus-os#try-it', target: '_blank', rel: 'noopener noreferrer' }, 'Get the local app and setup guide')),
    h('div', { class: 'drawer-actions' }, save, status));
  form.addEventListener('submit', async event => {
    event.preventDefault(); save.disabled = true; status.textContent = '';
    try {
      const result = await api('/api/config', { method: 'POST', body: { voice: { enabled: voice.checked } } });
      await onSaved();
      status.textContent = result.capabilities?.storage?.persistent === false ? 'Updated for this tab. Browser storage is unavailable.' : 'Preference saved in this browser.';
    } catch (error) { status.textContent = error.message; }
    finally { save.disabled = false; }
  });
  view.content.append(form);
  return { open() { voice.checked = !!getConfig().voice?.enabled; status.textContent = ''; view.open(); } };
}
