// Pure workspace commands shared by the local app and browser demo.
const short = (value, length = 180) => String(value ?? '').replace(/\s+/g, ' ').slice(0, length);
export function workspaceSummary(dashboard = {}) {
  const tasks = (dashboard.tasks?.items || []).filter(item => !item.done);
  const repos = dashboard.repos?.repos || [];
  const prs = dashboard.github?.myOpenPRs || [];
  const reviews = dashboard.github?.reviewRequested || [];
  const prefix = dashboard.demo ? 'Demo workspace (fictional data).' : 'Connected workspace.';
  const lines = [prefix, `${tasks.length} open tasks; ${repos.length} repositories; ${prs.length} open pull requests; ${reviews.length} reviews requested.`];
  for (const task of tasks.slice(0, 12)) lines.push(`Task: ${short(task.title)}`);
  for (const repo of repos.slice(0, 12)) lines.push(`Repository: ${short(repo.name, 70)}; branch ${short(repo.branch, 70)}; ${Number(repo.dirtyFiles) || 0} changed files.`);
  for (const pr of prs.slice(0, 8)) lines.push(`Pull request: ${short(pr.title)}; CI ${short(pr.ci || 'unknown', 20)}.`);
  const unavailable = Object.entries(dashboard.sources || {}).filter(([, source]) => ['error', 'disabled'].includes(source.status)).map(([name]) => name);
  if (unavailable.length) lines.push(`Unavailable sources: ${unavailable.join(', ')}. Do not infer their state.`);
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
