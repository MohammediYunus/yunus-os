import { createFixtures } from '../../fixtures.mjs';
import { localAnswer } from '../lib/local-commands.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const storageKeyDefault = `yunus-os:browser-demo:v1:${new URL('../../', import.meta.url).pathname}`;

function titleOf(value) {
  if (typeof value !== 'string' || value.length > 240 || /[\u0000-\u001f\u007f]/u.test(value) || !value.trim()) throw new Error('Give the task a title of up to 240 characters without control characters.');
  return value.trim();
}
function savedState(value) {
  if (!keys(value, ['version', 'tasks', 'voice']) || value.version !== 1 || !Array.isArray(value.tasks) || value.tasks.length > 200 || !keys(value.voice, ['enabled']) || typeof value.voice.enabled !== 'boolean') throw new Error('Invalid saved demo');
  const ids = new Set();
  const tasks = value.tasks.map(task => {
    if (!keys(task, ['id', 'title', 'done', 'createdAt']) || typeof task.id !== 'string' || !task.id || task.id.length > 100 || /[\u0000-\u001f\u007f]/u.test(task.id) || ids.has(task.id) || typeof task.done !== 'boolean' || typeof task.createdAt !== 'string' || !Number.isFinite(Date.parse(task.createdAt))) throw new Error('Invalid saved task');
    ids.add(task.id);
    return { id: task.id, title: titleOf(task.title), done: task.done, createdAt: task.createdAt };
  });
  return { version: 1, tasks, voice: { enabled: value.voice.enabled } };
}

// This adapter has no network or local-server fallback. Only demo tasks and a
// speech preference can be saved; account/provider settings are never accepted.
export function createDemoApi({ storage = null, storageKey = storageKeyDefault, now = () => new Date(), uuid = () => globalThis.crypto.randomUUID() } = {}) {
  const initial = createFixtures(now());
  let state = { version: 1, tasks: structuredClone(initial.tasks.items), voice: { enabled: false } };
  let persistent = Boolean(storage), storageMessage = '';
  function syncStored({ bootstrap = false } = {}) {
    if (!persistent) return;
    try {
      const raw = storage.getItem(storageKey);
      if (raw === null) {
        if (bootstrap) storage.setItem(storageKey, JSON.stringify(state));
      } else {
        try {
          if (typeof raw !== 'string' || raw.length > 256 * 1024) throw new Error('Invalid saved demo');
          state = savedState(JSON.parse(raw));
          storageMessage = '';
        } catch { storageMessage = 'Saved demo data was invalid; this page kept its last valid tasks. Task edits are saved only in this browser.'; }
      }
    } catch { persistent = false; storageMessage = 'Browser storage is unavailable. Further edits last only for this page session and will be lost on reload.'; }
  }
  syncStored({ bootstrap: true });
  const persist = () => {
    if (!persistent) return;
    try { storage.setItem(storageKey, JSON.stringify(state)); }
    catch { persistent = false; storageMessage = 'Browser storage is unavailable. Further edits last only for this page session and will be lost on reload.'; }
  };
  const storageStatus = () => ({ persistent, message: storageMessage || (persistent ? 'Task edits are saved only in this browser.' : 'Task edits last only for this page session and will be lost on reload.') });
  const configuration = () => ({
    config: { mode: 'demo', displayName: 'Browser demo', timezone: 'system', workspacePaths: [], github: { username: '', repositories: [], hasToken: false }, assistant: { provider: 'local' }, voice: { enabled: state.voice.enabled } },
    capabilities: {
      runtime: 'browser-demo', connections: { available: false },
      assistant: { provider: 'local', available: true, local: true, mode: 'deterministic' },
      voice: { enabled: state.voice.enabled, available: false, inputSupported: false, reason: 'Microphone input requires the local app and Whisper.' },
      desktop: { available: false, apps: [] }, storage: storageStatus(),
    },
  });
  function dashboard() {
    const data = structuredClone(initial), stamp = now().toISOString();
    data.fetchedAt = stamp; data.storage = storageStatus();
    data.disclosure = `Sample graph, repositories and GitHub activity. No connected accounts. ${data.storage.message}`;
    data.tasks = { items: structuredClone(state.tasks), fetchedAt: stamp };
    data.initiative = { fetchedAt: stamp, name: 'Browser demo checklist', branch: '', recentCommits: [], checklist: { done: state.tasks.filter(task => task.done).length, total: state.tasks.length, items: state.tasks.map(task => ({ text: task.title, done: task.done })) } };
    data.sources.tasks = data.sources.initiative = { status: 'demo', updatedAt: stamp, message: data.storage.message };
    data.runtime = { platform: 'Browser demo', nodeVersion: 'Not used', uptimeSeconds: 0, connectedSources: 0, repoCount: initial.repos.repos.length, voiceReady: false, voiceEnabled: state.voice.enabled, assistantProvider: 'local' };
    data.profile = { displayName: 'Browser demo', timezone: 'system' };
    return data;
  }
  function addTask(input) {
    if (!keys(input, ['title'])) throw new Error('Only a task title can be added in this demo.');
    const title = titleOf(input.title);
    if (state.tasks.length >= 200) throw new Error('Task list is full.');
    const id = uuid();
    if (typeof id !== 'string' || !id || id.length > 100 || /[\u0000-\u001f\u007f]/u.test(id) || state.tasks.some(task => task.id === id)) throw new Error('Could not create a unique task. Try again.');
    const task = { id, title, done: false, createdAt: now().toISOString() };
    state.tasks.push(task); persist();
    return structuredClone(task);
  }
  async function api(path, { method = 'GET', body, signal, binary = false } = {}) {
    signal?.throwIfAborted();
    if (binary) throw new Error('Recording and file uploads require the local app.');
    // Tabs on the same project share storage. Re-read before any operation so
    // an older open tab does not overwrite task or preference edits from another.
    syncStored();
    if (path === '/api/config' && method === 'GET') return configuration();
    if (path === '/api/config' && method === 'POST') {
      if (!keys(body, ['voice']) || !keys(body.voice, ['enabled']) || typeof body.voice.enabled !== 'boolean') throw new Error('This browser demo only saves the spoken-reply preference. Use the local app to connect accounts or providers.');
      state.voice.enabled = body.voice.enabled; persist(); return configuration();
    }
    if ((path === '/api/all' && method === 'GET') || (path === '/api/refresh' && method === 'POST')) return dashboard();
    if (path === '/api/tasks' && method === 'POST') return { task: addTask(body) };
    if (typeof path === 'string' && path.startsWith('/api/tasks/') && ['PATCH', 'DELETE'].includes(method)) {
      let id; try { id = decodeURIComponent(path.slice('/api/tasks/'.length)); } catch { throw new Error('Task not found.'); }
      const index = state.tasks.findIndex(task => task.id === id);
      if (index < 0) throw new Error('Task not found.');
      if (method === 'DELETE') state.tasks.splice(index, 1);
      else {
        if (!keys(body, ['done']) || typeof body.done !== 'boolean') throw new Error('Task state must be true or false.');
        state.tasks[index].done = body.done;
      }
      persist(); return { ok: true, task: method === 'DELETE' ? null : structuredClone(state.tasks[index]) };
    }
    if (path === '/api/assistant' && method === 'POST') {
      if (!keys(body, ['message']) || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 4000) throw new Error('Write a request of up to 4,000 characters.');
      return localAnswer(body.message, dashboard(), { allowDesktopActions: false });
    }
    if (path === '/api/action' && method === 'POST') {
      if (!keys(body, ['action']) || !keys(body.action, ['type', 'title']) || body.action.type !== 'add_task') throw new Error('Only checklist tasks can be approved in this browser demo.');
      return { ok: true, task: addTask({ title: body.action.title }), message: 'Task added to your demo checklist' };
    }
    if (path === '/api/assistant/cancel' && method === 'POST') return { ok: true };
    throw new Error('This action is not available in the browser demo. Use the local app to connect your workspace.');
  }
  return { api, connectSession: async () => {} };
}
