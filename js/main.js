// Local console shell. Sample and connected data are never merged.
import { h } from '/js/lib/ui.js';
import { initTheme } from '/js/lib/theme.js';
import { api, connectSession } from '/js/lib/api.js';
import { initConnections } from '/js/lib/connections.js';
import { initAssistant } from '/js/lib/assistant.js';
const WIDGETS = [
  { id: 'runtime', idx: '01', title: 'Local runtime' },
  { id: 'initiative', idx: '02', title: 'Initiative' },
  { id: 'graph', idx: '03', title: 'The graph' },
  { id: 'news', idx: '04', title: 'Activity feed' },
  { id: 'tasks', idx: '05', title: 'Local tasks' },
  { id: 'github', idx: '06', title: 'GitHub ops' },
  { id: 'hygiene', source: 'repos', idx: '07', title: 'Repo hygiene' },
];
const state = { mods: new Map(), panels: new Map(), data: null, config: { mode: 'demo', timezone: 'system' }, capabilities: {}, request: 0, controller: null, loading: false };
let connections, assistant;
function buildPanels() {
  for (const widget of WIDGETS) {
    const aux = h('div', { class: 'panel-aux' });
    const body = h('div', { class: 'panel-body', id: `body-${widget.id}` });
    const notice = h('div', { class: 'source-notice', hidden: true });
    document.getElementById(`panel-${widget.id}`).append(h('div', { class: 'panel-head' }, h('h2', { class: 'panel-title' }, h('span', { class: 'idx' }, widget.idx), widget.title), aux), notice, body, h('i', { class: 'tick-b' }));
    state.panels.set(widget.id, { el: body, aux, notice, api, reload: () => loadData(), openConnections: () => connections.open() });
  }
}
async function boot() {
  const overlay = document.getElementById('boot');
  const finish = () => { overlay.classList.add('done'); document.body.classList.add('ready'); };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
  overlay.addEventListener('click', finish, { once: true });
  for (const [index, line] of ['starting local console', 'loading workspace settings', 'rendering canvas and panels', 'welcome to yunus os'].entries()) {
    if (overlay.classList.contains('done')) return;
    document.getElementById('boot-lines').append(h('div', { class: 'sys' }, `› ${line}`));
    document.querySelector('#boot-bar i').style.width = `${(index + 1) * 25}%`;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  finish();
}
function startClock() {
  let priorZone, time, date;
  const render = () => {
    const zone = state.config.timezone || 'system';
    if (zone !== priorZone) {
      let options = zone === 'system' ? {} : { timeZone: zone };
      try { time = new Intl.DateTimeFormat('en-GB', { ...options, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); date = new Intl.DateTimeFormat('en-GB', { ...options, weekday: 'short', day: '2-digit', month: 'short' }); }
      catch { time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); date = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }); }
      priorZone = zone;
    }
    const now = new Date(), str = time.format(now);
    document.getElementById('clock').replaceChildren(str.slice(0, 6), h('span', { class: 'sec' }, str.slice(6)));
    document.getElementById('clock-meta').textContent = `${date.format(now)} · ${zone === 'system' ? 'local time' : zone}`;
  };
  render(); setInterval(render, 1000);
}
function showError(message) { document.getElementById('load-error-message').textContent = message; document.getElementById('load-error').hidden = false; }
function renderDashboard(data) {
  state.data = data;
  const demo = data.mode === 'demo' || data.demo === true;
  if (!demo) document.getElementById('welcome-strip').hidden = true;
  document.getElementById('workspace-mode').textContent = demo ? 'Demo workspace' : 'My workspace';
  document.querySelector('.wordmark .sub').textContent = state.config.displayName || 'Your local command center';
  document.querySelector('.boot-version').textContent = demo ? 'demo' : 'local';
  for (const widget of WIDGETS) {
    const ctx = state.panels.get(widget.id), source = data.sources?.[widget.source || widget.id];
    const unavailable = source?.status === 'disabled' || source?.status === 'error';
    const partialData = source?.status === 'error' && ((widget.id === 'hygiene' && data.repos?.repos?.length) || (widget.id === 'graph' && data.graph?.nodes?.length));
    ctx.notice.hidden = !unavailable; ctx.el.hidden = unavailable && !partialData;
    ctx.notice.classList.toggle('error', source?.status === 'error');
    if (unavailable) ctx.notice.replaceChildren(h('p', {}, source.message || (source.status === 'disabled' ? 'Connect this source to see your activity.' : 'This source could not refresh.')), h('button', { type: 'button', class: 'text-button', onclick: () => source.status === 'disabled' ? connections.open() : void loadData({ refresh: true }) }, source.status === 'disabled' ? 'Open connections' : 'Try again'));
    try { state.mods.get(widget.id)?.update(data, ctx); }
    catch { ctx.notice.hidden = false; ctx.el.hidden = true; ctx.notice.replaceChildren(h('p', {}, 'This panel could not load.'), h('button', { class: 'text-button', type: 'button', onclick: () => void loadData() }, 'Reload panel')); }
  }
  const githubReady = ['live', 'demo'].includes(data.sources?.github?.status);
  const reposReady = ['live', 'demo'].includes(data.sources?.repos?.status);
  const failing = (data.github?.recentRuns || []).filter(run => run.conclusion === 'failure').length;
  const openTasks = (data.tasks?.items || []).filter(task => !task.done).length;
  const dirty = (data.repos?.repos || []).reduce((sum, repo) => sum + (Number(repo.dirtyFiles) || 0), 0);
  const chips = [['ok', 'Local server up'], [githubReady ? (failing ? 'crit' : 'ok') : '', githubReady ? (failing ? `${failing} recent run${failing === 1 ? '' : 's'} failed` : 'Recent CI clear') : 'GitHub not connected'], [openTasks ? 'warn' : 'ok', `${openTasks} tasks open`], [reposReady ? (dirty ? 'warn' : 'ok') : '', reposReady ? `${dirty} dirty files` : 'No workspace folders']];
  document.getElementById('system-chips').replaceChildren(...chips.map(([tone, text]) => h('span', { class: `chip ${tone}` }, h('span', { class: 'dot' }), text)));
  document.getElementById('footer').replaceChildren(h('span', {}, data.disclosure || (demo ? 'Demo sources · tasks are saved on this computer' : 'Your connected workspace · read-only sources')), h('span', { class: 'spacer' }), h('span', {}, `Updated ${new Date(data.fetchedAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`));
  document.getElementById('load-error').hidden = true;
  assistant?.sync();
}
async function loadData({ refresh = false } = {}) {
  const own = ++state.request;
  state.controller?.abort(); state.controller = new AbortController(); state.loading = true;
  const button = document.getElementById('refresh'); button.disabled = true; button.textContent = 'Refreshing…';
  try {
    const data = await api(refresh ? '/api/refresh' : '/api/all', { method: refresh ? 'POST' : 'GET', ...(refresh ? { body: {} } : {}), signal: state.controller.signal });
    if (own === state.request) renderDashboard(data);
  } catch (error) { if (own === state.request && error.name !== 'AbortError') showError(`${error.message}${state.data ? ' The previous view is still shown.' : ''}`); }
  finally { if (own === state.request) { button.disabled = false; button.textContent = 'Refresh'; state.loading = false; } }
}
async function loadConfig() {
  const response = await api('/api/config'); state.config = response.config || response; state.capabilities = response.capabilities || {};
}
async function init() {
  buildPanels(); startClock(); initTheme(document.getElementById('theme-toggle'));
  const booted = boot();
  connections = initConnections({ getConfig: () => state.config, onSaved: async () => { await loadConfig(); await loadData({ refresh: true }); assistant?.sync(); } });
  assistant = initAssistant({ getConfig: () => state.config, getCapabilities: () => state.capabilities, onRefresh: () => loadData(), openConnections: () => connections.open() });
  for (const id of ['connections-open', 'welcome-connect', 'workspace-mode']) document.getElementById(id).addEventListener('click', () => connections.open());
  document.getElementById('assistant-open').addEventListener('click', () => assistant.open());
  document.getElementById('refresh').addEventListener('click', () => void loadData({ refresh: true }));
  document.getElementById('retry').addEventListener('click', async () => { try { await loadConfig(); await loadData(); } catch (error) { showError(error.message); } });
  document.getElementById('welcome-dismiss').addEventListener('click', () => { document.getElementById('welcome-strip').hidden = true; try { localStorage.setItem('yos-welcome-dismissed', '1'); } catch {} });
  await Promise.all(WIDGETS.map(async widget => {
    try { const module = (await import(`/js/widgets/${widget.id}.js`)).default; module.mount(state.panels.get(widget.id).el, state.panels.get(widget.id)); state.mods.set(widget.id, module); }
    catch { const panel = state.panels.get(widget.id); panel.notice.hidden = false; panel.notice.textContent = 'Panel unavailable. Reload the page to try again.'; }
  }));
  await connectSession(); await loadConfig(); await loadData(); await booted;
  let dismissed = false; try { dismissed = localStorage.getItem('yos-welcome-dismissed') === '1'; } catch {}
  document.getElementById('welcome-strip').hidden = dismissed || state.config.mode !== 'demo';
  setInterval(() => { if (!document.hidden && !state.loading) void loadData(); }, 60_000);
  setInterval(() => { for (const module of state.mods.values()) { try { module.tick?.(Date.now()); } catch {} } }, 1000);
}
init().catch(error => { document.body.classList.add('ready'); document.getElementById('boot').classList.add('done'); showError(error.message); });
