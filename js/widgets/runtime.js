import { h, fmtInt } from '../lib/ui.js';
const el = {};
export default {
  mount(root) {
    el.label = h('div', { class: 'runtime-state' }, 'STARTING');
    el.detail = h('p', { class: 'runtime-detail' }, 'Connecting to local server');
    el.stats = h('div', { class: 'runtime-stats' });
    el.facts = h('dl', { class: 'runtime-facts' });
    root.append(h('div', { class: 'w-runtime' }, h('div', { class: 'runtime-head' }, h('span', { class: 'dot ok' }), el.label), el.detail, el.stats, el.facts));
  },
  update(data, ctx) {
    const runtime = data.runtime || {};
    const demo = data.sources?.runtime?.status === 'demo';
    el.label.textContent = ctx.browserDemo ? 'BROWSER DEMO' : demo ? 'DEMO ONLINE' : 'LOCAL ONLINE';
    el.detail.textContent = ctx.browserDemo ? 'Sample workspace. Your tasks stay in this browser.' : demo ? 'Explore the console, then make it yours.' : 'Your command center is running on this computer.';
    el.stats.replaceChildren(...[[runtime.repoCount, 'repositories'], [runtime.connectedSources, 'connections']].map(([count, label]) => h('div', {}, h('strong', { class: 'num' }, fmtInt(count)), h('span', {}, label))));
    el.facts.replaceChildren(...[['Platform', runtime.platform || 'Local'], ctx.browserDemo ? ['Task storage', data.storage?.persistent === false ? 'This tab only' : 'This browser'] : ['Node', runtime.nodeVersion || 'Unknown'], ['Assistant', runtime.assistantProvider === 'local' ? 'Local commands' : runtime.assistantProvider || 'Not configured'], ctx.browserDemo ? ['Voice input', 'Local app only'] : ['Voice input', runtime.voiceReady ? 'Ready' : 'Optional · not ready']].flatMap(([name, value]) => [h('dt', {}, name), h('dd', {}, value)]));
    ctx.aux.textContent = demo ? 'Sample' : `${Math.floor((runtime.uptimeSeconds || 0) / 60)}m up`;
  },
};
