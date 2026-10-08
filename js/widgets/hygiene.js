// YUNUS OS — widget 07: REPO HYGIENE. Full-width bottom strip: repo/worktree cards + suggestions.
// Data source: data.repos (see docs/CONTRACT.md — repos.json). May be null; never throw.
// Layout: primary row shows only as many WHOLE cards as fit (main repos first, then by
// dirtiness); overflow collapses into a "+N MORE" chip that toggles a second wrapped row.
// Recomputed on ResizeObserver — cards never clip mid-card and never run under suggestions.
import { h, fmtInt, ageHours, statusDot, clamp } from '../lib/ui.js';

let mainEl = null; // column: primary row + overflow row
let rowEl = null; // primary row (whole cards + "+N more" chip)
let moreEl = null; // toggleable second row with the hidden cards
let sugListEl = null;
let auxEl = null;

let moreChip = null;
let moreNumEl = null;
let moreVerbEl = null;
let moreDirtyEl = null;

let orderedRepos = [];
let cardNodes = [];
let open = false;
let ro = null;
let raf = 0;
let lastW = 0;

/* "38 dirty · 2 untracked · 16 deleted" — dirty segment warns past 25 */
function statParts(r) {
  const dirty = r.dirtyFiles || 0;
  const untracked = r.untracked || 0;
  const deleted = r.deleted || 0;
  if (!dirty && !untracked && !deleted) {
    return [h('span', { class: 'hy-clean' }, 'clean')];
  }
  const parts = [];
  const push = (n, label, cls) => {
    if (parts.length) parts.push(h('span', { class: 'hy-sep' }, '·'));
    parts.push(h('span', { class: cls || null }, `${fmtInt(n)} ${label}`));
  };
  push(dirty, 'dirty', dirty > 25 ? 'warn' : null);
  if (untracked) push(untracked, 'untracked');
  if (deleted) push(deleted, 'deleted');
  return parts;
}

/* small chips: ahead/behind arrows when nonzero, stash count when > 0 */
function flagChips(r) {
  const out = [];
  const ahead = r.ahead || 0;
  const behind = r.behind || 0;
  if (ahead > 0 || behind > 0) {
    out.push(h('span', { class: 'hy-flag info num' }, `↑${ahead} ↓${behind}`));
  }
  const stashes = r.stashes || 0;
  if (stashes > 0) {
    out.push(h('span', { class: 'hy-flag num' }, `${stashes} stash${stashes > 1 ? 'es' : ''}`));
  }
  return out;
}

function repoCard(r) {
  const dirty = r.dirtyFiles || 0;
  const tone = dirty > 60 ? 'is-crit' : dirty > 25 ? 'is-warn' : '';
  const flags = flagChips(r);
  return h('article', { class: `hy-card ${tone}`, title: r.path || null },
    h('div', { class: 'hy-name' },
      r.worktree ? null : statusDot('orange'),
      h('span', { class: 'hy-name-txt' }, r.name || '—')),
    // branch/name ellipsize via CSS inside the card; title carries the full value
    h('div', { class: 'hy-branch microlabel', title: r.branch || null }, r.branch || '—'),
    h('div', { class: 'hy-stats num' }, statParts(r)),
    flags.length ? h('div', { class: 'hy-flags' }, flags) : null,
    h('div', { class: 'hy-last' },
      h('span', { class: 'hy-age num' }, ageHours(r.lastCommitAgeHours)),
      h('span', { class: 'hy-msg' }, clamp(r.lastCommitMsg, 80) || '—')));
}

function suggestionRow(s) {
  return h('div', { class: 'hy-sug' },
    statusDot(s.severity),
    h('span', { class: 'hy-sug-txt' }, s.text || ''));
}

function setOpen(v) {
  open = !!v && moreEl && moreEl.childElementCount > 0;
  if (mainEl) mainEl.classList.toggle('is-open', open);
  if (moreChip) moreChip.setAttribute('aria-expanded', String(open));
  if (moreVerbEl) moreVerbEl.textContent = open ? 'hide' : 'more';
}

/* Fit as many whole cards as possible; overflow goes behind the +N chip. */
function relayout() {
  if (!rowEl || !moreEl) return;
  if (!cardNodes.length) return;
  const avail = rowEl.clientWidth;
  if (!avail) return;

  // measure with real CSS: one card + the chip, then decide
  rowEl.replaceChildren(cardNodes[0], moreChip);
  const gap = parseFloat(getComputedStyle(rowEl).columnGap) || 10;
  const cardW = cardNodes[0].offsetWidth || 236;
  const chipW = moreChip.offsetWidth || 118;

  const n = cardNodes.length;
  const fitAll = Math.floor((avail + gap) / (cardW + gap));
  let visible = n;
  if (fitAll < n) visible = Math.max(1, Math.floor((avail - chipW) / (cardW + gap)));

  const hidden = orderedRepos.slice(visible);
  if (hidden.length) {
    const hiddenDirty = hidden.reduce((a, r) => a + (r.dirtyFiles || 0), 0);
    moreNumEl.textContent = `+${hidden.length}`;
    moreDirtyEl.textContent = `${fmtInt(hiddenDirty)} dirty`;
    rowEl.replaceChildren(...cardNodes.slice(0, visible), moreChip);
    moreEl.replaceChildren(...cardNodes.slice(visible));
    setOpen(open); // keep toggle state across resizes, refresh labels
  } else {
    rowEl.replaceChildren(...cardNodes);
    moreEl.replaceChildren();
    setOpen(false);
  }
}

function scheduleRelayout() {
  if (raf) cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => { raf = 0; relayout(); });
}

export default {
  id: 'hygiene',
  title: 'Repo Hygiene',

  mount(el, ctx) {
    auxEl = ctx?.aux || null;

    moreNumEl = h('span', { class: 'hy-more-n num' }, '+0');
    moreVerbEl = h('span', { class: 'hy-more-verb microlabel' }, 'more');
    moreDirtyEl = h('span', { class: 'hy-more-dirty num' }, '');
    moreChip = h('button', {
      class: 'hy-more',
      type: 'button',
      'aria-expanded': 'false',
      'aria-controls': 'hy-row-more',
      onclick: () => setOpen(!open),
    }, moreNumEl, moreVerbEl, moreDirtyEl);

    rowEl = h('div', { class: 'hy-row' },
      h('div', { class: 'empty-state' }, 'awaiting repo scan'));
    moreEl = h('div', { class: 'hy-row hy-row-more', id: 'hy-row-more' });
    mainEl = h('div', { class: 'hy-main' }, rowEl, moreEl);

    sugListEl = h('div', { class: 'hy-sug-list' },
      h('div', { class: 'hy-sug-empty' }, '—'));
    el.append(h('div', { class: 'w-hygiene' },
      mainEl,
      h('aside', { class: 'hy-suggest' },
        h('div', { class: 'microlabel hy-sug-head' }, 'suggestions'),
        sugListEl)));
    if (auxEl) auxEl.replaceChildren('—');

    if (ro) ro.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        const w = rowEl ? rowEl.clientWidth : 0;
        if (w === lastW) return;
        lastW = w;
        scheduleRelayout();
      });
      ro.observe(rowEl);
    }
  },

  update(data, ctx) {
    if (!rowEl || !sugListEl) return;
    const aux = ctx?.aux || auxEl;
    const src = data?.repos;
    const repos = (Array.isArray(src?.repos) ? src.repos : []).map(repo => ({ ...repo, worktree: repo.worktree ?? repo.isWorktree, lastCommitAgeHours: repo.lastCommitAgeHours ?? (repo.ageDays == null ? null : repo.ageDays * 24), lastCommitMsg: repo.lastCommitMsg ?? (typeof repo.lastCommit === 'string' ? repo.lastCommit : repo.lastCommit?.message || repo.lastCommit?.msg) }));

    if (!repos.length) {
      orderedRepos = [];
      cardNodes = [];
      rowEl.replaceChildren(
        h('div', { class: 'empty-state' }, src?.error ? 'repo scan failed' : 'no repo data'));
      moreEl.replaceChildren();
      setOpen(false);
      if (aux) aux.replaceChildren('—');
    } else {
      // main repos first, then by dirtiness (dirtiest visible, cleanest behind the chip)
      orderedRepos = [...repos].sort((a, b) =>
        ((a.worktree ? 1 : 0) - (b.worktree ? 1 : 0)) ||
        ((b.dirtyFiles || 0) - (a.dirtyFiles || 0)));
      cardNodes = orderedRepos.map(repoCard);
      relayout();
      if (aux) {
        const totalDirty = repos.reduce((a, r) => a + (r.dirtyFiles || 0), 0);
        const wt = repos.filter((r) => r.worktree).length;
        aux.replaceChildren(`${repos.length} repos · ${wt} wt · ${fmtInt(totalDirty)} dirty`);
      }
    }

    const sugs = Array.isArray(src?.suggestions) ? src.suggestions.slice(0, 4) : [];
    sugListEl.replaceChildren(...(sugs.length
      ? sugs.map(suggestionRow)
      : [h('div', { class: 'hy-sug-empty' }, repos.length ? 'Nothing flagged in the selected repositories.' : 'Connect a repository to get started.')]));
  },
};
