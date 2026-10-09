// Pure workspace commands shared by the local app and browser demo.
const short = (value, length = 180) => String(value ?? '').replace(/\s+/g, ' ').slice(0, length);
// A loaded page is not a total, including legacy snapshots with numeric counts.
export function githubSearchCount(github, name) {
  const loaded = Array.isArray(github?.[name]) ? github[name].length : 0;
  const search = github?.search?.[name];
  const total = Number.isSafeInteger(search?.totalCount) && search.totalCount >= loaded && search.incompleteResults === false ? search.totalCount : null;
  return { loaded, total, incomplete: search?.incompleteResults === true };
}
function searchSummary(github, name, singular, plural) {
  const { loaded, total, incomplete } = githubSearchCount(github, name);
  const count = total ?? loaded, label = count === 1 ? singular : plural;
  return total === null ? `${loaded} ${label} loaded (total unknown${incomplete ? '; GitHub search incomplete' : ''})`
    : `${total} ${label}${loaded < total ? ` (${loaded} loaded)` : ''}`;
}
export function workspaceSummary(dashboard = {}) {
  const tasks = (dashboard.tasks?.items || []).filter(item => !item.done);
  const repoSource = dashboard.sources?.repos || {};
  const githubSource = dashboard.sources?.github || {};
  const repoRows = Array.isArray(dashboard.repos?.repos) ? dashboard.repos.repos : null;
  const partialRepos = repoSource.status === 'error' && Boolean(repoRows?.length);
  const hasRepos = Boolean(repoRows) && (['live', 'demo'].includes(repoSource.status) || partialRepos);
  const repos = hasRepos ? repoRows : [];
  const githubReady = ['live', 'demo'].includes(githubSource.status) && Array.isArray(dashboard.github?.myOpenPRs) && Array.isArray(dashboard.github?.reviewRequested);
  const githubUser = typeof dashboard.github?.user === 'string' ? dashboard.github.user.trim() : null;
  const hasGitHub = githubReady && Boolean(githubUser);
  const prs = hasGitHub ? dashboard.github.myOpenPRs : [];
  const prefix = dashboard.demo ? 'Demo workspace (fictional data).' : 'Your workspace.';
  const counts = [`${tasks.length} open task${tasks.length === 1 ? '' : 's'}`];
  if (hasRepos) counts.push(`${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}${partialRepos ? ' available (partial)' : ''}`);
  if (hasGitHub) counts.push(searchSummary(dashboard.github, 'myOpenPRs', 'open pull request', 'open pull requests'), searchSummary(dashboard.github, 'reviewRequested', 'review requested', 'reviews requested'));
  const lines = [prefix, counts.join('; ') + '.'];
  for (const task of tasks.slice(0, 12)) lines.push(`Task: ${short(task.title)}`);
  for (const repo of repos.slice(0, 12)) lines.push(`Repository: ${short(repo.name, 70)}; branch ${short(repo.branch, 70)}; ${Number(repo.dirtyFiles) || 0} changed files.`);
  for (const pr of prs.slice(0, 8)) lines.push(`Pull request: ${short(pr.title)}; CI ${short(pr.ci || 'unknown', 20)}.`);
  if (!hasRepos) lines.push(`Local repositories ${repoSource.status === 'disabled' ? 'not connected' : 'unavailable'}.${repoSource.message ? ' ' + short(repoSource.message) : ''}`);
  else if (partialRepos && repoSource.message) lines.push(`Repository status: ${short(repoSource.message)}`);
  if (githubReady && githubUser === '') lines.push('GitHub pull requests and reviews: no username configured.');
  else if (!hasGitHub) lines.push(`GitHub ${githubSource.status === 'disabled' ? 'not connected' : 'unavailable'}.${githubSource.message ? ' ' + short(githubSource.message) : ''}`);
  const unavailable = Object.entries(dashboard.sources || {}).filter(([name, source]) => !['github', 'repos'].includes(name) && ['error', 'disabled'].includes(source.status)).map(([name]) => short(name, 70));
  if (unavailable.length) lines.push(`Other sources needing setup or attention: ${unavailable.join(', ')}.`);
  return lines.join('\n');
}

function proposedAction(message) {
  const title = message.match(/^\s*add a task:\s*([^\r\n]+?)\s*$/i)?.[1].trim();
  if (title && title.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(title)) return { type: 'add_task', title };
  const app = message.match(/^\s*(?:please\s+)?open\s+(calculator|textedit|finder)[.!]?\s*$/i)?.[1];
  if (app) return { type: 'open_app', app: { calculator: 'Calculator', textedit: 'TextEdit', finder: 'Finder' }[app.toLowerCase()] };
  const target = message.match(/^\s*(?:please\s+)?open\s+(https:\/\/\S+)\s*$/i)?.[1];
  if (target) {
    try {
      const url = new URL(target);
      if (url.protocol === 'https:' && !url.username && !url.password) return { type: 'open_url', url: url.href };
    } catch { /* Invalid URLs receive a normal answer without an action. */ }
  }
  return null;
}

export function localAnswer(message, dashboard, { allowDesktopActions = true } = {}) {
  const action = proposedAction(message);
  if (action && action.type !== 'add_task' && !allowDesktopActions) {
    return { text: 'This browser demo cannot open apps or websites. Try a workspace summary or add a task to the demo checklist.', provider: 'local' };
  }
  if (action) {
    const description = action.type === 'add_task' ? `add the task "${action.title}"` : `open ${action.app || action.url}`;
    return { text: `Ready to ${description}. Use the approval button when you're ready.`, provider: 'local', actions: [action] };
  }
  const tasks = (dashboard.tasks?.items || []).filter(item => !item.done);
  if (/\b(tasks?|todos?|next|priority|priorities)\b/i.test(message)) {
    const prefix = dashboard.demo ? 'In this demo, ' : '';
    return { text: tasks.length ? `${prefix}${tasks.length} task${tasks.length === 1 ? ' is' : 's are'} open. ${tasks.slice(0, 5).map(item => short(item.title)).join('; ')}.` : `${prefix}there are no open tasks in your checklist.`, provider: 'local' };
  }
  if (/\b(status|summary|summari[sz]e|workspace|attention|repos?|repositories|github|reviews?|pull|changed)\b/i.test(message)) return { text: workspaceSummary(dashboard), provider: 'local' };
  if (!allowDesktopActions) return { text: 'I can summarize this sample workspace, list tasks, or propose a task with "Add a task: ...". These browser demo commands do not use a model or connect to your accounts.', provider: 'local' };
  return { text: 'I can summarize your connected workspace, list open tasks, propose a task with "Add a task: ...", or prepare an approved app or HTTPS link to open. This local mode uses your dashboard data directly. Choose Ollama or Claude in Settings for conversational answers.', provider: 'local' };
}
