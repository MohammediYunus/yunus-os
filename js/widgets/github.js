// YUNUS OS — GitHub Ops widget: review queue, my open PRs, recent workflow runs.
import { h, relTime, statusDot, listRow, clamp } from '../lib/ui.js';
import { githubSearchCount } from '../lib/local-commands.js';

const CI_DOT = { passing: 'ok', failing: 'crit', pending: 'warn', none: '' };
const RUN_DOT = { success: 'ok', failure: 'crit', cancelled: '' };

const shortRepo = (repo) =>
  repo && repo.includes('/') ? repo.split('/')[1] : repo || '?';

/* section header: microlabel + count badge (badge lights orange only when hot) */
function sectionHead(label) {
  const badge = h('span', { class: 'gh-count' }, '—');
  return { head: h('div', { class: 'gh-sec-head' }, h('span', { class: 'microlabel' }, label), badge), badge };
}

function setBadge(badge, n, { hot = false } = {}) {
  badge.textContent = n == null ? '—' : String(n);
  badge.classList.toggle('hot', hot && n > 0);
}

function reviewRow(pr) {
  return listRow({
    href: pr.url,
    cls: 'gh-row',
    left: [
      h('div', { class: 'gh-line' },
        h('span', { class: 'gh-chip' }, `${shortRepo(pr.repo)}#${pr.number}`),
        pr.isDraft ? h('span', { class: 'gh-chip faint' }, 'draft') : null,
        h('span', { class: 'gh-title' }, clamp(pr.title, 80)),
      ),
      h('div', { class: 'gh-meta' }, h('span', {}, `@${pr.author || '?'}`)),
    ],
    right: relTime(pr.createdAt),
  });
}

function prRow(pr) {
  const decision =
    pr.reviewDecision === 'APPROVED'
      ? h('span', { class: 'gh-chip ok' }, 'APPROVED')
      : pr.reviewDecision === 'CHANGES_REQUESTED'
        ? h('span', { class: 'gh-chip crit' }, 'CHANGES')
        : null;
  return listRow({
    href: pr.url,
    cls: 'gh-row',
    left: [
      h('div', { class: 'gh-line' },
        statusDot(CI_DOT[pr.ci] ?? ''),
        h('span', { class: 'gh-chip' }, `${shortRepo(pr.repo)}#${pr.number}`),
        h('span', { class: 'gh-title' }, clamp(pr.title, 72)),
      ),
      h('div', { class: 'gh-meta' },
        h('span', { class: 'gh-branch' }, pr.branch || '—'),
        decision,
      ),
    ],
    right: relTime(pr.updatedAt),
  });
}

function runRow(run) {
  // null conclusion = still running → pending
  const kind = run.conclusion == null ? 'warn' : RUN_DOT[run.conclusion] ?? '';
  return listRow({
    href: run.url,
    cls: 'gh-row slim',
    left: h('div', { class: 'gh-line' },
      statusDot(kind),
      h('span', { class: 'gh-title' }, clamp(run.workflow, 34)),
      h('span', { class: 'gh-branch' }, run.branch || '—'),
    ),
    right: relTime(run.updatedAt),
  });
}

function fill(bodyEl, rows, emptyText) {
  if (rows && rows.length) bodyEl.replaceChildren(...rows);
  else bodyEl.replaceChildren(h('div', { class: 'empty-state' }, emptyText));
}

function searchNotice(result, configured) {
  if (!configured) return 'No GitHub username configured.';
  if (result.total === null) return `Showing ${result.loaded} results. ${result.incomplete ? 'GitHub search incomplete; total unknown.' : 'Total unavailable.'}`;
  return result.loaded < result.total ? `Showing ${result.loaded} of ${result.total}.` : '';
}

const els = {};

export default {
  id: 'github',
  title: 'GitHub Ops',

  mount(el) {
    const review = sectionHead('Needs your review');
    const prs = sectionHead('Your open PRs');
    const runs = sectionHead('Recent runs');
    els.freshness = h('div', { class: 'gh-freshness', hidden: true });
    els.reviewBadge = review.badge;
    els.prsBadge = prs.badge;
    els.runsBadge = runs.badge;
    els.reviewNotice = h('div', { class: 'gh-search-note', hidden: true });
    els.prsNotice = h('div', { class: 'gh-search-note', hidden: true });
    els.reviewBody = h('div', { class: 'gh-sec-body' }, h('div', { class: 'empty-state' }, 'awaiting data'));
    els.prsBody = h('div', { class: 'gh-sec-body' }, h('div', { class: 'empty-state' }, 'awaiting data'));
    els.runsBody = h('div', { class: 'gh-sec-body' }, h('div', { class: 'empty-state' }, 'awaiting data'));
    el.append(
      h('div', { class: 'w-github' },
        els.freshness,
        h('div', { class: 'gh-sec' }, review.head, els.reviewNotice, els.reviewBody),
        h('div', { class: 'gh-sec' }, prs.head, els.prsNotice, els.prsBody),
        h('div', { class: 'gh-sec' }, runs.head, els.runsBody),
      ),
    );
  },

  update(data, ctx) {
    const gh = data?.github || null;
    const source = data?.sources?.github;
    const updatedAt = source?.updatedAt;
    const updated = new Date(updatedAt);
    const hasTimestamp = !!gh && !!updatedAt && Number.isFinite(updated.getTime());
    els.freshness.hidden = !hasTimestamp;
    els.freshness.replaceChildren();
    if (hasTimestamp) {
      els.freshness.append(
        source.stale ? 'Last known data · Updated ' : 'Last updated ',
        h('time', { datetime: updated.toISOString(), title: updated.toLocaleString() }, updated.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
      );
    }
    if (!gh) {
      if (ctx?.aux) ctx.aux.replaceChildren(h('span', { class: 'gh-aux' }, '—'));
      setBadge(els.reviewBadge, null);
      setBadge(els.prsBadge, null);
      setBadge(els.runsBadge, null);
      els.reviewNotice.hidden = els.prsNotice.hidden = true;
      fill(els.reviewBody, null, 'no github data');
      fill(els.prsBody, null, 'no github data');
      fill(els.runsBody, null, 'no github data');
      return;
    }

    const review = Array.isArray(gh.reviewRequested) ? gh.reviewRequested : [];
    const prs = Array.isArray(gh.myOpenPRs) ? gh.myOpenPRs : [];
    const runs = (Array.isArray(gh.recentRuns) ? gh.recentRuns : []).slice(0, 4);
    const configured = gh.user !== '';
    const reviewCount = githubSearchCount(gh, 'reviewRequested'), prCount = githubSearchCount(gh, 'myOpenPRs'), issueCount = githubSearchCount(gh, 'openIssues');
    const nReview = configured ? reviewCount.total : null, nPrs = configured ? prCount.total : null, nIssues = configured ? issueCount.total : null;
    for (const [element, count] of [[els.reviewNotice, reviewCount], [els.prsNotice, prCount]]) {
      element.textContent = searchNotice(count, configured); element.hidden = !element.textContent;
    }

    if (ctx?.aux) {
      ctx.aux.replaceChildren(
        h('span', { class: `gh-aux num${nReview > 0 ? ' hot' : ''}`, title: `Reviews requested: ${nReview ?? 'total unknown'}` }, nReview == null ? '—' : String(nReview)),
        h('span', { class: 'gh-aux-sep' }, '·'),
        h('span', { class: 'gh-aux num', title: `Open pull requests: ${nPrs ?? 'total unknown'}` }, nPrs == null ? '—' : String(nPrs)),
        h('span', { class: 'gh-aux-sep' }, '·'),
        h('span', { class: 'gh-aux num', title: `Assigned issues: ${nIssues ?? 'total unknown'}` }, nIssues == null ? '—' : String(nIssues)),
      );
    }

    setBadge(els.reviewBadge, nReview, { hot: true });
    setBadge(els.prsBadge, nPrs);
    setBadge(els.runsBadge, runs.length);

    fill(els.reviewBody, review.map(reviewRow), nReview === 0 ? 'review queue clear' : 'no review results loaded');
    fill(els.prsBody, prs.map(prRow), nPrs === 0 ? 'no open prs' : 'no pull request results loaded');
    fill(els.runsBody, runs.map(runRow), 'no recent runs');
  },
};
