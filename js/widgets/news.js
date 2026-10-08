// YUNUS OS — AI Intel widget: filterable news feed (anthropic / openai / hn / reddit).
import { h, relTime, fmtInt, clamp, listRow } from '/js/lib/ui.js';

const SOURCES = ['git', 'github', 'local', 'anthropic', 'openai', 'hn', 'reddit'];
const FILTERS = ['all', ...SOURCES];
const LS_KEY = 'yos-news-filter';
const MAX_ROWS = 10;

const state = {
  filter: 'all',
  items: [],
  fetchedAt: null,
  listEl: null,
  footEl: null,
  auxEl: null,
  chipEls: new Map(),
  renderedKey: '',
};

function loadFilter() {
  try {
    const v = localStorage.getItem(LS_KEY);
    return FILTERS.includes(v) ? v : 'all';
  } catch {
    return 'all';
  }
}

function saveFilter(v) {
  try { localStorage.setItem(LS_KEY, v); } catch { /* storage unavailable */ }
}

function matching() {
  if (state.filter === 'all') return state.items;
  return state.items.filter((it) => String(it.source || '').toLowerCase() === state.filter);
}

// One neutral badge style for every source (design law: color = semantics or
// identity only; the active filter chip is the single colored element here).
function srcChip(it) {
  const src = String(it.source || '').toLowerCase();
  const label = typeof it.tag === 'string' && it.tag ? it.tag : (src || '?').toUpperCase();
  return h('span', { class: 'src' }, label);
}

function rowMeta(it) {
  const bits = [];
  if (it.points != null) bits.push(h('span', { class: 'm-pts' }, `▴${fmtInt(it.points)}`));
  if (it.comments != null) bits.push(h('span', { class: 'm-cmt' }, `${fmtInt(it.comments)}c`));
  bits.push(h('span', { class: 'm-time' }, relTime(it.publishedAt)));
  return bits;
}

function renderList(animate) {
  if (!state.listEl) return;
  const shown = matching().slice(0, MAX_ROWS);
  if (!shown.length) {
    state.listEl.replaceChildren(h('div', { class: 'empty-state' },
      state.items.length ? 'No activity in this filter' : 'No recent activity'));
    return;
  }
  const rows = shown.map((it, i) => {
    const row = listRow({
      href: typeof it.url === 'string' ? it.url : null,
      cls: 'news-row',
      left: [
        srcChip(it),
        h('span', { class: 'news-title', title: it.title || '' }, clamp(it.title, 160)),
        // dotted leader filling the title→meta gap on wide viewports
        h('span', { class: 'news-lead', 'aria-hidden': 'true' }),
      ],
      right: rowMeta(it),
    });
    if (animate) {
      row.classList.add('enter');
      row.style.animationDelay = `${Math.min(i * 26, 300)}ms`;
    }
    return row;
  });
  state.listEl.replaceChildren(...rows);
}

function renderAux() {
  if (!state.auxEl) return;
  const n = matching().length;
  state.auxEl.textContent = `${n} ${n === 1 ? 'item' : 'items'} · ${state.fetchedAt ? relTime(state.fetchedAt) : '—'}`;
}

// Always-present footer line so the panel keeps its mass under sparse filters.
function renderFoot() {
  if (!state.footEl) return;
  state.footEl.textContent =
    `${matching().length} of ${state.items.length} · filter: ${state.filter}`;
}

function setFilter(v) {
  if (!FILTERS.includes(v) || v === state.filter) return;
  state.filter = v;
  saveFilter(v);
  for (const [name, chip] of state.chipEls) {
    chip.classList.toggle('active', name === v);
    chip.setAttribute('aria-pressed', String(name === v));
  }
  renderList(true);
  renderAux();
  renderFoot();
}

export default {
  id: 'news',
  title: 'AI Intel',

  mount(el, ctx) {
    el.classList.add('w-news');
    state.filter = loadFilter();
    state.auxEl = ctx?.aux || null;
    state.chipEls.clear();
    const chips = FILTERS.map((f) => {
      const chip = h('button', {
        class: `news-chip${f === state.filter ? ' active' : ''}`,
        type: 'button',
        'aria-pressed': String(f === state.filter),
        onclick: () => setFilter(f),
      }, f.toUpperCase());
      state.chipEls.set(f, chip);
      return chip;
    });
    state.listEl = h('div', { class: 'news-list' });
    state.footEl = h('div', { class: 'news-foot' });
    el.append(h('div', { class: 'news-chips' }, chips), state.listEl, state.footEl);
    renderList(false);
    renderAux();
    renderFoot();
  },

  update(data, ctx) {
    if (ctx?.aux) state.auxEl = ctx.aux;
    const news = data?.news;
    state.items = Array.isArray(news?.items)
      ? news.items.filter((it) => it && typeof it === 'object')
      : [];
    state.fetchedAt = news?.fetchedAt || null;
    const activeSources = new Set(state.items.map(item => String(item.source || '').toLowerCase()));
    for (const [name, chip] of state.chipEls) chip.hidden = name !== 'all' && !activeSources.has(name);
    if (state.filter !== 'all' && !activeSources.has(state.filter)) setFilter('all');
    const key = JSON.stringify([data.mode, state.items]);
    if (key !== state.renderedKey) {
      state.renderedKey = key;
      renderList(true);
    }
    renderAux();
    renderFoot();
  },
};
