import { mkdir, readFile, writeFile, rename, unlink, chmod, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export const defaults = () => ({
  mode: 'demo', displayName: 'Your workspace', timezone: 'system', workspacePaths: [],
  github: { username: '', repositories: [], token: '' },
  assistant: { provider: 'local', model: '', claudeModel: '', endpoint: 'http://127.0.0.1:11434', executable: 'claude' },
  voice: { enabled: false, whisperExecutable: 'whisper-cli', whisperModelPath: '' },
});
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function text(value, name, max = 300) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`Invalid ${name}`);
  return value.trim();
}
function strings(value, name, max = 8) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid ${name}`);
  return [...new Set(value.map(item => text(item, name, 2000)).filter(Boolean))];
}
export function validateConfig(input, previous = defaults()) {
  if (!object(input)) throw new Error('Settings must be a JSON object');
  const config = structuredClone(previous);
  if ('mode' in input) {
    if (!['demo', 'live'].includes(input.mode)) throw new Error('Choose demo or live mode');
    config.mode = input.mode;
  }
  if ('displayName' in input) config.displayName = text(input.displayName, 'workspace name', 80) || 'Your workspace';
  if ('timezone' in input) {
    const zone = text(input.timezone, 'timezone', 80);
    if (zone !== 'system') { try { new Intl.DateTimeFormat('en', { timeZone: zone }); } catch { throw new Error('Invalid timezone'); } }
    config.timezone = zone;
  }
  if ('workspacePaths' in input) config.workspacePaths = strings(input.workspacePaths, 'workspace folders').map(folder => {
    const expanded = folder === '~' ? os.homedir() : folder.startsWith('~/') ? path.join(os.homedir(), folder.slice(2)) : folder;
    if (!path.isAbsolute(expanded)) throw new Error('Workspace folders must use absolute paths');
    return path.resolve(expanded);
  });
  if ('github' in input) {
    const value = input.github;
    if (!object(value)) throw new Error('Invalid GitHub settings');
    if ('username' in value) {
      const user = text(value.username, 'GitHub username', 39);
      if (user && !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(user)) throw new Error('Invalid GitHub username');
      config.github.username = user;
    }
    if ('repositories' in value) config.github.repositories = strings(value.repositories, 'GitHub repositories', 4).map(repo => {
      if (!/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(repo)) throw new Error('Use owner/repository for each GitHub repository');
      return repo;
    });
    if ('clearToken' in value && typeof value.clearToken !== 'boolean') throw new Error('Invalid clear token switch');
    if ('token' in value) {
      const token = text(value.token, 'GitHub token', 500);
      if (token) config.github.token = token;
    }
    if (value.clearToken === true) config.github.token = '';
  }
  if ('assistant' in input) {
    const value = input.assistant;
    if (!object(value)) throw new Error('Invalid assistant settings');
    if ('provider' in value) {
      if (!['local', 'ollama', 'claude'].includes(value.provider)) throw new Error('Invalid assistant provider');
      config.assistant.provider = value.provider;
    }
    for (const field of ['model', 'claudeModel', 'executable']) if (field in value) config.assistant[field] = text(value[field], field, 1000);
    if ('endpoint' in value) {
      let url; try { url = new URL(value.endpoint); } catch { throw new Error('Invalid Ollama address'); }
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Ollama must use a local HTTP address');
      config.assistant.endpoint = url.origin;
    }
  }
  if ('voice' in input) {
    const value = input.voice;
    if (!object(value)) throw new Error('Invalid voice settings');
    if ('enabled' in value) { if (typeof value.enabled !== 'boolean') throw new Error('Invalid voice switch'); config.voice.enabled = value.enabled; }
    for (const field of ['whisperExecutable', 'whisperModelPath']) if (field in value) config.voice[field] = text(value[field], field, 2000);
  }
  return config;
}
export function publicConfig(config) {
  const copy = structuredClone(config);
  const { token, ...github } = copy.github;
  return { ...copy, github: { ...github, hasToken: Boolean(token) } };
}
function validateTasks(value) {
  if (!Array.isArray(value) || value.length > 200) throw new Error('Invalid local task file');
  const ids = new Set();
  return value.map(task => {
    if (!object(task)) throw new Error('Invalid local task');
    const id = text(task.id, 'task id', 80), title = text(task.title, 'task title', 240);
    if (!id || ids.has(id) || !title || typeof task.done !== 'boolean' || typeof task.createdAt !== 'string' || !Number.isFinite(Date.parse(task.createdAt))) throw new Error('Invalid local task');
    ids.add(id);
    return { id, title, done: task.done, createdAt: task.createdAt };
  });
}
async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
    if (process.platform !== 'win32') await chmod(file, 0o600);
  } finally { await unlink(temp).catch(() => {}); }
}
async function readJson(file, fallback) {
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error('Configuration files must not be symlinks');
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function createConfigStore(directory = process.env.YOS_CONFIG_DIR || path.join(os.homedir(), '.config', 'yunus-os')) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Configuration directory must not be a symlink');
  const file = path.join(directory, 'config.json'), taskFile = path.join(directory, 'tasks.json');
  const saved = await readJson(file, defaults());
  // Older profiles shared one model field. Preserve a saved Claude override
  // only for its saved provider; never guess provider ownership from its name.
  if (object(saved?.assistant) && saved.assistant.provider === 'claude' && !('claudeModel' in saved.assistant)) {
    saved.assistant.claudeModel = 'model' in saved.assistant ? saved.assistant.model : '';
    saved.assistant.model = '';
  }
  let config = validateConfig(saved);
  let tasks = await readJson(taskFile, undefined);
  if (tasks === undefined) tasks = ['Connect a project folder', 'Explore your code graph', 'Add your first task'].map(title => ({ id: randomUUID(), title, done: false, createdAt: new Date().toISOString() }));
  tasks = validateTasks(tasks);
  await atomicJson(file, config); await atomicJson(taskFile, tasks);
  let queue = Promise.resolve();
  const serial = work => { const next = queue.then(work); queue = next.catch(() => {}); return next; };
  return {
    get: () => structuredClone(config), tasks: () => structuredClone(tasks),
    save: patch => serial(async () => { const next = validateConfig(patch, config); await atomicJson(file, next); config = next; return publicConfig(config); }),
    updateTask: (id, input, remove = false) => serial(async () => {
      if (!remove && !object(input)) throw new Error('Task must be a JSON object');
      const next = structuredClone(tasks);
      if (id) {
        const index = next.findIndex(task => task.id === id);
        if (index < 0) throw new Error('Task not found');
        if (remove) next.splice(index, 1);
        else { if (typeof input.done !== 'boolean') throw new Error('Task state must be true or false'); next[index].done = input.done; }
      } else {
        if (next.length >= 200) throw new Error('Task list is full');
        const title = text(input.title, 'task title', 240);
        if (!title) throw new Error('Give the task a title');
        id = randomUUID(); next.push({ id, title, done: false, createdAt: new Date().toISOString() });
      }
      await atomicJson(taskFile, next); tasks = next;
      return next.find(task => task.id === id) || null;
    }),
  };
}
