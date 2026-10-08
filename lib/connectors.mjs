import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createFixtures } from '../fixtures.mjs';
import { voiceCapabilities } from './voice.mjs';
const exec = promisify(execFile);
const stamp = () => new Date().toISOString();
const safeLink = value => { try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } };
const setupError = code => Object.assign(new Error('Repository setup failed'), { setupCode: code });
const gitWith = execute => async (root, ...args) => {
  try { return (await execute('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, ...args], { timeout: 6000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })).stdout.trimEnd(); }
  catch (error) {
    if (error.code === 'ENOENT') throw setupError('git-missing');
    if (error.code === 'EACCES' || error.code === 'EPERM') throw setupError('git-start-failed');
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel' && /not a git repository/i.test(error.stderr || '')) throw setupError('not-repository');
    throw setupError('git-failed');
  }
};
const setupMessages = {
  'path-missing': 'This path does not exist. Correct the path in Connections.',
  'path-unreadable': 'This folder could not be read. Check its access permissions, then try again.',
  'not-folder': 'Choose a folder rather than a file in Connections.',
  'not-repository': 'This is not a Git repository. Choose an existing Git repository in Connections.',
  'not-root': 'Choose the root folder of this Git repository in Connections, rather than a subfolder.',
  'git-missing': 'Git is not available to Yunus OS. Install Git or add it to the server’s PATH, then restart Yunus OS.',
  'git-start-failed': 'Git could not start. Check that Git can run on this computer, then restart Yunus OS.',
  'git-failed': 'Git could not read this repository. Check that git status works in this folder, then try again.',
};
function setupProblem(folder, error) {
  const code = Object.hasOwn(setupMessages, error?.setupCode) ? error.setupCode : 'path-unreadable';
  return { path: String(folder).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 2000), code, message: setupMessages[code] };
}
const skipPart = name => name.startsWith('.') || /^(node_modules|vendor|dist|build|coverage|__pycache__|target)$/i.test(name);
const sourceExt = /\.(?:[cm]?[jt]sx?|py|go|rs|swift|cs|java|html|css|md|json|ya?ml|toml)$/i;

async function repoState(root, git) {
  let actual;
  try { actual = await realpath(root); }
  catch (error) { throw setupError(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'path-missing' : 'path-unreadable'); }
  if (!(await lstat(actual)).isDirectory()) throw setupError('not-folder');
  const top = await realpath(await git(actual, 'rev-parse', '--show-toplevel'));
  if (actual !== top) throw setupError('not-root');
  const [branch, status, log, tracked, gitDir, commonDir] = await Promise.all([
    git(actual, 'branch', '--show-current'), git(actual, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
    git(actual, 'log', '-1', '--format=%H%x00%ct%x00%s').catch(() => ''),
    git(actual, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'),
    git(actual, 'rev-parse', '--absolute-git-dir'), git(actual, 'rev-parse', '--git-common-dir'),
  ]);
  const entries = status.split('\0').filter(Boolean), changes = [];
  for (let i = 0; i < entries.length; i++) {
    const line = entries[i]; changes.push(line);
    if (/[RC]/.test(line.slice(0, 2))) i++; // a rename/copy has a second NUL path
  }
  const [sha, timestamp, message] = log.split('\0');
  const files = [...new Set(tracked.split('\0').filter(Boolean))].filter(file => {
    const parts = file.split('/');
    return !parts.some(skipPart) && !parts.includes('..') && sourceExt.test(file) && !/\.(?:pem|key|p12|pfx)$/i.test(file);
  }).sort().slice(0, 5000);
  let ahead = 0, behind = 0;
  try { [behind, ahead] = (await git(actual, 'rev-list', '--left-right', '--count', '@{upstream}...HEAD')).split(/\s+/).map(Number); } catch { /* No tracking branch is normal. */ }
  return { actual, files, row: {
    name: path.basename(actual), path: actual, branch: branch || (sha ? 'detached HEAD' : 'No commits yet'),
    dirtyFiles: changes.length, untracked: changes.filter(line => line.startsWith('??')).length,
    deleted: changes.filter(line => line.slice(0, 2).includes('D')).length,
    staged: changes.filter(line => line[0] !== ' ' && line[0] !== '?').length,
    unstaged: changes.filter(line => line[0] !== '?' && line[1] !== ' ').length,
    ahead, behind, stashes: null, worktree: path.resolve(actual, gitDir) !== path.resolve(actual, commonDir),
    lastCommitAgeHours: timestamp ? Math.max(0, (Date.now() / 1000 - Number(timestamp)) / 3600) : null,
    lastCommitMsg: message || 'No commits yet', lastCommitAt: timestamp ? new Date(Number(timestamp) * 1000).toISOString() : null,
  }, sha };
}

async function sourceGraph(workspaces) {
  const nodes = [], links = [], seen = new Set();
  const addNode = node => { if (!seen.has(node.id)) { seen.add(node.id); nodes.push(node); } };
  const addLink = (source, target, kind) => { if (seen.has(source) && seen.has(target) && source !== target) links.push({ source, target, weight: kind === 'import' ? 2 : 1, kind }); };
  const selected = [];
  const perRepo = Math.max(1, Math.floor(180 / Math.max(1, workspaces.length)));
  for (const [community, workspace] of workspaces.entries()) {
    const prefix = `repo${community}:`, rootId = `${prefix}.`;
    const base = { community, communityName: workspace.row.name, degree: 0 };
    addNode({ ...base, id: rootId, label: workspace.row.name, fileType: 'folder' });
    for (const file of workspace.files.slice(0, perRepo)) {
      const absolute = path.join(workspace.actual, file);
      let info, resolved;
      try { info = await lstat(absolute); resolved = await realpath(absolute); } catch { continue; }
      const rel = path.relative(workspace.actual, resolved);
      if (info.isSymbolicLink() || !info.isFile() || path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) continue;
      const directory = path.posix.dirname(file), parent = directory === '.' ? rootId : `${prefix}${directory}/`;
      if (directory !== '.' && !seen.has(parent)) {
        addNode({ ...base, id: parent, label: `${workspace.row.name}/${directory}`, fileType: 'folder' });
        addLink(rootId, parent, 'contains');
      }
      const id = `${prefix}${file}`;
      addNode({ ...base, id, label: file, fileType: path.extname(file).slice(1) });
      addLink(parent, id, 'contains');
      selected.push({ id, file, prefix, absolute: resolved, size: info.size });
    }
  }
  for (const entry of selected) {
    if (!/\.[cm]?[jt]sx?$/.test(entry.file) || entry.size > 256 * 1024) continue;
    let text; try { text = await readFile(entry.absolute, 'utf8'); } catch { continue; }
    // A lightweight relative-module map, not a parser or semantic dependency graph.
    const identifier = '[$_\\p{ID_Start}][$\\u200C\\u200D\\p{ID_Continue}]*';
    const bindings = `(?:${identifier}\\s*,\\s*)?(?:\\{[^}]*\\}|\\*(?:\\s+as\\s+${identifier})?|${identifier})`;
    // Preserve existing same-line forms; only declaration bindings may span lines.
    const clause = `(?:[^'"\\n]*?|(?:type\\s+)?${bindings})`;
    const pattern = new RegExp(`(?:\\b(?:import|export)\\s+(?:${clause}\\s+from\\s+)?|\\brequire\\(\\s*)['"](\\.[^'"\\n]+)['"]`, 'gu');
    for (const match of text.matchAll(pattern)) {
      const stem = path.posix.normalize(path.posix.join(path.posix.dirname(entry.file), match[1]));
      const extension = path.posix.extname(stem);
      const sourceExtensions = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] }[extension] || [];
      // Prefer a selected literal file, then source counterparts of emitted paths.
      const candidates = [stem, ...sourceExtensions.map(ext => stem.slice(0, -extension.length) + ext),
        ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].map(ext => stem + ext), `${stem}/index.ts`, `${stem}/index.js`];
      const target = candidates.map(file => entry.prefix + file).find(id => seen.has(id));
      if (target) addLink(entry.id, target, 'import');
    }
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const link of links) { byId.get(link.source).degree++; byId.get(link.target).degree++; }
  return { fetchedAt: stamp(), nodes, links, stats: { nodes: nodes.length, links: links.length, communities: workspaces.length },
    builtAtCommit: workspaces[0]?.sha || '', filesAvailable: workspaces.reduce((n, repo) => n + repo.files.length, 0),
    description: 'Selected source files, folder membership and lightweight JS/TS relative imports. Up to 180 files; generated and hidden paths excluded.' };
}

export async function collectGitHub(config, fetchImpl = fetch) {
  const settings = config.github;
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'YunusOS/0.1' };
  if (settings.token) headers.Authorization = `Bearer ${settings.token}`;
  async function get(route) {
    const response = await fetchImpl(`https://api.github.com${route}`, { headers, signal: AbortSignal.timeout(12000), redirect: 'error' });
    if (!response.ok) throw new Error(response.status === 401 ? 'GitHub rejected the token. Check its access.' : response.status === 403 || response.status === 429 ? 'GitHub rate limit or permission check failed. Try later or check token access.' : `GitHub request failed (${response.status}).`);
    return response.json();
  }
  const user = settings.username;
  const issues = async query => (await get(`/search/issues?q=${encodeURIComponent(query)}&per_page=15&sort=updated`)).items || [];
  const [mine, reviews, assigned, runs] = await Promise.all([
    user ? issues(`is:pr is:open author:${user}`) : [],
    user ? issues(`is:pr is:open review-requested:${user}`) : [],
    user ? issues(`is:issue is:open assignee:${user}`) : [],
    Promise.all(settings.repositories.map(async repo => {
      const data = await get(`/repos/${repo}/actions/runs?per_page=5`);
      return (data.workflow_runs || []).map(run => ({ repo, workflow: run.name, branch: run.head_branch, conclusion: run.conclusion, status: run.status, updatedAt: run.updated_at, url: safeLink(run.html_url) }));
    })),
  ]);
  const common = issue => ({ repo: String(issue.repository_url || '').split('/repos/')[1] || '', number: issue.number, title: issue.title, author: issue.user?.login, createdAt: issue.created_at, updatedAt: issue.updated_at, url: safeLink(issue.html_url), isDraft: Boolean(issue.draft) });
  return { fetchedAt: stamp(), user, reviewRequested: reviews.map(common), myOpenPRs: mine.map(issue => ({ ...common(issue), branch: '', ci: 'none' })),
    openIssues: assigned.map(issue => ({ ...common(issue), labels: (issue.labels || []).map(label => typeof label === 'string' ? label : label.name).filter(Boolean) })), recentRuns: runs.flat(), counts: { reviewRequested: reviews.length, myOpenPRs: mine.length, openIssues: assigned.length } };
}

function activityFeed(data, tasks, now) {
  const events = new Map();
  const github = ['live', 'demo'].includes(data.sources?.github?.status) ? data.github : null;
  const add = (id, item) => {
    if (item.publishedAt && Number.isFinite(Date.parse(item.publishedAt))) events.set(id, item);
  };
  for (const repo of data.repos?.repos || []) {
    add(`git:${repo.path}:${repo.lastCommitAt}`, { source: 'git', tag: 'COMMIT', title: `${repo.name}: ${repo.lastCommitMsg}`, publishedAt: repo.lastCommitAt });
  }
  for (const pr of [...(github?.myOpenPRs || []), ...(github?.reviewRequested || [])]) {
    add(`pr:${pr.repo}:${pr.number}`, { source: 'github', tag: 'PR', title: `${pr.repo} #${pr.number}: ${pr.title}`, publishedAt: pr.updatedAt || pr.createdAt, url: pr.url });
  }
  for (const run of github?.recentRuns || []) {
    add(`run:${run.url || `${run.repo}:${run.workflow}:${run.updatedAt}`}`, { source: 'github', tag: 'CI', title: `${run.repo}: ${run.workflow || 'Workflow'} · ${run.conclusion || run.status || 'unknown'}`, publishedAt: run.updatedAt, url: run.url });
  }
  for (const task of tasks) {
    add(`task:${task.id}`, { source: 'local', tag: 'TASK', title: `Task added: ${task.title}`, publishedAt: task.createdAt });
  }
  return { fetchedAt: now, items: [...events.values()].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 60) };
}

export function createDashboard({ store, fetchImpl = fetch, execImpl = exec }) {
  const git = gitWith(execImpl);
  let cached = null, lastKey = '', refreshJob = null;
  let githubKey = null, githubSnapshot = null, githubRevision = 0;
  async function load(force = false) {
    const config = store.get(), key = JSON.stringify(config);
    const connectionKey = config.mode === 'live' && (config.github.username || config.github.repositories.length)
      ? JSON.stringify(config.github) : null;
    if (connectionKey !== githubKey) {
      githubKey = connectionKey; githubSnapshot = null; githubRevision++;
      cached = null; lastKey = '';
    }
    if (!force && cached && key === lastKey && Date.now() - Date.parse(cached.fetchedAt) < 60000) return decorate(cached, config);
    if (refreshJob) { await refreshJob; return load(force && key !== lastKey); }
    const revision = githubRevision;
    refreshJob = collect(config, revision).then(value => {
      // A late response must not refill the cache after an identity change.
      if (revision === githubRevision) { cached = value; lastKey = key; }
      return value;
    }).finally(() => { refreshJob = null; });
    return decorate(await refreshJob, config);
  }
  async function decorate(data, config) {
    const value = structuredClone(data), items = store.tasks(), now = stamp();
    value.tasks = { items, fetchedAt: now };
    value.initiative = { fetchedAt: now, name: `${config.displayName} checklist`, branch: '', checklist: { done: items.filter(item => item.done).length, total: items.length, items: items.map(item => ({ text: item.title, done: item.done })) }, recentCommits: [] };
    value.sources.tasks = { status: 'live', updatedAt: now, message: 'Saved on this device' };
    value.sources.initiative = { status: 'live', updatedAt: now, message: 'Your local checklist' };
    if (config.mode === 'live') {
      value.news = activityFeed(value, items, now);
      value.sources.news = { status: value.news.items.length ? 'live' : 'disabled', updatedAt: now, message: value.news.items.length ? 'Existing local commits, GitHub updates and task creation. No additional requests.' : 'No local or connected activity yet.' };
    }
    value.sources.runtime = { status: 'live', updatedAt: now, message: 'This local process' };
    const voice = await voiceCapabilities(config);
    value.runtime = { platform: os.platform(), nodeVersion: process.versions.node, uptimeSeconds: Math.floor(process.uptime()), connectedSources: Object.values(value.sources).filter(source => source.status === 'live').length, repoCount: config.mode === 'live' ? value.repos?.repos?.length || 0 : 0, voiceReady: voice.available, voiceEnabled: voice.enabled, voiceReason: voice.reason || '', assistantProvider: config.assistant.provider };
    value.mode = config.mode; value.profile = { displayName: config.displayName, timezone: config.timezone };
    return value;
  }
  async function collect(config, revision) {
    const now = stamp();
    if (config.mode === 'demo') {
      const data = createFixtures();
      data.disclosure = 'Sample graph, repository and GitHub activity. Runtime and tasks are saved locally.';
      return { ...data, fetchedAt: now, sources: Object.fromEntries(['runtime', 'initiative', 'graph', 'news', 'tasks', 'github', 'repos'].map(name => [name, { status: 'demo', message: 'Sample workspace', updatedAt: now }])) };
    }
    const sources = Object.fromEntries(['graph', 'news', 'github', 'repos'].map(name => [name, { status: 'disabled', message: name === 'news' ? 'No local or connected activity yet.' : 'Connect a source in Settings.' }]));
    const data = { demo: false, mode: 'live', fetchedAt: now, disclosure: 'Your connected sources. Empty panels have no configured source.', sources, graph: null, news: null, github: null, repos: null };
    if (config.workspacePaths.length) {
      const results = await Promise.allSettled(config.workspacePaths.map(root => repoState(root, git)));
      const ready = results.filter(result => result.status === 'fulfilled').map(result => result.value);
      const problems = results.flatMap((result, index) => result.status === 'rejected' ? [setupProblem(config.workspacePaths[index], result.reason)] : []);
      const failures = problems.length;
      data.repos = { fetchedAt: now, repos: ready.map(repo => repo.row), suggestions: problems.map(problem => ({ severity: 'warn', text: `${problem.path}: ${problem.message}` })) };
      data.graph = await sourceGraph(ready);
      sources.repos = sources.graph = { status: failures ? 'error' : 'live', updatedAt: now, problems, message: failures ? `${ready.length} connected, ${failures} unavailable` : `${ready.length} local repositories. Read only.` };
    }
    if (config.github.username || config.github.repositories.length) {
      try {
        data.github = await collectGitHub(config, fetchImpl);
        if (revision === githubRevision) githubSnapshot = structuredClone(data.github);
        sources.github = { status: 'live', stale: false, updatedAt: data.github.fetchedAt, message: 'GitHub API. Read only.' };
      } catch (error) {
        if (revision === githubRevision && githubSnapshot) data.github = structuredClone(githubSnapshot);
        sources.github = { status: 'error', stale: Boolean(data.github), ...(data.github ? { updatedAt: data.github.fetchedAt } : {}),
          message: error.message.startsWith('GitHub ') ? error.message : 'GitHub is unavailable. Check the connection and try again.' };
      }
    }
    return data;
  }
  return { load };
}
