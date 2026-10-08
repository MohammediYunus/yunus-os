// YUNUS OS — widget: Active Initiative (plan progress, checklist tail, recent commits).
// Data source: data.initiative (see docs/CONTRACT.md — may be null; never throw).
import { h, relTime, tickUp, clamp } from '../lib/ui.js';

const refs = {};
let painted = false;

/** Short display label for a plan path. */
function planShort(planPath) {
  if (!planPath) return '';
  let s = String(planPath).split('/').pop().replace(/\.md$/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')
    .replace(/-(plan|spec|design)$/i, '');
  const m = s.match(/phase\d+/i);
  if (m && m.index > 0) s = s.slice(m.index);
  return clamp(s, 26);
}

function barSegments(done, total) {
  const n = Math.max(0, Math.min(Math.floor(total) || 0, 60));
  const lit = Math.max(0, Math.min(Math.floor(done) || 0, n));
  const segs = [];
  for (let i = 0; i < n; i++) segs.push(h('i', { class: i < lit ? 'on' : '' }));
  return segs;
}

function checklistRow(item) {
  const done = !!item?.done;
  const full = String(item?.text ?? '');
  // display text: no trailing commas/colons (reads badly under the 2-line clamp); full text in title
  const display = clamp(full.replace(/[\s,:;]+$/, ''), 160);
  return h('div', { class: `ini-item ${done ? 'done' : 'open'}` },
    h('span', { class: 'ini-mark' }, done ? '✓' : '▸'),
    h('span', { class: 'ini-text', title: full }, display));
}

function commitRow(c) {
  return h('div', { class: 'ini-commit' },
    h('span', { class: 'ini-sha num' }, String(c?.sha ?? '——————').slice(0, 7)),
    h('span', { class: 'ini-msg', title: String(c?.msg ?? '') },
      clamp(String(c?.msg ?? ''), 120)),
    h('span', { class: 'ini-when num' }, relTime(c?.at)));
}

export default {
  id: 'initiative',
  title: 'Active Initiative',

  mount(el) {
    refs.name = h('div', { class: 'ini-name' }, '—');
    refs.branch = h('span', { class: 'ini-branch' },
      h('span', { class: 'ini-branch-glyph' }, '⎇'),
      h('span', { class: 'ini-branch-name' }, '—'));
    refs.done = h('span', { class: 'ini-done num' }, '—');
    refs.total = h('span', { class: 'ini-total num' }, '/—');
    refs.pct = h('span', { class: 'ini-pct num' }, '');
    refs.bar = h('div', { class: 'ini-bar' });
    refs.list = h('div', { class: 'ini-list' });
    refs.commits = h('div', { class: 'ini-commits' });
    refs.main = h('div', { class: 'ini-main' },
      refs.name,
      h('div', { class: 'ini-branchrow' }, refs.branch),
      h('div', { class: 'ini-progress' },
        h('div', { class: 'ini-frac' }, refs.done, refs.total, refs.pct),
        refs.bar),
      h('div', { class: 'ini-sec microlabel' }, 'checklist · latest'),
      refs.list,
      h('div', { class: 'ini-sec microlabel' }, 'recent commits'),
      refs.commits);
    refs.empty = h('div', { class: 'empty-state' }, 'no active initiative');
    refs.root = h('div', { class: 'w-initiative is-empty' }, refs.main, refs.empty);
    el.append(refs.root);
  },

  update(data, ctx) {
    const ini = data?.initiative || null;
    refs.root.classList.toggle('is-empty', !ini);
    if (ctx?.aux) {
      // single non-wrapping span (never lets the panel head grow past one line)
      if (!refs.aux) refs.aux = h('span', { class: 'ini-aux' });
      refs.aux.textContent = ini ? (planShort(ini.planPath) || 'Local checklist') : 'No initiative';
      refs.aux.title = ini?.planPath ? String(ini.planPath) : '';
      if (refs.aux.parentNode !== ctx.aux) ctx.aux.replaceChildren(refs.aux);
    }
    if (!ini) return;

    refs.name.textContent = ini.name || 'untitled initiative';
    refs.name.title = ini.name || '';
    refs.branch.lastChild.textContent = ini.branch || '';
    refs.branch.parentElement.hidden = !ini.branch;

    const done = Number(ini.checklist?.done);
    const total = Number(ini.checklist?.total);
    const haveNums = Number.isFinite(done) && Number.isFinite(total);
    if (haveNums && !painted) { tickUp(refs.done, done, { ms: 400 }); painted = true; }
    else refs.done.textContent = Number.isFinite(done) ? String(done) : '—';
    refs.total.textContent = `/${Number.isFinite(total) ? total : '—'}`;
    refs.pct.textContent = haveNums && total > 0 ? `${Math.round((done / total) * 100)}%` : '';
    refs.bar.replaceChildren(...(haveNums ? barSegments(done, total) : []));

    const items = Array.isArray(ini.checklist?.items) ? ini.checklist.items.slice(-6) : [];
    refs.list.replaceChildren(...(items.length
      ? items.map(checklistRow)
      : [h('div', { class: 'ini-none' }, 'no checklist items')]));

    const commits = Array.isArray(ini.recentCommits) ? ini.recentCommits.slice(0, 4) : [];
    refs.commits.hidden = commits.length === 0;
    refs.commits.previousElementSibling.hidden = commits.length === 0;
    refs.commits.replaceChildren(...(commits.length
      ? commits.map(commitRow)
      : [h('div', { class: 'ini-none' }, 'no recent commits')]));
  },
};
